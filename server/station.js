'use strict';
// Optional hooks for running Beeldkrant as one part of Build My TV Station (station contract version 1,
// https://github.com/rhisijmuiden/BulldMyTVStation/blob/main/docs/station-contract.md):
//   BK_BASE_PATH        serve the whole app under a path, e.g. /channel1
//   BK_SERVICE_TOKEN    a Bearer token that counts as an admin on /api (at least 32 characters)
//   BK_PUBLIC_URL       the public address, used where Beeldkrant builds absolute links
//   BK_TRUSTED_PROXIES  IPs or CIDRs of the reverse proxy; only they may set X-Forwarded-* headers
// Every setting is off until it is set; with none of them set Beeldkrant behaves as a standalone install,
// except that a request with X-Forwarded-For never counts as coming from this machine.
const crypto = require('crypto');
const net = require('net');

const CONTRACT = 1;
const MIN_TOKEN_LENGTH = 32;

// '' for the root, else '/a/b' without a trailing slash.
function parseBasePath(value) {
  const p = String(value || '').trim().replace(/\/+$/, '');
  if (!p) return '';
  const withSlash = p.startsWith('/') ? p : `/${p}`;
  if (!/^(\/[A-Za-z0-9._~-]+)+$/.test(withSlash) || /\/\.\.?(\/|$)/.test(withSlash)) throw new Error(`BK_BASE_PATH is not a valid path: ${value}`);
  return withSlash;
}

// IPv4 addresses that reach us over IPv6 sockets look like ::ffff:10.0.0.1.
function plainAddress(a) {
  const s = String(a || '').trim();
  return s.startsWith('::ffff:') && net.isIPv4(s.slice(7)) ? s.slice(7) : s;
}

// A BlockList of the trusted proxies, or null when none are set.
function parseProxies(value) {
  const entries = String(value || '').split(',').map((s) => s.trim()).filter(Boolean);
  if (!entries.length) return null;
  const list = new net.BlockList();
  for (const entry of entries) {
    const [addr, bits, extra] = entry.split('/');
    const ip = plainAddress(addr);
    const type = net.isIPv4(ip) ? 'ipv4' : net.isIPv6(ip) ? 'ipv6' : null;
    const prefix = Number(bits);
    if (!type || extra !== undefined || (bits !== undefined && !(Number.isInteger(prefix) && prefix >= 0 && prefix <= (type === 'ipv4' ? 32 : 128)))) {
      throw new Error(`BK_TRUSTED_PROXIES has an entry that is not an IP address or CIDR: ${entry}`);
    }
    if (bits === undefined) list.addAddress(ip, type);
    else list.addSubnet(ip, prefix, type);
  }
  return list;
}

function parseToken(value) {
  const token = String(value || '');
  if (!token) return '';
  if (token.length < MIN_TOKEN_LENGTH) {
    console.error(`BK_SERVICE_TOKEN is shorter than ${MIN_TOKEN_LENGTH} characters and is ignored.`);
    return '';
  }
  return token;
}

const BASE_PATH = parseBasePath(process.env.BK_BASE_PATH);
const PUBLIC_URL = String(process.env.BK_PUBLIC_URL || '').trim().replace(/\/+$/, '');
const PROXIES = parseProxies(process.env.BK_TRUSTED_PROXIES);
const SERVICE_TOKEN = parseToken(process.env.BK_SERVICE_TOKEN);
const TOKEN_HASH = SERVICE_TOKEN && crypto.createHash('sha256').update(SERVICE_TOKEN).digest();

function isTrustedProxy(address) {
  if (!PROXIES) return false;
  const ip = plainAddress(address);
  const type = net.isIPv4(ip) ? 'ipv4' : net.isIPv6(ip) ? 'ipv6' : null;
  return !!type && PROXIES.check(ip, type);
}

const fromTrustedProxy = (req) => isTrustedProxy(req.socket.remoteAddress);

// The address of the client: the socket, or behind a trusted proxy the last X-Forwarded-For entry
// that is not one of the trusted proxies.
function clientAddress(req) {
  const socket = plainAddress(req.socket.remoteAddress);
  if (!fromTrustedProxy(req)) return socket;
  const chain = String(req.headers['x-forwarded-for'] || '').split(',').map(plainAddress).filter(Boolean);
  for (let i = chain.length - 1; i >= 0; i--) if (i === 0 || !isTrustedProxy(chain[i])) return chain[i];
  return socket;
}

// From this machine itself (the renderer's Chromium). A request that came through a proxy, i.e. carries
// X-Forwarded-For, never counts, even when the proxy runs on this machine.
function isLocal(req) {
  if (req.headers['x-forwarded-for'] !== undefined) return false;
  const a = plainAddress(req.socket.remoteAddress);
  return a === '127.0.0.1' || a === '::1';
}

// X-Forwarded-Proto and X-Forwarded-Host: as before when no proxies are set, else only from them.
function forwarded(req, name) {
  if (PROXIES && !fromTrustedProxy(req)) return undefined;
  return req.headers[name];
}

// The token from an "Authorization: Bearer" header, or null.
function bearer(req) {
  const m = /^Bearer\s+(\S+)\s*$/i.exec(req.headers.authorization || '');
  return m ? m[1] : null;
}

// Compares in constant time: both sides are hashed to the same length first.
function tokenMatches(token) {
  if (!TOKEN_HASH) return false;
  return crypto.timingSafeEqual(crypto.createHash('sha256').update(String(token)).digest(), TOKEN_HASH);
}

module.exports = {
  CONTRACT, BASE_PATH, PUBLIC_URL, SERVICE_TOKEN, MIN_TOKEN_LENGTH,
  parseBasePath, parseProxies, plainAddress, isTrustedProxy, clientAddress, isLocal, forwarded, bearer, tokenMatches,
};
