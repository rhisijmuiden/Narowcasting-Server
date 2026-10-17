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
const pkg = require('../package.json');

const PORT = Number(process.env.PORT) || 8080;
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
  res.json({ ...rest, activePlayoutId: schedule.activePlayoutId() });
});
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
  const url = String(b.url || '').trim();
  if (url && !/^(rtmps?|srt):\/\//i.test(url)) return res.status(400).json({ error: 'The destination must start with rtmp://, rtmps:// or srt://' });
  const out = store.setSection('output', {
    url,
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

// Stream control
app.get('/api/stream', (req, res) => res.json(stream.status()));
app.get('/api/stream/logs', (req, res) => res.json(stream.logs.slice(-200)));
app.post('/api/stream/start', wrap(async (req, res) => { await stream.start(); res.json(stream.status()); }));
app.post('/api/stream/stop', wrap(async (req, res) => { await stream.stop(); res.json(stream.status()); }));
app.post('/api/stream/restart', wrap(async (req, res) => { await stream.restart(); res.json(stream.status()); }));

// Software updates (admins only)
app.get('/api/system/update', wrap(async (req, res) => res.json(await updater.status())));
app.post('/api/system/update/check', auth.requireRole('admin'), wrap(async (req, res) => res.json(await updater.check())));
app.post('/api/system/update', auth.requireRole('admin'), wrap(async (req, res) => {
  updater.requestUpdate();
  res.json(await updater.status());
}));

// ---------- admin UI ----------
app.use('/admin', express.static(path.join(PUBLIC, 'admin')));
app.get('/', (req, res) => res.redirect('/admin/'));

app.use((err, req, res, next) => {
  console.error(err);
  res.status(err.status || 400).json({ error: err.message || 'Something went wrong' });
});

app.listen(PORT, HOST, () => {
  console.log(`Beeldkrant ${pkg.version} admin panel on http://${HOST}:${PORT}/admin/`);
  updater.start();
  if (store.getSection('output').enabled) {
    stream.start().catch((err) => console.error('Could not resume stream:', err.message));
  }
});

for (const sig of ['SIGINT', 'SIGTERM']) {
  process.on(sig, async () => {
    stream.wanted = false;
    await stream.killAll();
    process.exit(0);
  });
}
