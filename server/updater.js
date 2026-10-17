'use strict';
// Checks once a day whether a newer version is available and lets an admin start the update.
// The update itself runs as root through the beeldkrant-update systemd units (see deploy/):
// this process only writes the request file that their path unit watches.
const fs = require('fs');
const path = require('path');
const { execFile } = require('child_process');
const store = require('./store');

const APP_DIR = path.join(__dirname, '..');
const REF = process.env.BEELDKRANT_REF || 'main';
const REQUEST_FILE = path.join(store.DATA_DIR, 'update-request');
const LOG_FILE = path.join(store.DATA_DIR, 'update.log');
const PATH_UNIT = '/etc/systemd/system/beeldkrant-update.path';
const DAY = 24 * 60 * 60 * 1000;

const state = { latest: null, checkedAt: null, error: null, incoming: null };

function run(cmd, args, timeout = 30000) {
  return new Promise((resolve, reject) => {
    execFile(cmd, args, { cwd: APP_DIR, timeout }, (err, out) => (err ? reject(err) : resolve(String(out).trim())));
  });
}
// safe.directory: the checkout may be owned by another user than the one running the server.
const git = (...args) => run('git', ['-c', `safe.directory=${APP_DIR}`, '-C', APP_DIR, ...args]);

function version() {
  try { return JSON.parse(fs.readFileSync(path.join(APP_DIR, 'package.json'), 'utf8')).version; } catch { return null; }
}

async function current() {
  try { return await git('rev-parse', 'HEAD'); } catch { return null; }
}

async function check() {
  try {
    const out = await git('ls-remote', 'origin', `refs/heads/${REF}`);
    state.latest = out.split(/\s+/)[0] || null;
    state.error = state.latest ? null : `Branch ${REF} not found`;
    state.incoming = state.latest && state.latest !== (await current()) ? await incomingChangelog() : null;
  } catch (err) {
    state.error = 'Could not reach the repository';
  }
  state.checkedAt = new Date().toISOString();
  return status();
}

async function commitDate() {
  try { return await git('log', '-1', '--format=%cI'); } catch { return null; }
}

function changelog() {
  try { return fs.readFileSync(path.join(APP_DIR, 'CHANGELOG.md'), 'utf8'); } catch { return ''; }
}

// The changelog of the newer version, so the panel can show what an update brings.
// Fetching only touches FETCH_HEAD; `update` fetches the same way.
async function incomingChangelog() {
  try {
    await run('git', ['-c', `safe.directory=${APP_DIR}`, '-C', APP_DIR, 'fetch', '--quiet', '--depth', '1', 'origin', REF], 120000);
    return await git('show', 'FETCH_HEAD:CHANGELOG.md');
  } catch { return null; }
}

async function status() {
  const commit = await current();
  let log = '';
  try { log = fs.readFileSync(LOG_FILE, 'utf8').slice(-4000); } catch { /* no update has run yet */ }
  return {
    version: version(),
    commit,
    branch: REF,
    latest: state.latest,
    available: !!(commit && state.latest && commit !== state.latest),
    checkedAt: state.checkedAt,
    error: state.error,
    incoming: state.incoming,
    // The panel can only start updates on an installed container (git checkout + systemd units).
    canUpdate: !!commit && fs.existsSync(PATH_UNIT),
    requested: fs.existsSync(REQUEST_FILE),
    log,
  };
}

function requestUpdate() {
  if (!fs.existsSync(PATH_UNIT)) throw new Error('Updating from the panel needs the update service of the installer. Run `update` in the container shell instead.');
  fs.writeFileSync(REQUEST_FILE, new Date().toISOString());
}

function start() {
  if (!fs.existsSync(path.join(APP_DIR, '.git'))) return;
  setTimeout(check, 60 * 1000);
  setInterval(check, DAY);
}

module.exports = { check, status, requestUpdate, start, commitDate, changelog };
