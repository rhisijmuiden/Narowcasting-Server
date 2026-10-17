'use strict';
// Small JSON-file store. All state lives in DATA_DIR/data.json and is written atomically.
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { EventEmitter } = require('events');

const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, '..', 'data');
const MEDIA_DIR = path.join(DATA_DIR, 'media');
const DB_FILE = path.join(DATA_DIR, 'data.json');

fs.mkdirSync(MEDIA_DIR, { recursive: true });

const COLLECTIONS = ['media', 'folders', 'feeds', 'playouts', 'schedule', 'users', 'outputs', 'accounts', 'cameras'];

function defaults() {
  return {
    media: [],
    folders: [],
    feeds: [],
    playouts: [],
    schedule: [],
    users: [],
    // Stream destinations: { name, type: custom|youtube|facebook, mode: account|key, url, streamKey, accountId, enabled, ... }
    outputs: [],
    // IP cameras: { name, protocol: rtsp|rtmp|rtmps|rtp, url, username, password, transport, ignoreSsl, sdp, fps, maxWidth }
    cameras: [],
    // Linked YouTube / Facebook accounts with their tokens (never sent to the browser).
    accounts: [],
    // API credentials for linking accounts.
    connections: { googleClientId: '', googleClientSecret: '', facebookAppId: '', facebookClientToken: '' },
    settings: {
      defaultPlayoutId: null,
      timezone: process.env.TZ || 'Europe/Amsterdam',
      locale: 'en-GB',
      panelName: 'Beeldkrant',
    },
    output: {
      enabled: false,
      url: '',
      // 'playout' captures at the resolution of the playout on air; 'fixed' scales everything to width x height
      resolutionMode: 'playout',
      width: 1920,
      height: 1080,
      fps: 25,
      videoBitrate: 4500,
      audioBitrate: 128,
      preset: 'veryfast',
      audio: true,
      encoder: 'libx264',
    },
    // Password policy (users with Microsoft sign-in follow Entra's policy instead).
    security: { passwordPolicy: { minLength: 8, requireSpecial: false, requireMixed: false, expiryDays: 0 } },
    // Microsoft Entra ID single sign-on.
    sso: { enabled: false, tenantId: '', clientId: '', clientSecret: '', buttonLabel: 'Sign in with Microsoft', provisioning: false, defaultRole: 'readonly', defaultPermissions: {}, roleClaims: { admin: '', user: '', readonly: '' } },
    backup: {
      parts: { app: true, database: true, media: true },
      // 'single': one archive with every part; 'separate': one archive per part
      layout: 'single',
      schedule: { enabled: false, days: ['mon', 'tue', 'wed', 'thu', 'fri', 'sat', 'sun'], time: '03:00' },
      keepLocal: 5,
      keepRemote: 14,
      remote: { type: 'none', host: '', port: null, username: '', password: '', privateKey: '', path: '/beeldkrant-backups', allowSelfSigned: false },
    },
  };
}

const events = new EventEmitter();
let db = load();

function load() {
  try {
    return merge(JSON.parse(fs.readFileSync(DB_FILE, 'utf8')));
  } catch (err) {
    if (err.code !== 'ENOENT') console.error('Could not read data file, starting fresh:', err.message);
    return defaults();
  }
}

// Fills in defaults for anything an older data file does not have yet.
function merge(raw) {
  const base = defaults();
  const backup = raw.backup || {};
  // Before multiple outputs there was one destination in output.url.
  if (!raw.outputs && raw.output && raw.output.url) {
    raw.outputs = [{ id: id(), name: 'Main stream', type: 'custom', url: raw.output.url, enabled: true, createdAt: new Date().toISOString() }];
  }
  return {
    ...base,
    ...raw,
    settings: { ...base.settings, ...raw.settings },
    output: { ...base.output, ...raw.output },
    connections: { ...base.connections, ...raw.connections },
    security: { ...base.security, ...raw.security, passwordPolicy: { ...base.security.passwordPolicy, ...(raw.security || {}).passwordPolicy } },
    sso: { ...base.sso, ...raw.sso, roleClaims: { ...base.sso.roleClaims, ...(raw.sso || {}).roleClaims } },
    backup: {
      ...base.backup,
      ...backup,
      parts: { ...base.backup.parts, ...backup.parts },
      schedule: { ...base.backup.schedule, ...backup.schedule },
      remote: { ...base.backup.remote, ...backup.remote },
    },
  };
}

function save() {
  const tmp = DB_FILE + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(db, null, 2));
  fs.renameSync(tmp, DB_FILE);
  events.emit('change');
}

function id() {
  return crypto.randomBytes(6).toString('hex');
}

function list(col) {
  return db[col];
}

function get(col, itemId) {
  return db[col].find((x) => x.id === itemId) || null;
}

function create(col, data) {
  const item = { ...data, id: id(), createdAt: new Date().toISOString() };
  db[col].push(item);
  save();
  return item;
}

function update(col, itemId, data) {
  const idx = db[col].findIndex((x) => x.id === itemId);
  if (idx < 0) return null;
  db[col][idx] = { ...db[col][idx], ...data, id: itemId, updatedAt: new Date().toISOString() };
  save();
  return db[col][idx];
}

function remove(col, itemId) {
  const idx = db[col].findIndex((x) => x.id === itemId);
  if (idx < 0) return null;
  const [removed] = db[col].splice(idx, 1);
  save();
  return removed;
}

function getSection(name) {
  return db[name];
}

function setSection(name, data) {
  db[name] = { ...db[name], ...data };
  save();
  return db[name];
}

// A copy of the whole database, for backups.
function snapshot() {
  return JSON.parse(JSON.stringify(db));
}

// Replaces the whole database, for restoring a backup.
function replaceAll(raw) {
  if (!raw || typeof raw !== 'object' || !Array.isArray(raw.users)) throw new Error('This is not a Beeldkrant database');
  db = merge(raw);
  save();
}

module.exports = {
  DATA_DIR,
  MEDIA_DIR,
  COLLECTIONS,
  events,
  id,
  list,
  get,
  create,
  update,
  remove,
  getSection,
  setSection,
  snapshot,
  replaceAll,
};
