'use strict';
// Station contract version 1: health, service token, base path and trusted proxies.
// Each group starts its own server in a fresh data directory. Run with `npm test`.
const { test, describe, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { startServer, PASSWORD } = require('./helpers');
const TOKEN = 'x'.repeat(16) + 'station-token-for-tests';

const get = (url, headers = {}) => fetch(url, { headers, redirect: 'manual' });
const login = (url) => fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ username: 'admin', password: PASSWORD }) });

describe('standalone (no station settings)', () => {
  let s;
  before(async () => { s = await startServer(); });
  after(() => s.stop());

  test('GET /healthz answers without a login', async () => {
    const res = await get(`${s.url}/healthz`);
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.deepEqual(Object.keys(body).sort(), ['app', 'contract', 'status', 'version']);
    assert.equal(body.status, 'ok');
    assert.equal(body.app, 'beeldkrant');
    assert.equal(body.contract, 1);
    assert.equal(body.version, require('../package.json').version);
  });

  test('/ still redirects to /admin/ and the admin panel is at the root', async () => {
    const res = await get(`${s.url}/`);
    assert.equal(res.status, 302);
    assert.equal(res.headers.get('location'), '/admin/');
    assert.equal((await get(`${s.url}/admin/`)).status, 200);
  });

  test('Bearer headers are ignored without a configured token', async () => {
    const res = await get(`${s.url}/api/settings`, { Authorization: `Bearer ${TOKEN}` });
    assert.equal(res.status, 401);
    assert.equal((await res.json()).error, 'Not logged in');
  });

  test('the session cookie has Path=/', async () => {
    const res = await login(`${s.url}/api/login`);
    assert.equal(res.status, 200);
    assert.match(res.headers.get('set-cookie'), /; Path=\/;/);
  });

  test('a local request is local, unless it carries X-Forwarded-For', async () => {
    assert.equal((await get(`${s.url}/api/player/state`)).status, 200);
    assert.equal((await get(`${s.url}/api/player/state`, { 'X-Forwarded-For': '203.0.113.7' })).status, 401);
  });
});

describe('service token', () => {
  let s;
  before(async () => { s = await startServer({ BK_SERVICE_TOKEN: TOKEN }); });
  after(() => s.stop());

  test('the right token is an admin on the API, without a cookie', async () => {
    const res = await get(`${s.url}/api/settings`, { Authorization: `Bearer ${TOKEN}` });
    assert.equal(res.status, 200);
    const created = await fetch(`${s.url}/api/folders`, { method: 'POST', headers: { Authorization: `Bearer ${TOKEN}`, 'Content-Type': 'application/json' }, body: JSON.stringify({ name: 'From the station' }) });
    assert.equal(created.status, 200);
    assert.equal((await created.json()).name, 'From the station');
    const users = await get(`${s.url}/api/users`, { Authorization: `Bearer ${TOKEN}` });
    assert.equal(users.status, 200);
  });

  test('a wrong token gets 401', async () => {
    for (const t of ['wrong', `${TOKEN}x`, TOKEN.slice(0, -1)]) {
      const res = await get(`${s.url}/api/settings`, { Authorization: `Bearer ${t}` });
      assert.equal(res.status, 401);
      assert.equal((await res.json()).error, 'Wrong service token');
    }
  });

  test('without a token the API still needs a login', async () => {
    assert.equal((await get(`${s.url}/api/settings`)).status, 401);
  });

  test('a token shorter than 32 characters is not accepted', async () => {
    const short = await startServer({ BK_SERVICE_TOKEN: 'too-short' });
    try {
      const res = await get(`${short.url}/api/settings`, { Authorization: 'Bearer too-short' });
      assert.equal(res.status, 401);
      assert.equal((await res.json()).error, 'Not logged in');
    } finally { short.stop(); }
  });
});

describe('base path', () => {
  let s;
  before(async () => { s = await startServer({ BK_BASE_PATH: '/channel1/' }); });
  after(() => s.stop());

  test('/healthz answers at the root and under the base path', async () => {
    for (const p of ['/healthz', '/channel1/healthz']) {
      const res = await get(`${s.url}${p}`);
      assert.equal(res.status, 200, p);
      assert.equal((await res.json()).contract, 1);
    }
  });

  test('redirects stay under the base path', async () => {
    let res = await get(`${s.url}/channel1`);
    assert.equal(res.status, 302);
    assert.equal(res.headers.get('location'), '/channel1/');
    res = await get(`${s.url}/channel1?x=1`);
    assert.equal(res.headers.get('location'), '/channel1/?x=1');
    res = await get(`${s.url}/channel1/`);
    assert.equal(res.status, 302);
    assert.equal(res.headers.get('location'), '/channel1/admin/');
  });

  test('pages, assets and the API are served under the base path only', async () => {
    assert.equal((await get(`${s.url}/channel1/admin/`)).status, 200);
    assert.equal((await get(`${s.url}/channel1/admin/app.js`)).status, 200);
    assert.equal((await get(`${s.url}/channel1/player/render.js`)).status, 200);
    assert.equal((await get(`${s.url}/channel1/api/auth/options`)).status, 200);
    assert.equal((await get(`${s.url}/admin/`)).status, 404);
    assert.equal((await get(`${s.url}/api/auth/options`)).status, 404);
  });

  test('the session cookie has Path=<base path> and works under it', async () => {
    const res = await login(`${s.url}/channel1/api/login`);
    assert.equal(res.status, 200);
    const cookie = res.headers.get('set-cookie');
    assert.match(cookie, /; Path=\/channel1;/);
    const me = await (await get(`${s.url}/channel1/api/me`, { Cookie: cookie.split(';')[0] })).json();
    assert.equal(me.user.username, 'admin');
    const out = await fetch(`${s.url}/channel1/api/logout`, { method: 'POST', headers: { Cookie: cookie.split(';')[0] } });
    assert.match(out.headers.get('set-cookie'), /; Path=\/channel1;/);
  });

  test('an invalid base path stops the server with a message', async () => {
    await assert.rejects(startServer({ BK_BASE_PATH: '/a b' }), /BK_BASE_PATH is not a valid path/);
  });
});

describe('trusted proxies', () => {
  // The module reads its settings once, so load a fresh copy per environment.
  function load(env) {
    const keys = ['BK_TRUSTED_PROXIES', 'BK_BASE_PATH', 'BK_SERVICE_TOKEN', 'BK_PUBLIC_URL'];
    const saved = Object.fromEntries(keys.map((k) => [k, process.env[k]]));
    for (const k of keys) delete process.env[k];
    Object.assign(process.env, env);
    delete require.cache[require.resolve('../server/station')];
    try { return require('../server/station'); } finally {
      for (const k of keys) { if (saved[k] === undefined) delete process.env[k]; else process.env[k] = saved[k]; }
    }
  }
  const req = (remoteAddress, headers = {}) => ({ socket: { remoteAddress }, headers });

  test('without a list: the socket address counts, and X-Forwarded-For is never local', () => {
    const st = load({});
    assert.equal(st.clientAddress(req('10.0.0.5', { 'x-forwarded-for': '203.0.113.7' })), '10.0.0.5');
    assert.equal(st.isLocal(req('127.0.0.1')), true);
    assert.equal(st.isLocal(req('::ffff:127.0.0.1')), true);
    assert.equal(st.isLocal(req('::1')), true);
    assert.equal(st.isLocal(req('127.0.0.1', { 'x-forwarded-for': '203.0.113.7' })), false);
    assert.equal(st.isLocal(req('127.0.0.1', { 'x-forwarded-for': '127.0.0.1' })), false);
    assert.equal(st.isLocal(req('10.0.0.5')), false);
    assert.equal(st.forwarded(req('10.0.0.5', { 'x-forwarded-proto': 'https' }), 'x-forwarded-proto'), 'https');
  });

  test('with a list: X-Forwarded-* is only believed from the proxies', () => {
    const st = load({ BK_TRUSTED_PROXIES: '10.0.0.1, 192.168.1.0/24,fd00::/8' });
    assert.equal(st.clientAddress(req('10.0.0.1', { 'x-forwarded-for': '203.0.113.7' })), '203.0.113.7');
    assert.equal(st.clientAddress(req('::ffff:192.168.1.20', { 'x-forwarded-for': '198.51.100.1, 203.0.113.7, 10.0.0.1' })), '203.0.113.7');
    assert.equal(st.clientAddress(req('fd00::2', { 'x-forwarded-for': '203.0.113.9' })), '203.0.113.9');
    assert.equal(st.clientAddress(req('10.0.0.9', { 'x-forwarded-for': '203.0.113.7' })), '10.0.0.9');
    assert.equal(st.clientAddress(req('10.0.0.1')), '10.0.0.1');
    assert.equal(st.forwarded(req('10.0.0.1', { 'x-forwarded-host': 'tv.example.com' }), 'x-forwarded-host'), 'tv.example.com');
    assert.equal(st.forwarded(req('10.0.0.9', { 'x-forwarded-host': 'evil.example.com' }), 'x-forwarded-host'), undefined);
    assert.equal(st.isLocal(req('127.0.0.1', { 'x-forwarded-for': '127.0.0.1' })), false);
  });

  test('a list with something that is not an address is refused', () => {
    assert.throws(() => load({ BK_TRUSTED_PROXIES: '10.0.0.1,proxy.local' }), /BK_TRUSTED_PROXIES/);
    assert.throws(() => load({ BK_TRUSTED_PROXIES: '10.0.0.0/33' }), /BK_TRUSTED_PROXIES/);
  });

  test('the renderer stays local behind a trusted proxy on this machine', async () => {
    const s = await startServer({ BK_TRUSTED_PROXIES: '127.0.0.1' });
    try {
      assert.equal((await get(`${s.url}/api/player/state`)).status, 200);
      assert.equal((await get(`${s.url}/api/player/state`, { 'X-Forwarded-For': '203.0.113.7' })).status, 401);
    } finally { s.stop(); }
  });
});
