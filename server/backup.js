'use strict';
// Backups of the application, the database and the media, kept locally and optionally copied to
// an FTP, FTPS or SFTP/SCP server. Runs on a schedule or on request, and restores a chosen backup.
//
// An archive is a .tar.gz named beeldkrant_<YYYY-MM-DD_HHMMSS>_<parts>.tar.gz holding manifest.json
// plus app/, database/data.json and/or media/. Archives with the same timestamp form one backup
// (the "separate" layout writes one archive per part).
const fs = require('fs');
const fsp = fs.promises;
const path = require('path');
const { execFile } = require('child_process');
const ftp = require('basic-ftp');
const SftpClient = require('ssh2-sftp-client');
const store = require('./store');
const { nowParts } = require('./schedule');

const APP_DIR = path.join(__dirname, '..');
const BACKUP_DIR = path.join(store.DATA_DIR, 'backups');
const STATUS_FILE = path.join(BACKUP_DIR, 'status.json');
const REQUEST_FILE = path.join(store.DATA_DIR, 'update-request');
const RESTORE_APP_DIR = path.join(store.DATA_DIR, 'restore-app');
const PATH_UNIT = '/etc/systemd/system/beeldkrant-update.path';
const PARTS = ['app', 'database', 'media'];
const NAME_RE = /^beeldkrant_(\d{4}-\d{2}-\d{2}_\d{6})_((?:app|database|media)(?:-(?:app|database|media))*)\.tar\.gz$/;

fs.mkdirSync(BACKUP_DIR, { recursive: true });

// The running job and the outcome of the last one. Kept out of data.json: writing there would
// reload every player.
const job = { running: false, kind: null, phase: '', startedAt: null, log: [] };
let last = readJSON(STATUS_FILE) || {};

function readJSON(file) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return null; }
}

function log(line) {
  job.phase = line;
  job.log.push(`${new Date().toLocaleTimeString('en-GB')}  ${line}`);
  if (job.log.length > 300) job.log.shift();
}

function saveLast(patch) {
  last = { ...last, ...patch };
  fs.writeFileSync(STATUS_FILE, JSON.stringify(last, null, 2));
}

function config() {
  return store.getSection('backup');
}

function version() {
  try { return JSON.parse(fs.readFileSync(path.join(APP_DIR, 'package.json'), 'utf8')).version; } catch { return null; }
}

function run(cmd, args, opts = {}) {
  return new Promise((resolve, reject) => {
    execFile(cmd, args, { maxBuffer: 16 * 1024 * 1024, ...opts }, (err, stdout, stderr) => {
      // GNU tar exits with 1 when a file changed while it was read; the archive is still usable.
      if (err && !(opts.okCodes || []).includes(err.code)) {
        err.message = String(stderr || err.message).trim().split('\n').slice(-3).join(' ');
        return reject(err);
      }
      resolve(String(stdout));
    });
  });
}

// ---------- naming ----------
function stamp() {
  const tz = store.getSection('settings').timezone;
  const p = Object.fromEntries(new Intl.DateTimeFormat('en-GB', {
    timeZone: tz || 'UTC', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false,
  }).formatToParts(new Date()).map((x) => [x.type, x.value]));
  return `${p.year}-${p.month}-${p.day}_${String(Number(p.hour) % 24).padStart(2, '0')}${p.minute}${p.second}`;
}

const archiveName = (id, parts) => `beeldkrant_${id}_${parts.join('-')}.tar.gz`;

// Groups archive files into backups by timestamp, newest first.
function groupSets(files) {
  const sets = new Map();
  for (const f of files) {
    const m = NAME_RE.exec(f.name);
    if (!m) continue;
    const set = sets.get(m[1]) || { id: m[1], files: [], parts: [], size: 0 };
    const parts = m[2].split('-');
    set.files.push({ name: f.name, size: f.size || 0, parts });
    set.parts = PARTS.filter((p) => set.parts.includes(p) || parts.includes(p));
    set.size += f.size || 0;
    sets.set(m[1], set);
  }
  return [...sets.values()].sort((a, b) => b.id.localeCompare(a.id));
}

// ---------- locations ----------
const local = {
  async list() {
    const names = await fsp.readdir(BACKUP_DIR);
    const files = [];
    for (const name of names.filter((n) => NAME_RE.test(n))) files.push({ name, size: (await fsp.stat(path.join(BACKUP_DIR, name))).size });
    return files;
  },
  async remove(name) { await fsp.rm(path.join(BACKUP_DIR, name), { force: true }); },
};

function remoteConfigured(remote = config().remote) {
  return !!(remote && remote.type && remote.type !== 'none' && remote.host);
}

// Opens a connection to the remote location and hands fn an object with list/upload/download/remove.
async function withRemote(remote, fn) {
  if (!remoteConfigured(remote)) throw new Error('No external backup location is set up');
  const dir = remote.path || '/';
  if (remote.type === 'sftp') {
    const client = new SftpClient();
    try {
      await client.connect({
        host: remote.host,
        port: Number(remote.port) || 22,
        username: remote.username,
        password: remote.password || undefined,
        privateKey: remote.privateKey || undefined,
        readyTimeout: 15000,
      });
      if (!(await client.exists(dir))) await client.mkdir(dir, true);
      const join = (name) => path.posix.join(dir, name);
      return await fn({
        list: async () => (await client.list(dir)).filter((f) => f.type === '-').map((f) => ({ name: f.name, size: f.size })),
        upload: (file, name) => client.fastPut(file, join(name)),
        download: (name, file) => client.fastGet(join(name), file),
        remove: (name) => client.delete(join(name), true),
      });
    } finally {
      await client.end().catch(() => {});
    }
  }
  const client = new ftp.Client(30000);
  try {
    await client.access({
      host: remote.host,
      port: Number(remote.port) || 21,
      user: remote.username || 'anonymous',
      password: remote.password || '',
      secure: remote.type === 'ftps',
      secureOptions: { rejectUnauthorized: !remote.allowSelfSigned },
    });
    await client.ensureDir(dir);
    return await fn({
      list: async () => (await client.list()).filter((f) => f.isFile).map((f) => ({ name: f.name, size: f.size })),
      upload: (file, name) => client.uploadFrom(file, name),
      download: (name, file) => client.downloadTo(file, name),
      remove: (name) => client.remove(name),
    });
  } finally {
    client.close();
  }
}

async function listSets(location) {
  if (location === 'remote') return groupSets(await withRemote(config().remote, (r) => r.list()));
  return groupSets(await local.list());
}

// Deletes the oldest backups beyond `keep`.
async function prune(loc, keep) {
  const sets = groupSets(await loc.list());
  for (const set of sets.slice(Math.max(0, keep))) {
    for (const f of set.files) await loc.remove(f.name);
    log(`Removed old backup ${set.id}`);
  }
}

// ---------- making a backup ----------
async function createArchive(id, parts, work) {
  const name = archiveName(id, parts);
  const out = path.join(BACKUP_DIR, `${name}.part`);
  const manifest = { app: 'beeldkrant', version: version(), parts, createdAt: new Date().toISOString() };
  try { manifest.commit = (await run('git', ['-c', `safe.directory=${APP_DIR}`, '-C', APP_DIR, 'rev-parse', 'HEAD'])).trim(); } catch { /* not a git checkout */ }
  await fsp.writeFile(path.join(work, 'manifest.json'), JSON.stringify(manifest, null, 2));

  const args = ['-czf', out, '-C', work, 'manifest.json'];
  if (parts.includes('database')) args.push('-C', work, 'database');
  if (parts.includes('media')) args.push('-C', store.DATA_DIR, path.basename(store.MEDIA_DIR));
  if (parts.includes('app')) {
    // The code without node_modules (restored with npm ci), stored under app/.
    const base = path.basename(APP_DIR);
    args.push(`--exclude=${base}/node_modules`, `--exclude=${base}/data`,
      `--transform=s,^${base.replace(/[.^$*[\]\\]/g, '\\$&')}\\(/\\|$\\),app\\1,`,
      '-C', path.dirname(APP_DIR), base);
  }
  await run('tar', args, { okCodes: [1] });
  await fsp.rename(out, path.join(BACKUP_DIR, name));
  return name;
}

// opts.parts overrides the configured parts; opts.localOnly skips the external location
// (used for the backup before an update).
async function backup(opts = {}) {
  const cfg = config();
  const parts = opts.parts ? PARTS.filter((p) => opts.parts.includes(p)) : PARTS.filter((p) => cfg.parts && cfg.parts[p]);
  if (!parts.length) throw new Error('Choose at least one part to back up');
  const id = stamp();
  const work = path.join(BACKUP_DIR, `.work-${id}`);
  await fsp.mkdir(path.join(work, 'database'), { recursive: true });
  const names = [];
  try {
    if (parts.includes('database')) await fsp.writeFile(path.join(work, 'database', 'data.json'), JSON.stringify(store.snapshot(), null, 2));
    const groups = cfg.layout === 'separate' ? parts.map((p) => [p]) : [parts];
    for (const group of groups) {
      log(`Packing ${group.join(', ')}`);
      names.push(await createArchive(id, group, work));
    }
  } finally {
    await fsp.rm(work, { recursive: true, force: true });
  }
  const size = (await Promise.all(names.map((n) => fsp.stat(path.join(BACKUP_DIR, n))))).reduce((a, s) => a + s.size, 0);
  log(`Backup ${id} written (${(size / 1e6).toFixed(1)} MB)`);

  const upload = remoteConfigured(cfg.remote) && !opts.localOnly;
  if (upload) {
    await withRemote(cfg.remote, async (r) => {
      for (const name of names) {
        log(`Uploading ${name} to ${cfg.remote.host}`);
        await r.upload(path.join(BACKUP_DIR, name), name);
      }
      await prune(r, Math.max(1, Number(cfg.keepRemote) || 1));
    });
    log('Upload complete');
  }
  // Without an external location at least the newest backup stays here.
  await prune(local, Math.max(upload ? 0 : 1, Number(cfg.keepLocal) || 0));
  log(`Backup ${id} complete`);
  return { id, files: names, size };
}

// ---------- restoring ----------
async function restore({ location, id, parts }) {
  const want = PARTS.filter((p) => (parts || []).includes(p));
  if (!want.length) throw new Error('Choose what to restore');
  const set = (await listSets(location)).find((s) => s.id === id);
  if (!set) throw new Error('Backup not found');
  const files = set.files.filter((f) => f.parts.some((p) => want.includes(p)));
  const missing = want.filter((p) => !set.parts.includes(p));
  if (missing.length) throw new Error(`This backup does not contain: ${missing.join(', ')}`);
  if (want.includes('app') && !fs.existsSync(PATH_UNIT)) throw new Error('Restoring the application needs the update service of the installer');

  const work = path.join(BACKUP_DIR, `.restore-${id}`);
  await fsp.rm(work, { recursive: true, force: true });
  await fsp.mkdir(work, { recursive: true });
  try {
    for (const f of files) {
      let file = path.join(BACKUP_DIR, f.name);
      if (location === 'remote') {
        file = path.join(work, f.name);
        log(`Downloading ${f.name}`);
        await withRemote(config().remote, (r) => r.download(f.name, file));
      }
      log(`Unpacking ${f.name}`);
      await run('tar', ['-xzf', file, '-C', work]);
    }
    const manifest = readJSON(path.join(work, 'manifest.json'));
    if (!manifest || manifest.app !== 'beeldkrant') throw new Error('This is not a Beeldkrant backup');

    if (want.includes('database')) {
      log('Restoring the database');
      store.replaceAll(readJSON(path.join(work, 'database', 'data.json')));
    }
    if (want.includes('media')) {
      log('Restoring the media');
      const incoming = path.join(work, 'media');
      if (!fs.existsSync(incoming)) throw new Error('The backup has no media folder');
      const old = `${store.MEDIA_DIR}.old`;
      await fsp.rm(old, { recursive: true, force: true });
      await fsp.rename(store.MEDIA_DIR, old);
      await fsp.rename(incoming, store.MEDIA_DIR);
      await fsp.rm(old, { recursive: true, force: true });
    }
    if (want.includes('app')) {
      // Replacing the code, installing its dependencies and restarting needs root: the update
      // service does that (see scripts/update.sh --restore-app).
      log('Handing the application over to the update service; Beeldkrant restarts shortly');
      await fsp.rm(RESTORE_APP_DIR, { recursive: true, force: true });
      await fsp.rename(path.join(work, 'app'), RESTORE_APP_DIR);
      await fsp.writeFile(REQUEST_FILE, `restore-app ${RESTORE_APP_DIR}\n`);
    }
  } finally {
    await fsp.rm(work, { recursive: true, force: true });
  }
  log(`Restored ${want.join(', ')} from backup ${id}`);
}

// ---------- jobs ----------
// Runs one backup or restore at a time in the background; status() reports on it.
function startJob(kind, fn, done = () => {}) {
  if (job.running) throw new Error(`A ${job.kind} is already running`);
  Object.assign(job, { running: true, kind, phase: 'Starting', startedAt: new Date().toISOString(), log: [] });
  log(kind === 'backup' ? 'Starting backup' : 'Starting restore');
  fn().then((result) => {
    saveLast({ [kind]: { at: new Date().toISOString(), ok: true, message: job.phase, ...(result || {}) } });
    job.running = false;
    done(null, result);
  }).catch((err) => {
    log(`Failed: ${err.message}`);
    console.error(`Backup: ${kind} failed:`, err.message);
    saveLast({ [kind]: { at: new Date().toISOString(), ok: false, message: err.message } });
    job.running = false;
    done(err);
  });
}

function status() {
  const cfg = config();
  return {
    running: job.running,
    kind: job.kind,
    phase: job.phase,
    startedAt: job.startedAt,
    log: job.log.slice(-100),
    last,
    remote: remoteConfigured(cfg.remote),
    canRestoreApp: fs.existsSync(PATH_UNIT),
    nextRun: nextRun(cfg),
  };
}

// ---------- schedule ----------
const DAYS = ['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat'];

function nextRun(cfg) {
  const s = cfg.schedule || {};
  if (!s.enabled || !(s.days || []).length) return null;
  const now = nowParts(store.getSection('settings').timezone);
  const [h, m] = String(s.time || '03:00').split(':').map(Number);
  const at = h * 60 + m;
  for (let i = 0; i < 8; i++) {
    const day = DAYS[(DAYS.indexOf(now.day) + i) % 7];
    if (s.days.includes(day) && (i > 0 || at > now.minutes)) return { day, time: s.time, inDays: i };
  }
  return null;
}

let lastSlot = last.lastSlot || null;
function tick() {
  const s = config().schedule || {};
  if (!s.enabled) return;
  const now = nowParts(store.getSection('settings').timezone);
  const [h, m] = String(s.time || '03:00').split(':').map(Number);
  const slot = `${now.date} ${s.time}`;
  if (!(s.days || []).includes(now.day) || now.minutes !== h * 60 + m || lastSlot === slot || job.running) return;
  lastSlot = slot;
  saveLast({ lastSlot: slot });
  startJob('backup', backup);
}

function start() {
  // Leftovers of a job that was interrupted by a restart.
  for (const name of fs.readdirSync(BACKUP_DIR)) {
    if (name.startsWith('.work-') || name.startsWith('.restore-') || name.endsWith('.part')) fs.rmSync(path.join(BACKUP_DIR, name), { recursive: true, force: true });
  }
  setInterval(tick, 20 * 1000);
}

module.exports = {
  BACKUP_DIR,
  NAME_RE,
  PARTS,
  status,
  start,
  listSets,
  withRemote,
  remoteConfigured,
  runBackup: (opts, done) => startJob('backup', () => backup(opts), done),
  runRestore: (opts) => startJob('restore', () => restore(opts)),
  async removeSet(location, id) {
    const remove = async (loc) => {
      const set = groupSets(await loc.list()).find((s) => s.id === id);
      if (!set) throw new Error('Backup not found');
      for (const f of set.files) await loc.remove(f.name);
    };
    if (location === 'remote') await withRemote(config().remote, remove);
    else await remove(local);
  },
};
