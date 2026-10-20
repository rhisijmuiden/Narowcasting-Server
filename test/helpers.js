'use strict';
// Starts a Beeldkrant server for a test in a fresh data directory.
const { spawn } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');
const net = require('net');

const ROOT = path.join(__dirname, '..');
const PASSWORD = 'first-Password-1';

function freePort() {
  return new Promise((resolve, reject) => {
    const s = net.createServer().listen(0, '127.0.0.1', () => { const { port } = s.address(); s.close(() => resolve(port)); });
    s.on('error', reject);
  });
}

// Starts Beeldkrant with these extra environment variables; resolves once it listens.
async function startServer(env = {}) {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'beeldkrant-test-'));
  const port = await freePort();
  const proc = spawn(process.execPath, [path.join(ROOT, 'server', 'index.js')], {
    env: { PATH: process.env.PATH, DATA_DIR: dataDir, PORT: String(port), HOST: '127.0.0.1', BK_INITIAL_PASSWORD: PASSWORD, ...env },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let output = '';
  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`Server did not start:\n${output}`)), 15000);
    const onData = (d) => { output += d; if (/admin panel on/.test(output)) { clearTimeout(timer); resolve(); } };
    proc.stdout.on('data', onData);
    proc.stderr.on('data', (d) => { output += d; });
    proc.on('exit', (code) => { clearTimeout(timer); reject(new Error(`Server exited with ${code}:\n${output}`)); });
  });
  return {
    url: `http://127.0.0.1:${port}`,
    stop() { proc.removeAllListeners('exit'); proc.kill('SIGKILL'); fs.rmSync(dataDir, { recursive: true, force: true }); },
  };
}

module.exports = { startServer, freePort, PASSWORD, ROOT };
