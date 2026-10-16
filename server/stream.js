'use strict';
// Renders the player page in Chromium on a virtual X display and pushes it out with ffmpeg.
//
//   Xvfb (:display) <- Chromium (kiosk, /player) ; PulseAudio null sink <- Chromium audio
//   ffmpeg x11grab + pulse monitor -> H.264/AAC -> FLV over RTMP, or MPEG-TS over SRT
const { spawn, execFileSync } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { EventEmitter } = require('events');
const store = require('./store');
const schedule = require('./schedule');

const DISPLAY = process.env.BK_DISPLAY || ':99';
const PORT = Number(process.env.PORT) || 8080;
const RUNTIME_DIR = path.join(os.tmpdir(), `beeldkrant-${process.getuid ? process.getuid() : 'run'}`);
const PULSE_SOCKET = path.join(RUNTIME_DIR, 'pulse.sock');
const MAX_LOG = 400;
const VAAPI_DEVICE = process.env.VAAPI_DEVICE || '/dev/dri/renderD128';

function which(cmds) {
  for (const cmd of cmds) {
    if (!cmd) continue;
    if (cmd.includes('/')) { if (fs.existsSync(cmd)) return cmd; continue; }
    try { return execFileSync('sh', ['-c', `command -v ${cmd}`]).toString().trim() || null; } catch { /* not found */ }
  }
  return null;
}

class StreamManager extends EventEmitter {
  constructor() {
    super();
    this.procs = {};
    this.logs = [];
    this.state = 'stopped'; // stopped | starting | live | restarting | error
    this.startedAt = null;
    this.lastError = null;
    this.stats = {};
    this.wanted = false;
    this.restartTimer = null;
    this.restartDelay = 2000;
  }

  log(source, line) {
    const text = String(line).trimEnd();
    if (!text) return;
    for (const l of text.split(/\r?\n|\r/)) {
      if (source === 'chromium' && /dbus|object_proxy|Fontconfig|viz_main_impl|gl_factory/.test(l)) continue;
      if (source === 'ffmpeg' && l.startsWith('frame=')) { this.parseStats(l); continue; }
      this.logs.push({ t: new Date().toISOString(), source, line: l });
    }
    if (this.logs.length > MAX_LOG) this.logs.splice(0, this.logs.length - MAX_LOG);
  }

  parseStats(line) {
    const grab = (k) => { const m = new RegExp(`${k}=\\s*([^\\s]+)`).exec(line); return m ? m[1] : null; };
    this.stats = { frame: grab('frame'), fps: grab('fps'), bitrate: grab('bitrate'), speed: grab('speed'), time: grab('time') };
    if (this.state === 'starting' || this.state === 'restarting') { this.state = 'live'; this.restartDelay = 2000; }
  }

  status() {
    const output = store.getSection('output');
    return {
      state: this.state,
      wanted: this.wanted,
      startedAt: this.startedAt,
      lastError: this.lastError,
      stats: this.stats,
      resolution: this.size ? `${this.size.outW}x${this.size.outH}@${output.fps}` : null,
      destination: redact(output.url),
      tools: this.tools(),
    };
  }

  tools() {
    return {
      xvfb: which(['Xvfb']),
      chromium: which([process.env.CHROMIUM_PATH, 'chromium', 'chromium-browser', 'google-chrome']),
      ffmpeg: which([process.env.FFMPEG_PATH, 'ffmpeg']),
      pulseaudio: which(['pulseaudio']),
      vaapi: fs.existsSync(VAAPI_DEVICE),
      nvenc: fs.existsSync('/dev/nvidia0'),
    };
  }

  spawnProc(name, cmd, args, env) {
    this.log('system', `starting ${name}: ${cmd} ${args.map(a => (name === 'ffmpeg' && /^(rtmps?|srt):/.test(a) ? redact(a) : a)).join(' ')}`);
    const p = spawn(cmd, args, { env: { ...process.env, ...env }, stdio: ['ignore', 'pipe', 'pipe'] });
    p.stdout.on('data', (d) => this.log(name, d));
    p.stderr.on('data', (d) => this.log(name, d));
    p.on('error', (err) => this.log(name, `failed to start: ${err.message}`));
    p.on('exit', (code, signal) => {
      this.log('system', `${name} exited (${signal || code})`);
      if (this.procs[name] === p) delete this.procs[name];
      if (!this.wanted || this.stopping) return;
      // A dropped connection only needs a new encoder; anything else rebuilds the whole pipeline.
      if (name === 'ffmpeg' && this.procs.xvfb && this.procs.chromium) this.scheduleEncoderRestart();
      else this.scheduleRestart(`${name} exited`);
    });
    this.procs[name] = p;
    return p;
  }

  async start() {
    const output = store.getSection('output');
    if (!output.url) throw new Error('Set a stream destination first');
    const tools = this.tools();
    for (const t of ['xvfb', 'chromium', 'ffmpeg']) if (!tools[t]) throw new Error(`${t} is not installed`);
    this.wanted = true;
    store.setSection('output', { enabled: true });
    this.watchResolution();
    await this.launch();
  }

  async launch() {
    clearTimeout(this.restartTimer);
    await this.killAll();
    const output = store.getSection('output');
    const tools = this.tools();
    const size = this.computeSize();
    this.size = size;
    const { w, h } = size;
    const fps = Number(output.fps) || 25;
    this.state = this.startedAt ? 'restarting' : 'starting';
    this.startedAt = this.startedAt || new Date().toISOString();
    this.lastError = null;
    this.stats = {};
    fs.mkdirSync(RUNTIME_DIR, { recursive: true, mode: 0o700 });

    // 1. Virtual display
    const lock = `/tmp/.X${DISPLAY.replace(':', '')}-lock`;
    try { fs.unlinkSync(lock); } catch { /* none */ }
    this.spawnProc('xvfb', tools.xvfb, [DISPLAY, '-screen', '0', `${w}x${h}x24`, '-nolisten', 'tcp', '-ac']);
    await waitFor(() => fs.existsSync(lock), 5000);

    // 2. Audio sink (optional: without PulseAudio a silent track is sent)
    const useAudio = output.audio !== false && tools.pulseaudio;
    const audioEnv = {};
    if (useAudio) {
      try { fs.unlinkSync(PULSE_SOCKET); } catch { /* none */ }
      this.spawnProc('pulseaudio', tools.pulseaudio, [
        '-n', '--daemonize=no', '--exit-idle-time=-1', '--disallow-exit', '--use-pid-file=no', '--system=false',
        '--load=module-null-sink sink_name=beeldkrant sink_properties=device.description=Beeldkrant',
        `--load=module-native-protocol-unix socket=${PULSE_SOCKET} auth-anonymous=1`,
        '--load=module-always-sink',
      ], { XDG_RUNTIME_DIR: RUNTIME_DIR, HOME: RUNTIME_DIR });
      await waitFor(() => fs.existsSync(PULSE_SOCKET), 5000);
      audioEnv.PULSE_SERVER = `unix:${PULSE_SOCKET}`;
      audioEnv.PULSE_SINK = 'beeldkrant';
    }

    // 3. Browser showing the player
    const profile = path.join(RUNTIME_DIR, 'chromium-profile');
    this.spawnProc('chromium', tools.chromium, [
      '--no-sandbox', '--no-first-run', '--no-default-browser-check', '--disable-infobars', '--disable-session-crashed-bubble',
      '--disable-features=Translate,MediaRouter', '--autoplay-policy=no-user-gesture-required', '--disable-dev-shm-usage',
      '--hide-scrollbars', '--force-device-scale-factor=1', '--kiosk', `--window-position=0,0`, `--window-size=${w},${h}`,
      `--user-data-dir=${profile}`, '--password-store=basic', '--use-angle=swiftshader', '--enable-unsafe-swiftshader',
      `--app=http://127.0.0.1:${PORT}/player/?output=1`,
    ], { DISPLAY, ...audioEnv });
    await sleep(Number(process.env.BK_BROWSER_WARMUP_MS) || 4000);

    this.audioEnv = audioEnv;
    this.useAudio = useAudio;
    this.startEncoder();
  }

  startEncoder() {
    const output = store.getSection('output');
    const tools = this.tools();
    const size = this.size;
    const { w, h } = size;
    const fps = Number(output.fps) || 25;
    const useAudio = this.useAudio;
    const audioEnv = this.audioEnv;
    const vb = Number(output.videoBitrate) || 4500;
    const args = ['-hide_banner', '-loglevel', 'warning', '-stats', '-thread_queue_size', '512',
      '-f', 'x11grab', '-draw_mouse', '0', '-video_size', `${w}x${h}`, '-framerate', String(fps), '-i', `${DISPLAY}.0+0,0`];
    if (useAudio) args.push('-thread_queue_size', '512', '-f', 'pulse', '-i', 'beeldkrant.monitor');
    else args.push('-f', 'lavfi', '-i', 'anullsrc=channel_layout=stereo:sample_rate=44100');
    const filters = [];
    if (size.outW !== w || size.outH !== h) {
      filters.push(`scale=${size.outW}:${size.outH}:force_original_aspect_ratio=decrease,pad=${size.outW}:${size.outH}:(ow-iw)/2:(oh-ih)/2:black`);
    }
    const encoder = output.encoder || 'libx264';
    const rate = ['-b:v', `${vb}k`, '-maxrate', `${vb}k`, '-bufsize', `${vb * 2}k`, '-g', String(fps * 2), '-keyint_min', String(fps * 2)];
    if (encoder === 'h264_vaapi') {
      // Intel / AMD GPU passed through to the container
      args.unshift('-vaapi_device', VAAPI_DEVICE);
      filters.push('format=nv12', 'hwupload');
      args.push('-vf', filters.join(','), '-c:v', 'h264_vaapi', ...rate);
    } else if (encoder === 'h264_nvenc') {
      if (filters.length) args.push('-vf', filters.join(','));
      args.push('-c:v', 'h264_nvenc', '-preset', 'p4', '-tune', 'll', '-pix_fmt', 'yuv420p', ...rate);
    } else {
      if (filters.length) args.push('-vf', filters.join(','));
      args.push('-c:v', 'libx264', '-preset', output.preset || 'veryfast', '-tune', 'zerolatency', '-pix_fmt', 'yuv420p', ...rate, '-sc_threshold', '0');
    }
    args.push(
      '-c:a', 'aac', '-b:a', `${Number(output.audioBitrate) || 128}k`, '-ar', '44100', '-ac', '2',
    );
    if (/^srt:/i.test(output.url)) args.push('-f', 'mpegts', output.url);
    else args.push('-f', 'flv', '-flvflags', 'no_duration_filesize', output.url);
    this.spawnProc('ffmpeg', tools.ffmpeg, args, audioEnv);
  }

  scheduleEncoderRestart() {
    if (this.restartTimer) return;
    this.state = 'restarting';
    this.lastError = 'encoder stopped (destination unreachable?)';
    const delay = this.restartDelay;
    this.restartDelay = Math.min(this.restartDelay * 2, 30000);
    this.log('system', `reconnecting encoder in ${delay / 1000}s`);
    this.restartTimer = setTimeout(() => {
      this.restartTimer = null;
      if (this.wanted) this.startEncoder();
    }, delay);
  }

  // Capture at the on-air playout's resolution; optionally scale to a fixed output size.
  computeSize() {
    const output = store.getSection('output');
    const id = schedule.activePlayoutId();
    const p = id && store.get('playouts', id);
    const even = (n, d) => { const v = Math.round(Number(n)) || d; return v - (v % 2); };
    const w = even(p && p.width, even(output.width, 1920));
    const h = even(p && p.height, even(output.height, 1080));
    if (output.resolutionMode === 'fixed') return { w, h, outW: even(output.width, 1920), outH: even(output.height, 1080) };
    return { w, h, outW: w, outH: h };
  }

  // When the schedule switches to a playout with another resolution, rebuild the pipeline.
  watchResolution() {
    if (this.watchTimer) return;
    this.watchTimer = setInterval(() => {
      if (!this.wanted || !this.size || this.restartTimer) return;
      const next = this.computeSize();
      if (next.w !== this.size.w || next.h !== this.size.h || next.outW !== this.size.outW || next.outH !== this.size.outH) {
        this.log('system', `resolution changed to ${next.w}x${next.h}, restarting pipeline`);
        this.launch().catch((err) => this.scheduleRestart(err.message));
      }
    }, 15000);
  }

  scheduleRestart(reason) {
    if (this.restartTimer) return;
    this.state = 'restarting';
    this.lastError = reason;
    const delay = this.restartDelay;
    this.restartDelay = Math.min(this.restartDelay * 2, 60000);
    this.log('system', `restarting pipeline in ${delay / 1000}s (${reason})`);
    this.restartTimer = setTimeout(() => {
      this.restartTimer = null;
      if (this.wanted) this.launch().catch((err) => { this.lastError = err.message; this.scheduleRestart(err.message); });
    }, delay);
  }

  async stop() {
    this.wanted = false;
    clearTimeout(this.restartTimer);
    this.restartTimer = null;
    store.setSection('output', { enabled: false });
    await this.killAll();
    this.state = 'stopped';
    this.startedAt = null;
    this.stats = {};
  }

  async restart() {
    if (!this.wanted) return this.start();
    this.startedAt = null;
    return this.launch();
  }

  async killAll() {
    this.stopping = true;
    const procs = Object.values(this.procs);
    for (const p of procs) { try { p.kill('SIGTERM'); } catch { /* gone */ } }
    await Promise.all(procs.map((p) => new Promise((resolve) => {
      if (p.exitCode !== null || p.signalCode) return resolve();
      const t = setTimeout(() => { try { p.kill('SIGKILL'); } catch { /* gone */ } resolve(); }, 4000);
      p.once('exit', () => { clearTimeout(t); resolve(); });
    })));
    this.procs = {};
    this.stopping = false;
  }
}

function redact(url) {
  if (!url) return '';
  // Hide the stream key (last path segment) and any credentials.
  return String(url).replace(/\/\/[^@/]+@/, '//***@').replace(/\/([^/]+)$/, (m, key) => (key.length > 4 ? `/${key.slice(0, 2)}…` : m));
}

function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }
async function waitFor(fn, timeout) {
  const end = Date.now() + timeout;
  while (Date.now() < end) { if (fn()) return true; await sleep(100); }
  return false;
}

module.exports = new StreamManager();
