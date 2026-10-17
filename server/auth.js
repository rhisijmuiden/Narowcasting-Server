'use strict';
// User accounts (scrypt password hashes) with HTTP-only session cookies, roles and permissions,
// the password policy and two-step verification (TOTP authenticator apps).
// On first start an "admin" user is created with a one-time password that must be changed at first login.
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const store = require('./store');
const station = require('./station');

const sessions = new Map(); // token -> { userId, expiresAt }
const pending = new Map(); // login ticket -> { userId, stage: 'verify'|'setup', secret, expiresAt }
const SESSION_MS = 12 * 60 * 60 * 1000;
const TICKET_MS = 5 * 60 * 1000;
const INITIAL_PASSWORD_FILE = path.join(store.DATA_DIR, 'initial-admin-password');
const COOKIE_PATH = station.BASE_PATH || '/';
// What a request with the service token (BK_SERVICE_TOKEN) acts as: an admin that is not in the user list.
const SERVICE_USER = Object.freeze({ id: 'service-token', username: 'service-token', displayName: 'Service token', role: 'admin', authMethod: 'password', mustChangePassword: false });

// Admin can do everything; a user can do what their permissions allow; read only can only look.
const ROLES = ['admin', 'user', 'readonly'];
const PERMISSIONS = {
  playouts: 'Playouts and scenes',
  media: 'Media, RSS feeds, input streams and IP cameras',
  schedule: 'Schedule',
  outputs: 'Outputs, routing and starting or stopping the stream',
  settings: 'Application settings',
  backups: 'Backups and restore',
};
const allPermissions = () => Object.fromEntries(Object.keys(PERMISSIONS).map((p) => [p, true]));

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

// Creates the first admin account when there are no users yet, and moves accounts from before
// roles and permissions (editor, viewer) to the new roles.
function bootstrap() {
  for (const u of store.list('users')) {
    if (u.role === 'editor') store.update('users', u.id, { role: 'user', permissions: { ...allPermissions(), settings: false, backups: false } });
    else if (u.role === 'viewer') store.update('users', u.id, { role: 'readonly' });
  }
  if (store.list('users').length) return;
  const password = process.env.BK_INITIAL_PASSWORD || randomPassword();
  store.create('users', { username: 'admin', role: 'admin', authMethod: 'password', passwordHash: hash(password), passwordChangedAt: new Date().toISOString(), mustChangePassword: true });
  fs.writeFileSync(INITIAL_PASSWORD_FILE, `${password}\n`, { mode: 0o600 });
  console.log(`Created user "admin" with one-time password: ${password}`);
  console.log(`(also stored in ${INITIAL_PASSWORD_FILE} until it is changed)`);
}

// Gives the user "admin" a new one-time password that must be changed at the next login (creating the
// user when it is gone) and returns it. Used by `beeldkrant-station --reset-admin` while the service is stopped.
function resetAdmin() {
  const password = randomPassword();
  let admin = store.list('users').find((u) => u.username === 'admin');
  if (!admin) admin = store.create('users', { username: 'admin', role: 'admin', authMethod: 'password' });
  store.update('users', admin.id, { role: 'admin', authMethod: 'password', disabled: false });
  setPassword(admin.id, password, { mustChange: true });
  fs.writeFileSync(INITIAL_PASSWORD_FILE, `${password}\n`, { mode: 0o600 });
  return password;
}

function permissionsOf(u) {
  if (!u) return {};
  if (u.role === 'admin') return allPermissions();
  if (u.role === 'user') return Object.fromEntries(Object.keys(PERMISSIONS).map((p) => [p, !!(u.permissions || {})[p]]));
  return Object.fromEntries(Object.keys(PERMISSIONS).map((p) => [p, false]));
}

function can(u, perm) {
  return !!u && (u.role === 'admin' || (u.role === 'user' && !!(u.permissions || {})[perm]));
}

function publicUser(u) {
  return u && {
    id: u.id,
    username: u.username,
    displayName: u.displayName || '',
    email: u.email || '',
    role: u.role,
    permissions: permissionsOf(u),
    authMethod: u.authMethod === 'sso' ? 'sso' : 'password',
    mustChangePassword: !!u.mustChangePassword,
    passwordExpired: !!u.passwordExpired,
    mfaRequired: !!u.mfaRequired,
    mfaEnabled: !!u.totpSecret,
    theme: u.theme || 'system',
  };
}

// What the users page shows about each account.
function adminUser(u) {
  return { ...publicUser(u), disabled: !!u.disabled, lastLoginAt: u.lastLoginAt || null, passwordChangedAt: u.passwordChangedAt || null, ssoLinked: !!u.ssoOid, createdAt: u.createdAt };
}

function findByName(username) {
  const name = String(username || '').trim().toLowerCase();
  return store.list('users').find((u) => u.username.toLowerCase() === name) || null;
}

function verify(username, password) {
  const user = findByName(username);
  if (!user || !user.passwordHash) { hash(password); return null; } // keep timing similar
  return check(password, user.passwordHash) ? user : null;
}

// ---------- password policy ----------
function policy() {
  return { minLength: 8, requireSpecial: false, requireMixed: false, expiryDays: 0, ...(store.getSection('security') || {}).passwordPolicy };
}

// An error message when a password does not meet the policy, else null.
function policyError(password) {
  const p = policy();
  const pw = String(password || '');
  if (pw.length < p.minLength) return `Use at least ${p.minLength} characters`;
  if (p.requireSpecial && !/[^A-Za-z0-9]/.test(pw)) return 'Use at least one special character, such as ! ? # or %';
  if (p.requireMixed && !(/[a-z]/.test(pw) && /[A-Z]/.test(pw) && /[0-9]/.test(pw))) return 'Use upper case and lower case letters and a number';
  return null;
}

function passwordExpired(u) {
  const days = Number(policy().expiryDays) || 0;
  if (!days || u.authMethod === 'sso' || !u.passwordHash) return false;
  const since = Date.parse(u.passwordChangedAt || u.createdAt || 0) || 0;
  return Date.now() - since > days * 86400000;
}

function setPassword(userId, password, { mustChange = false } = {}) {
  store.update('users', userId, { passwordHash: hash(password), passwordChangedAt: new Date().toISOString(), mustChangePassword: mustChange, passwordExpired: false });
  const remaining = store.list('users').some((u) => u.mustChangePassword && u.username === 'admin');
  if (!remaining) fs.rm(INITIAL_PASSWORD_FILE, { force: true }, () => {});
}

// ---------- two-step verification (TOTP, RFC 6238) ----------
const B32 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
function base32(buf) {
  let bits = 0; let value = 0; let out = '';
  for (const b of buf) {
    value = (value << 8) | b; bits += 8;
    while (bits >= 5) { out += B32[(value >>> (bits - 5)) & 31]; bits -= 5; }
  }
  if (bits > 0) out += B32[(value << (5 - bits)) & 31];
  return out;
}
function unbase32(str) {
  let bits = 0; let value = 0; const out = [];
  for (const c of String(str).replace(/[\s=]/g, '').toUpperCase()) {
    const i = B32.indexOf(c);
    if (i < 0) continue;
    value = (value << 5) | i; bits += 5;
    if (bits >= 8) { out.push((value >>> (bits - 8)) & 255); bits -= 8; }
  }
  return Buffer.from(out);
}
function totp(secret, step = Math.floor(Date.now() / 30000)) {
  const msg = Buffer.alloc(8);
  msg.writeBigUInt64BE(BigInt(step));
  const h = crypto.createHmac('sha1', unbase32(secret)).update(msg).digest();
  const o = h[h.length - 1] & 15;
  return String((h.readUInt32BE(o) & 0x7fffffff) % 1000000).padStart(6, '0');
}
// Accepts the code of the previous, current and next 30 seconds (clock drift).
function checkTotp(secret, code) {
  const c = String(code || '').replace(/\s/g, '');
  if (!/^\d{6}$/.test(c)) return false;
  const now = Math.floor(Date.now() / 30000);
  return [-1, 0, 1].some((d) => crypto.timingSafeEqual(Buffer.from(totp(secret, now + d)), Buffer.from(c)));
}
function newMfaSecret() {
  return base32(crypto.randomBytes(20));
}
function otpauthUrl(user, secret) {
  const issuer = (store.getSection('settings') || {}).panelName || 'Beeldkrant';
  const label = encodeURIComponent(`${issuer}:${user.username}`);
  return `otpauth://totp/${label}?secret=${secret}&issuer=${encodeURIComponent(issuer)}&algorithm=SHA1&digits=6&period=30`;
}
// One-time recovery codes, shown once; only their hashes are kept.
function newRecoveryCodes() {
  return Array.from({ length: 8 }, () => {
    const s = crypto.randomBytes(5).toString('hex');
    return `${s.slice(0, 5)}-${s.slice(5)}`;
  });
}
function enableMfa(userId, secret) {
  const codes = newRecoveryCodes();
  store.update('users', userId, { totpSecret: secret, recoveryCodes: codes.map((c) => hash(c)) });
  return codes;
}
function useRecoveryCode(user, code) {
  const c = String(code || '').trim().toLowerCase();
  const list = user.recoveryCodes || [];
  const i = list.findIndex((hsh) => check(c, hsh));
  if (i < 0) return false;
  store.update('users', user.id, { recoveryCodes: list.filter((_, j) => j !== i) });
  return true;
}

// ---------- login steps ----------
// After the password: either a session, or a ticket for the second step.
function startLogin(res, user) {
  if (user.totpSecret || user.mfaRequired) {
    const ticket = crypto.randomBytes(24).toString('hex');
    const stage = user.totpSecret ? 'verify' : 'setup';
    const p = { userId: user.id, stage, expiresAt: Date.now() + TICKET_MS, tries: 0 };
    if (stage === 'setup') p.secret = newMfaSecret();
    pending.set(ticket, p);
    return { mfa: stage, ticket, ...(stage === 'setup' ? { secret: p.secret, otpauth: otpauthUrl(user, p.secret) } : {}) };
  }
  return finishLogin(res, user);
}

function finishLogin(res, user) {
  const patch = { lastLoginAt: new Date().toISOString() };
  if (passwordExpired(user)) Object.assign(patch, { mustChangePassword: true, passwordExpired: true });
  const u = store.update('users', user.id, patch);
  login(res, u);
  return { ok: true, user: publicUser(u) };
}

// The second step: a code from the app (or a recovery code); while setting up, the first code
// turns two-step verification on and returns the recovery codes.
function secondStep(res, ticket, code) {
  const p = pending.get(String(ticket || ''));
  if (!p || p.expiresAt < Date.now()) { pending.delete(ticket); throw Object.assign(new Error('This login has expired. Log in again.'), { status: 401 }); }
  const user = store.get('users', p.userId);
  if (!user || user.disabled) { pending.delete(ticket); throw Object.assign(new Error('Not allowed'), { status: 401 }); }
  if (++p.tries > 6) { pending.delete(ticket); throw Object.assign(new Error('Too many wrong codes. Log in again.'), { status: 401 }); }
  if (p.stage === 'setup') {
    if (!checkTotp(p.secret, code)) throw Object.assign(new Error('That code is not right. Check the time on your phone and try the newest code.'), { status: 400 });
    pending.delete(ticket);
    const recoveryCodes = enableMfa(user.id, p.secret);
    return { ...finishLogin(res, store.get('users', user.id)), recoveryCodes };
  }
  const ok = checkTotp(user.totpSecret, code) || useRecoveryCode(user, code);
  if (!ok) throw Object.assign(new Error('That code is not right'), { status: 400 });
  pending.delete(ticket);
  return finishLogin(res, user);
}

// ---------- sessions ----------
function parseCookies(req) {
  return Object.fromEntries((req.headers.cookie || '').split(';').filter(Boolean).map((c) => {
    const i = c.indexOf('=');
    return [c.slice(0, i).trim(), decodeURIComponent(c.slice(i + 1).trim())];
  }));
}

function login(res, user) {
  const token = crypto.randomBytes(24).toString('hex');
  sessions.set(token, { userId: user.id, expiresAt: Date.now() + SESSION_MS });
  // Lax so the session cookie also comes along on the redirect back from Microsoft sign-in.
  res.setHeader('Set-Cookie', `bk_session=${token}; HttpOnly; SameSite=Lax; Path=${COOKIE_PATH}; Max-Age=${SESSION_MS / 1000}`);
}

function logout(req, res) {
  sessions.delete(parseCookies(req).bk_session);
  res.setHeader('Set-Cookie', `bk_session=; HttpOnly; SameSite=Lax; Path=${COOKIE_PATH}; Max-Age=0`);
}

// Ends every session of a user (deleted, disabled, or their sign-in changed).
function endSessions(userId) {
  for (const [token, s] of sessions) if (s.userId === userId) sessions.delete(token);
}

// With BK_SERVICE_TOKEN set, a request with "Authorization: Bearer <token>" is an admin on /api, without
// a cookie; a wrong token gets 401. Without a configured token Bearer headers are ignored.
function serviceToken(req, res, next) {
  if (!station.SERVICE_TOKEN) return next();
  const token = station.bearer(req);
  if (token === null) return next();
  if (!station.tokenMatches(token)) return res.status(401).json({ error: 'Wrong service token' });
  req.serviceToken = true;
  next();
}

function currentUser(req) {
  if (req.serviceToken) return SERVICE_USER;
  const token = parseCookies(req).bk_session;
  const s = token && sessions.get(token);
  if (!s) return null;
  if (s.expiresAt < Date.now()) { sessions.delete(token); return null; }
  const user = store.get('users', s.userId);
  if (!user || user.disabled) { sessions.delete(token); return null; }
  return user;
}

function isAuthenticated(req) {
  const user = currentUser(req);
  return !!user && !user.mustChangePassword;
}

// Logged in, and the one-time or expired password has been replaced.
function requireAuth(req, res, next) {
  const user = currentUser(req);
  if (!user) return res.status(401).json({ error: 'Not logged in' });
  if (user.mustChangePassword) return res.status(403).json({ error: 'Change your password first', mustChangePassword: true });
  req.user = user;
  next();
}

function requireRole(role) {
  return (req, res, next) => {
    const user = req.user || currentUser(req);
    if (!user || ROLES.indexOf(user.role) > ROLES.indexOf(role)) return res.status(403).json({ error: 'Only an admin can do this' });
    next();
  };
}

function requirePerm(perm) {
  return (req, res, next) => {
    const user = req.user || currentUser(req);
    if (!can(user, perm)) return res.status(403).json({ error: user && user.role === 'readonly' ? 'Your account is read only' : `You do not have the permission "${PERMISSIONS[perm]}"` });
    next();
  };
}

module.exports = {
  ROLES, PERMISSIONS, allPermissions, bootstrap, resetAdmin, serviceToken, verify, setPassword, check, hash, publicUser, adminUser, currentUser, login, logout, endSessions,
  isAuthenticated, requireAuth, requireRole, requirePerm, can, permissionsOf, policy, policyError, passwordExpired, findByName,
  startLogin, finishLogin, secondStep, newMfaSecret, otpauthUrl, checkTotp, enableMfa, totp,
};
