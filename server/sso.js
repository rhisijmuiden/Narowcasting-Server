'use strict';
// Microsoft Entra ID single sign-on (OpenID Connect, authorization code flow with PKCE).
//
//   /api/sso/start -> Microsoft sign-in -> /api/sso/callback -> ID token checked -> session
//
// Users that sign in with Entra are matched on their Entra object id, then on their e-mail or
// user principal name. With provisioning on, a new account is created on first sign-in; users can
// also be added from the directory (Microsoft Graph, needs the User.Read.All application permission).
const crypto = require('crypto');
const store = require('./store');
const auth = require('./auth');

// Overridable for testing against a local identity provider.
const AUTHORITY = (process.env.BK_ENTRA_AUTHORITY || 'https://login.microsoftonline.com').replace(/\/+$/, '');
const GRAPH = (process.env.BK_GRAPH_URL || 'https://graph.microsoft.com').replace(/\/+$/, '');
const states = new Map(); // state -> { verifier, nonce, redirectUri, expiresAt }
let jwks = { tenant: null, keys: [], fetchedAt: 0 };

function config() {
  return {
    enabled: false, tenantId: '', clientId: '', clientSecret: '', buttonLabel: 'Sign in with Microsoft',
    provisioning: false, defaultRole: 'readonly', defaultPermissions: {}, roleClaims: { admin: '', user: '', readonly: '' },
    ...(store.getSection('sso') || {}),
  };
}

function publicConfig() {
  const { clientSecret, ...rest } = config();
  return { ...rest, hasClientSecret: !!clientSecret };
}

function ready(c = config()) {
  return !!(c.enabled && c.tenantId && c.clientId && c.clientSecret);
}

const b64url = (buf) => Buffer.from(buf).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');

async function getJson(url, opts = {}) {
  const res = await fetch(url, { ...opts, signal: AbortSignal.timeout(15000) });
  const text = await res.text();
  let data;
  try { data = JSON.parse(text); } catch { data = { error_description: text.slice(0, 200) }; }
  if (!res.ok) {
    const msg = data.error_description || (data.error && (data.error.message || data.error)) || `HTTP ${res.status}`;
    throw Object.assign(new Error(String(msg).split('\r\n')[0].replace(/^AADSTS\d+:\s*/, '')), { status: res.status, code: data.error && (data.error.code || data.error) });
  }
  return data;
}

// The address Microsoft sends the user back to; it must be registered in the app registration.
function redirectUri(req) {
  const s = store.getSection('settings') || {};
  if (s.serverAddress && /^https?:\/\//i.test(s.serverAddress)) return `${s.serverAddress.replace(/\/+$/, '')}/api/sso/callback`;
  const proto = req.headers['x-forwarded-proto'] || (req.socket.encrypted ? 'https' : 'http');
  return `${proto}://${req.headers['x-forwarded-host'] || req.headers.host}/api/sso/callback`;
}

function startUrl(req) {
  const c = config();
  if (!ready(c)) throw new Error('Microsoft sign-in is not set up');
  const verifier = b64url(crypto.randomBytes(32));
  const state = b64url(crypto.randomBytes(18));
  const nonce = b64url(crypto.randomBytes(18));
  const uri = redirectUri(req);
  for (const [k, v] of states) if (v.expiresAt < Date.now()) states.delete(k);
  states.set(state, { verifier, nonce, redirectUri: uri, expiresAt: Date.now() + 10 * 60 * 1000 });
  const q = new URLSearchParams({
    client_id: c.clientId, response_type: 'code', redirect_uri: uri, response_mode: 'query', scope: 'openid profile email',
    state, nonce, code_challenge: b64url(crypto.createHash('sha256').update(verifier).digest()), code_challenge_method: 'S256', prompt: 'select_account',
  });
  return `${AUTHORITY}/${encodeURIComponent(c.tenantId)}/oauth2/v2.0/authorize?${q}`;
}

async function signingKey(tenant, kid) {
  if (jwks.tenant !== tenant || Date.now() - jwks.fetchedAt > 3600000 || !jwks.keys.some((k) => k.kid === kid)) {
    const data = await getJson(`${AUTHORITY}/${encodeURIComponent(tenant)}/discovery/v2.0/keys`);
    jwks = { tenant, keys: data.keys || [], fetchedAt: Date.now() };
  }
  const jwk = jwks.keys.find((k) => k.kid === kid);
  if (!jwk) throw new Error('Unknown signing key in the Microsoft token');
  return crypto.createPublicKey({ key: { kty: jwk.kty, n: jwk.n, e: jwk.e }, format: 'jwk' });
}

// Checks signature, issuer, audience, lifetime and nonce of an ID token and returns its claims.
async function verifyIdToken(idToken, c, nonce) {
  const [h, p, s] = String(idToken || '').split('.');
  if (!s) throw new Error('No ID token from Microsoft');
  const header = JSON.parse(Buffer.from(h, 'base64url').toString());
  const claims = JSON.parse(Buffer.from(p, 'base64url').toString());
  if (header.alg !== 'RS256') throw new Error('Unexpected token signature');
  const ok = crypto.verify('RSA-SHA256', Buffer.from(`${h}.${p}`), await signingKey(c.tenantId, header.kid), Buffer.from(s, 'base64url'));
  if (!ok) throw new Error('The Microsoft token signature is not valid');
  const now = Math.floor(Date.now() / 1000);
  if (claims.aud !== c.clientId) throw new Error('The token is for another application');
  if (claims.iss !== `${AUTHORITY}/${claims.tid}/v2.0`) throw new Error('The token comes from an unexpected issuer');
  if (c.tenantId && !/^(common|organizations)$/i.test(c.tenantId) && claims.tid !== c.tenantId && !/\./.test(c.tenantId)) throw new Error('The account is from another tenant');
  if (!(claims.exp > now - 120) || (claims.nbf && claims.nbf > now + 120)) throw new Error('The Microsoft token has expired');
  if (claims.nonce !== nonce) throw new Error('The sign-in did not match (nonce)');
  return claims;
}

// The role an Entra app role in the token gives, when role mapping is set up.
function mappedRole(c, claims) {
  const roles = claims.roles || [];
  for (const r of ['admin', 'user', 'readonly']) if (c.roleClaims[r] && roles.includes(c.roleClaims[r])) return r;
  return null;
}

function findSsoUser(claims) {
  const users = store.list('users');
  const byOid = users.find((u) => u.ssoOid && u.ssoOid === claims.oid);
  if (byOid) return byOid;
  const names = [claims.preferred_username, claims.email, claims.upn].filter(Boolean).map((x) => String(x).toLowerCase());
  return users.find((u) => u.authMethod === 'sso' && !u.ssoOid && (names.includes(String(u.email || '').toLowerCase()) || names.includes(u.username.toLowerCase()))) || null;
}

async function callback(req) {
  const { code, state, error, error_description: desc } = req.query;
  if (error) throw new Error(String(desc || error).split('\r\n')[0].replace(/^AADSTS\d+:\s*/, ''));
  const st = states.get(String(state || ''));
  states.delete(String(state || ''));
  if (!st || st.expiresAt < Date.now()) throw new Error('The sign-in took too long or was started elsewhere. Try again.');
  const c = config();
  if (!ready(c)) throw new Error('Microsoft sign-in is turned off');
  const token = await getJson(`${AUTHORITY}/${encodeURIComponent(c.tenantId)}/oauth2/v2.0/token`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ client_id: c.clientId, client_secret: c.clientSecret, grant_type: 'authorization_code', code: String(code || ''), redirect_uri: st.redirectUri, code_verifier: st.verifier, scope: 'openid profile email' }),
  });
  const claims = await verifyIdToken(token.id_token, c, st.nonce);
  const email = String(claims.email || claims.preferred_username || '').toLowerCase();
  const role = mappedRole(c, claims);
  let user = findSsoUser(claims);
  if (!user) {
    if (!c.provisioning) throw new Error(`There is no Beeldkrant account for ${email || 'this Microsoft account'}. Ask an admin to add you.`);
    const base = email || claims.oid;
    const username = auth.findByName(base) ? `${base}-${claims.oid.slice(0, 4)}` : base;
    user = store.create('users', {
      username, displayName: claims.name || '', email, authMethod: 'sso', ssoOid: claims.oid, provisioned: true,
      role: role || (auth.ROLES.includes(c.defaultRole) ? c.defaultRole : 'readonly'),
      permissions: { ...c.defaultPermissions },
    });
  } else {
    if (user.authMethod !== 'sso') throw new Error('This account signs in with a password, not with Microsoft');
    if (user.disabled) throw new Error('This account is disabled');
    const patch = { ssoOid: claims.oid, displayName: claims.name || user.displayName || '', email: email || user.email };
    if (role) patch.role = role;
    user = store.update('users', user.id, patch);
  }
  return user;
}

// Checks the tenant, the client id and secret, and whether the directory can be searched.
async function test(input) {
  const c = { ...config(), ...input };
  const steps = [];
  if (!c.tenantId || !c.clientId) throw new Error('Enter the tenant ID and the client ID');
  const meta = await getJson(`${AUTHORITY}/${encodeURIComponent(c.tenantId)}/v2.0/.well-known/openid-configuration`).catch((err) => { throw new Error(/tenant/i.test(err.message) ? err.message : `Tenant not found: ${err.message}`); });
  steps.push({ ok: true, text: `Tenant found (${meta.issuer.split('/')[3] || c.tenantId})` });
  if (!c.clientSecret) { steps.push({ ok: false, text: 'Enter the client secret' }); return { ok: false, steps }; }
  let access;
  try {
    access = await appToken(c);
    steps.push({ ok: true, text: 'Client ID and client secret accepted' });
  } catch (err) {
    steps.push({ ok: false, text: `Client ID or secret refused: ${err.message}` });
    return { ok: false, steps };
  }
  try {
    await getJson(`${GRAPH}/v1.0/users?$top=1&$select=id`, { headers: { Authorization: `Bearer ${access}` } });
    steps.push({ ok: true, text: 'Directory search works (User.Read.All)' });
  } catch {
    steps.push({ ok: null, text: 'Directory search not allowed: add the Microsoft Graph application permission User.Read.All (with admin consent) to add users from Entra. Sign-in works without it.' });
  }
  return { ok: true, steps };
}

let appTokenCache = { key: '', token: '', expiresAt: 0 };
async function appToken(c = config()) {
  const key = `${c.tenantId}|${c.clientId}|${c.clientSecret}`;
  if (appTokenCache.key === key && appTokenCache.expiresAt > Date.now() + 60000) return appTokenCache.token;
  const t = await getJson(`${AUTHORITY}/${encodeURIComponent(c.tenantId)}/oauth2/v2.0/token`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ client_id: c.clientId, client_secret: c.clientSecret, grant_type: 'client_credentials', scope: `${GRAPH}/.default` }),
  });
  appTokenCache = { key, token: t.access_token, expiresAt: Date.now() + (Number(t.expires_in) || 3600) * 1000 };
  return t.access_token;
}

// Users in the Entra directory whose name or e-mail starts with the search text.
async function searchDirectory(q) {
  const c = config();
  if (!c.tenantId || !c.clientId || !c.clientSecret) throw new Error('Configure SSO first');
  const access = await appToken(c);
  const text = String(q || '').replace(/["\\]/g, '').trim().slice(0, 60);
  const params = new URLSearchParams({ $select: 'id,displayName,userPrincipalName,mail,jobTitle,accountEnabled', $top: '25', $orderby: 'displayName' });
  if (text) params.set('$search', `"displayName:${text}" OR "mail:${text}" OR "userPrincipalName:${text}"`);
  const data = await getJson(`${GRAPH}/v1.0/users?${params}`, { headers: { Authorization: `Bearer ${access}`, ConsistencyLevel: 'eventual' } })
    .catch((err) => { throw new Error(err.status === 403 ? 'Not allowed to read the directory: add the Microsoft Graph application permission User.Read.All with admin consent' : err.message); });
  const users = store.list('users');
  return (data.value || []).map((u) => {
    const email = String(u.mail || u.userPrincipalName || '').toLowerCase();
    return {
      id: u.id, name: u.displayName, email, jobTitle: u.jobTitle || '', enabled: u.accountEnabled !== false,
      exists: users.some((x) => x.ssoOid === u.id || (email && String(x.email || '').toLowerCase() === email)),
    };
  });
}

module.exports = { config, publicConfig, ready, startUrl, callback, test, searchDirectory, redirectUri, AUTHORITY };
