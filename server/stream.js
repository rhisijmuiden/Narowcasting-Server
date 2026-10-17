'use strict';
// Renders the player page in Chromium on a virtual X display and pushes it out with ffmpeg.
//
//   Xvfb (:display) <- Chromium (kiosk, /player) ; PulseAudio null sink <- Chromium audio
//   ffmpeg x11grab + pulse monitor -> H.264/AAC -> MPEG-TS -> outputs (see outputs.js), which send
//   it on to every enabled destination
//
// There is one such pipeline per source in use: the schedule, plus every playout that an output is
// routed to directly (for example a clean feed). Each pipeline gets its own display and audio sink.
const { spawn, execFileSync } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { EventEmitter } = require('events');
const store = require('./store');
const schedule = require('./schedule');
const outputs = require('./outputs');

const DISPLAY_BASE = Number(String(process.env.BK_DISPLAY || ':99').replace(':', '')) || 99;
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

// One rendering pipeline for one source: its own virtual display, audio sink, browser and encoder.
// Source 'schedule' shows whatever the schedule puts on air; any other source is a playout id.
class Pipeline {
  constructor(manager, source, slot) {
    this.manager = manager;
    this.source = source;
    this.slot = slot;
    this.display = `:${DISPLAY_BASE + slot}`;
    this.sink = slot ? `beeldkrant${slot}` : 'beeldkrant';
    this.pulseSocket = path.join(RUNTIME_DIR, slot ? `pulse-${slot}.sock` : 'pulse.sock');
    this.procs = {};
    this.state = 'stopped'; // stopped | starting | live | restarting | error
    this.startedAt = null;
    this.lastError = null;
    this.stats = {};
    this.wanted = false;
    this.restartTimer = null;
    this.restartDelay = 2000;
  }

  get label() {
    if (this.source === outputs.SCHEDULE) return 'Schedule';
    const p = store.get('playouts', this.source);
    return p ? p.name : 'Deleted playout';
  }

  // The playout this pipeline shows right now.
  playoutId() {
    return this.source === outputs.SCHEDULE ? schedule.activePlayoutId() : this.source;
  }

  log(source, line) {
    const text = String(line).trimEnd();
    if (!text) return;
    for (const l of text.split(/\r?\n|\r/)) {
      if (source === 'chromium' && /dbus|object_proxy|Fontconfig|viz_main_impl|gl_factory/.test(l)) continue;
      if (source === 'ffmpeg' && l.startsWith('frame=')) { this.parseStats(l); continue; }
      this.manager.pushLog(this.slot ? `${source} · ${this.label}` : source, l);
    }
  }

  parseStats(line) {
    const grab = (k) => { const m = new RegExp(`${k}=\\s*([^\\s]+)`).exec(line); return m ? m[1] : null; };
    this.stats = { frame: grab('frame'), fps: grab('fps'), bitrate: grab('bitrate'), speed: grab('speed'), time: grab('time') };
    if (this.state === 'starting' || this.state === 'restarting') { this.state = 'live'; this.restartDelay = 2000; }
  }

  status() {
    const output = store.getSection('output');
    const id = this.playoutId();
    const p = id && store.get('playouts', id);
    return {
      source: this.source,
      label: this.label,
      playoutId: id || null,
      playoutName: p ? p.name : null,
      state: this.state,
      startedAt: this.startedAt,
      lastError: this.lastError,
      stats: this.stats,
      resolution: this.size ? `${this.size.outW}x${this.size.outH}@${output.fps}` : null,
    };
  }

  spawnProc(name, cmd, args, env) {
    this.log('system', `starting ${name}: ${cmd} ${args.join(' ')}`);
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
    this.wanted = true;
    this.watchResolution();
    await this.launch();
  }

  async launch() {
    clearTimeout(this.restartTimer);
    this.restartTimer = null;
    await this.killAll();
    const output = store.getSection('output');
    const tools = this.manager.tools();
    const size = this.computeSize();
    this.size = size;
    const { w, h } = size;
    this.state = this.startedAt ? 'restarting' : 'starting';
    this.startedAt = this.startedAt || new Date().toISOString();
    this.lastError = null;
    this.stats = {};
    fs.mkdirSync(RUNTIME_DIR, { recursive: true, mode: 0o700 });

    // 1. Virtual display
    const lock = `/tmp/.X${this.display.replace(':', '')}-lock`;
    try { fs.unlinkSync(lock); } catch { /* none */ }
    this.spawnProc('xvfb', tools.xvfb, [this.display, '-screen', '0', `${w}x${h}x24`, '-nolisten', 'tcp', '-ac']);
    await waitFor(() => fs.existsSync(lock), 5000);

    // 2. Audio sink (optional: without PulseAudio a silent track is sent)
    const useAudio = output.audio !== false && tools.pulseaudio;
    const audioEnv = {};
    if (useAudio) {
      try { fs.unlinkSync(this.pulseSocket); } catch { /* none */ }
      this.spawnProc('pulseaudio', tools.pulseaudio, [
        '-n', '--daemonize=no', '--exit-idle-time=-1', '--disallow-exit', '--use-pid-file=no', '--system=false',
        `--load=module-null-sink sink_name=${this.sink} sink_properties=device.description=Beeldkrant`,
        `--load=module-native-protocol-unix socket=${this.pulseSocket} auth-anonymous=1`,
        '--load=module-always-sink',
      ], { XDG_RUNTIME_DIR: RUNTIME_DIR, HOME: RUNTIME_DIR });
      await waitFor(() => fs.existsSync(this.pulseSocket), 5000);
      audioEnv.PULSE_SERVER = `unix:${this.pulseSocket}`;
      audioEnv.PULSE_SINK = this.sink;
    }

    // 3. Browser showing the player
    const profile = path.join(RUNTIME_DIR, this.slot ? `chromium-profile-${this.slot}` : 'chromium-profile');
    const page = `http://127.0.0.1:${this.manager.port || PORT}/player/?output=1${this.source === outputs.SCHEDULE ? '' : `&playout=${encodeURIComponent(this.source)}`}`;
    this.spawnProc('chromium', tools.chromium, [
      '--no-sandbox', '--no-first-run', '--no-default-browser-check', '--disable-infobars', '--disable-session-crashed-bubble',
      '--disable-features=Translate,MediaRouter', '--autoplay-policy=no-user-gesture-required', '--disable-dev-shm-usage',
      '--hide-scrollbars', '--force-device-scale-factor=1', '--kiosk', `--window-position=0,0`, `--window-size=${w},${h}`,
      `--user-data-dir=${profile}`, '--password-store=basic', '--use-angle=swiftshader', '--enable-unsafe-swiftshader',
      `--app=${page}`,
    ], { DISPLAY: this.display, ...audioEnv });
    await sleep(Number(process.env.BK_BROWSER_WARMUP_MS) || 4000);
    if (!this.wanted) return;

    this.audioEnv = audioEnv;
    this.useAudio = useAudio;
    this.startEncoder();
  }

  startEncoder() {
    const output = store.getSection('output');
    const tools = this.manager.tools();
    const size = this.size;
    const { w, h } = size;
    const fps = Number(output.fps) || 25;
    const useAudio = this.useAudio;
    const audioEnv = this.audioEnv;
    const vb = Number(output.videoBitrate) || 4500;
    const args = ['-hide_banner', '-loglevel', 'warning', '-stats', '-thread_queue_size', '512',
      '-f', 'x11grab', '-draw_mouse', '0', '-video_size', `${w}x${h}`, '-framerate', String(fps), '-i', `${this.display}.0+0,0`];
    if (useAudio) args.push('-thread_queue_size', '512', '-f', 'pulse', '-i', `${this.sink}.monitor`);
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
    // Repeated headers let an output that starts later pick up the stream right away.
    args.push('-f', 'mpegts', '-mpegts_flags', '+resend_headers', outputs.openFeed(this.source, this.slot));
    this.spawnProc('ffmpeg', tools.ffmpeg, args, audioEnv);
    outputs.setFeeding(this.source, true, tools.ffmpeg);
  }

  scheduleEncoderRestart() {
    if (this.restartTimer) return;
    this.state = 'restarting';
    this.lastError = 'encoder stopped';
    const delay = this.restartDelay;
    this.restartDelay = Math.min(this.restartDelay * 2, 30000);
    this.log('system', `reconnecting encoder in ${delay / 1000}s`);
    this.restartTimer = setTimeout(() => {
      this.restartTimer = null;
      if (this.wanted) this.startEncoder();
    }, delay);
  }

  // Capture at the playout's resolution; optionally scale to a fixed output size.
  computeSize() {
    const output = store.getSection('output');
    const id = this.playoutId();
    const p = id && store.get('playouts', id);
    const even = (n, d) => { const v = Math.round(Number(n)) || d; return v - (v % 2); };
    const w = even(p && p.width, even(output.width, 1920));
    const h = even(p && p.height, even(output.height, 1080));
    if (output.resolutionMode === 'fixed') return { w, h, outW: even(output.width, 1920), outH: even(output.height, 1080) };
    return { w, h, outW: w, outH: h };
  }

  // When the playout changes resolution (or the schedule switches to another one), rebuild the pipeline.
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
    clearInterval(this.watchTimer);
    this.watchTimer = null;
    await outputs.setFeeding(this.source, false);
    await this.killAll();
    this.state = 'stopped';
    this.startedAt = null;
    this.stats = {};
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

// Runs one pipeline per source that an enabled output is routed to (see Routing in the panel).
class StreamManager extends EventEmitter {
  constructor() {
    super();
    this.pipelines = {}; // source -> Pipeline
    this.logs = [];
    this.wanted = false;
    this.syncing = Promise.resolve();
  }

  pushLog(source, line) {
    this.logs.push({ t: new Date().toISOString(), source, line });
    if (this.logs.length > MAX_LOG) this.logs.splice(0, this.logs.length - MAX_LOG);
  }

  // Overall state: live when every pipeline is live.
  get state() {
    const list = Object.values(this.pipelines);
    if (!list.length) return this.wanted ? 'idle' : 'stopped';
    for (const s of ['error', 'restarting', 'starting']) if (list.some((p) => p.state === s)) return s;
    return list.every((p) => p.state === 'live') ? 'live' : list[0].state;
  }

  status() {
    const list = Object.values(this.pipelines);
    const first = this.pipelines[outputs.SCHEDULE] || list[0];
    // Bitrate of all encoders together, in the format ffmpeg reports it.
    const kbit = list.reduce((sum, p) => sum + (parseFloat(p.stats.bitrate) || 0), 0);
    const startedAt = list.map((p) => p.startedAt).filter(Boolean).sort()[0] || null;
    return {
      state: this.state,
      wanted: this.wanted,
      startedAt,
      lastError: (list.find((p) => p.lastError) || {}).lastError || null,
      stats: first ? { ...first.stats, bitrate: kbit ? `${kbit.toFixed(1)}kbits/s` : first.stats.bitrate } : {},
      resolution: first ? first.status().resolution : null,
      pipelines: list.map((p) => p.status()),
      outputs: outputs.status(),
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

  async start() {
    if (!store.list('outputs').some((o) => o.enabled)) throw new Error('Turn on at least one output first');
    const tools = this.tools();
    for (const t of ['xvfb', 'chromium', 'ffmpeg']) if (!tools[t]) throw new Error(`${t} is not installed`);
    this.wanted = true;
    store.setSection('output', { enabled: true });
    await this.sync();
  }

  // Starts a pipeline for every source in use and stops the ones nothing is routed to anymore.
  // Called on start and whenever outputs are turned on or off or routed elsewhere.
  sync() {
    this.syncing = this.syncing.catch(() => {}).then(async () => {
      const wanted = this.wanted ? outputs.wantedSources().filter((s) => s === outputs.SCHEDULE || store.get('playouts', s)) : [];
      for (const [source, p] of Object.entries(this.pipelines)) {
        if (!wanted.includes(source)) { delete this.pipelines[source]; await p.stop(); }
      }
      const starting = [];
      for (const source of wanted) {
        if (this.pipelines[source]) continue;
        const used = new Set(Object.values(this.pipelines).map((p) => p.slot));
        let slot = source === outputs.SCHEDULE && !used.has(0) ? 0 : 1;
        while (used.has(slot)) slot++;
        const p = new Pipeline(this, source, slot);
        this.pipelines[source] = p;
        starting.push(p.start().catch((err) => { p.lastError = err.message; p.scheduleRestart(err.message); }));
      }
      await Promise.all(starting);
    });
    return this.syncing;
  }

  async stop() {
    this.wanted = false;
    store.setSection('output', { enabled: false });
    await this.sync();
    await outputs.stopAll();
  }

  // Rebuilds every pipeline, e.g. after the encoding settings changed.
  async restart() {
    if (!this.wanted) return this.start();
    await this.syncing.catch(() => {});
    await Promise.all(Object.values(this.pipelines).map((p) => { p.startedAt = null; return p.launch(); }));
  }
}

function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }
async function waitFor(fn, timeout) {
  const end = Date.now() + timeout;
  while (Date.now() < end) { if (fn()) return true; await sleep(100); }
  return false;
}

module.exports = new StreamManager();
