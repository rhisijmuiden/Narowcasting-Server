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

const COLLECTIONS = ['media', 'feeds', 'playouts', 'schedule', 'users'];

function defaults() {
  return {
    media: [],
    feeds: [],
    playouts: [],
    schedule: [],
    users: [],
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
  };
}

const events = new EventEmitter();
let db = load();

function load() {
  try {
    const raw = JSON.parse(fs.readFileSync(DB_FILE, 'utf8'));
    const base = defaults();
    return {
      ...base,
      ...raw,
      settings: { ...base.settings, ...raw.settings },
      output: { ...base.output, ...raw.output },
    };
  } catch (err) {
    if (err.code !== 'ENOENT') console.error('Could not read data file, starting fresh:', err.message);
    return defaults();
  }
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
};
