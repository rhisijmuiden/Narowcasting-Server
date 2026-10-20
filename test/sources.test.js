'use strict';
// Feed kinds (iCal, Outlook, Instagram, Facebook), departure boards and QR codes, against a local
// stand-in for the outside services. Run with `npm test`.
const { test, describe, before, after } = require('node:test');
const assert = require('node:assert/strict');
const http = require('http');
const { startServer, freePort } = require('./helpers');

const TOKEN = 'y'.repeat(16) + 'sources-token-for-tests';
const HOUR = 3600 * 1000;
const DAY = 24 * HOUR;
const ics = (d) => d.toISOString().replace(/[-:]/g, '').replace(/\.\d{3}/, '');
const icsDay = (d) => d.toISOString().slice(0, 10).replace(/-/g, '');

// What the stand-in received, for checks on the requests Beeldkrant makes.
const seen = [];

function calendar() {
  const now = Date.now();
  const tomorrow = new Date(now + DAY);
  tomorrow.setUTCHours(10, 0, 0, 0);
  const inThreeDays = new Date(now + 3 * DAY);
  return [
    'BEGIN:VCALENDAR', 'VERSION:2.0', 'PRODID:-//test//EN', 'X-WR-CALNAME:Team calendar',
    'BEGIN:VEVENT', 'UID:past@test', `DTSTART:${ics(new Date(now - 3 * DAY))}`, `DTEND:${ics(new Date(now - 3 * DAY + HOUR))}`, 'SUMMARY:Already over', 'END:VEVENT',
    'BEGIN:VEVENT', 'UID:meeting@test', `DTSTART:${ics(tomorrow)}`, `DTEND:${ics(new Date(tomorrow.getTime() + HOUR))}`, 'SUMMARY:Board meeting', 'LOCATION:Room 1', 'END:VEVENT',
    'BEGIN:VEVENT', 'UID:daily@test', `DTSTART:${ics(new Date(now - 2 * DAY + 2 * HOUR))}`, `DTEND:${ics(new Date(now - 2 * DAY + 3 * HOUR))}`, 'RRULE:FREQ=DAILY;COUNT=4', 'SUMMARY:Stand-up', 'END:VEVENT',
    'BEGIN:VEVENT', 'UID:allday@test', `DTSTART;VALUE=DATE:${icsDay(inThreeDays)}`, `DTEND;VALUE=DATE:${icsDay(new Date(inThreeDays.getTime() + DAY))}`, 'SUMMARY:Open day', 'END:VEVENT',
    'BEGIN:VEVENT', 'UID:cancelled@test', `DTSTART:${ics(new Date(now + 2 * DAY))}`, 'STATUS:CANCELLED', 'SUMMARY:Called off', 'END:VEVENT',
    'END:VCALENDAR',
  ].join('\r\n');
}

function standIn(req, res) {
  const url = new URL(req.url, 'http://x');
  seen.push(url);
  const json = (code, body) => { res.writeHead(code, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(body)); };
  if (url.pathname === '/cal.ics') { res.writeHead(200, { 'Content-Type': 'text/calendar' }); return res.end(calendar()); }
  if (url.pathname === '/not-a-calendar') { res.writeHead(200); return res.end('<html></html>'); }
  // Instagram API with Instagram Login
  if (url.pathname === '/refresh_access_token') return json(200, { access_token: 'renewed-token', token_type: 'bearer', expires_in: 5184000 });
  if (url.pathname === '/me/media') {
    if (url.searchParams.get('access_token') !== 'renewed-token') return json(400, { error: { message: 'Invalid OAuth access token', code: 190 } });
    return json(200, { data: [
      { id: '1', caption: 'Summer party!\nSee you there', media_type: 'IMAGE', media_url: 'https://cdn.example/1.jpg', permalink: 'https://instagram.com/p/1', timestamp: '2026-10-01T10:00:00+0000', username: 'acme' },
      { id: '2', caption: 'A video', media_type: 'VIDEO', media_url: 'https://cdn.example/2.mp4', thumbnail_url: 'https://cdn.example/2.jpg', permalink: 'https://instagram.com/p/2', timestamp: '2026-09-30T10:00:00+0000', username: 'acme' },
    ] });
  }
  // Microsoft Entra and Graph
  if (/\/oauth2\/v2\.0\/token$/.test(url.pathname)) return json(200, { access_token: 'graph-token', expires_in: 3600 });
  if (decodeURIComponent(url.pathname) === '/v1.0/users/room1@example.com/calendarView') {
    if (req.headers.authorization !== 'Bearer graph-token') return json(401, { error: { message: 'No token' } });
    const start = new Date(Date.now() + HOUR);
    return json(200, { value: [
      { subject: 'Sales review', start: { dateTime: start.toISOString().replace('Z', '0000'), timeZone: 'UTC' }, end: { dateTime: new Date(start.getTime() + HOUR).toISOString().replace('Z', '0000'), timeZone: 'UTC' }, isAllDay: false, location: { displayName: 'Room 1' }, sensitivity: 'normal', bodyPreview: 'Q3 numbers' },
      { subject: 'Doctor', start: { dateTime: new Date(start.getTime() + 2 * HOUR).toISOString().replace('Z', '0000'), timeZone: 'UTC' }, end: { dateTime: new Date(start.getTime() + 3 * HOUR).toISOString().replace('Z', '0000'), timeZone: 'UTC' }, isAllDay: false, location: { displayName: 'Secret place' }, sensitivity: 'private', bodyPreview: 'private' },
      { subject: 'Gone', start: { dateTime: start.toISOString().replace('Z', '0000') }, end: { dateTime: start.toISOString().replace('Z', '0000') }, isCancelled: true },
    ] });
  }
  // MOTIS (Transitous)
  if (url.pathname === '/api/v1/geocode') {
    return json(200, [
      { type: 'STOP', name: 'Utrecht Centraal', id: 'nl_8400621', lat: 52.09, lon: 5.11, areas: [{ name: 'Utrecht', adminLevel: 8, matched: false }], score: 1, modes: ['RAIL', 'BUS'], tokens: [] },
      { type: 'ADDRESS', name: 'Utrechtseweg 1', id: 'addr', lat: 0, lon: 0, areas: [], score: 0.5, tokens: [] },
    ]);
  }
  if (url.pathname === '/api/v6/stoptimes') {
    const t = (min) => new Date(Date.now() + min * 60000).toISOString();
    return json(200, { place: { name: 'Utrecht Centraal' }, previousPageCursor: '', nextPageCursor: '', stopTimes: [
      { place: { name: 'Utrecht Centraal', departure: t(12), scheduledDeparture: t(9), track: '7', scheduledTrack: '5' }, mode: 'REGIONAL_RAIL', realTime: true, headsign: 'Amersfoort', routeShortName: 'SPR', agencyName: 'NS', cancelled: false, tripCancelled: false },
      { place: { name: 'Utrecht Centraal', departure: t(4), scheduledDeparture: t(4), track: 'C3' }, mode: 'BUS', realTime: false, headsign: 'Zeist', routeShortName: '50', routeColor: 'E30613', routeTextColor: 'FFFFFF', cancelled: false, tripCancelled: false },
      { place: { name: 'Utrecht Centraal', departure: t(20), scheduledDeparture: t(20) }, mode: 'TRAM', realTime: true, headsign: 'IJsselstein', routeShortName: '21', cancelled: false, tripCancelled: true },
      { place: { name: 'Utrecht Centraal', departure: t(-10), scheduledDeparture: t(-10) }, mode: 'BUS', realTime: true, headsign: 'Gone', routeShortName: '1', cancelled: false, tripCancelled: false },
    ] });
  }
  json(404, { error: { message: 'not here' } });
}

describe('feed kinds, departures and QR codes', () => {
  let s;
  let mock;
  let mockUrl;
  const api = (path, opts = {}) => fetch(`${s.url}${path}`, { ...opts, headers: { Authorization: `Bearer ${TOKEN}`, 'Content-Type': 'application/json', ...(opts.headers || {}) } });
  const create = async (feed) => { const res = await api('/api/feeds', { method: 'POST', body: JSON.stringify(feed) }); return { status: res.status, body: await res.json() }; };
  const items = async (id) => (await api(`/api/feeds/${id}/items?force=1`)).json();

  before(async () => {
    const port = await freePort();
    mockUrl = `http://127.0.0.1:${port}`;
    mock = http.createServer(standIn);
    await new Promise((r) => mock.listen(port, '127.0.0.1', r));
    s = await startServer({
      BK_SERVICE_TOKEN: TOKEN, TZ: 'UTC',
      BK_INSTAGRAM_GRAPH_URL: mockUrl, BK_MOTIS_URL: mockUrl, BK_ENTRA_AUTHORITY: mockUrl, BK_GRAPH_URL: mockUrl,
    });
  });
  after(() => { s.stop(); mock.close(); });

  test('an iCal feed gives upcoming appointments in order, with repeats expanded', async () => {
    const { status, body } = await create({ kind: 'ical', name: 'Team', url: `${mockUrl}/cal.ics`, daysAhead: 7 });
    assert.equal(status, 200);
    const res = await items(body.id);
    assert.equal(res.error, null);
    assert.equal(res.title, 'Team calendar');
    const titles = res.items.map((i) => i.title);
    assert.ok(!titles.includes('Already over'));
    assert.ok(!titles.includes('Called off'));
    assert.ok(titles.includes('Board meeting'));
    // The daily stand-up started two days ago and runs 4 times: today and tomorrow remain.
    assert.equal(titles.filter((t) => t === 'Stand-up').length, 2);
    const meeting = res.items.find((i) => i.title === 'Board meeting');
    assert.equal(meeting.location, 'Room 1');
    assert.equal(meeting.allDay, false);
    assert.equal(Date.parse(meeting.end) - Date.parse(meeting.date), HOUR);
    const open = res.items.find((i) => i.title === 'Open day');
    assert.equal(open.allDay, true);
    assert.match(open.date, /^\d{4}-\d{2}-\d{2}$/);
    const starts = res.items.map((i) => (i.allDay ? `${i.date}T00:00:00.000Z` : i.date));
    assert.deepEqual(starts, [...starts].sort());
  });

  test('a link that is not a calendar gives a clear error', async () => {
    const { body } = await create({ kind: 'ical', name: 'Bad', url: `${mockUrl}/not-a-calendar` });
    assert.match((await items(body.id)).error, /not an iCal/);
  });

  test('an Outlook calendar reads the mailbox through Graph and hides private appointments', async () => {
    const sso = await api('/api/sso', { method: 'PUT', body: JSON.stringify({ tenantId: 'contoso.onmicrosoft.com', clientId: 'app', clientSecret: 'secret' }) });
    assert.equal(sso.status, 200);
    assert.equal((await create({ kind: 'outlook', name: 'Room', mailbox: 'not an address' })).status, 400);
    const { body } = await create({ kind: 'outlook', name: 'Room 1', mailbox: 'room1@example.com' });
    const res = await items(body.id);
    assert.equal(res.error, null);
    assert.deepEqual(res.items.map((i) => i.title), ['Sales review', 'Private appointment']);
    assert.equal(res.items[0].location, 'Room 1');
    assert.equal(res.items[1].location, '');
    assert.equal(res.items[1].description, '');
    assert.ok(res.items[0].date.endsWith('Z'));
  });

  test('an Instagram feed renews its token, gives posts and never shows the token', async () => {
    assert.equal((await create({ kind: 'instagram', name: 'Insta' })).status, 400);
    const { body } = await create({ kind: 'instagram', name: 'Insta', accessToken: 'first-token' });
    assert.equal(body.accessToken, undefined);
    assert.equal(body.hasAccessToken, true);
    const res = await items(body.id);
    assert.equal(res.error, null);
    assert.equal(res.title, '@acme');
    assert.equal(res.items[0].title, 'Summer party!');
    assert.equal(res.items[0].description, 'Summer party!\nSee you there');
    assert.equal(res.items[0].image, 'https://cdn.example/1.jpg');
    assert.equal(res.items[1].image, 'https://cdn.example/2.jpg'); // the cover of a video
    const list = await (await api('/api/feeds')).json();
    assert.ok(list.every((f) => f.accessToken === undefined));
    // Saving without a token keeps the saved (renewed) one.
    const saved = await api(`/api/feeds/${body.id}`, { method: 'PUT', body: JSON.stringify({ kind: 'instagram', name: 'Insta 2' }) });
    assert.equal(saved.status, 200);
    assert.equal((await items(body.id)).error, null);
  });

  test('a Facebook feed needs an account and a page', async () => {
    assert.equal((await create({ kind: 'facebook', name: 'Page' })).status, 400);
  });

  test('stops can be searched and departures come sorted, without the ones gone', async () => {
    const stops = await (await api('/api/transit/stops?q=Utrecht')).json();
    assert.deepEqual(stops.map((x) => x.id), ['nl_8400621']);
    assert.deepEqual(stops[0].modes, ['train', 'bus']);
    const res = await fetch(`${s.url}/api/player/departures?stop=nl_8400621&n=5&modes=bus,train`, { headers: { Authorization: `Bearer ${TOKEN}` } });
    const data = await res.json();
    assert.equal(data.stop, 'Utrecht Centraal');
    assert.deepEqual(data.departures.map((d) => d.destination), ['Zeist', 'Amersfoort', 'IJsselstein']);
    const [bus, train, tram] = data.departures;
    assert.equal(bus.color, '#E30613');
    assert.equal(bus.mode, 'bus');
    assert.equal(train.delay, 3);
    assert.equal(train.platform, '7');
    assert.equal(train.platformChanged, true);
    assert.equal(train.mode, 'train');
    assert.equal(tram.cancelled, true);
    const asked = seen.filter((u) => u.pathname === '/api/v6/stoptimes').pop();
    assert.equal(asked.searchParams.get('stopId'), 'nl_8400621');
    assert.match(asked.searchParams.get('mode'), /BUS/);
    assert.match(asked.searchParams.get('mode'), /REGIONAL_RAIL/);
  });

  test('QR codes come as SVG in the chosen colours', async () => {
    const res = await fetch(`${s.url}/api/player/qr?text=${encodeURIComponent('https://example.com')}&fg=%23123456&bg=%23fedcba`, { headers: { Authorization: `Bearer ${TOKEN}` } });
    assert.equal(res.status, 200);
    assert.match(res.headers.get('content-type'), /image\/svg\+xml/);
    const svg = await res.text();
    assert.match(svg, /#123456/);
    assert.match(svg, /#fedcba/);
    const empty = await fetch(`${s.url}/api/player/qr?text=`, { headers: { Authorization: `Bearer ${TOKEN}` } });
    assert.equal(empty.status, 400);
  });

  test('the HLS player script is served for live stream elements', async () => {
    const res = await fetch(`${s.url}/player/vendor/hls.min.js`);
    assert.equal(res.status, 200);
    assert.match(await res.text(), /Hls/);
  });
});
