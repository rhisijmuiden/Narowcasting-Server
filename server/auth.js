'use strict';
// User accounts (scrypt password hashes) with HTTP-only session cookies.
// On first start an "admin" user is created with a one-time password that must be changed at first login.
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const store = require('./store');

const sessions = new Map(); // token -> { userId, expiresAt }
const SESSION_MS = 12 * 60 * 60 * 1000;
const INITIAL_PASSWORD_FILE = path.join(store.DATA_DIR, 'initial-admin-password');
const ROLES = ['admin', 'editor', 'viewer'];

function hash(password, salt = crypto.randomBytes(16).toString('hex')) {
  const key = crypto.scryptSync(String(password), salt, 32).toString('hex');
  return `${salt}:${key}`;
}

function check(password, stored) {
  if (!stored) return false;
  const [salt, key] = stored.split(':');
  const test = crypto.scryptSync(String(password), salt, 32);
  return crypto.timingSafeEqual(test, Buffer.from(key, 'hex'));
}

function randomPassword() {
  const alphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnpqrstuvwxyz23456789';
  return Array.from(crypto.randomBytes(14), (b) => alphabet[b % alphabet.length]).join('');
}

// Creates the first admin account when there are no users yet.
function bootstrap() {
  if (store.list('users').length) return;
  const password = process.env.BK_INITIAL_PASSWORD || randomPassword();
  store.create('users', { username: 'admin', role: 'admin', passwordHash: hash(password), mustChangePassword: true });
  fs.writeFileSync(INITIAL_PASSWORD_FILE, `${password}\n`, { mode: 0o600 });
  console.log(`Created user "admin" with one-time password: ${password}`);
  console.log(`(also stored in ${INITIAL_PASSWORD_FILE} until it is changed)`);
}

function publicUser(u) {
  return u && { id: u.id, username: u.username, role: u.role, mustChangePassword: !!u.mustChangePassword };
}

function findByName(username) {
  const name = String(username || '').trim().toLowerCase();
  return store.list('users').find((u) => u.username.toLowerCase() === name) || null;
}

function verify(username, password) {
  const user = findByName(username);
  if (!user) { hash(password); return null; } // keep timing similar
  return check(password, user.passwordHash) ? user : null;
}

function setPassword(userId, password) {
  store.update('users', userId, { passwordHash: hash(password), mustChangePassword: false });
  const remaining = store.list('users').some((u) => u.mustChangePassword && u.username === 'admin');
  if (!remaining) fs.rm(INITIAL_PASSWORD_FILE, { force: true }, () => {});
}

function parseCookies(req) {
  return Object.fromEntries((req.headers.cookie || '').split(';').filter(Boolean).map((c) => {
    const i = c.indexOf('=');
    return [c.slice(0, i).trim(), decodeURIComponent(c.slice(i + 1).trim())];
  }));
}

function login(res, user) {
  const token = crypto.randomBytes(24).toString('hex');
  sessions.set(token, { userId: user.id, expiresAt: Date.now() + SESSION_MS });
  res.setHeader('Set-Cookie', `bk_session=${token}; HttpOnly; SameSite=Strict; Path=/; Max-Age=${SESSION_MS / 1000}`);
}

function logout(req, res) {
  sessions.delete(parseCookies(req).bk_session);
  res.setHeader('Set-Cookie', 'bk_session=; HttpOnly; SameSite=Strict; Path=/; Max-Age=0');
}

function currentUser(req) {
  const token = parseCookies(req).bk_session;
  const s = token && sessions.get(token);
  if (!s) return null;
  if (s.expiresAt < Date.now()) { sessions.delete(token); return null; }
  const user = store.get('users', s.userId);
  if (!user) { sessions.delete(token); return null; }
  return user;
}

function isAuthenticated(req) {
  const user = currentUser(req);
  return !!user && !user.mustChangePassword;
}

// Logged in, and the one-time password has been replaced.
function requireAuth(req, res, next) {
  const user = currentUser(req);
  if (!user) return res.status(401).json({ error: 'Not logged in' });
  if (user.mustChangePassword) return res.status(403).json({ error: 'Change your password first', mustChangePassword: true });
  req.user = user;
  next();
}

// For the upcoming user management: admin > editor > viewer.
function requireRole(role) {
  return (req, res, next) => {
    const user = req.user || currentUser(req);
    if (!user || ROLES.indexOf(user.role) > ROLES.indexOf(role)) return res.status(403).json({ error: 'Not allowed for your role' });
    next();
  };
}

module.exports = { ROLES, bootstrap, verify, setPassword, check, publicUser, currentUser, login, logout, isAuthenticated, requireAuth, requireRole };
