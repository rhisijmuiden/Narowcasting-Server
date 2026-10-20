'use strict';
// Fetches and caches feeds so the player never talks to the internet directly. A feed has a kind:
//   rss        RSS or Atom (the default)
//   ical       an iCal (.ics) calendar link, e.g. Google Calendar or Outlook "publish calendar"
//   outlook    an Exchange Online mailbox calendar through Microsoft Graph (uses the Entra SSO app)
//   instagram  the posts of an Instagram professional account (Instagram API with Instagram Login)
//   facebook   the posts of a Facebook page, through a Facebook account linked under Outputs
// Every kind gives the same item shape ({ title, description, link, image, date }), so tickers, RSS
// elements and scene templates work with all of them. Calendar items also carry end, allDay and location.
const Parser = require('rss-parser');
const ical = require('node-ical');
const store = require('./store');
const sso = require('./sso');
const providers = require('./providers');

// Overridable for tests.
const INSTAGRAM = (process.env.BK_INSTAGRAM_GRAPH_URL || 'https://graph.instagram.com').replace(/\/+$/, '');
const FACEBOOK = (process.env.BK_FACEBOOK_GRAPH_URL || 'https://graph.facebook.com/v19.0').replace(/\/+$/, '');
const KINDS = ['rss', 'ical', 'outlook', 'instagram', 'facebook'];
const CALENDAR_KINDS = ['ical', 'outlook'];
const SOCIAL_KINDS = ['instagram', 'facebook'];
const kindOf = (feed) => (KINDS.includes(feed.kind) ? feed.kind : 'rss');

const parser = new Parser({
  timeout: 15000,
  headers: { 'User-Agent': 'Beeldkrant/0.1 (+narrowcasting)' },
  customFields: {
    item: [
      ['media:content', 'mediaContent', { keepArray: true }],
      ['media:thumbnail', 'mediaThumbnail'],
      ['enclosure', 'enclosure'],
    ],
  },
});

const cache = new Map(); // feedId -> { fetchedAt, items, error }

function stripHtml(html) {
  return String(html || '')
    .replace(/<script[\s\S]*?<\/script>/gi, '')
    .replace(/<style[\s\S]*?<\/style>/gi, '')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/\s+/g, ' ')
    .trim();
}

function pickImage(item) {
  if (item.enclosure && item.enclosure.url && /^image\//.test(item.enclosure.type || 'image/')) return item.enclosure.url;
  if (Array.isArray(item.mediaContent)) {
    const m = item.mediaContent.find((c) => c && c.$ && c.$.url && (!c.$.medium || c.$.medium === 'image'));
    if (m) return m.$.url;
  }
  if (item.mediaThumbnail && item.mediaThumbnail.$ && item.mediaThumbnail.$.url) return item.mediaThumbnail.$.url;
  const html = item['content:encoded'] || item.content || '';
  const match = /<img[^>]+src=["']([^"']+)["']/i.exec(html);
  return match ? match[1] : null;
}

function normalize(item) {
  return {
    title: stripHtml(item.title),
    description: stripHtml(item.contentSnippet || item.summary || item.content || item.description),
    link: item.link || null,
    image: pickImage(item),
    date: item.isoDate || item.pubDate || null,
  };
}

async function fetchRss(feed) {
  const parsed = await parser.parseURL(feed.url);
  return { title: parsed.title || feed.name, items: (parsed.items || []).map(normalize) };
}

// ---------- calendars ----------
const DAY = 24 * 60 * 60 * 1000;
const pad = (n) => String(n).padStart(2, '0');
// The calendar day of an all-day iCal date: in its own time zone when it has one, else as written.
function dayOf(date) {
  if (date.tz) {
    try { return new Intl.DateTimeFormat('en-CA', { timeZone: date.tz, year: 'numeric', month: '2-digit', day: '2-digit' }).format(date); } catch { /* fall through */ }
  }
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
}
const range = (feed) => {
  const from = new Date();
  return { from, to: new Date(from.getTime() + Math.min(366, Math.max(1, Number(feed.daysAhead) || 14)) * DAY) };
};
const byStart = (a, b) => String(a.date).localeCompare(String(b.date));
// All-day events sort by their day; in ISO form that sorts before the timed events of that day.
const calendarItem = ({ title, description, location, start, end, allDay, link }) => ({
  title: title || '(no title)', description: description || '', location: location || '', link: link || null, image: null,
  date: allDay ? start : new Date(start).toISOString(), end: end ? (allDay ? end : new Date(end).toISOString()) : null, allDay: !!allDay,
});

async function fetchIcal(feed) {
  const res = await fetch(String(feed.url).replace(/^webcal:/i, 'https:'), { headers: { 'User-Agent': 'Beeldkrant (+narrowcasting)' }, signal: AbortSignal.timeout(20000) });
  if (!res.ok) throw new Error(`The calendar link returned ${res.status}`);
  const text = await res.text();
  if (!/BEGIN:VCALENDAR/i.test(text)) throw new Error('This link is not an iCal (.ics) calendar');
  const data = ical.sync.parseICS(text);
  const { from, to } = range(feed);
  const items = [];
  let title = feed.name;
  for (const v of Object.values(data)) {
    if (v.type === 'VCALENDAR' && v['WR-CALNAME']) title = v['WR-CALNAME'];
    if (v.type !== 'VEVENT' || v.status === 'CANCELLED' || !v.start) continue;
    const instances = ical.expandRecurringEvent(v, { from, to, expandOngoing: true });
    for (const i of instances) {
      const allDay = !!(i.isFullDay || (i.start && i.start.dateOnly));
      const endAt = i.end || (allDay ? new Date(i.start.getTime() + DAY) : i.start);
      if (endAt <= from || i.start > to) continue;
      const ev = i.event || v;
      const text = (x) => (x && typeof x === 'object' ? x.val : x) || '';
      items.push(calendarItem({
        title: text(i.summary || ev.summary), description: stripHtml(text(ev.description)), location: text(ev.location), link: text(ev.url) || null,
        start: allDay ? dayOf(i.start) : i.start, end: allDay ? dayOf(endAt) : endAt, allDay,
      }));
    }
  }
  return { title, items: items.sort(byStart) };
}

async function fetchOutlook(feed) {
  if (!feed.mailbox) throw new Error('Enter the mailbox of the calendar');
  const { from, to } = range(feed);
  const events = await sso.calendarView(feed.mailbox, from, to);
  const utc = (x) => (x && x.dateTime ? new Date(`${x.dateTime.replace(/Z$/, '').slice(0, 23)}Z`) : null);
  const items = events.filter((e) => !e.isCancelled).map((e) => {
    const priv = e.sensitivity === 'private' || e.sensitivity === 'confidential';
    const start = utc(e.start);
    const end = utc(e.end);
    return calendarItem({
      title: priv ? 'Private appointment' : e.subject, description: priv ? '' : e.bodyPreview, location: priv ? '' : e.location && e.location.displayName,
      start: e.isAllDay ? start.toISOString().slice(0, 10) : start, end: e.isAllDay && end ? end.toISOString().slice(0, 10) : end, allDay: !!e.isAllDay, link: e.webLink,
    });
  });
  return { title: feed.name, items: items.sort(byStart) };
}

// ---------- social media ----------
async function getJson(url) {
  const res = await fetch(url, { signal: AbortSignal.timeout(15000) });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    const e = data.error || {};
    throw Object.assign(new Error(e.message || `HTTP ${res.status}`), { status: res.status, code: e.code });
  }
  return data;
}
const firstLine = (text) => {
  const line = String(text || '').split('\n').map((x) => x.trim()).find(Boolean) || '';
  return line.length > 120 ? `${line.slice(0, 117)}…` : line;
};

// Instagram tokens last 60 days. They are renewed once a week while the feed is in use.
const TOKEN_RENEW = 7 * DAY;
async function instagramToken(feed) {
  if (!feed.accessToken) throw new Error('Enter the Instagram access token');
  if (feed.tokenRenewedAt && Date.now() - feed.tokenRenewedAt < TOKEN_RENEW) return feed.accessToken;
  try {
    const t = await getJson(`${INSTAGRAM}/refresh_access_token?grant_type=ig_refresh_token&access_token=${encodeURIComponent(feed.accessToken)}`);
    if (t.access_token) {
      store.update('feeds', feed.id, { accessToken: t.access_token, tokenRenewedAt: Date.now(), tokenExpiresAt: t.expires_in ? Date.now() + t.expires_in * 1000 : null });
      return t.access_token;
    }
  } catch (err) {
    // A token younger than 24 hours cannot be renewed yet; anything else is worth telling.
    if (err.code === 190) throw new Error('The Instagram access token has expired. Create a new one and paste it in the feed.');
    store.update('feeds', feed.id, { tokenRenewedAt: Date.now() - TOKEN_RENEW + DAY }); // try again tomorrow
  }
  return feed.accessToken;
}

async function fetchInstagram(feed) {
  const token = await instagramToken(feed);
  const fields = 'id,caption,media_type,media_url,thumbnail_url,permalink,timestamp,username';
  const data = await getJson(`${INSTAGRAM}/me/media?fields=${fields}&limit=50&access_token=${encodeURIComponent(token)}`)
    .catch((err) => { throw new Error(err.code === 190 ? 'The Instagram access token is no longer valid. Create a new one and paste it in the feed.' : `Instagram: ${err.message}`); });
  const posts = data.data || [];
  return {
    title: posts[0] && posts[0].username ? `@${posts[0].username}` : feed.name,
    items: posts.map((p) => ({
      title: firstLine(p.caption), description: p.caption || '', link: p.permalink || null, date: p.timestamp || null,
      image: p.media_type === 'VIDEO' ? p.thumbnail_url || null : p.media_url || null, mediaType: String(p.media_type || '').toLowerCase(),
    })),
  };
}

async function fetchFacebook(feed) {
  const account = feed.accountId && store.get('accounts', feed.accountId);
  if (!account || account.provider !== 'facebook') throw new Error('Choose a Facebook account (link one under Outputs)');
  if (!feed.pageId) throw new Error('Choose a Facebook page');
  const page = (await providers.facebookPages(account)).find((p) => p.id === feed.pageId);
  if (!page) throw new Error('This Facebook page is no longer available to the linked account');
  const fields = 'message,full_picture,created_time,permalink_url';
  const data = await getJson(`${FACEBOOK}/${encodeURIComponent(page.id)}/posts?fields=${fields}&limit=50&access_token=${encodeURIComponent(page.accessToken)}`)
    .catch((err) => { throw new Error(`Facebook: ${err.message}`); });
  return {
    title: page.name,
    items: (data.data || []).filter((p) => p.message || p.full_picture).map((p) => ({
      title: firstLine(p.message), description: p.message || '', link: p.permalink_url || null, date: p.created_time || null, image: p.full_picture || null,
    })),
  };
}

const FETCHERS = { rss: fetchRss, ical: fetchIcal, outlook: fetchOutlook, instagram: fetchInstagram, facebook: fetchFacebook };

async function fetchFeed(feed) {
  try {
    const got = await FETCHERS[kindOf(feed)](feed);
    const entry = { fetchedAt: Date.now(), kind: kindOf(feed), title: got.title || feed.name, items: got.items, error: null };
    cache.set(feed.id, entry);
    return entry;
  } catch (err) {
    const prev = cache.get(feed.id);
    const entry = { fetchedAt: Date.now(), kind: kindOf(feed), title: feed.name, items: prev ? prev.items : [], error: err.message };
    cache.set(feed.id, entry);
    return entry;
  }
}

async function getItems(feed, { force = false } = {}) {
  let entry = cache.get(feed.id);
  // Calendar items that have ended drop off between refreshes.
  if (entry && CALENDAR_KINDS.includes(entry.kind)) {
    const now = new Date().toISOString();
    entry = { ...entry, items: entry.items.filter((i) => !i.end || (i.allDay ? i.end > now.slice(0, 10) : i.end > now)) };
  }
  const maxAge = Math.max(1, Number(feed.refreshMinutes) || 10) * 60 * 1000;
  if (!force && entry && Date.now() - entry.fetchedAt < maxAge) return entry;
  return fetchFeed(feed);
}

// Only the number of items set on the feed (default 10) goes to scenes, tickers and RSS elements.
const DEFAULT_ITEMS = 10;
function limit(feed, entry) {
  const max = Math.max(1, Number(feed.maxItems) || DEFAULT_ITEMS);
  return { ...entry, items: (entry.items || []).slice(0, max), total: (entry.items || []).length };
}

function forget(feedId) {
  cache.delete(feedId);
}

// What the browser may see of a feed: secrets stay on the server.
function publicFeed(feed) {
  const { accessToken, ...rest } = feed;
  return { ...rest, kind: kindOf(feed), hasAccessToken: !!accessToken };
}

// Cleans a feed from the panel. An empty access token keeps the saved one.
function cleanFeed(body, existing = {}) {
  const kind = KINDS.includes(body.kind) ? body.kind : 'rss';
  const out = { ...body, kind };
  delete out.hasAccessToken;
  if (kind === 'rss' || kind === 'ical') {
    if (!/^(https?|webcal):\/\//i.test(String(out.url || '').trim())) throw new Error('Enter a valid http(s) URL');
    out.url = String(out.url).trim();
  }
  if (kind === 'outlook' && !/^[^@\s]+@[^@\s]+$/.test(String(out.mailbox || '').trim())) throw new Error('Enter the e-mail address of the mailbox or room');
  if (kind === 'facebook' && (!out.accountId || !out.pageId)) throw new Error('Choose a Facebook account and page');
  if (out.accessToken) {
    out.accessToken = String(out.accessToken).trim();
    out.tokenRenewedAt = null;
  } else if (existing.accessToken && kind === kindOf(existing)) out.accessToken = existing.accessToken;
  else delete out.accessToken;
  if (kind === 'instagram' && !out.accessToken) throw new Error('Paste the Instagram access token');
  return out;
}

module.exports = { getItems, forget, limit, publicFeed, cleanFeed, DEFAULT_ITEMS, KINDS, CALENDAR_KINDS, SOCIAL_KINDS };
