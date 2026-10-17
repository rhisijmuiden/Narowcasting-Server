'use strict';
// Sends the encoded stream to several destinations at once.
//
//   encoder (ffmpeg) -> MPEG-TS over UDP -> fan-out (this process) -> one relay ffmpeg per output
//
// Every output is routed to a source: the schedule (whatever is on air) or one fixed playout. Each
// source in use has its own encoder and its own fan-out port, so one playout can go to YouTube and
// Facebook while a clean-feed copy goes to another server. Each relay copies the stream without re-encoding to its own destination (RTMP(S) as FLV, SRT as
// MPEG-TS), so outputs start, stop and reconnect on their own without touching the others.
// YouTube and Facebook outputs linked to an account first create a live broadcast and use the
// ingest address it returns.
const dgram = require('dgram');
const { spawn } = require('child_process');
const store = require('./store');
const providers = require('./providers');

const FANOUT_PORT = Number(process.env.BK_FANOUT_PORT) || 29000; // feeds use FANOUT_PORT + slot, relays from FANOUT_PORT + 100
const MAX_LOG = 200;
const SCHEDULE = 'schedule';

// The source an output is routed to: 'schedule' or a playout id.
function sourceOf(o) {
  return (o && o.source) || SCHEDULE;
}

// Ingest addresses for outputs that use a stream key.
const KEY_URLS = {
  youtube: 'rtmps://a.rtmps.youtube.com:443/live2',
  facebook: 'rtmps://live-api-s.facebook.com:443/rtmp',
};

function redact(url) {
  if (!url) return '';
  return String(url).replace(/\/\/[^@/]+@/, '//***@').replace(/\/([^/]+)$/, (m, key) => (key.length > 4 ? `/${key.slice(0, 2)}…` : m))
    .replace(/(streamid|passphrase)=[^&]+/gi, '$1=…');
}

// The address an output sends to, or null when it is linked to an account (resolved on start).
function destination(o) {
  if (o.type === 'custom') return o.url;
  if (o.mode === 'key') return o.streamKey ? `${KEY_URLS[o.type]}/${o.streamKey}` : null;
  return null;
}

class OutputManager {
  constructor() {
    this.running = {}; // output id -> { source, proc, port, state, stats, error, startedAt, watchUrl, ref, timer, delay, log }
    this.feeds = {}; // source -> { socket, port, slot }
    this.ffmpeg = 'ffmpeg';
    this.nextPort = FANOUT_PORT + 100;
  }

  // ---------- fan-out ----------
  // Opens the UDP port an encoder for this source sends to and returns its address.
  openFeed(source, slot) {
    let f = this.feeds[source];
    if (!f) {
      f = { socket: dgram.createSocket('udp4'), port: FANOUT_PORT + slot, slot, on: false };
      f.socket.on('message', (msg) => {
        for (const r of Object.values(this.running)) if (r.port && r.source === source) f.socket.send(msg, r.port, '127.0.0.1');
      });
      f.socket.on('error', (err) => console.error(`Output fan-out (${source}):`, err.message));
      f.socket.bind(f.port, '127.0.0.1');
      this.feeds[source] = f;
    }
    return `udp://127.0.0.1:${f.port}?pkt_size=1316`;
  }

  closeFeed(source) {
    const f = this.feeds[source];
    if (f) { try { f.socket.close(); } catch { /* closed */ } }
    delete this.feeds[source];
  }

  // The sources that enabled outputs are routed to.
  wantedSources() {
    return [...new Set(store.list('outputs').filter((o) => o.enabled).map(sourceOf))];
  }

  isFeeding(source) {
    return !!(this.feeds[source] && this.feeds[source].on);
  }

  get feeding() {
    return Object.values(this.feeds).some((f) => f.on);
  }

  // ---------- lifecycle ----------
  // Called when the encoder of a source starts or stops: runs every enabled output routed to it.
  setFeeding(source, on, ffmpegPath) {
    if (ffmpegPath) this.ffmpeg = ffmpegPath;
    if (on) {
      if (!this.feeds[source]) return Promise.resolve();
      this.feeds[source].on = true;
      for (const o of store.list('outputs')) if (o.enabled && sourceOf(o) === source && !this.running[o.id]) this.startOutput(o.id).catch(() => {});
      return Promise.resolve();
    }
    const stopping = Object.keys(this.running).filter((id) => this.running[id].source === source).map((id) => this.stopOutput(id));
    this.closeFeed(source);
    return Promise.all(stopping);
  }

  stopAll() {
    return Promise.all(Object.keys(this.feeds).map((s) => this.setFeeding(s, false)));
  }

  // Enables an output and starts it when its source is on air.
  async enable(id, on) {
    const o = store.update('outputs', id, { enabled: !!on });
    if (on && this.isFeeding(sourceOf(o))) await this.startOutput(id);
    if (!on) await this.stopOutput(id);
  }

  // Routes an output to another source; it restarts on that source when it is on air.
  async route(id, source) {
    const o = store.update('outputs', id, { source: source || SCHEDULE });
    await this.stopOutput(id);
    if (o.enabled && this.isFeeding(sourceOf(o))) await this.startOutput(id);
  }

  async startOutput(id) {
    const o = store.get('outputs', id);
    if (!o) return;
    if (this.running[id]) await this.stopOutput(id);
    const r = { source: sourceOf(o), state: 'connecting', stats: {}, error: null, startedAt: null, log: [], delay: 3000, port: null };
    this.running[id] = r;
    try {
      let url = destination(o);
      if (!url) {
        if (o.mode === 'key') throw new Error('Enter the stream key');
        this.log(r, `creating a live ${o.type === 'youtube' ? 'broadcast on YouTube' : 'video on Facebook'}`);
        const live = await providers.goLive(o);
        Object.assign(r, { ref: live.ref, watchUrl: live.watchUrl });
        url = live.url;
      }
      if (!url) throw new Error('No destination set');
      if (this.running[id] !== r) return; // stopped meanwhile
      r.url = url;
      this.spawnRelay(id, r);
    } catch (err) {
      r.state = 'error';
      r.error = err.message;
      this.log(r, `could not start: ${err.message}`);
    }
  }

  spawnRelay(id, r) {
    const o = store.get('outputs', id);
    r.port = r.port || this.nextPort++;
    const srt = /^srt:/i.test(r.url);
    const args = ['-hide_banner', '-loglevel', 'warning', '-stats',
      '-fflags', '+genpts', '-f', 'mpegts', '-i', `udp://127.0.0.1:${r.port}?fifo_size=1000000&overrun_nonfatal=1&timeout=15000000`,
      '-map', '0', '-c', 'copy'];
    if (srt) args.push('-f', 'mpegts', r.url);
    else args.push('-bsf:a', 'aac_adtstoasc', '-f', 'flv', '-flvflags', 'no_duration_filesize', r.url);
    this.log(r, `sending to ${redact(r.url)}`);
    const p = spawn(this.ffmpeg, args, { stdio: ['ignore', 'pipe', 'pipe'] });
    r.proc = p;
    r.state = 'connecting';
    const onData = (d) => {
      for (const line of String(d).split(/\r?\n|\r/)) {
        if (!line.trim()) continue;
        if (line.startsWith('frame=') || line.startsWith('size=')) {
          const grab = (k) => { const m = new RegExp(`${k}=\\s*([^\\s]+)`).exec(line); return m ? m[1] : null; };
          r.stats = { bitrate: grab('bitrate'), time: grab('time'), speed: grab('speed') };
          if (r.state !== 'live') { r.state = 'live'; r.startedAt = r.startedAt || new Date().toISOString(); r.error = null; r.delay = 3000; }
        } else this.log(r, line);
      }
    };
    p.stdout.on('data', onData);
    p.stderr.on('data', onData);
    p.on('error', (err) => this.log(r, `failed to start: ${err.message}`));
    p.on('exit', (code, signal) => {
      if (r.proc !== p) return;
      r.proc = null;
      if (this.running[id] !== r || r.stopping) return;
      // Dropped: reconnect with back-off while the stream and this output are still on.
      r.state = 'reconnecting';
      r.error = r.error || `connection lost (${signal || code})`;
      this.log(r, `stopped (${signal || code}), reconnecting in ${r.delay / 1000}s`);
      r.timer = setTimeout(() => {
        const cur = store.get('outputs', id);
        if (this.running[id] === r && this.isFeeding(r.source) && cur && cur.enabled) this.spawnRelay(id, r);
      }, r.delay);
      r.delay = Math.min(r.delay * 2, 60000);
      if (o && o.type !== 'custom' && o.mode !== 'key' && r.delay > 24000) {
        // A broadcast that kept failing may have ended on the platform's side: make a new one.
        this.startOutput(id).catch(() => {});
      }
    });
  }

  async stopOutput(id) {
    const r = this.running[id];
    if (!r) return;
    delete this.running[id];
    r.stopping = true;
    clearTimeout(r.timer);
    if (r.proc) {
      const p = r.proc;
      await new Promise((resolve) => {
        const t = setTimeout(() => { try { p.kill('SIGKILL'); } catch { /* gone */ } resolve(); }, 4000);
        p.once('exit', () => { clearTimeout(t); resolve(); });
        try { p.kill('SIGTERM'); } catch { resolve(); }
      });
    }
    const o = store.get('outputs', id);
    if (o && r.ref) providers.stop(o, r.ref).catch((err) => console.error(`Output ${o.name}: could not end the live broadcast:`, err.message));
  }

  log(r, line) {
    r.log.push(`${new Date().toLocaleTimeString('en-GB')}  ${line}`);
    if (r.log.length > MAX_LOG) r.log.shift();
  }

  status() {
    return store.list('outputs').map((o) => {
      const r = this.running[o.id];
      return {
        id: o.id,
        name: o.name,
        type: o.type,
        enabled: !!o.enabled,
        source: sourceOf(o),
        destination: redact(destination(o)) || (o.type !== 'custom' && o.mode !== 'key' ? `${o.type === 'youtube' ? 'YouTube' : 'Facebook'} account` : ''),
        state: r ? r.state : 'stopped',
        error: r ? r.error : null,
        stats: r ? r.stats : {},
        startedAt: r ? r.startedAt : null,
        watchUrl: r ? r.watchUrl || null : null,
        log: r ? r.log.slice(-50) : [],
      };
    });
  }
}

module.exports = new OutputManager();
module.exports.KEY_URLS = KEY_URLS;
module.exports.redact = redact;
module.exports.sourceOf = sourceOf;
module.exports.SCHEDULE = SCHEDULE;
