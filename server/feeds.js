'use strict';
// Fetches and caches RSS/Atom feeds so the player never talks to the internet directly.
const Parser = require('rss-parser');

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

async function fetchFeed(feed) {
  try {
    const parsed = await parser.parseURL(feed.url);
    const entry = { fetchedAt: Date.now(), title: parsed.title || feed.name, items: (parsed.items || []).map(normalize), error: null };
    cache.set(feed.id, entry);
    return entry;
  } catch (err) {
    const prev = cache.get(feed.id);
    const entry = { fetchedAt: Date.now(), title: feed.name, items: prev ? prev.items : [], error: err.message };
    cache.set(feed.id, entry);
    return entry;
  }
}

async function getItems(feed, { force = false } = {}) {
  const entry = cache.get(feed.id);
  const maxAge = Math.max(1, Number(feed.refreshMinutes) || 10) * 60 * 1000;
  if (!force && entry && Date.now() - entry.fetchedAt < maxAge) return entry;
  return fetchFeed(feed);
}

function forget(feedId) {
  cache.delete(feedId);
}

module.exports = { getItems, forget };
