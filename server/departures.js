'use strict';
// Public transport departures for departure board elements, from a MOTIS server. The default is
// Transitous (api.transitous.org): free, no key, with real-time data for the Netherlands (trains,
// buses, trams, metro and ferries) and much of Europe. Another MOTIS server can be set under Settings.
const store = require('./store');

const DEFAULT_SERVER = 'https://api.transitous.org';
const UA = 'Beeldkrant (+https://github.com/rhisijmuiden/TV-Channel-Generator)';
const cache = new Map(); // key -> { at, data }
const TTL = 30 * 1000;

function server() {
  const s = store.getSection('settings') || {};
  return String(process.env.BK_MOTIS_URL || s.transitServer || DEFAULT_SERVER).replace(/\/+$/, '');
}

async function getJson(url) {
  const res = await fetch(url, { headers: { 'User-Agent': UA, Accept: 'application/json' }, signal: AbortSignal.timeout(15000) });
  if (!res.ok) throw new Error(`The public transport server returned ${res.status}`);
  return res.json();
}

// Simplified kinds of transport, for the filter and the icons on the board.
const MODE_GROUPS = {
  train: ['RAIL', 'HIGHSPEED_RAIL', 'LONG_DISTANCE', 'NIGHT_RAIL', 'REGIONAL_FAST_RAIL', 'REGIONAL_RAIL', 'SUBURBAN'],
  metro: ['SUBWAY', 'METRO'],
  tram: ['TRAM', 'CABLE_CAR', 'FUNICULAR'],
  bus: ['BUS', 'COACH'],
  ferry: ['FERRY'],
};
const groupOf = (mode) => Object.keys(MODE_GROUPS).find((g) => MODE_GROUPS[g].includes(mode)) || 'other';

// Stops whose name matches the search text, for the editor.
async function searchStops(text) {
  const q = String(text || '').trim().slice(0, 80);
  if (q.length < 2) return [];
  const data = await getJson(`${server()}/api/v1/geocode?${new URLSearchParams({ text: q, type: 'STOP' })}`);
  return (Array.isArray(data) ? data : []).filter((m) => m.type === 'STOP').slice(0, 15).map((m) => ({
    id: m.id, name: m.name, lat: m.lat, lon: m.lon,
    area: (m.areas || []).filter((a) => !a.default && a.name !== m.name).map((a) => a.name).slice(0, 2).join(', '),
    modes: [...new Set((m.modes || []).map(groupOf))],
  }));
}

const delayMin = (real, planned) => (real && planned ? Math.round((Date.parse(real) - Date.parse(planned)) / 60000) : 0);

// The next departures from a stop (and the other platforms of the same station).
async function departures(stopId, { n = 10, modes = [] } = {}) {
  const want = (Array.isArray(modes) ? modes : String(modes || '').split(',')).filter((m) => MODE_GROUPS[m]);
  const key = `${stopId}|${n}|${want.join(',')}`;
  const hit = cache.get(key);
  if (hit && Date.now() - hit.at < TTL) return hit.data;
  const params = new URLSearchParams({ stopId, n: String(Math.min(60, Math.max(1, Number(n) || 10)) + 10), radius: '200' });
  if (want.length) params.set('mode', want.flatMap((m) => MODE_GROUPS[m]).join(','));
  const raw = await getJson(`${server()}/api/v6/stoptimes?${params}`);
  const now = Date.now();
  const rows = (raw.stopTimes || []).map((s) => {
    const p = s.place || {};
    const planned = p.scheduledDeparture || p.departure;
    return {
      time: p.departure || planned, planned, delay: s.realTime ? delayMin(p.departure, p.scheduledDeparture) : 0, realTime: !!s.realTime,
      cancelled: !!(s.cancelled || s.tripCancelled || p.cancelled),
      line: s.routeShortName || s.displayName || s.tripShortName || '', destination: s.headsign || (s.tripTo && s.tripTo.name) || '',
      mode: groupOf(s.mode), color: s.routeColor ? `#${s.routeColor}` : null, textColor: s.routeTextColor ? `#${s.routeTextColor}` : null,
      platform: p.track || p.scheduledTrack || '', platformChanged: !!(p.track && p.scheduledTrack && p.track !== p.scheduledTrack),
      operator: s.agencyName || '',
    };
  }).filter((r) => r.time && Date.parse(r.time) > now - 60000)
    .sort((a, b) => Date.parse(a.time) - Date.parse(b.time))
    .slice(0, Math.max(1, Number(n) || 10));
  const data = { stop: (raw.place && raw.place.name) || null, departures: rows, fetchedAt: now };
  cache.set(key, { at: now, data });
  if (cache.size > 200) cache.delete(cache.keys().next().value);
  return data;
}

module.exports = { searchStops, departures, server, DEFAULT_SERVER, MODE_GROUPS: Object.keys(MODE_GROUPS) };
