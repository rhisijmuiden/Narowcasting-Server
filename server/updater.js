'use strict';
// Checks once a day whether a newer version is available and lets an admin start the update.
// Two release channels: Stable follows the newest GitHub release (a vX.Y.Z tag), Test follows
// the main branch, so every merged change. BEELDKRANT_REF (in /etc/default/beeldkrant) pins
// another branch instead and overrides the channel.
// The update itself runs as root through the beeldkrant-update systemd units (see deploy/):
// this process only writes the request file that their path unit watches.
const fs = require('fs');
const path = require('path');
const { execFile } = require('child_process');
const store = require('./store');

const APP_DIR = path.join(__dirname, '..');
const PINNED_REF = process.env.BEELDKRANT_REF || null;
const TEST_BRANCH = 'main';
const CHANNELS = ['stable', 'test'];
// Read by `update` too (it runs as root and cannot read the database), so it is a plain file.
const CHANNEL_FILE = path.join(store.DATA_DIR, 'update-channel');
const REQUEST_FILE = path.join(store.DATA_DIR, 'update-request');
const LOG_FILE = path.join(store.DATA_DIR, 'update.log');
const PATH_UNIT = '/etc/systemd/system/beeldkrant-update.path';
const DAY = 24 * 60 * 60 * 1000;

const state = { latest: null, latestVersion: null, ref: null, fallback: false, checkedAt: null, error: null, incoming: null };

function channel() {
  try {
    const c = fs.readFileSync(CHANNEL_FILE, 'utf8').trim();
    return CHANNELS.includes(c) ? c : 'stable';
  } catch { return 'stable'; }
}

function setChannel(c) {
  if (!CHANNELS.includes(c)) throw Object.assign(new Error('Unknown release channel'), { status: 400 });
  if (PINNED_REF) throw Object.assign(new Error(`This installation is pinned to branch ${PINNED_REF} (BEELDKRANT_REF in /etc/default/beeldkrant). Remove that line to use a release channel.`), { status: 409 });
  fs.writeFileSync(CHANNEL_FILE, `${c}\n`);
  return check();
}

// "0.10.2" > "0.9.7"; anything that is not x.y.z counts as 0.0.0.
function parseVersion(v) {
  const m = /^v?(\d+)\.(\d+)\.(\d+)$/.exec(String(v || '').trim());
  return m ? m.slice(1).map(Number) : [0, 0, 0];
}
function newer(a, b) {
  const x = parseVersion(a); const y = parseVersion(b);
  for (let i = 0; i < 3; i++) if (x[i] !== y[i]) return x[i] > y[i];
  return false;
}

// The newest release tag and its commit, from `git ls-remote --tags` output.
function latestRelease(out) {
  const tags = {};
  for (const line of out.split('\n')) {
    const [sha, ref] = line.trim().split(/\s+/);
    const m = /^refs\/tags\/(v\d+\.\d+\.\d+)(\^\{\})?$/.exec(ref || '');
    if (!m) continue;
    // An annotated tag has its own object; the ^{} line is the commit it points at.
    if (m[2] || !tags[m[1]]) tags[m[1]] = sha;
  }
  const names = Object.keys(tags).sort((a, b) => (newer(a, b) ? -1 : newer(b, a) ? 1 : 0));
  return names.length ? { tag: names[0], commit: tags[names[0]] } : null;
}

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

// What to update to: { ref, commit, version? }. Stable without any release yet follows main.
async function target() {
  if (PINNED_REF) {
    const out = await git('ls-remote', 'origin', `refs/heads/${PINNED_REF}`);
    return { ref: PINNED_REF, commit: out.split(/\s+/)[0] || null };
  }
  if (channel() === 'stable') {
    const release = latestRelease(await git('ls-remote', '--tags', 'origin', 'refs/tags/v*'));
    if (release) return { ref: `refs/tags/${release.tag}`, commit: release.commit, version: release.tag.slice(1) };
  }
  const out = await git('ls-remote', 'origin', `refs/heads/${TEST_BRANCH}`);
  return { ref: TEST_BRANCH, commit: out.split(/\s+/)[0] || null, fallback: channel() === 'stable' };
}

async function check() {
  try {
    const t = await target();
    Object.assign(state, { latest: t.commit, latestVersion: t.version || null, ref: t.ref, fallback: !!t.fallback });
    state.error = t.commit ? null : `Branch ${t.ref} not found`;
    state.incoming = isAvailable(await current()) ? await incomingChangelog(t.ref) : null;
  } catch (err) {
    state.error = 'Could not reach the repository';
  }
  state.checkedAt = new Date().toISOString();
  return status();
}

// A release only counts when it is newer than what runs now: switching from Test to Stable
// never installs an older version; you move over with the next stable release.
function isAvailable(commit) {
  if (!commit || !state.latest || commit === state.latest) return false;
  return state.latestVersion ? newer(state.latestVersion, version()) : true;
}

async function commitDate() {
  try { return await git('log', '-1', '--format=%cI'); } catch { return null; }
}

function changelog() {
  try { return fs.readFileSync(path.join(APP_DIR, 'CHANGELOG.md'), 'utf8'); } catch { return ''; }
}

// The changelog of the newer version, so the panel can show what an update brings.
// Fetching only touches FETCH_HEAD; `update` fetches the same way.
async function incomingChangelog(ref) {
  try {
    await run('git', ['-c', `safe.directory=${APP_DIR}`, '-C', APP_DIR, 'fetch', '--quiet', '--depth', '1', 'origin', ref], 120000);
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
    channel: channel(),
    pinned: PINNED_REF,
    branch: PINNED_REF || (state.ref && !state.ref.startsWith('refs/tags/') ? state.ref : null),
    latest: state.latest,
    latestVersion: state.latestVersion,
    // Stable has no release yet, so it follows main for now.
    stableFallback: state.fallback,
    // Running a test version that is newer than the latest stable release.
    aheadOfStable: !!(state.latestVersion && newer(version(), state.latestVersion)),
    available: isAvailable(commit),
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

module.exports = { check, status, requestUpdate, start, commitDate, changelog, channel, setChannel, latestRelease, newer };
