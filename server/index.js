'use strict';
const path = require('path');
const fs = require('fs');
const { execFile } = require('child_process');
const express = require('express');
const multer = require('multer');

const store = require('./store');
const auth = require('./auth');
const feeds = require('./feeds');
const weather = require('./weather');
const departures = require('./departures');
const schedule = require('./schedule');
const stream = require('./stream');
const updater = require('./updater');
const backup = require('./backup');
const stats = require('./stats');
const outputs = require('./outputs');
const providers = require('./providers');
const cameras = require('./cameras');
const sso = require('./sso');
const station = require('./station');
const http = require('http');
const QRCode = require('qrcode');
const pkg = require('../package.json');

// The port set under Settings → Application wins over the PORT the service starts with.
const PORT = Number(store.getSection('settings').port) || Number(process.env.PORT) || 8080;
const HOST = process.env.HOST || '0.0.0.0';
const PUBLIC = path.join(__dirname, '..', 'public');
// The whole app can live under a path, e.g. /channel1 (station contract); '' is the root.
const BASE = station.BASE_PATH;
const MAX_UPLOAD_MB = Number(process.env.MAX_UPLOAD_MB) || 2048;

const IMAGE_EXT = ['.jpg', '.jpeg', '.png', '.gif', '.webp', '.svg', '.bmp'];
const VIDEO_EXT = ['.mp4', '.m4v', '.webm', '.mov', '.mkv'];
const AUDIO_EXT = ['.mp3', '.m4a', '.aac', '.ogg', '.oga', '.opus', '.wav', '.flac'];
function mediaKind(file) {
  const ext = path.extname(file.originalname || '').toLowerCase();
  if (VIDEO_EXT.includes(ext) || /^video\/(mp4|webm|quicktime|x-matroska)$/.test(file.mimetype)) return 'video';
  if (IMAGE_EXT.includes(ext) || /^image\/(jpeg|png|gif|webp|svg\+xml|bmp)$/.test(file.mimetype)) return 'image';
  if (AUDIO_EXT.includes(ext) || /^audio\//.test(file.mimetype)) return 'audio';
  return null;
}

const app = express();
app.disable('x-powered-by');
app.use(express.json({ limit: '2mb' }));

// ---------- helpers ----------
const wrap = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);

// The renderer (local Chromium) and logged-in admins (preview) may read player data.
function playerAccess(req, res, next) {
  if (station.isLocal(req) || auth.isAuthenticated(req)) return next();
  res.status(401).json({ error: 'Not allowed' });
}

function mediaUrl(m) {
  if (m.external) return m.url;
  return `${BASE}/media/${encodeURIComponent(m.filename)}`;
}

function probe(file) {
  return new Promise((resolve) => {
    execFile('ffprobe', ['-v', 'error', '-show_entries', 'format=duration:stream=width,height,codec_type', '-of', 'json', file], { timeout: 20000 }, (err, out) => {
      if (err) return resolve({});
      try {
        const j = JSON.parse(out);
        const v = (j.streams || []).find((s) => s.codec_type === 'video') || {};
        resolve({
          duration: j.format && j.format.duration ? Math.round(Number(j.format.duration) * 10) / 10 : null,
          width: v.width || null,
          height: v.height || null,
          hasAudio: (j.streams || []).some((s) => s.codec_type === 'audio'),
        });
      } catch { resolve({}); }
    });
  });
}

function thumbnail(file, out) {
  return new Promise((resolve) => {
    execFile('ffmpeg', ['-y', '-v', 'error', '-ss', '1', '-i', file, '-frames:v', '1', '-vf', 'scale=320:-2', out], { timeout: 30000 }, (err) => resolve(!err));
  });
}

// ---------- health ----------
// Answers without a login, at the root and under the base path (station contract).
function healthz(req, res) {
  res.set('Cache-Control', 'no-store').json({ status: 'ok', app: 'beeldkrant', version: pkg.version, contract: station.CONTRACT });
}
app.get('/healthz', healthz);

// ---------- auth ----------
auth.bootstrap();
// The service token of the station panel acts as an admin on the API.
app.use('/api', auth.serviceToken);

// Brute-force brake: a few wrong passwords per address and user name, then a pause.
const failures = new Map(); // key -> { count, until }
function throttled(key) {
  const f = failures.get(key);
  return f && f.until > Date.now() ? Math.ceil((f.until - Date.now()) / 1000) : 0;
}
function failed(key) {
  const f = failures.get(key) || { count: 0, until: 0 };
  f.count += 1;
  if (f.count >= 5) { f.until = Date.now() + Math.min(15 * 60, 30 * 2 ** (f.count - 5)) * 1000; }
  failures.set(key, f);
}

// What the login page offers.
app.get('/api/auth/options', (req, res) => {
  const c = sso.config();
  res.json({ sso: sso.ready(c) ? { label: c.buttonLabel || 'Sign in with Microsoft' } : null, panelName: store.getSection('settings').panelName });
});

app.post('/api/login', (req, res) => {
  const { username, password } = req.body || {};
  const key = `${station.clientAddress(req)}|${String(username || '').toLowerCase()}`;
  const wait = throttled(key);
  if (wait) return res.status(429).json({ error: `Too many attempts. Try again in ${wait} s.` });
  const known = auth.findByName(username || '');
  if (known && known.authMethod === 'sso') return res.status(400).json({ error: 'This account signs in with Microsoft. Use the Microsoft button.' });
  const user = auth.verify(username || '', password || '');
  if (!user) { failed(key); return res.status(401).json({ error: 'Wrong username or password' }); }
  failures.delete(key);
  if (user.disabled) return res.status(403).json({ error: 'This account is disabled' });
  res.json(auth.startLogin(res, user));
});
// Second step: the code from the authenticator app (or a recovery code).
app.post('/api/login/mfa', (req, res) => {
  const { ticket, code } = req.body || {};
  try { res.json(auth.secondStep(res, ticket, code)); } catch (err) { res.status(err.status || 400).json({ error: err.message }); }
});
// The QR code for setting up an authenticator app.
app.get('/api/qr', wrap(async (req, res) => {
  const text = String(req.query.text || '');
  if (!text.startsWith('otpauth://totp/') || text.length > 400) return res.status(400).json({ error: 'Not an authenticator link' });
  res.type('image/svg+xml').set('Cache-Control', 'no-store').send(await QRCode.toString(text, { type: 'svg', margin: 1, errorCorrectionLevel: 'M' }));
}));

// Microsoft Entra sign-in.
app.get('/api/sso/start', (req, res) => {
  try { res.redirect(sso.startUrl(req)); } catch (err) { res.redirect(`${BASE}/admin/?sso_error=${encodeURIComponent(err.message)}`); }
});
app.get('/api/sso/callback', wrap(async (req, res) => {
  try {
    const user = await sso.callback(req);
    auth.finishLogin(res, user);
    res.redirect(`${BASE}/admin/`);
  } catch (err) {
    console.error('Microsoft sign-in failed:', err.message);
    res.redirect(`${BASE}/admin/?sso_error=${encodeURIComponent(err.message)}`);
  }
}));

app.post('/api/logout', (req, res) => { auth.logout(req, res); res.json({ ok: true }); });
app.get('/api/me', (req, res) => {
  res.json({ user: auth.publicUser(auth.currentUser(req)), panelName: store.getSection('settings').panelName, version: pkg.version, permissionLabels: auth.PERMISSIONS, passwordPolicy: auth.policy() });
});
// Each user picks their own admin theme.
app.put('/api/me/theme', (req, res) => {
  const user = auth.currentUser(req);
  if (!user) return res.status(401).json({ error: 'Not logged in' });
  const theme = ['light', 'dark', 'system'].includes((req.body || {}).theme) ? req.body.theme : 'system';
  store.update('users', user.id, { theme });
  res.json({ theme });
});
// Works while the one-time or expired password is still active, so it sits before requireAuth.
app.post('/api/password', (req, res) => {
  const user = auth.currentUser(req);
  if (!user) return res.status(401).json({ error: 'Not logged in' });
  if (user.authMethod === 'sso') return res.status(400).json({ error: 'Your password is managed by Microsoft' });
  const { current, password } = req.body || {};
  if (!auth.check(current || '', user.passwordHash)) return res.status(400).json({ error: 'Current password is wrong' });
  const bad = auth.policyError(password);
  if (bad) return res.status(400).json({ error: bad });
  if (password === current) return res.status(400).json({ error: 'Choose a new password' });
  auth.setPassword(user.id, password);
  res.json({ ok: true });
});

// ---------- player (renderer) ----------
function resolveElement(e) {
  const out = { ...e };
  if (e.mediaId) {
    const m = store.get('media', e.mediaId);
    out.src = m ? mediaUrl(m) : null;
    out.mediaType = m ? m.type : null;
  }
  // Carousels: a list of media in the order the user set.
  if (Array.isArray(e.items)) {
    out.sources = e.items.map((id) => store.get('media', id)).filter(Boolean).map((m) => ({ id: m.id, src: mediaUrl(m), type: m.type }));
  }
  if (e.type === 'camera' && e.cameraId) {
    const cam = store.get('cameras', e.cameraId);
    out.cameraName = cam ? cam.name : null;
    out.src = cam ? `${BASE}/api/player/camera/${cam.id}` : null;
    out.snapshot = cam ? `${BASE}/api/player/camera/${cam.id}/snapshot` : null;
  }
  return out;
}

function resolveSlides(slides) {
  const bg = (id) => { const m = id && store.get('media', id); return m ? { url: mediaUrl(m), type: m.type } : null; };
  return (slides || []).filter((sl) => sl.enabled !== false).map((sl) => ({
    ...sl,
    active: schedule.windowOpen(sl.window),
    backgroundMedia: bg(sl.backgroundMediaId),
    elements: (sl.elements || []).filter((e) => e.enabled !== false).map(resolveElement),
  }));
}

function resolvePlayout(p) {
  if (!p) return null;
  return {
    ...p,
    overlays: (p.overlays || []).filter((e) => e.enabled !== false).map(resolveElement),
    slides: resolveSlides(p.slides),
    // Ad blocks borrow the scenes of another playout and are inserted every N scenes or at set times.
    adBlocks: (p.adBlocks || []).filter((a) => a.enabled !== false && a.playoutId && a.playoutId !== p.id).map((a) => {
      const src = store.get('playouts', a.playoutId);
      return { ...a, slides: src ? resolveSlides(src.slides).filter((sl) => sl.active) : [] };
    }).filter((a) => a.slides.length),
  };
}

// Background music: an uploaded audio file or an external Shoutcast/Icecast stream, with volume and ducking.
function resolveMusic(p) {
  const bm = p && p.music;
  const m = bm && bm.mediaId && store.get('media', bm.mediaId);
  if (!m || m.type !== 'audio') return null;
  return { url: mediaUrl(m), live: !!m.external, volume: bm.volume ?? 60, duck: bm.duck ?? 15 };
}

app.get('/api/player/state', playerAccess, (req, res) => {
  const playoutId = req.query.playout || schedule.activePlayoutId();
  const settings = store.getSection('settings');
  res.json({
    playout: resolvePlayout(playoutId && store.get('playouts', playoutId)),
    music: resolveMusic(playoutId && store.get('playouts', playoutId)),
    timezone: settings.timezone,
    locale: settings.locale,
  });
});

// A single slide, used by the editor preview.
app.post('/api/player/render-slide', auth.requireAuth, (req, res) => {
  const { playout, slide } = req.body || {};
  const p = resolvePlayout({ ...(playout || {}), slides: [slide || {}] });
  res.json(p);
});

app.get('/api/player/feed/:id', playerAccess, wrap(async (req, res) => {
  const feed = store.get('feeds', req.params.id);
  if (!feed) return res.status(404).json({ error: 'Feed not found' });
  res.json(feeds.limit(feed, await feeds.getItems(feed)));
}));

app.get('/api/player/weather', playerAccess, wrap(async (req, res) => {
  res.json(await weather.getWeather(req.query.lat || 52.37, req.query.lon || 4.9));
}));

app.get('/api/player/departures', playerAccess, wrap(async (req, res) => {
  if (!req.query.stop) return res.status(400).json({ error: 'No stop chosen' });
  try { res.json(await departures.departures(String(req.query.stop), { n: req.query.n, modes: req.query.modes })); } catch (err) { res.status(502).json({ error: err.message }); }
}));

// QR codes for QR code elements, as SVG in the chosen colours.
const QR_COLOUR = /^#[0-9a-f]{6}$/i;
app.get('/api/player/qr', playerAccess, wrap(async (req, res) => {
  const text = String(req.query.text || '');
  if (!text || text.length > 1500) return res.status(400).json({ error: 'Enter the text or link for the QR code (at most 1500 characters)' });
  const dark = QR_COLOUR.test(req.query.fg || '') ? req.query.fg : '#000000';
  const light = QR_COLOUR.test(req.query.bg || '') ? req.query.bg : '#ffffff';
  const svg = await QRCode.toString(text, { type: 'svg', margin: Math.min(8, Math.max(0, Number(req.query.margin ?? 2) || 0)), errorCorrectionLevel: 'M', color: { dark, light } });
  res.type('image/svg+xml').set('Cache-Control', 'public, max-age=3600').send(svg);
}));

// Live reload: the player reconnects and refreshes when anything is saved.
let revision = Date.now();
const listeners = new Set();
store.events.on('change', () => {
  revision = Date.now();
  for (const res of listeners) res.write(`data: ${revision}\n\n`);
});
app.get('/api/player/events', playerAccess, (req, res) => {
  res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', Connection: 'keep-alive' });
  res.write(`data: ${revision}\n\n`);
  listeners.add(res);
  const ping = setInterval(() => res.write(': ping\n\n'), 25000);
  req.on('close', () => { clearInterval(ping); listeners.delete(res); });
});

// IP cameras as MJPEG for camera elements and the preview, and as a single picture.
app.get('/api/player/camera/:id', playerAccess, (req, res) => {
  if (!store.get('cameras', req.params.id)) return res.status(404).json({ error: 'Camera not found' });
  cameras.watch(req.params.id, req, res);
});
app.get('/api/player/camera/:id/snapshot', playerAccess, wrap(async (req, res) => {
  if (!store.get('cameras', req.params.id)) return res.status(404).json({ error: 'Camera not found' });
  try {
    const jpeg = await cameras.snapshot(req.params.id);
    res.set({ 'Content-Type': 'image/jpeg', 'Cache-Control': 'no-store' }).send(jpeg);
  } catch (err) { res.status(504).json({ error: err.message }); }
}));

app.use('/media', playerAccess, express.static(store.MEDIA_DIR, { maxAge: '1h', fallthrough: false }));
// hls.js plays HLS live streams (.m3u8) in live stream elements.
app.get('/player/vendor/hls.min.js', (req, res) => res.sendFile(require.resolve('hls.js/dist/hls.min.js'), { maxAge: '1d' }));
app.use('/player', express.static(path.join(PUBLIC, 'player')));

// ---------- everything below needs a login ----------
app.use('/api', auth.requireAuth);

// Changes need the permission for that part of the panel; read only accounts can only look.
// Anything not listed here (users, security, SSO, system) is for admins.
const WRITE_PERMISSIONS = [
  [/^\/(playouts|player)(\/|$)/, 'playouts'],
  [/^\/(media|folders|feeds|cameras)(\/|$)/, 'media'],
  [/^\/schedule(\/|$)/, 'schedule'],
  [/^\/(outputs?|stream|accounts)(\/|$)/, 'outputs'],
  [/^\/settings(\/|$)/, 'settings'],
  [/^\/backups(\/|$)/, 'backups'],
];
app.use('/api', (req, res, next) => {
  if (req.method === 'GET' || req.method === 'HEAD' || /^\/me(\/|$)/.test(req.path)) return next();
  const rule = WRITE_PERMISSIONS.find(([re]) => re.test(req.path));
  return rule ? auth.requirePerm(rule[1])(req, res, next) : auth.requireRole('admin')(req, res, next);
});
// Media library
const upload = multer({
  storage: multer.diskStorage({
    destination: store.MEDIA_DIR,
    filename: (req, file, cb) => {
      const ext = path.extname(file.originalname).toLowerCase().replace(/[^.a-z0-9]/g, '').slice(0, 8);
      cb(null, `${Date.now().toString(36)}-${store.id()}${ext}`);
    },
  }),
  limits: { fileSize: MAX_UPLOAD_MB * 1024 * 1024 },
  fileFilter: (req, file, cb) => cb(null, !!mediaKind(file)),
});

app.get('/api/media', (req, res) => {
  res.json(store.list('media').map((m) => ({ ...m, url: mediaUrl(m), thumbUrl: m.thumb ? `${BASE}/media/${encodeURIComponent(m.thumb)}` : m.type === 'image' ? mediaUrl(m) : null })));
});

// External media: an audio web stream (Shoutcast/Icecast) used as background music.
app.post('/api/media/external', (req, res) => {
  const { name, url } = req.body || {};
  if (!/^https?:\/\//i.test(String(url || ''))) return res.status(400).json({ error: 'Enter the http(s) address of the stream' });
  const folderId = folderExists((req.body || {}).folderId || null) ? req.body.folderId || null : null;
  res.json(store.create('media', { name: String(name || url).slice(0, 200), type: 'audio', external: true, url: String(url).trim(), size: 0, folderId }));
});

// Media folders: { name, parentId } (parentId null = top level). Media items carry a folderId.
function folderExists(id) {
  return id == null || !!store.get('folders', id);
}

app.get('/api/folders', (req, res) => res.json(store.list('folders')));
app.post('/api/folders', (req, res) => {
  const name = String((req.body || {}).name || '').trim().slice(0, 100);
  const parentId = (req.body || {}).parentId || null;
  if (!name) return res.status(400).json({ error: 'Give the folder a name' });
  if (!folderExists(parentId)) return res.status(400).json({ error: 'Parent folder not found' });
  res.json(store.create('folders', { name, parentId }));
});
app.put('/api/folders/:id', (req, res) => {
  const folder = store.get('folders', req.params.id);
  if (!folder) return res.status(404).json({ error: 'Not found' });
  const patch = {};
  if ((req.body || {}).name !== undefined) {
    patch.name = String(req.body.name).trim().slice(0, 100);
    if (!patch.name) return res.status(400).json({ error: 'Give the folder a name' });
  }
  if ('parentId' in (req.body || {})) {
    const parentId = req.body.parentId || null;
    if (!folderExists(parentId)) return res.status(400).json({ error: 'Parent folder not found' });
    // A folder cannot move into itself or one of its own subfolders.
    for (let p = parentId; p; p = (store.get('folders', p) || {}).parentId) {
      if (p === folder.id) return res.status(400).json({ error: 'A folder cannot be moved into itself' });
    }
    patch.parentId = parentId;
  }
  res.json(store.update('folders', folder.id, patch));
});
// Deleting a folder keeps its contents: files and subfolders move up one level.
app.delete('/api/folders/:id', (req, res) => {
  const folder = store.get('folders', req.params.id);
  if (!folder) return res.status(404).json({ error: 'Not found' });
  for (const m of store.list('media').filter((x) => x.folderId === folder.id)) store.update('media', m.id, { folderId: folder.parentId || null });
  for (const f of store.list('folders').filter((x) => x.parentId === folder.id)) store.update('folders', f.id, { parentId: folder.parentId || null });
  store.remove('folders', folder.id);
  res.json({ ok: true });
});

app.post('/api/media', upload.array('files', 50), wrap(async (req, res) => {
  const files = req.files || [];
  if (!files.length) return res.status(400).json({ error: 'No supported files received (images: jpg, png, gif, webp, svg; video: mp4, webm, mov, mkv; audio: mp3, m4a, aac, ogg, wav, flac)' });
  const created = [];
  for (const f of files) {
    const type = mediaKind(f);
    const info = await probe(f.path);
    let thumb = null;
    if (type === 'video') {
      const name = `${f.filename}.thumb.jpg`;
      if (await thumbnail(f.path, path.join(store.MEDIA_DIR, name))) thumb = name;
    }
    created.push(store.create('media', {
      folderId: folderExists(req.query.folderId || null) ? req.query.folderId || null : null,
      isAd: req.query.ad === '1',
      name: f.originalname, type, mime: f.mimetype, filename: f.filename, size: f.size, thumb,
      duration: type === 'image' ? null : info.duration, width: info.width || null, height: info.height || null, hasAudio: !!info.hasAudio,
    }));
  }
  res.json(created);
}));

app.patch('/api/media/:id', (req, res) => {
  const b = req.body || {};
  const patch = {};
  if (b.name !== undefined) patch.name = String(b.name).trim().slice(0, 200) || undefined;
  if ('folderId' in b) {
    if (!folderExists(b.folderId || null)) return res.status(400).json({ error: 'Folder not found' });
    patch.folderId = b.folderId || null;
  }
  if ('isAd' in b) patch.isAd = !!b.isAd;
  if (b.url !== undefined) {
    if (!(store.get('media', req.params.id) || {}).external) return res.status(400).json({ error: 'Only an input stream has an address' });
    if (!/^https?:\/\//i.test(String(b.url))) return res.status(400).json({ error: 'Enter the http(s) address of the stream' });
    patch.url = String(b.url).trim();
  }
  const m = store.get('media', req.params.id) && store.update('media', req.params.id, Object.fromEntries(Object.entries(patch).filter(([, v]) => v !== undefined)));
  if (!m) return res.status(404).json({ error: 'Not found' });
  res.json(m);
});

app.delete('/api/media/:id', (req, res) => {
  const m = store.remove('media', req.params.id);
  if (!m) return res.status(404).json({ error: 'Not found' });
  for (const f of [m.filename, m.thumb]) if (f) fs.rm(path.join(store.MEDIA_DIR, f), { force: true }, () => {});
  res.json({ ok: true });
});

// Feed preview for the editor
app.get('/api/feeds/:id/items', wrap(async (req, res) => {
  const feed = store.get('feeds', req.params.id);
  if (!feed) return res.status(404).json({ error: 'Feed not found' });
  res.json(feeds.limit(feed, await feeds.getItems(feed, { force: req.query.force === '1' })));
}));

// A full copy of a playout (scenes, overlays, ad blocks and music) under a new name.
app.post('/api/playouts/:id/clone', (req, res) => {
  const src = store.get('playouts', req.params.id);
  if (!src) return res.status(404).json({ error: 'Not found' });
  const { id, createdAt, updatedAt, ...copy } = JSON.parse(JSON.stringify(src));
  copy.name = String((req.body || {}).name || '').trim().slice(0, 80) || `${src.name} (copy)`;
  // Ad blocks that take their scenes from the original keep doing so.
  res.json(store.create('playouts', copy));
});

// Feeds. Access tokens never go back to the browser; an empty one keeps the saved one.
app.get('/api/feeds', (req, res) => res.json(store.list('feeds').map(feeds.publicFeed)));
app.get('/api/feeds/:id', (req, res) => {
  const feed = store.get('feeds', req.params.id);
  feed ? res.json(feeds.publicFeed(feed)) : res.status(404).json({ error: 'Not found' });
});
app.post('/api/feeds', (req, res) => {
  try { res.json(feeds.publicFeed(store.create('feeds', feeds.cleanFeed(clean(req.body))))); } catch (err) { res.status(400).json({ error: err.message }); }
});
app.put('/api/feeds/:id', (req, res) => {
  const existing = store.get('feeds', req.params.id);
  if (!existing) return res.status(404).json({ error: 'Not found' });
  try {
    const item = store.update('feeds', existing.id, feeds.cleanFeed(clean(req.body), existing));
    feeds.forget(existing.id);
    res.json(feeds.publicFeed(item));
  } catch (err) { res.status(400).json({ error: err.message }); }
});
app.delete('/api/feeds/:id', (req, res) => {
  feeds.forget(req.params.id);
  store.remove('feeds', req.params.id) ? res.json({ ok: true }) : res.status(404).json({ error: 'Not found' });
});

// Stops for departure board elements.
app.get('/api/transit/stops', wrap(async (req, res) => {
  try { res.json(await departures.searchStops(req.query.q)); } catch (err) { res.status(502).json({ error: err.message }); }
}));

// Generic CRUD for playouts and schedule rules
for (const col of ['playouts', 'schedule']) {
  app.get(`/api/${col}`, (req, res) => res.json(store.list(col)));
  app.get(`/api/${col}/:id`, (req, res) => {
    const item = store.get(col, req.params.id);
    item ? res.json(item) : res.status(404).json({ error: 'Not found' });
  });
  app.post(`/api/${col}`, (req, res) => res.json(store.create(col, clean(req.body))));
  app.put(`/api/${col}/:id`, (req, res) => {
    const item = store.update(col, req.params.id, clean(req.body));
    item ? res.json(item) : res.status(404).json({ error: 'Not found' });
  });
  app.delete(`/api/${col}/:id`, (req, res) => {
    const item = store.remove(col, req.params.id);
    if (item && col === 'playouts') {
      // Outputs that sent this playout fall back to the schedule.
      for (const o of store.list('outputs').filter((x) => x.source === req.params.id)) outputs.route(o.id, outputs.SCHEDULE).catch(() => {});
      applyRouting();
    }
    item ? res.json({ ok: true }) : res.status(404).json({ error: 'Not found' });
  });
}

function clean(body) {
  const { id, createdAt, updatedAt, ...rest } = body || {};
  return rest;
}

// Settings and output
app.get('/api/settings', (req, res) => {
  const { passwordHash, ...rest } = store.getSection('settings');
  res.json({ ...rest, port: listenPort, activePlayoutId: schedule.activePlayoutId() });
});
// Server address and port (admins only). A new port is opened before the old one closes, so a
// port that is in use is refused without losing the panel.
app.put('/api/settings/server', auth.requirePerm('settings'), wrap(async (req, res) => {
  const b = req.body || {};
  const serverAddress = String(b.serverAddress || '').trim().replace(/\/+$/, '').slice(0, 200);
  if (serverAddress && !/^[a-z0-9.\-:[\]]+$/i.test(serverAddress.replace(/^https?:\/\//i, ''))) return res.status(400).json({ error: 'Enter a host name or IP address, e.g. 192.168.1.50 or beeldkrant.example.com' });
  const port = Number(b.port);
  if (!Number.isInteger(port) || port < 1 || port > 65535) return res.status(400).json({ error: 'Enter a port between 1 and 65535' });
  const moved = port !== listenPort;
  if (moved) {
    try { await openServer(port); } catch (err) {
      return res.status(400).json({ error: err.code === 'EADDRINUSE' ? `Port ${port} is already in use` : err.code === 'EACCES' ? `Port ${port} needs root; choose a port above 1023` : err.message });
    }
  }
  store.setSection('settings', { serverAddress, port });
  res.json({ ok: true, port, moved });
}));
app.put('/api/settings', (req, res) => {
  const { timezone, locale, panelName } = req.body || {};
  const patch = {};
  if ('defaultPlayoutId' in (req.body || {})) patch.defaultPlayoutId = req.body.defaultPlayoutId || null;
  if (panelName !== undefined) {
    const name = String(panelName).trim().slice(0, 60);
    if (!name) return res.status(400).json({ error: 'The panel name cannot be empty' });
    patch.panelName = name;
  }
  if (locale) {
    try { new Intl.DateTimeFormat(locale); patch.locale = locale; } catch { return res.status(400).json({ error: 'Unknown locale' }); }
  }
  if (timezone) {
    try { new Intl.DateTimeFormat('en', { timeZone: timezone }); patch.timezone = timezone; } catch { return res.status(400).json({ error: 'Unknown timezone' }); }
  }
  if ('transitServer' in (req.body || {})) {
    const url = String(req.body.transitServer || '').trim().replace(/\/+$/, '');
    if (url && !/^https?:\/\/[^\s]+$/.test(url)) return res.status(400).json({ error: 'Enter the public transport server as an http(s) address' });
    patch.transitServer = url;
  }
  store.setSection('settings', patch);
  res.json({ ok: true });
});

app.get('/api/output', (req, res) => res.json(store.getSection('output')));
app.put('/api/output', wrap(async (req, res) => {
  const b = req.body || {};
  const num = (v, min, max, d) => Math.min(max, Math.max(min, Math.round(Number(v)) || d));
  const width = num(b.width, 160, 7680, 1920);
  const height = num(b.height, 120, 4320, 1080);
  const out = store.setSection('output', {
    resolutionMode: b.resolutionMode === 'fixed' ? 'fixed' : 'playout',
    width: width - (width % 2),
    height: height - (height % 2),
    fps: num(b.fps, 1, 60, 25),
    videoBitrate: num(b.videoBitrate, 200, 50000, 4500),
    audioBitrate: num(b.audioBitrate, 32, 320, 128),
    preset: ['ultrafast', 'superfast', 'veryfast', 'faster', 'fast', 'medium'].includes(b.preset) ? b.preset : 'veryfast',
    audio: b.audio !== false,
    encoder: ['libx264', 'h264_vaapi', 'h264_nvenc'].includes(b.encoder) ? b.encoder : 'libx264',
  });
  if (stream.wanted) await stream.restart();
  res.json(out);
}));
// ---------- outputs ----------
// Secrets (stream keys) are replaced by has* flags on the way out and kept when not sent back.
function publicOutput(o) {
  const { streamKey, youtubeStreamId, ...rest } = o;
  return { ...rest, hasStreamKey: !!streamKey };
}
function cleanOutput(b, existing = {}) {
  const type = ['custom', 'youtube', 'facebook'].includes(b.type) ? b.type : existing.type || 'custom';
  const o = {
    name: String(b.name ?? existing.name ?? '').trim().slice(0, 80) || 'Output',
    type,
    mode: type === 'custom' ? undefined : (b.mode === 'key' ? 'key' : 'account'),
    url: type === 'custom' ? String(b.url ?? existing.url ?? '').trim() : undefined,
    streamKey: b.streamKey !== undefined && b.streamKey !== '' ? String(b.streamKey).trim() : existing.streamKey,
    accountId: b.accountId ?? existing.accountId ?? null,
    facebookPageId: b.facebookPageId ?? existing.facebookPageId ?? null,
    title: String(b.title ?? existing.title ?? '').slice(0, 100),
    description: String(b.description ?? existing.description ?? '').slice(0, 5000),
    privacy: ['public', 'unlisted', 'private'].includes(b.privacy) ? b.privacy : existing.privacy || 'unlisted',
    enabled: b.enabled !== undefined ? !!b.enabled : existing.enabled !== undefined ? existing.enabled : true,
    source: cleanSource(b.source !== undefined ? b.source : existing.source),
  };
  if (type === 'custom' && !/^(rtmps?|srt):\/\//i.test(o.url || '')) throw Object.assign(new Error('The destination must start with rtmp://, rtmps:// or srt://'), { status: 400 });
  if (type !== 'custom' && o.mode === 'account' && o.accountId && !store.get('accounts', o.accountId)) throw Object.assign(new Error('Account not found'), { status: 400 });
  // An account change means a new YouTube stream key.
  if (existing.accountId && existing.accountId !== o.accountId) o.youtubeStreamId = null;
  return o;
}
// 'schedule' (what is on air) or the id of a playout.
function cleanSource(v) {
  if (!v || v === outputs.SCHEDULE) return outputs.SCHEDULE;
  if (!store.get('playouts', v)) throw Object.assign(new Error('Playout not found'), { status: 400 });
  return v;
}
// Starts or stops pipelines for the current routing, then (re)starts the output when its source is on air.
// Starting a new pipeline takes a few seconds, so this runs in the background.
function applyRouting(id) {
  if (!stream.wanted) return;
  stream.sync().then(() => {
    const o = id && store.get('outputs', id);
    if (o && o.enabled && outputs.isFeeding(outputs.sourceOf(o)) && !outputs.running[o.id]) return outputs.startOutput(o.id);
    return null;
  }).catch((err) => console.error('Routing:', err.message));
}
app.get('/api/outputs', (req, res) => res.json(store.list('outputs').map(publicOutput)));
app.get('/api/outputs/status', (req, res) => res.json(outputs.status()));
app.post('/api/outputs', wrap(async (req, res) => {
  const o = store.create('outputs', cleanOutput(req.body || {}));
  applyRouting(o.id);
  res.json(publicOutput(o));
}));
app.put('/api/outputs/:id', wrap(async (req, res) => {
  const existing = store.get('outputs', req.params.id);
  if (!existing) return res.status(404).json({ error: 'Not found' });
  const o = store.update('outputs', existing.id, cleanOutput(req.body || {}, existing));
  // Restart a running output so it uses the new settings.
  await outputs.stopOutput(o.id);
  applyRouting(o.id);
  res.json(publicOutput(o));
}));
app.post('/api/outputs/:id/enable', wrap(async (req, res) => {
  if (!store.get('outputs', req.params.id)) return res.status(404).json({ error: 'Not found' });
  await outputs.enable(req.params.id, !!(req.body || {}).enabled);
  applyRouting(req.params.id);
  res.json({ ok: true });
}));
// Routing: which playout an output sends.
app.put('/api/outputs/:id/source', wrap(async (req, res) => {
  if (!store.get('outputs', req.params.id)) return res.status(404).json({ error: 'Not found' });
  await outputs.route(req.params.id, cleanSource((req.body || {}).source));
  applyRouting(req.params.id);
  res.json({ ok: true });
}));
app.delete('/api/outputs/:id', wrap(async (req, res) => {
  await outputs.stopOutput(req.params.id);
  store.remove('outputs', req.params.id);
  applyRouting();
  res.json({ ok: true });
}));

// IP cameras. The password never goes back to the browser; an empty one keeps the saved one.
function publicCamera(c) {
  const { password, ...rest } = c;
  return { ...rest, hasPassword: !!password, address: cameras.redact(cameras.address({ ...c, password: password ? 'x' : '' })), status: cameras.status(c.id) };
}
function cleanCamera(b, existing = {}) {
  const c = {
    name: String(b.name || '').trim().slice(0, 80) || 'Camera',
    protocol: String(b.protocol || 'rtsp').toLowerCase(),
    url: String(b.url || '').trim().slice(0, 1000),
    username: String(b.username || '').trim().slice(0, 200),
    password: b.password ? String(b.password).slice(0, 200) : b.clearPassword ? '' : existing.password || '',
    transport: b.transport === 'udp' ? 'udp' : 'tcp',
    ignoreSsl: !!b.ignoreSsl,
    sdp: String(b.sdp || '').slice(0, 20000),
    fps: Math.min(Math.max(Number(b.fps) || 25, 1), 60),
    maxWidth: Math.min(Math.max(Number(b.maxWidth) || 1920, 160), 3840),
  };
  cameras.check(c);
  return c;
}
app.get('/api/cameras', (req, res) => res.json(store.list('cameras').map(publicCamera)));
app.post('/api/cameras/test', wrap(async (req, res) => {
  const b = req.body || {};
  const existing = (b.id && store.get('cameras', b.id)) || {};
  let cam;
  try { cam = { ...cleanCamera(b, existing), id: existing.id }; } catch (err) { return res.status(400).json({ ok: false, error: err.message }); }
  // A camera that is already being watched answers from its running stream (an RTP port can only be opened once).
  const live = existing.id && cameras.status(existing.id);
  if (live && live.state === 'live' && !b.changed) return res.json({ ok: true, summary: `Live: ${live.width}×${live.height} at ${live.fps} fps (already open)` });
  try { res.json({ ok: true, ...(await cameras.test(cam)) }); } catch (err) { res.json({ ok: false, error: err.message }); }
}));
app.post('/api/cameras', (req, res) => {
  try { res.json(publicCamera(store.create('cameras', cleanCamera(req.body || {})))); } catch (err) { res.status(400).json({ error: err.message }); }
});
app.put('/api/cameras/:id', (req, res) => {
  const existing = store.get('cameras', req.params.id);
  if (!existing) return res.status(404).json({ error: 'Not found' });
  try {
    const c = store.update('cameras', existing.id, cleanCamera(req.body || {}, existing));
    cameras.changed(c.id);
    res.json(publicCamera(c));
  } catch (err) { res.status(400).json({ error: err.message }); }
});
app.delete('/api/cameras/:id', (req, res) => {
  cameras.remove(req.params.id);
  store.remove('cameras', req.params.id) ? res.json({ ok: true }) : res.status(404).json({ error: 'Not found' });
});

// ---------- users, roles, security and SSO (admins only, see the write rules above) ----------
const adminOnlyRead = auth.requireRole('admin');
function cleanUserInput(b, existing = {}) {
  const u = {};
  if (b.username !== undefined) {
    const name = String(b.username).trim().slice(0, 120);
    if (!/^[\w.@+-]{2,120}$/.test(name)) throw new Error('Use 2 or more letters, digits or . _ - @ + for the user name');
    const other = auth.findByName(name);
    if (other && other.id !== existing.id) throw new Error('This user name is already taken');
    u.username = name;
  }
  if (b.displayName !== undefined) u.displayName = String(b.displayName).trim().slice(0, 120);
  if (b.email !== undefined) {
    u.email = String(b.email).trim().toLowerCase().slice(0, 200);
    if (u.email && !/^[^\s@]+@[^\s@]+$/.test(u.email)) throw new Error('Enter a valid e-mail address');
  }
  if (b.role !== undefined) {
    if (!auth.ROLES.includes(b.role)) throw new Error('Unknown role');
    u.role = b.role;
  }
  if (b.permissions !== undefined) u.permissions = Object.fromEntries(Object.keys(auth.PERMISSIONS).map((p) => [p, !!(b.permissions || {})[p]]));
  if (b.authMethod !== undefined) u.authMethod = b.authMethod === 'sso' ? 'sso' : 'password';
  if (b.mfaRequired !== undefined) u.mfaRequired = !!b.mfaRequired;
  if (b.disabled !== undefined) u.disabled = !!b.disabled;
  if (b.ssoOid !== undefined) u.ssoOid = String(b.ssoOid || '').slice(0, 64) || undefined;
  return u;
}
const activeAdmins = (exceptId) => store.list('users').filter((x) => x.role === 'admin' && !x.disabled && x.id !== exceptId);

app.get('/api/users', adminOnlyRead, (req, res) => res.json(store.list('users').map(auth.adminUser)));
app.post('/api/users', (req, res) => {
  const b = req.body || {};
  try {
    const u = cleanUserInput({ role: 'readonly', authMethod: 'password', ...b });
    if (!u.username) throw new Error('Enter a user name');
    if (u.authMethod === 'password') {
      const bad = auth.policyError(b.password);
      if (bad) throw new Error(bad);
    } else if (!u.email && !u.ssoOid) throw new Error('Enter the e-mail address (user principal name) the user signs in with at Microsoft');
    const created = store.create('users', { ...u, mustChangePassword: u.authMethod === 'password' && b.mustChangePassword !== false });
    if (u.authMethod === 'password') auth.setPassword(created.id, b.password, { mustChange: b.mustChangePassword !== false });
    res.json(auth.adminUser(store.get('users', created.id)));
  } catch (err) { res.status(400).json({ error: err.message }); }
});
app.put('/api/users/:id', (req, res) => {
  const existing = store.get('users', req.params.id);
  if (!existing) return res.status(404).json({ error: 'Not found' });
  try {
    const u = cleanUserInput(req.body || {}, existing);
    const losesAdmin = existing.role === 'admin' && ((u.role && u.role !== 'admin') || u.disabled);
    if (losesAdmin && !activeAdmins(existing.id).length) throw new Error('There must be at least one admin who can log in');
    if (existing.id === req.user.id && (u.disabled || (u.role && u.role !== 'admin'))) throw new Error('You cannot take away your own admin role or disable yourself');
    if (u.authMethod === 'password' && existing.authMethod === 'sso' && !existing.passwordHash && !(req.body || {}).password) throw new Error('Set a password for this user');
    if ((req.body || {}).password) {
      const bad = auth.policyError(req.body.password);
      if (bad) throw new Error(bad);
    }
    const updated = store.update('users', existing.id, u);
    if ((req.body || {}).password) auth.setPassword(existing.id, req.body.password, { mustChange: true });
    if (u.authMethod && u.authMethod !== existing.authMethod) auth.endSessions(existing.id);
    if (u.disabled) auth.endSessions(existing.id);
    res.json(auth.adminUser(store.get('users', updated.id)));
  } catch (err) { res.status(400).json({ error: err.message }); }
});
app.post('/api/users/:id/password', (req, res) => {
  const u = store.get('users', req.params.id);
  if (!u) return res.status(404).json({ error: 'Not found' });
  if (u.authMethod === 'sso') return res.status(400).json({ error: 'This user signs in with Microsoft' });
  const bad = auth.policyError((req.body || {}).password);
  if (bad) return res.status(400).json({ error: bad });
  auth.setPassword(u.id, req.body.password, { mustChange: (req.body || {}).mustChange !== false });
  auth.endSessions(u.id);
  res.json({ ok: true });
});
app.post('/api/users/:id/mfa/reset', (req, res) => {
  const u = store.get('users', req.params.id);
  if (!u) return res.status(404).json({ error: 'Not found' });
  store.update('users', u.id, { totpSecret: null, recoveryCodes: [] });
  auth.endSessions(u.id);
  res.json(auth.adminUser(store.get('users', u.id)));
});
app.delete('/api/users/:id', (req, res) => {
  const u = store.get('users', req.params.id);
  if (!u) return res.status(404).json({ error: 'Not found' });
  if (u.id === req.user.id) return res.status(400).json({ error: 'You cannot delete yourself' });
  if (u.role === 'admin' && !activeAdmins(u.id).length) return res.status(400).json({ error: 'There must be at least one admin' });
  auth.endSessions(u.id);
  store.remove('users', u.id);
  res.json({ ok: true });
});

// Your own two-step verification.
app.post('/api/me/mfa/setup', (req, res) => {
  if (req.user.authMethod === 'sso') return res.status(400).json({ error: 'Microsoft handles two-step verification for your account' });
  const secret = auth.newMfaSecret();
  res.json({ secret, otpauth: auth.otpauthUrl(req.user, secret) });
});
app.post('/api/me/mfa/enable', (req, res) => {
  const { secret, code } = req.body || {};
  if (!/^[A-Z2-7]{32}$/.test(String(secret || '')) || !auth.checkTotp(secret, code)) return res.status(400).json({ error: 'That code is not right. Check the time on your phone and try the newest code.' });
  res.json({ recoveryCodes: auth.enableMfa(req.user.id, secret) });
});
app.delete('/api/me/mfa', (req, res) => {
  if (req.user.mfaRequired) return res.status(400).json({ error: 'An admin has made two-step verification required for your account' });
  if (!auth.check((req.body || {}).password || '', req.user.passwordHash)) return res.status(400).json({ error: 'Enter your current password to turn it off' });
  store.update('users', req.user.id, { totpSecret: null, recoveryCodes: [] });
  res.json({ ok: true });
});

app.get('/api/security', adminOnlyRead, (req, res) => res.json({ passwordPolicy: auth.policy(), ssoEnabled: sso.ready() }));
app.put('/api/security', (req, res) => {
  const p = (req.body || {}).passwordPolicy || {};
  const passwordPolicy = {
    minLength: Math.max(6, Math.min(128, Number(p.minLength) || 8)),
    requireSpecial: !!p.requireSpecial,
    requireMixed: !!p.requireMixed,
    expiryDays: Math.max(0, Math.min(3650, Number(p.expiryDays) || 0)),
  };
  store.setSection('security', { passwordPolicy });
  res.json({ passwordPolicy });
});

app.get('/api/sso', adminOnlyRead, (req, res) => res.json({ ...sso.publicConfig(), redirectUri: sso.redirectUri(req) }));
function cleanSso(b) {
  const cur = sso.config();
  const out = {
    enabled: !!b.enabled,
    tenantId: String(b.tenantId ?? cur.tenantId).trim().slice(0, 100),
    clientId: String(b.clientId ?? cur.clientId).trim().slice(0, 100),
    clientSecret: b.clientSecret ? String(b.clientSecret).trim().slice(0, 300) : cur.clientSecret,
    buttonLabel: String(b.buttonLabel ?? cur.buttonLabel).trim().slice(0, 60) || 'Sign in with Microsoft',
    provisioning: !!b.provisioning,
    defaultRole: auth.ROLES.includes(b.defaultRole) ? b.defaultRole : 'readonly',
    defaultPermissions: Object.fromEntries(Object.keys(auth.PERMISSIONS).map((p) => [p, !!(b.defaultPermissions || {})[p]])),
    roleClaims: Object.fromEntries(['admin', 'user', 'readonly'].map((r) => [r, String(((b.roleClaims || {})[r]) ?? '').trim().slice(0, 100)])),
  };
  if (out.tenantId && !/^[\w.-]+$/.test(out.tenantId)) throw new Error('The tenant ID is a GUID or a domain such as contoso.onmicrosoft.com');
  if (out.enabled && !(out.tenantId && out.clientId && out.clientSecret)) throw new Error('Enter the tenant ID, client ID and client secret before turning Microsoft sign-in on');
  return out;
}
app.put('/api/sso', (req, res) => {
  try {
    store.setSection('sso', cleanSso(req.body || {}));
    res.json({ ...sso.publicConfig(), redirectUri: sso.redirectUri(req) });
  } catch (err) { res.status(400).json({ error: err.message }); }
});
app.post('/api/sso/test', wrap(async (req, res) => {
  const b = req.body || {};
  try { res.json(await sso.test({ tenantId: b.tenantId, clientId: b.clientId, ...(b.clientSecret ? { clientSecret: b.clientSecret } : {}) })); } catch (err) { res.json({ ok: false, steps: [{ ok: false, text: err.message }] }); }
}));
app.get('/api/sso/directory', adminOnlyRead, wrap(async (req, res) => {
  try { res.json(await sso.searchDirectory(req.query.q)); } catch (err) { res.status(400).json({ error: err.message }); }
}));

// Linked accounts and the API credentials to link them (admins only).
const adminOnly = auth.requireRole('admin');
app.get('/api/connections', adminOnly, (req, res) => {
  const c = store.getSection('connections');
  res.json({ googleClientId: c.googleClientId, facebookAppId: c.facebookAppId, hasGoogleClientSecret: !!c.googleClientSecret, hasFacebookClientToken: !!c.facebookClientToken });
});
app.put('/api/connections', adminOnly, (req, res) => {
  const b = req.body || {};
  const patch = {};
  for (const k of ['googleClientId', 'googleClientSecret', 'facebookAppId', 'facebookClientToken']) if (b[k] !== undefined) patch[k] = String(b[k]).trim();
  store.setSection('connections', patch);
  res.json({ ok: true });
});
app.get('/api/accounts', (req, res) => res.json(store.list('accounts').map((a) => ({ id: a.id, provider: a.provider, name: a.name }))));
app.delete('/api/accounts/:id', adminOnly, (req, res) => {
  for (const o of store.list('outputs').filter((x) => x.accountId === req.params.id)) store.update('outputs', o.id, { accountId: null, youtubeStreamId: null });
  store.remove('accounts', req.params.id);
  res.json({ ok: true });
});
app.get('/api/accounts/:id/pages', wrap(async (req, res) => {
  const account = store.get('accounts', req.params.id);
  if (!account || account.provider !== 'facebook') return res.status(404).json({ error: 'Not found' });
  res.json((await providers.facebookPages(account)).map(({ id, name }) => ({ id, name })));
}));
app.post('/api/accounts/link', adminOnly, wrap(async (req, res) => res.json(await providers.startLinking((req.body || {}).provider))));
app.get('/api/accounts/link/:id', adminOnly, (req, res) => {
  const st = providers.linkingStatus(req.params.id);
  st ? res.json(st) : res.status(404).json({ error: 'This link request is no longer active' });
});
app.delete('/api/accounts/link/:id', adminOnly, (req, res) => { providers.cancelLinking(req.params.id); res.json({ ok: true }); });


// Stream control
app.get('/api/stream', (req, res) => res.json(stream.status()));
app.get('/api/stream/logs', (req, res) => res.json(stream.logs.slice(-200)));
app.post('/api/stream/start', wrap(async (req, res) => { await stream.start(); res.json(stream.status()); }));
app.post('/api/stream/stop', wrap(async (req, res) => { await stream.stop(); res.json(stream.status()); }));
app.post('/api/stream/restart', wrap(async (req, res) => { await stream.restart(); res.json(stream.status()); }));

// Software updates (admins only)
app.get('/api/system/update', wrap(async (req, res) => res.json({ ...(await updater.status()), prepare })));
app.post('/api/system/update/check', auth.requireRole('admin'), wrap(async (req, res) => res.json(await updater.check())));
// Release channel: stable (GitHub releases) or test (every change on main).
app.put('/api/system/update/channel', auth.requireRole('admin'), wrap(async (req, res) => res.json({ ...(await updater.setChannel((req.body || {}).channel)), prepare })));
// An update can first make a local backup of the application and database (and optionally the
// media); `prepare` reports on that step until the update itself is requested.
let prepare = null;
app.post('/api/system/update', auth.requireRole('admin'), wrap(async (req, res) => {
  const b = req.body || {};
  if (!(await updater.status()).canUpdate) updater.requestUpdate(); // throws with the reason
  if (b.backup) {
    prepare = { state: 'backup' };
    backup.runBackup({ parts: ['app', 'database', ...(b.media ? ['media'] : [])], localOnly: true }, (err) => {
      if (err) { prepare = { state: 'failed', message: `The backup failed (${err.message}), so the update was not started.` }; return; }
      try { updater.requestUpdate(); prepare = null; } catch (e) { prepare = { state: 'failed', message: e.message }; }
    });
  } else {
    prepare = null;
    updater.requestUpdate();
  }
  res.json({ ...(await updater.status()), prepare });
}));

// System info (admins only): build, changelog and the machine it runs on.
app.get('/api/system/info', auth.requireRole('admin'), wrap(async (req, res) => {
  const update = await updater.status();
  res.json({
    ...update,
    builtAt: await updater.commitDate(),
    changelog: updater.changelog(),
    node: process.version,
    uptime: Math.round(process.uptime()),
    dataDir: store.DATA_DIR,
  });
}));

// Backups (backups permission). Secrets of the external location are never sent back to the browser.
const backupAccess = auth.requirePerm('backups');
function publicBackupConfig() {
  const cfg = store.getSection('backup');
  const { password, privateKey, ...remote } = cfg.remote;
  return { ...cfg, remote: { ...remote, hasPassword: !!password, hasPrivateKey: !!privateKey } };
}
// Merges the remote settings from the browser with the stored secrets it did not change.
function backupRemote(input) {
  const stored = store.getSection('backup').remote;
  const r = { ...stored, ...(input || {}) };
  delete r.hasPassword; delete r.hasPrivateKey;
  if (!['none', 'ftp', 'ftps', 'sftp'].includes(r.type)) throw new Error('Unknown backup location type');
  if (input && input.password === undefined) r.password = stored.password;
  if (input && input.privateKey === undefined) r.privateKey = stored.privateKey;
  r.host = String(r.host || '').trim();
  r.port = r.port ? Number(r.port) : null;
  r.path = String(r.path || '/').trim() || '/';
  r.allowSelfSigned = !!r.allowSelfSigned;
  return r;
}
app.get('/api/backups/config', backupAccess, (req, res) => res.json(publicBackupConfig()));
app.put('/api/backups/config', backupAccess, (req, res) => {
  const b = req.body || {};
  const cfg = store.getSection('backup');
  const next = {
    parts: Object.fromEntries(backup.PARTS.map((p) => [p, !!(b.parts || cfg.parts)[p]])),
    layout: b.layout === 'separate' ? 'separate' : 'single',
    keepLocal: Math.max(0, Math.min(365, Number(b.keepLocal ?? cfg.keepLocal) || 0)),
    keepRemote: Math.max(1, Math.min(365, Number(b.keepRemote ?? cfg.keepRemote) || 1)),
    schedule: { ...cfg.schedule, ...(b.schedule || {}) },
    remote: backupRemote(b.remote),
  };
  if (!/^\d{2}:\d{2}$/.test(next.schedule.time || '')) return res.status(400).json({ error: 'Enter the time as HH:MM' });
  next.schedule.days = (next.schedule.days || []).filter((d) => schedule.DAYS.includes(d));
  next.schedule.enabled = !!next.schedule.enabled;
  store.setSection('backup', next);
  res.json(publicBackupConfig());
});
app.post('/api/backups/test', backupAccess, wrap(async (req, res) => {
  const remote = backupRemote((req.body || {}).remote);
  const files = await backup.withRemote(remote, (r) => r.list());
  res.json({ ok: true, backups: files.filter((f) => backup.NAME_RE.test(f.name)).length });
}));
app.get('/api/backups/status', backupAccess, (req, res) => res.json(backup.status()));
app.get('/api/backups', backupAccess, wrap(async (req, res) => res.json(await backup.listSets(req.query.location === 'remote' ? 'remote' : 'local'))));
app.post('/api/backups/run', backupAccess, (req, res) => { backup.runBackup(); res.json(backup.status()); });
app.post('/api/backups/restore', backupAccess, (req, res) => {
  const { location, id, parts } = req.body || {};
  backup.runRestore({ location: location === 'remote' ? 'remote' : 'local', id: String(id || ''), parts: Array.isArray(parts) ? parts : [] });
  res.json(backup.status());
});
app.delete('/api/backups/:id', backupAccess, wrap(async (req, res) => {
  await backup.removeSet(req.query.location === 'remote' ? 'remote' : 'local', req.params.id);
  res.json({ ok: true });
}));
app.get('/api/backups/download/:name', backupAccess, (req, res) => {
  if (!backup.NAME_RE.test(req.params.name)) return res.status(404).json({ error: 'Not found' });
  res.download(path.join(backup.BACKUP_DIR, req.params.name));
});

// ---------- admin UI ----------
app.use('/admin', express.static(path.join(PUBLIC, 'admin')));
app.get('/', (req, res) => res.redirect(`${BASE}/admin/`));

app.use((err, req, res, next) => {
  console.error(err);
  res.status(err.status || 400).json({ error: err.message || 'Something went wrong' });
});

// ---------- base path ----------
// With a base path the app is mounted under it; outside it only /healthz answers. The reverse proxy
// forwards the full path, so nothing needs rewriting. <base path> without the slash goes to <base path>/.
let root = app;
if (BASE) {
  root = express();
  root.disable('x-powered-by');
  root.get('/healthz', healthz);
  root.get(BASE, (req, res, next) => (req.path === BASE ? res.redirect(`${BASE}/${req.originalUrl.slice(BASE.length)}`) : next()));
  root.use(BASE, app);
}

// ---------- listening ----------
let server = null;
let listenPort = null;
// Listens on `port`; when already listening elsewhere, the old port closes once the new one is open.
function openServer(port) {
  return new Promise((resolve, reject) => {
    const next = http.createServer(root);
    next.once('error', reject);
    next.listen(port, HOST, () => {
      next.removeListener('error', reject);
      const old = server;
      server = next;
      listenPort = port;
      stream.port = port;
      console.log(`Beeldkrant ${pkg.version} admin panel on http://${HOST}:${port}${BASE}/admin/`);
      if (old) {
        // Give the browser that asked for the change its answer before closing the old port.
        setTimeout(() => { old.close(); if (old.closeAllConnections) old.closeAllConnections(); }, 1500);
        if (stream.wanted) stream.restart().catch((err) => console.error('Could not restart the stream on the new port:', err.message));
      }
      resolve(next);
    });
  });
}

app.get('/api/stats', (req, res) => res.json(stats.current()));

openServer(PORT).catch((err) => { console.error(`Cannot listen on port ${PORT}:`, err.message); process.exit(1); }).then(() => {
  updater.start();
  backup.start();
  stats.start(stream);
  if (store.getSection('output').enabled) {
    stream.start().catch((err) => console.error('Could not resume stream:', err.message));
  }
});

for (const sig of ['SIGINT', 'SIGTERM']) {
  process.on(sig, async () => {
    stream.wanted = false;
    cameras.stopAll();
    await outputs.stopAll();
    await Promise.all(Object.values(stream.pipelines).map((p) => { p.wanted = false; return p.killAll(); }));
    process.exit(0);
  });
}
