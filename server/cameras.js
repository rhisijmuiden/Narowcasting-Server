'use strict';
// IP cameras: RTSP, RTMP(S) and RTP streams pulled with ffmpeg.
//
//   camera -> ffmpeg (one per camera, only while someone watches) -> JPEG frames -> every viewer
//
// Viewers are the preview in the admin panel and camera elements in scenes on air; they all share
// one ffmpeg, which reconnects when the camera drops and stops shortly after the last viewer leaves.
const fs = require('fs');
const path = require('path');
const tls = require('tls');
const { spawn, execFile } = require('child_process');
const store = require('./store');

const PROTOCOLS = ['rtsp', 'rtmp', 'rtmps', 'rtp'];
const DEFAULT_PORT = { rtsp: 554, rtmp: 1935, rtmps: 443 };
const IDLE_STOP_MS = 10000;
const STALL_MS = 15000;
const MAX_LOG = 100;
const SDP_DIR = path.join(store.DATA_DIR, 'cameras');

// The address with the user name and password filled in.
function address(cam) {
  const url = String(cam.url || '').trim();
  if (!cam.username || cam.protocol === 'rtp') return url;
  try {
    const u = new URL(url);
    u.username = encodeURIComponent(cam.username);
    u.password = encodeURIComponent(cam.password || '');
    return u.toString();
  } catch { return url; }
}

function redact(url) {
  return String(url || '').replace(/\/\/[^@/]+@/, '//***@');
}

function check(cam) {
  if (!PROTOCOLS.includes(cam.protocol)) throw new Error('Choose RTSP, RTMP, RTMPS or RTP');
  const url = String(cam.url || '').trim();
  if (!url) throw new Error('Enter the address of the camera');
  if (!url.toLowerCase().startsWith(`${cam.protocol}://`)) throw new Error(`The address should start with ${cam.protocol}://`);
}

// ffmpeg/ffprobe input options and the input itself.
function input(cam) {
  check(cam);
  const args = [];
  if (cam.protocol === 'rtsp') args.push('-rtsp_transport', cam.transport === 'udp' ? 'udp' : 'tcp', '-timeout', '10000000');
  if (cam.protocol === 'rtmp' || cam.protocol === 'rtmps') args.push('-rw_timeout', '10000000');
  if (cam.protocol === 'rtp') {
    args.push('-protocol_whitelist', 'file,udp,rtp');
    if (String(cam.sdp || '').trim()) {
      // Without an SDP description ffmpeg only knows the fixed RTP payload types (such as MPEG-TS).
      fs.mkdirSync(SDP_DIR, { recursive: true });
      const file = path.join(SDP_DIR, `${cam.id || 'test'}.sdp`);
      fs.writeFileSync(file, String(cam.sdp).trim() + '\n');
      return [...args, '-i', file];
    }
  }
  return [...args, '-i', address(cam)];
}

// RTMPS: ffmpeg does not check certificates, so we do, unless SSL errors are to be ignored.
function checkCertificate(cam) {
  if (cam.protocol !== 'rtmps' || cam.ignoreSsl) return Promise.resolve();
  let u;
  try { u = new URL(cam.url); } catch { return Promise.reject(new Error('This address is not valid')); }
  return new Promise((resolve, reject) => {
    const socket = tls.connect({ host: u.hostname, port: Number(u.port) || DEFAULT_PORT.rtmps, servername: u.hostname, rejectUnauthorized: true, timeout: 8000 }, () => { socket.end(); resolve(); });
    socket.on('timeout', () => { socket.destroy(); reject(new Error(`No answer from ${u.hostname}`)); });
    socket.on('error', (err) => {
      const ssl = /certificate|self[- ]signed|CERT|unable to verify|hostname/i.test(`${err.code} ${err.message}`);
      reject(new Error(ssl ? `SSL error: ${err.message}. Tick "Ignore SSL errors" to connect anyway.` : `Could not connect: ${err.message}`));
    });
  });
}

// Short description of what ffprobe found, e.g. "H264 1920×1080 25 fps · AAC audio".
function describe(info) {
  const parts = [];
  if (info.video) parts.push(`${info.video.codec.toUpperCase()} ${info.video.width}×${info.video.height}${info.video.fps ? ` ${info.video.fps} fps` : ''}`);
  if (info.audio) parts.push(`${info.audio.codec.toUpperCase()} audio`);
  return parts.join(' · ');
}

const rate = (r) => { const [a, b] = String(r || '').split('/').map(Number); return a && b ? Math.round((a / b) * 100) / 100 : null; };

// Connects once and reports what the camera sends.
async function test(cam) {
  const started = Date.now();
  await checkCertificate(cam);
  const args = ['-v', 'error', '-analyzeduration', '5000000', '-probesize', '5000000',
    '-show_entries', 'stream=codec_type,codec_name,width,height,avg_frame_rate,r_frame_rate,sample_rate,channels', '-of', 'json', ...input(cam)];
  const out = await new Promise((resolve, reject) => {
    execFile('ffprobe', args, { timeout: 25000 }, (err, stdout, stderr) => {
      if (err) {
        const msg = String(stderr || '').trim().split('\n').filter(Boolean).pop() || (err.killed ? 'No answer from the camera' : err.message);
        return reject(new Error(cleanError(msg)));
      }
      resolve(stdout);
    });
  });
  const streams = (JSON.parse(out).streams || []);
  const v = streams.find((s) => s.codec_type === 'video');
  const a = streams.find((s) => s.codec_type === 'audio');
  if (!v) throw new Error('Connected, but the camera sends no video');
  const info = {
    video: { codec: v.codec_name, width: v.width, height: v.height, fps: rate(v.avg_frame_rate) || rate(v.r_frame_rate) },
    audio: a ? { codec: a.codec_name, sampleRate: Number(a.sample_rate) || null, channels: a.channels || null } : null,
    ms: Date.now() - started,
  };
  return { ...info, summary: describe(info) };
}

function cleanError(msg) {
  const m = String(msg).replace(/^\[[^\]]+\]\s*/, '').replace(/^.*?:\s(?=[A-Z])/, '');
  if (/Connection refused/i.test(m)) return 'Connection refused: is the address and port right?';
  if (/401|Unauthorized/i.test(m)) return 'The camera refused the user name or password (401)';
  if (/404|Not Found/i.test(m)) return 'The camera does not know this path (404)';
  if (/timed out|timeout/i.test(m)) return 'No answer from the camera (timed out)';
  return m;
}

class Live {
  constructor(id) {
    this.id = id;
    this.clients = new Set(); // HTTP responses that get every frame
    this.waiting = []; // callbacks waiting for one frame
    this.frame = null;
    this.frameAt = 0;
    this.frames = []; // timestamps of the last second, for the frame rate
    this.state = 'idle';
    this.error = null;
    this.log = [];
    this.delay = 2000;
  }

  get viewers() { return this.clients.size + this.waiting.length; }

  touch() {
    clearTimeout(this.idleTimer);
    this.idleTimer = null;
    if (!this.proc && !this.retry) this.start();
  }

  start() {
    const cam = store.get('cameras', this.id);
    if (!cam) return;
    this.retry = null;
    this.state = 'connecting';
    this.started = Date.now();
    checkCertificate(cam).then(() => this.spawn(cam), (err) => this.failed(err.message));
  }

  spawn(cam) {
    if (!this.viewers) { this.state = 'idle'; return; }
    let args;
    try { args = input(cam); } catch (err) { return this.failed(err.message); }
    const fps = Math.min(Math.max(Number(cam.fps) || 25, 1), 60);
    const width = Math.min(Math.max(Number(cam.maxWidth) || 1920, 160), 3840);
    const full = ['-hide_banner', '-loglevel', 'error', '-fflags', 'nobuffer', '-flags', 'low_delay', ...args,
      '-an', '-vf', `fps=${fps},scale='min(${width},iw)':-2`, '-c:v', 'mjpeg', '-q:v', String(Number(cam.quality) || 4), '-f', 'mpjpeg', 'pipe:1'];
    this.addLog(`connecting to ${redact(cam.protocol === 'rtp' && cam.sdp ? `${cam.url} (SDP)` : address(cam))}`);
    const p = spawn('ffmpeg', full, { stdio: ['ignore', 'pipe', 'pipe'] });
    this.proc = p;
    let buf = Buffer.alloc(0);
    p.stdout.on('data', (d) => {
      buf = buf.length ? Buffer.concat([buf, d]) : d;
      // mpjpeg: "--ffmpeg\r\nContent-type: image/jpeg\r\nContent-length: N\r\n\r\n<jpeg>\r\n"
      for (;;) {
        const head = buf.indexOf('\r\n\r\n');
        if (head < 0) break;
        const m = /Content-length:\s*(\d+)/i.exec(buf.subarray(0, head).toString('latin1'));
        if (!m) { buf = buf.subarray(head + 4); continue; }
        const len = Number(m[1]);
        if (buf.length < head + 4 + len) break;
        this.onFrame(Buffer.from(buf.subarray(head + 4, head + 4 + len)));
        buf = buf.subarray(head + 4 + len);
      }
      if (buf.length > 30e6) buf = Buffer.alloc(0);
    });
    p.stderr.on('data', (d) => String(d).split(/\r?\n/).filter((l) => l.trim()).forEach((l) => { this.lastError = cleanError(l); this.addLog(l); }));
    p.on('error', (err) => this.addLog(`could not start ffmpeg: ${err.message}`));
    this.watchdog = setInterval(() => {
      if (Date.now() - Math.max(this.frameAt, this.started) > STALL_MS) { this.addLog('no pictures for 15 s, reconnecting'); this.lastError = 'No pictures from the camera for 15 s'; try { p.kill('SIGKILL'); } catch { /* gone */ } }
    }, 3000);
    p.on('exit', (code, signal) => {
      clearInterval(this.watchdog);
      if (this.proc !== p) return;
      this.proc = null;
      if (this.stopping) { this.stopping = false; this.state = 'idle'; return; }
      this.failed(this.lastError || `the stream stopped (${signal || code})`);
    });
  }

  failed(message) {
    this.state = 'error';
    this.error = message;
    this.addLog(`error: ${message}`);
    // Keep trying while someone is watching.
    if (this.viewers) {
      this.retry = setTimeout(() => { this.retry = null; if (this.viewers) this.start(); else this.state = 'idle'; }, this.delay);
      this.delay = Math.min(this.delay * 2, 30000);
    }
  }

  onFrame(jpeg) {
    const now = Date.now();
    if (this.state !== 'live') { this.state = 'live'; this.error = null; this.lastError = null; this.delay = 2000; this.addLog('receiving pictures'); }
    this.frame = jpeg;
    this.frameAt = now;
    this.frames.push(now);
    while (this.frames.length && now - this.frames[0] > 1000) this.frames.shift();
    if (!this.size) this.size = jpegSize(jpeg);
    for (const res of this.clients) {
      if (res.writableLength > jpeg.length * 2) continue; // slow viewer: skip a frame
      res.write(`--frame\r\nContent-Type: image/jpeg\r\nContent-Length: ${jpeg.length}\r\n\r\n`);
      res.write(jpeg);
      res.write('\r\n');
    }
    const waiting = this.waiting.splice(0);
    waiting.forEach((fn) => fn(jpeg));
    if (!this.viewers) this.idle();
  }

  idle() {
    if (this.idleTimer) return;
    this.idleTimer = setTimeout(() => { this.idleTimer = null; if (!this.viewers) this.stop(); }, IDLE_STOP_MS);
  }

  stop() {
    clearTimeout(this.idleTimer);
    this.idleTimer = null;
    clearTimeout(this.retry);
    this.retry = null;
    if (this.proc) { this.stopping = true; try { this.proc.kill('SIGTERM'); } catch { /* gone */ } } else this.state = 'idle';
    this.frames = [];
  }

  addLog(line) {
    this.log.push(`${new Date().toLocaleTimeString('en-GB')}  ${line}`);
    if (this.log.length > MAX_LOG) this.log.shift();
  }

  status() {
    const fresh = Date.now() - this.frameAt < 3000;
    return {
      state: this.state,
      error: this.error,
      viewers: this.viewers,
      fps: fresh ? this.frames.length : 0,
      width: this.size ? this.size.width : null,
      height: this.size ? this.size.height : null,
      lastFrameAt: this.frameAt ? new Date(this.frameAt).toISOString() : null,
      log: this.log.slice(-30),
    };
  }
}

// Width and height from a JPEG's start-of-frame marker.
function jpegSize(b) {
  let i = 2;
  while (i + 9 < b.length) {
    if (b[i] !== 0xff) return null;
    const marker = b[i + 1];
    const len = b.readUInt16BE(i + 2);
    if (marker >= 0xc0 && marker <= 0xc3) return { height: b.readUInt16BE(i + 5), width: b.readUInt16BE(i + 7) };
    i += 2 + len;
  }
  return null;
}

class CameraManager {
  constructor() { this.live = {}; }

  get(id) {
    if (!this.live[id]) this.live[id] = new Live(id);
    return this.live[id];
  }

  // Streams the camera as MJPEG (multipart/x-mixed-replace) until the viewer goes away.
  watch(id, req, res) {
    const l = this.get(id);
    res.writeHead(200, { 'Content-Type': 'multipart/x-mixed-replace; boundary=frame', 'Cache-Control': 'no-cache, no-store', Connection: 'close', Pragma: 'no-cache' });
    l.clients.add(res);
    if (l.frame && Date.now() - l.frameAt < 2000) {
      res.write(`--frame\r\nContent-Type: image/jpeg\r\nContent-Length: ${l.frame.length}\r\n\r\n`);
      res.write(l.frame);
      res.write('\r\n');
    }
    l.touch();
    req.on('close', () => { l.clients.delete(res); if (!l.viewers) l.idle(); });
  }

  // One recent picture; starts the camera for a moment when nobody is watching.
  snapshot(id, timeoutMs = 20000) {
    const l = this.get(id);
    if (l.frame && Date.now() - l.frameAt < 2000) return Promise.resolve(l.frame);
    return new Promise((resolve, reject) => {
      let done = false;
      const fn = (jpeg) => { done = true; clearTimeout(t); resolve(jpeg); };
      const t = setTimeout(() => {
        if (done) return;
        l.waiting = l.waiting.filter((x) => x !== fn);
        if (!l.viewers) l.idle();
        reject(new Error(l.error || 'No picture from the camera'));
      }, timeoutMs);
      l.waiting.push(fn);
      l.touch();
    });
  }

  // Restarts a camera after its settings changed.
  changed(id) {
    const l = this.live[id];
    if (!l) return;
    const viewers = l.viewers;
    l.stop();
    l.size = null;
    l.delay = 2000;
    if (viewers) setTimeout(() => l.touch(), 500);
  }

  remove(id) {
    const l = this.live[id];
    if (l) { l.stop(); for (const res of l.clients) res.end(); }
    delete this.live[id];
    try { fs.unlinkSync(path.join(SDP_DIR, `${id}.sdp`)); } catch { /* none */ }
  }

  status(id) {
    return this.live[id] ? this.live[id].status() : { state: 'idle', error: null, viewers: 0, fps: 0, width: null, height: null, lastFrameAt: null, log: [] };
  }

  stopAll() {
    for (const l of Object.values(this.live)) l.stop();
  }
}

module.exports = new CameraManager();
module.exports.test = test;
module.exports.check = check;
module.exports.redact = redact;
module.exports.address = address;
module.exports.PROTOCOLS = PROTOCOLS;
