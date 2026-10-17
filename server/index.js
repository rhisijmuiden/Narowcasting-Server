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
const schedule = require('./schedule');
const stream = require('./stream');
const updater = require('./updater');
const backup = require('./backup');
const stats = require('./stats');
const outputs = require('./outputs');
const providers = require('./providers');
const http = require('http');
const pkg = require('../package.json');

// The port set under Settings → Application wins over the PORT the service starts with.
const PORT = Number(store.getSection('settings').port) || Number(process.env.PORT) || 8080;
const HOST = process.env.HOST || '0.0.0.0';
const PUBLIC = path.join(__dirname, '..', 'public');
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

function isLocal(req) {
  const a = req.socket.remoteAddress || '';
  return a === '127.0.0.1' || a === '::1' || a === '::ffff:127.0.0.1';
}

// The renderer (local Chromium) and logged-in admins (preview) may read player data.
function playerAccess(req, res, next) {
  if (isLocal(req) || auth.isAuthenticated(req)) return next();
  res.status(401).json({ error: 'Not allowed' });
}

function mediaUrl(m) {
  if (m.external) return m.url;
  return `/media/${encodeURIComponent(m.filename)}`;
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

// ---------- auth ----------
auth.bootstrap();

app.post('/api/login', (req, res) => {
  const { username, password } = req.body || {};
  const user = auth.verify(username || '', password || '');
  if (!user) return res.status(401).json({ error: 'Wrong username or password' });
  auth.login(res, user);
  res.json({ ok: true, user: auth.publicUser(user) });
});
app.post('/api/logout', (req, res) => { auth.logout(req, res); res.json({ ok: true }); });
app.get('/api/me', (req, res) => {
  res.json({ user: auth.publicUser(auth.currentUser(req)), panelName: store.getSection('settings').panelName, version: pkg.version });
});
// Each user picks their own admin theme.
app.put('/api/me/theme', (req, res) => {
  const user = auth.currentUser(req);
  if (!user) return res.status(401).json({ error: 'Not logged in' });
  const theme = ['light', 'dark', 'system'].includes((req.body || {}).theme) ? req.body.theme : 'system';
  store.update('users', user.id, { theme });
  res.json({ theme });
});
// Works while the one-time password is still active, so it sits before requireAuth.
app.post('/api/password', (req, res) => {
  const user = auth.currentUser(req);
  if (!user) return res.status(401).json({ error: 'Not logged in' });
  const { current, password } = req.body || {};
  if (!auth.check(current || '', user.passwordHash)) return res.status(400).json({ error: 'Current password is wrong' });
  if (!password || String(password).length < 8) return res.status(400).json({ error: 'Use at least 8 characters' });
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
  res.json(await feeds.getItems(feed));
}));

app.get('/api/player/weather', playerAccess, wrap(async (req, res) => {
  res.json(await weather.getWeather(req.query.lat || 52.37, req.query.lon || 4.9));
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

app.use('/media', playerAccess, express.static(store.MEDIA_DIR, { maxAge: '1h', fallthrough: false }));
app.use('/player', express.static(path.join(PUBLIC, 'player')));

// ---------- everything below needs a login ----------
app.use('/api', auth.requireAuth);

// Viewers may look but not change anything.
app.use('/api', (req, res, next) => (req.method === 'GET' ? next() : auth.requireRole('editor')(req, res, next)));
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
  res.json(store.list('media').map((m) => ({ ...m, url: mediaUrl(m), thumbUrl: m.thumb ? `/media/${encodeURIComponent(m.thumb)}` : m.type === 'image' ? mediaUrl(m) : null })));
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
  res.json(await feeds.getItems(feed, { force: req.query.force === '1' }));
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

// Generic CRUD for feeds, playouts and schedule rules
for (const col of ['feeds', 'playouts', 'schedule']) {
  app.get(`/api/${col}`, (req, res) => res.json(store.list(col)));
  app.get(`/api/${col}/:id`, (req, res) => {
    const item = store.get(col, req.params.id);
    item ? res.json(item) : res.status(404).json({ error: 'Not found' });
  });
  app.post(`/api/${col}`, (req, res) => res.json(store.create(col, clean(req.body))));
  app.put(`/api/${col}/:id`, (req, res) => {
    const item = store.update(col, req.params.id, clean(req.body));
    if (col === 'feeds') feeds.forget(req.params.id);
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
app.put('/api/settings/server', auth.requireRole('admin'), wrap(async (req, res) => {
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

// Backups (admins only). Secrets of the external location are never sent back to the browser.
const admin = auth.requireRole('admin');
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
app.get('/api/backups/config', admin, (req, res) => res.json(publicBackupConfig()));
app.put('/api/backups/config', admin, (req, res) => {
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
app.post('/api/backups/test', admin, wrap(async (req, res) => {
  const remote = backupRemote((req.body || {}).remote);
  const files = await backup.withRemote(remote, (r) => r.list());
  res.json({ ok: true, backups: files.filter((f) => backup.NAME_RE.test(f.name)).length });
}));
app.get('/api/backups/status', admin, (req, res) => res.json(backup.status()));
app.get('/api/backups', admin, wrap(async (req, res) => res.json(await backup.listSets(req.query.location === 'remote' ? 'remote' : 'local'))));
app.post('/api/backups/run', admin, (req, res) => { backup.runBackup(); res.json(backup.status()); });
app.post('/api/backups/restore', admin, (req, res) => {
  const { location, id, parts } = req.body || {};
  backup.runRestore({ location: location === 'remote' ? 'remote' : 'local', id: String(id || ''), parts: Array.isArray(parts) ? parts : [] });
  res.json(backup.status());
});
app.delete('/api/backups/:id', admin, wrap(async (req, res) => {
  await backup.removeSet(req.query.location === 'remote' ? 'remote' : 'local', req.params.id);
  res.json({ ok: true });
}));
app.get('/api/backups/download/:name', admin, (req, res) => {
  if (!backup.NAME_RE.test(req.params.name)) return res.status(404).json({ error: 'Not found' });
  res.download(path.join(backup.BACKUP_DIR, req.params.name));
});

// ---------- admin UI ----------
app.use('/admin', express.static(path.join(PUBLIC, 'admin')));
app.get('/', (req, res) => res.redirect('/admin/'));

app.use((err, req, res, next) => {
  console.error(err);
  res.status(err.status || 400).json({ error: err.message || 'Something went wrong' });
});

// ---------- listening ----------
let server = null;
let listenPort = null;
// Listens on `port`; when already listening elsewhere, the old port closes once the new one is open.
function openServer(port) {
  return new Promise((resolve, reject) => {
    const next = http.createServer(app);
    next.once('error', reject);
    next.listen(port, HOST, () => {
      next.removeListener('error', reject);
      const old = server;
      server = next;
      listenPort = port;
      stream.port = port;
      console.log(`Beeldkrant ${pkg.version} admin panel on http://${HOST}:${port}/admin/`);
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
    await outputs.stopAll();
    await Promise.all(Object.values(stream.pipelines).map((p) => { p.wanted = false; return p.killAll(); }));
    process.exit(0);
  });
}
