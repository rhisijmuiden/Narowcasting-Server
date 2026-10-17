'use strict';
// System statistics for the Statistics page: load, CPU, memory, network traffic, stream bitrate
// and free disk space. Samples every 5 seconds and keeps the last 15 minutes.
const fs = require('fs');
const os = require('os');
const store = require('./store');

const INTERVAL = 5000;
const KEEP = 180; // 15 minutes
const history = [];
let lastNet = null;
let lastCpu = null;

// Bytes sent and received on all interfaces except loopback.
function netBytes() {
  try {
    let rx = 0;
    let tx = 0;
    for (const line of fs.readFileSync('/proc/net/dev', 'utf8').split('\n').slice(2)) {
      const [name, rest] = line.split(':');
      if (!rest || name.trim() === 'lo') continue;
      const f = rest.trim().split(/\s+/).map(Number);
      rx += f[0];
      tx += f[8];
    }
    return { rx, tx, at: Date.now() };
  } catch { return null; }
}

function cpuTimes() {
  let idle = 0;
  let total = 0;
  for (const c of os.cpus()) {
    for (const v of Object.values(c.times)) total += v;
    idle += c.times.idle;
  }
  return { idle, total };
}

function disk() {
  try {
    const s = fs.statfsSync(store.DATA_DIR);
    return { total: s.blocks * s.bsize, free: s.bavail * s.bsize };
  } catch { return null; }
}

// ffmpeg reports e.g. "4512.3kbits/s".
function kbit(text) {
  const m = /([\d.]+)\s*kbits/.exec(String(text || ''));
  return m ? Number(m[1]) : null;
}

function sample(stream) {
  const net = netBytes();
  const cpu = cpuTimes();
  const point = { t: Date.now(), load: os.loadavg()[0], cpu: null, txMbit: null, rxMbit: null, streamKbit: null, mem: 1 - os.freemem() / os.totalmem() };
  if (net && lastNet && net.at > lastNet.at) {
    const sec = (net.at - lastNet.at) / 1000;
    point.txMbit = Math.max(0, ((net.tx - lastNet.tx) * 8) / 1e6 / sec);
    point.rxMbit = Math.max(0, ((net.rx - lastNet.rx) * 8) / 1e6 / sec);
  }
  if (lastCpu && cpu.total > lastCpu.total) point.cpu = 1 - (cpu.idle - lastCpu.idle) / (cpu.total - lastCpu.total);
  lastNet = net;
  lastCpu = cpu;
  const st = stream.status();
  point.streamKbit = st.state === 'live' ? kbit(st.stats && st.stats.bitrate) : null;
  history.push(point);
  if (history.length > KEEP) history.shift();
}

function start(stream) {
  sample(stream);
  setInterval(() => sample(stream), INTERVAL).unref();
}

function current() {
  return {
    cpus: os.cpus().length,
    memTotal: os.totalmem(),
    uptime: os.uptime(),
    disk: disk(),
    interval: INTERVAL,
    history,
  };
}

module.exports = { start, current };
