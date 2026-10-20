/* Shared slide renderer, used by the on-air player and by the slide editor in the admin panel.
 * All positions and sizes are pixels at the playout's resolution; the stage is scaled to fit the window. */
(() => {
  'use strict';

  const el = (tag, cls, text) => {
    const e = document.createElement(tag);
    if (cls) e.className = cls;
    if (text != null) e.textContent = text;
    return e;
  };

  function sleep(ms, signal) {
    return new Promise((resolve) => {
      const t = setTimeout(resolve, ms);
      if (signal) signal.addEventListener('abort', () => { clearTimeout(t); resolve(); }, { once: true });
    });
  }

  // The path the app is served under ('' at the root, e.g. /channel1 behind a station proxy): whatever
  // comes before /admin/ or /player/ in the address of this page.
  const base = location.pathname.replace(/\/(admin|player)(\/.*)?$/, '');

  async function getJSON(url) {
    const res = await fetch(base + url, { cache: 'no-store', credentials: 'same-origin' });
    if (!res.ok) throw new Error(`${url}: ${res.status}`);
    return res.json();
  }

  function fmtDate(ctx, date, opts) {
    try { return new Intl.DateTimeFormat(ctx.locale || 'en-GB', { timeZone: ctx.timezone, ...opts }).format(date); } catch { return date.toLocaleString(); }
  }

  // Replaces {{title}}, {{description}}, {{date}}, {{feed}} with values from the current feed item.
  function fill(text, ctx) {
    const item = ctx.item || {};
    return String(text || '').replace(/\{\{\s*(\w+)\s*\}\}/g, (m, key) => {
      if (key === 'date') return item.date ? fmtDate(ctx, new Date(item.date), { dateStyle: 'medium', timeStyle: 'short' }) : '';
      if (key === 'feed') return item.feedTitle || '';
      return item[key] != null ? String(item[key]) : '';
    });
  }

  const feedCache = new Map();
  async function feedItems(feedId, maxAgeMs = 60000) {
    const hit = feedCache.get(feedId);
    if (hit && Date.now() - hit.at < maxAgeMs) return hit.data;
    const data = await getJSON(`/api/player/feed/${encodeURIComponent(feedId)}`);
    feedCache.set(feedId, { at: Date.now(), data });
    return data;
  }

  // The order a carousel plays its items in: as listed, or shuffled every round without
  // showing the same item twice in a row.
  function playOrder(list, random, last) {
    const order = list.map((x, i) => i);
    if (!random || list.length < 2) return order;
    for (let i = order.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [order[i], order[j]] = [order[j], order[i]];
    }
    if (order[0] === last) [order[0], order[1]] = [order[1], order[0]];
    return order;
  }

  // A small label on carousels in the editor, which shows only the first item.
  function badge(text) {
    return el('div', 'carousel-badge', text);
  }

  const CAROUSEL_FX = {
    fade: [{ opacity: 0 }, { opacity: 1 }],
    'slide-left': [{ transform: 'translateX(100%)' }, { transform: 'translateX(0)' }],
    'slide-up': [{ transform: 'translateY(100%)' }, { transform: 'translateY(0)' }],
    zoom: [{ opacity: 0, transform: 'scale(1.08)' }, { opacity: 1, transform: 'scale(1)' }],
  };

  // Element types whose box takes the background colour set on the element.
  const BACKGROUND_TYPES = ['text', 'box', 'clock', 'weather', 'countdown', 'agenda', 'departures'];

  // A few words in the language set for dates (Settings → Region); English otherwise.
  const WORDS = {
    en: { days: ['day', 'days'], hours: ['hour', 'hours'], minutes: ['min', 'min'], seconds: ['sec', 'sec'], allDay: 'All day', now: 'Now', next: 'Next', free: 'Available', until: 'until', noEvents: 'No appointments', cancelled: 'Cancelled', platform: 'Platform', departure: 'Departure', destination: 'Destination', line: 'Line', min: 'min', due: 'now', noDepartures: 'No departures' },
    nl: { days: ['dag', 'dagen'], hours: ['uur', 'uur'], minutes: ['min', 'min'], seconds: ['sec', 'sec'], allDay: 'Hele dag', now: 'Nu', next: 'Hierna', free: 'Beschikbaar', until: 'tot', noEvents: 'Geen afspraken', cancelled: 'Rijdt niet', platform: 'Spoor', departure: 'Vertrek', destination: 'Richting', line: 'Lijn', min: 'min', due: 'nu', noDepartures: 'Geen vertrekken' },
    de: { days: ['Tag', 'Tage'], hours: ['Stunde', 'Stunden'], minutes: ['Min', 'Min'], seconds: ['Sek', 'Sek'], allDay: 'Ganztägig', now: 'Jetzt', next: 'Danach', free: 'Frei', until: 'bis', noEvents: 'Keine Termine', cancelled: 'Fällt aus', platform: 'Gleis', departure: 'Abfahrt', destination: 'Ziel', line: 'Linie', min: 'Min', due: 'jetzt', noDepartures: 'Keine Abfahrten' },
    fr: { days: ['jour', 'jours'], hours: ['heure', 'heures'], minutes: ['min', 'min'], seconds: ['s', 's'], allDay: 'Toute la journée', now: 'Maintenant', next: 'Ensuite', free: 'Disponible', until: "jusqu'à", noEvents: 'Aucun rendez-vous', cancelled: 'Supprimé', platform: 'Voie', departure: 'Départ', destination: 'Destination', line: 'Ligne', min: 'min', due: 'imminent', noDepartures: 'Aucun départ' },
  };
  const words = (ctx) => WORDS[String(ctx.locale || 'en').slice(0, 2)] || WORDS.en;

  // 'YYYY-MM-DDTHH:MM' as a wall-clock time in the given time zone (the one under Settings → Region).
  function zonedDate(str, tz) {
    const m = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})/.exec(String(str || ''));
    if (!m) return null;
    const guess = Date.UTC(+m[1], m[2] - 1, +m[3], +m[4], +m[5]);
    if (!tz) return new Date(+m[1], m[2] - 1, +m[3], +m[4], +m[5]);
    const offset = (t) => {
      try {
        const p = Object.fromEntries(new Intl.DateTimeFormat('en-US', { timeZone: tz, hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit' })
          .formatToParts(new Date(t)).map((x) => [x.type, x.value]));
        return Date.UTC(+p.year, p.month - 1, +p.day, +p.hour, +p.minute, +p.second) - t;
      } catch { return -new Date(t).getTimezoneOffset() * 60000; }
    };
    const first = guess - offset(guess);
    return new Date(guess - offset(first));
  }

  // The calendar day ('YYYY-MM-DD') of a moment in the given time zone.
  function dayKey(ctx, date) {
    try { return new Intl.DateTimeFormat('en-CA', { timeZone: ctx.timezone, year: 'numeric', month: '2-digit', day: '2-digit' }).format(date); } catch { return date.toISOString().slice(0, 10); }
  }

  // Loads a script once (hls.js for live streams).
  const scripts = new Map();
  function loadScript(src) {
    if (!scripts.has(src)) {
      scripts.set(src, new Promise((resolve, reject) => {
        const tag = document.createElement('script');
        tag.src = src;
        tag.onload = resolve;
        tag.onerror = () => { scripts.delete(src); reject(new Error(`Could not load ${src}`)); };
        document.head.appendChild(tag);
      }));
    }
    return scripts.get(src);
  }

  // Which service a live stream address points at.
  function streamSource(url) {
    const u = String(url || '').trim();
    let m = /(?:youtube(?:-nocookie)?\.com\/(?:watch\?(?:.*&)?v=|live\/|embed\/|shorts\/)|youtu\.be\/)([\w-]{11})/.exec(u);
    if (m) return { kind: 'youtube', id: m[1] };
    m = /youtube\.com\/channel\/(UC[\w-]{22})/.exec(u);
    if (m) return { kind: 'youtube', channel: m[1] };
    m = /twitch\.tv\/([\w]{3,25})\/?(?:$|\?)/.exec(u);
    if (m) return { kind: 'twitch', channel: m[1] };
    if (/\.m3u8(\?|$)/i.test(u)) return { kind: 'hls', url: u };
    if (/^https?:\/\//i.test(u)) return { kind: 'video', url: u };
    return null;
  }

  function box(e) {
    const b = el('div', `el el-${e.type}`);
    Object.assign(b.style, {
      left: `${Number(e.x) || 0}px`, top: `${Number(e.y) || 0}px`,
      width: `${Number(e.w) || 100}px`, height: `${Number(e.h) || 100}px`,
      zIndex: String(Number(e.z) || 0),
      opacity: e.opacity != null && e.opacity !== '' ? String(Number(e.opacity) / 100) : '',
      borderRadius: e.radius ? `${Number(e.radius)}px` : '',
      background: BACKGROUND_TYPES.includes(e.type) ? (e.background || 'transparent') : '',
    });
    if (e.rotate) b.style.transform = `rotate(${Number(e.rotate)}deg)`;
    return b;
  }

  // Each renderer returns { node, done?: Promise } where done resolves when a video finished.
  const renderers = {
    box(e) { return { node: box(e) }; },

    text(e, ctx) {
      const b = box(e);
      b.style.display = 'flex';
      b.style.alignItems = { top: 'flex-start', middle: 'center', bottom: 'flex-end' }[e.valign || 'top'];
      b.style.padding = `${Number(e.padding) || 0}px`;
      const t = el('div', 'txt', fill(e.text, ctx));
      Object.assign(t.style, {
        width: '100%', fontSize: `${Number(e.fontSize) || 48}px`, fontWeight: String(e.fontWeight || 400), color: e.color || '#ffffff',
        textAlign: e.align || 'left', lineHeight: String(Number(e.lineHeight) || 1.25), fontFamily: e.fontFamily || '',
        textTransform: e.uppercase ? 'uppercase' : '', textShadow: e.shadow ? '0 2px 8px rgba(0,0,0,.6)' : '',
      });
      if (Number(e.maxLines)) { t.style.webkitLineClamp = String(Number(e.maxLines)); t.classList.add('clamp'); }
      b.appendChild(t);
      return { node: b };
    },

    image(e, ctx) {
      const b = box(e);
      const src = e.source === 'feed' ? ctx.item && ctx.item.image : e.src;
      if (src) {
        const img = el('img', `fill fit-${e.fit || 'cover'}`);
        img.src = src;
        img.onerror = () => img.remove();
        b.appendChild(img);
      } else if (ctx.editor) b.appendChild(el('div', 'placeholder', e.source === 'feed' ? 'Feed image' : 'No image chosen'));
      return { node: b };
    },

    video(e, ctx) {
      const b = box(e);
      b.style.background = '#000';
      if (!e.src) {
        if (ctx.editor) b.appendChild(el('div', 'placeholder', 'No video chosen'));
        return { node: b, done: null };
      }
      const v = el('video', `fill fit-${e.fit || 'cover'}`);
      v.src = e.src;
      v.playsInline = true;
      v.preload = 'auto';
      v.muted = ctx.editor || !e.audio;
      v.loop = !!e.loop;
      b.appendChild(v);
      if (ctx.editor) { v.currentTime = 1; return { node: b, done: null }; }
      const done = new Promise((resolve) => {
        v.addEventListener('ended', resolve);
        v.addEventListener('error', () => setTimeout(resolve, 1000));
        if (ctx.signal) ctx.signal.addEventListener('abort', resolve, { once: true });
      });
      ctx.onShow.push(() => v.play().catch(() => { v.muted = true; v.play().catch(() => {}); }));
      ctx.onHide.push(() => { v.pause(); v.removeAttribute('src'); v.load(); });
      return { node: b, done };
    },

    // Photo carousel: several images one after the other, in a set or random order.
    slideshow(e, ctx) {
      const b = box(e);
      b.style.background = e.background || '#000';
      const items = (e.sources || []).filter((x) => x.type === 'image');
      if (!items.length) {
        if (ctx.editor) b.appendChild(el('div', 'placeholder', 'Add photos to the carousel'));
        return { node: b, done: null };
      }
      const img = (src) => { const i = el('img', `fill fit-${e.fit || 'cover'}`); i.src = src; return i; };
      if (ctx.editor) {
        b.append(img(items[0].src), badge(`Photo carousel · ${items.length} photo${items.length === 1 ? '' : 's'}${e.order === 'random' ? ' · random' : ''}`));
        return { node: b, done: null };
      }
      const interval = Math.max(1, Number(e.interval) || 5) * 1000;
      const fx = CAROUSEL_FX[e.transition || 'fade'];
      const ms = e.transition === 'cut' ? 0 : Number(e.transitionMs ?? 800);
      let stopped = false;
      let finish;
      const done = new Promise((resolve) => { finish = resolve; });
      ctx.onHide.push(() => { stopped = true; finish(); });
      if (ctx.signal) ctx.signal.addEventListener('abort', () => finish(), { once: true });
      ctx.onShow.push(async () => {
        let last = -1;
        let first = true;
        while (!stopped) {
          for (const i of playOrder(items, e.order === 'random', last)) {
            if (stopped) return;
            const next = img(items[i].src);
            await new Promise((r) => { if (next.complete) r(); else { next.onload = r; next.onerror = r; } });
            const prev = b.lastElementChild;
            b.appendChild(next);
            if (!first && fx && ms) await next.animate(fx, { duration: ms, easing: 'ease-in-out' }).finished.catch(() => {});
            if (prev && prev !== next) prev.remove();
            first = false;
            last = i;
            await sleep(interval, ctx.signal);
          }
          finish(); // one full round played: a scene set to move on when its media ends can go on
        }
      });
      return { node: b, done };
    },

    // Video carousel: several videos back to back, in a set or random order. Repeats until the scene ends.
    playlist(e, ctx) {
      const b = box(e);
      b.style.background = '#000';
      const items = (e.sources || []).filter((x) => x.type === 'video');
      if (!items.length) {
        if (ctx.editor) b.appendChild(el('div', 'placeholder', 'Add videos to the carousel'));
        return { node: b, done: null };
      }
      const v = el('video', `fill fit-${e.fit || 'cover'}`);
      v.playsInline = true;
      v.preload = 'auto';
      v.muted = ctx.editor || !e.audio;
      b.appendChild(v);
      if (ctx.editor) {
        v.src = items[0].src;
        v.currentTime = 1;
        b.appendChild(badge(`Video carousel · ${items.length} video${items.length === 1 ? '' : 's'}${e.order === 'random' ? ' · random' : ''}`));
        return { node: b, done: null };
      }
      let stopped = false;
      let finish;
      const done = new Promise((resolve) => { finish = resolve; });
      if (ctx.signal) ctx.signal.addEventListener('abort', () => finish(), { once: true });
      const playOne = (src) => new Promise((resolve) => {
        const end = () => { v.removeEventListener('ended', end); v.removeEventListener('error', fail); resolve(); };
        const fail = () => { v.removeEventListener('ended', end); v.removeEventListener('error', fail); setTimeout(resolve, 1000); };
        v.addEventListener('ended', end);
        v.addEventListener('error', fail);
        v.src = src;
        v.play().catch(() => { v.muted = true; v.play().catch(() => {}); });
      });
      ctx.onShow.push(async () => {
        let last = -1;
        while (!stopped) {
          for (const i of playOrder(items, e.order === 'random', last)) {
            if (stopped) return;
            await playOne(items[i].src);
            last = i;
          }
          finish();
        }
      });
      ctx.onHide.push(() => { stopped = true; finish(); v.pause(); v.removeAttribute('src'); v.load(); });
      return { node: b, done };
    },

    // A whole RSS feed with photos and text: as a list, a grid of cards, or one item at a time.
    // Pages through the items when they do not all fit.
    rss(e, ctx) {
      const b = box(e);
      b.style.background = e.background || 'transparent';
      const wrap = el('div', `rss rss-${e.layout || 'list'}`);
      Object.assign(wrap.style, { color: e.color || '#ffffff', fontFamily: e.fontFamily || '' });
      wrap.style.setProperty('--rss-title', `${Number(e.fontSize) || 40}px`);
      wrap.style.setProperty('--rss-card', e.cardBackground || 'rgba(0,0,0,0.45)');
      wrap.style.setProperty('--rss-gap', `${Number(e.gap ?? 20)}px`);
      b.appendChild(wrap);
      if (!e.feedId) { if (ctx.editor) wrap.appendChild(el('div', 'placeholder', e.type === 'social' ? 'Choose an Instagram or Facebook feed' : 'Choose a feed')); return { node: b, done: null }; }
      const social = e.type === 'social';
      const layout = e.layout || (social ? 'single' : 'list');
      const perPage = layout === 'single' ? 1 : Math.max(1, Number(e.perPage) || (layout === 'grid' ? 6 : 4));
      if (layout === 'grid') wrap.style.gridTemplateColumns = `repeat(${Math.max(1, Number(e.columns) || 3)}, 1fr)`;
      const card = (item) => {
        const c = el('div', 'rss-item');
        if (e.showImage !== false && item.image) {
          const im = el('img', 'rss-img');
          im.src = item.image;
          im.onerror = () => im.remove();
          c.appendChild(im);
        }
        const t = el('div', 'rss-text');
        if (social && e.showSource !== false && item.feedTitle) t.appendChild(el('div', 'rss-source', item.feedTitle));
        if (!social) t.appendChild(el('div', 'rss-title', item.title || ''));
        if ((social || e.showDescription !== false) && item.description) {
          const d = el('div', social ? 'rss-desc rss-caption' : 'rss-desc', item.description);
          d.style.webkitLineClamp = String(Number(e.descLines) || (layout === 'single' ? 4 : 2));
          t.appendChild(d);
        }
        if (e.showDate && item.date) t.appendChild(el('div', 'rss-date', fmtDate(ctx, new Date(item.date), { dateStyle: 'medium', timeStyle: 'short' })));
        c.appendChild(t);
        return c;
      };
      let finish;
      const done = ctx.editor ? null : new Promise((resolve) => { finish = resolve; });
      let stopped = false;
      const load = async () => {
        try {
          const data = await feedItems(e.feedId);
          const max = Number(e.maxItems);
          return (data.items || []).slice(0, max > 0 ? max : undefined).map((i) => ({ ...i, feedTitle: data.title }));
        } catch { return []; }
      };
      const showPage = (items, page) => {
        wrap.replaceChildren(...items.slice(page * perPage, page * perPage + perPage).map(card));
        if (!ctx.editor && page > 0) wrap.animate([{ opacity: 0 }, { opacity: 1 }], { duration: 600, easing: 'ease-out' });
      };
      if (ctx.editor) {
        load().then((items) => {
          if (!items.length) { wrap.replaceChildren(el('div', 'placeholder', 'No items in this feed yet')); return; }
          showPage(items, 0);
          const pages = Math.ceil(items.length / perPage);
          if (pages > 1) b.appendChild(badge(`${e.type === 'social' ? 'Social' : 'RSS'} · ${items.length} ${e.type === 'social' ? 'posts' : 'items'} · ${pages} pages`));
        });
        return { node: b, done: null };
      }
      if (ctx.signal) ctx.signal.addEventListener('abort', () => finish(), { once: true });
      ctx.onHide.push(() => { stopped = true; finish(); });
      ctx.onShow.push(async () => {
        while (!stopped) {
          const items = await load(); // re-read every round so new items show up
          if (!items.length) { wrap.replaceChildren(); await sleep(5000, ctx.signal); continue; }
          const pages = Math.ceil(items.length / perPage);
          for (let page = 0; page < pages && !stopped; page++) {
            showPage(items, page);
            await sleep(Math.max(2, Number(e.interval) || 8) * 1000, ctx.signal);
          }
          finish();
        }
      });
      // The first page is drawn right away so the scene does not start empty.
      load().then((items) => { if (!wrap.children.length && items.length) showPage(items, 0); });
      return { node: b, done };
    },

    // Instagram or Facebook posts: the RSS element with the caption instead of a title.
    social(e, ctx) { return renderers.rss(e, ctx); },

    // IP camera: a live MJPEG picture from the server, which reconnects by itself.
    camera(e, ctx) {
      const b = box(e);
      b.style.background = '#000';
      if (!e.src) {
        if (ctx.editor) b.appendChild(el('div', 'placeholder', 'Choose a camera'));
        return { node: b };
      }
      const img = el('img', `fill fit-${e.fit || 'cover'}`);
      img.alt = '';
      b.appendChild(img);
      if (ctx.editor) {
        // The editor shows one picture rather than keeping a live connection per redraw.
        const wait = el('div', 'placeholder', ctx.thumb ? '' : `Connecting to ${e.cameraName || 'the camera'}…`);
        b.prepend(wait);
        img.onload = () => wait.remove();
        img.onerror = () => { img.remove(); wait.textContent = `${e.cameraName || 'Camera'}: no picture`; };
        img.src = `${e.snapshot}?t=${Date.now()}`;
        if (!ctx.thumb) b.appendChild(badge(`Live camera · ${e.cameraName || ''}`));
        return { node: b };
      }
      let on = false;
      let retry;
      const connect = () => { if (on) img.src = `${e.src}?t=${Date.now()}`; };
      img.onerror = () => { clearTimeout(retry); retry = setTimeout(connect, 3000); };
      ctx.onShow.push(() => { on = true; connect(); });
      ctx.onHide.push(() => { on = false; clearTimeout(retry); img.removeAttribute('src'); });
      if (ctx.signal) ctx.signal.addEventListener('abort', () => { on = false; clearTimeout(retry); img.removeAttribute('src'); }, { once: true });
      return { node: b };
    },

    // A QR code for a link or text; in an RSS scene {{link}} gives a code per feed item.
    qr(e, ctx) {
      const b = box(e);
      const text = fill(e.text, ctx).trim();
      const bg = e.background || '#ffffff';
      Object.assign(b.style, { background: bg, display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', padding: `${Number(e.padding ?? 16)}px` });
      if (!text) { if (ctx.editor) b.appendChild(el('div', 'placeholder', 'Enter a link for the QR code')); return { node: b }; }
      const img = el('img', 'qr-img');
      img.alt = '';
      img.src = `${base}/api/player/qr?${new URLSearchParams({ text, fg: e.color || '#000000', bg, margin: String(Number(e.margin ?? 1)) })}`;
      b.appendChild(img);
      if (e.caption) {
        const c = el('div', 'qr-caption', fill(e.caption, ctx));
        Object.assign(c.style, { color: e.captionColor || e.color || '#000000', fontSize: `${Number(e.fontSize) || 32}px`, fontWeight: String(e.fontWeight || 700), fontFamily: e.fontFamily || '' });
        b.appendChild(c);
      }
      return { node: b };
    },

    // Counts down to a date and time, or to a time every day, then shows a closing text.
    countdown(e, ctx) {
      const b = box(e);
      const w = words(ctx);
      const wrap = el('div', `countdown cd-${e.style || 'blocks'}`);
      Object.assign(wrap.style, { color: e.color || '#ffffff', fontSize: `${Number(e.fontSize) || 72}px`, fontFamily: e.fontFamily || '', fontWeight: String(e.fontWeight || 700) });
      wrap.style.setProperty('--cd-accent', e.accent || 'rgba(255,255,255,0.12)');
      b.appendChild(wrap);
      const label = e.label ? el('div', 'cd-label', e.label) : null;
      const body = el('div', 'cd-body');
      wrap.append(...[label, body].filter(Boolean));
      const units = [['days', 86400], ['hours', 3600], ['minutes', 60], ['seconds', 1]].filter(([u]) => e[`show_${u}`] !== false);
      const target = () => {
        if (e.mode === 'daily') {
          const now = new Date();
          const today = dayKey(ctx, now);
          let t = zonedDate(`${today}T${e.time || '09:00'}`, ctx.timezone);
          if (t && t <= now) t = zonedDate(`${dayKey(ctx, new Date(now.getTime() + 86400000))}T${e.time || '09:00'}`, ctx.timezone);
          return t;
        }
        return zonedDate(e.target, ctx.timezone);
      };
      const tick = () => {
        const t = target();
        if (!t) { body.replaceChildren(el('div', 'cd-done', ctx.editor ? 'Set the date and time' : '')); return; }
        let left = Math.max(0, Math.floor((t - Date.now()) / 1000));
        if (left === 0 && e.mode !== 'daily') {
          if (label && e.hideLabelWhenDone) label.style.display = 'none';
          body.replaceChildren(el('div', 'cd-done', e.doneText || ''));
          return;
        }
        if (label) label.style.display = '';
        const parts = units.map(([u, secs], i) => {
          const v = Math.floor(left / secs);
          left -= v * secs;
          return [u, v];
        });
        if (e.style === 'text') {
          const [first, ...rest] = parts;
          const big = first && first[0] === 'days' ? `${first[1]} ${w.days[first[1] === 1 ? 0 : 1]} ` : '';
          const clock = (big ? rest : parts).map(([, v]) => String(v).padStart(2, '0')).join(':');
          body.replaceChildren(el('div', 'cd-text', `${big}${clock}`));
          return;
        }
        body.replaceChildren(...parts.map(([u, v]) => {
          const cell = el('div', 'cd-cell');
          cell.append(el('div', 'cd-num', u === 'days' ? String(v) : String(v).padStart(2, '0')), el('div', 'cd-unit', w[u][v === 1 ? 0 : 1]));
          return cell;
        }));
      };
      tick();
      const iv = setInterval(tick, 1000);
      ctx.onHide.push(() => clearInterval(iv));
      if (ctx.signal) ctx.signal.addEventListener('abort', () => clearInterval(iv), { once: true });
      return { node: b };
    },

    // Upcoming appointments from an iCal or Outlook calendar feed: a list by day, or now and next (room sign).
    agenda(e, ctx) {
      const b = box(e);
      const w = words(ctx);
      const wrap = el('div', `agenda agenda-${e.layout || 'list'}`);
      Object.assign(wrap.style, { color: e.color || '#ffffff', fontFamily: e.fontFamily || '' });
      wrap.style.setProperty('--ag-size', `${Number(e.fontSize) || 36}px`);
      wrap.style.setProperty('--ag-accent', e.accent || '#4f8cff');
      wrap.style.setProperty('--ag-card', e.cardBackground || 'rgba(0,0,0,0.35)');
      b.appendChild(wrap);
      if (!e.feedId) { if (ctx.editor) wrap.appendChild(el('div', 'placeholder', 'Choose a calendar')); return { node: b }; }
      const time = (d) => fmtDate(ctx, d, { hour: '2-digit', minute: '2-digit' });
      const when = (i) => {
        if (i.allDay) return w.allDay;
        const s = new Date(i.date);
        const end = i.end && new Date(i.end);
        return end && dayKey(ctx, end) === dayKey(ctx, s) ? `${time(s)} – ${time(end)}` : time(s);
      };
      const dayOf = (i) => (i.allDay ? i.date : dayKey(ctx, new Date(i.date)));
      const dayTitle = (key) => {
        const today = dayKey(ctx, new Date());
        const diff = Math.round((Date.parse(`${key}T12:00:00Z`) - Date.parse(`${today}T12:00:00Z`)) / 86400000);
        if (diff >= 0 && diff <= 1) {
          try { const r = new Intl.RelativeTimeFormat(ctx.locale || 'en-GB', { numeric: 'auto' }).format(diff, 'day'); return r.charAt(0).toUpperCase() + r.slice(1); } catch { /* fall through */ }
        }
        return fmtDate({ ...ctx, timezone: 'UTC' }, new Date(`${key}T12:00:00Z`), { weekday: 'long', day: 'numeric', month: 'long' });
      };
      const row = (i, big) => {
        const r = el('div', big ? 'ag-now' : 'ag-item');
        r.appendChild(el('div', 'ag-time', when(i)));
        const t = el('div', 'ag-text');
        t.appendChild(el('div', 'ag-title', i.title));
        if (e.showLocation !== false && i.location) t.appendChild(el('div', 'ag-loc', i.location));
        if (e.showDescription && i.description) t.appendChild(el('div', 'ag-desc', i.description));
        r.appendChild(t);
        return r;
      };
      const draw = (items) => {
        const now = Date.now();
        const nodes = [];
        if (e.title) nodes.push(el('div', 'ag-head', e.title));
        if ((e.layout || 'list') === 'now-next') {
          const start = (i) => (i.allDay ? zonedDate(`${i.date}T00:00`, ctx.timezone) : new Date(i.date)).getTime();
          const current = items.find((i) => !i.allDay && start(i) <= now && (!i.end || Date.parse(i.end) > now));
          const later = items.filter((i) => !i.allDay && start(i) > now).slice(0, Math.max(1, Number(e.maxItems) || 3));
          const status = el('div', `ag-status ${current ? 'busy' : 'free'}`);
          status.appendChild(el('div', 'ag-label', current ? w.now : w.free));
          if (current) status.appendChild(row(current, true));
          else if (later[0]) status.appendChild(el('div', 'ag-loc', `${w.until} ${time(new Date(later[0].date))}`));
          nodes.push(status);
          if (later.length) {
            nodes.push(el('div', 'ag-label', w.next));
            later.forEach((i) => nodes.push(row(i)));
          }
        } else {
          const list = items.slice(0, Math.max(1, Number(e.maxItems) || 8));
          if (!list.length) nodes.push(el('div', 'ag-empty', w.noEvents));
          let lastDay = null;
          for (const i of list) {
            const d = dayOf(i);
            if (e.groupByDay !== false && d !== lastDay) { nodes.push(el('div', 'ag-day', dayTitle(d < dayKey(ctx, new Date()) ? dayKey(ctx, new Date()) : d))); lastDay = d; }
            nodes.push(row(i));
          }
        }
        wrap.replaceChildren(...nodes);
        // Appointments that do not fit are left off rather than cut in half, and so is a day heading without any.
        requestAnimationFrame(() => {
          const bottom = wrap.getBoundingClientRect().bottom + 1;
          while (wrap.children.length > 1 && wrap.lastElementChild.getBoundingClientRect().bottom > bottom) wrap.lastElementChild.remove();
          while (wrap.children.length > 1 && /ag-day|ag-label/.test(wrap.lastElementChild.className)) wrap.lastElementChild.remove();
        });
      };
      const load = () => feedItems(e.feedId).then((d) => draw(d.items || [])).catch(() => { if (ctx.editor) wrap.replaceChildren(el('div', 'placeholder', 'Calendar unavailable')); });
      load();
      if (!ctx.editor) {
        const iv = setInterval(load, 60000);
        ctx.onHide.push(() => clearInterval(iv));
        if (ctx.signal) ctx.signal.addEventListener('abort', () => clearInterval(iv), { once: true });
      }
      return { node: b };
    },

    // Live departure board for a bus, tram or metro stop or a train station.
    departures(e, ctx) {
      const b = box(e);
      const w = words(ctx);
      const wrap = el('div', e.showPlatform === false ? 'board no-plat' : 'board');
      Object.assign(wrap.style, { color: e.color || '#ffffff', fontFamily: e.fontFamily || '' });
      wrap.style.setProperty('--bd-size', `${Number(e.fontSize) || 36}px`);
      wrap.style.setProperty('--bd-head', e.headBackground || '#1f3c88');
      wrap.style.setProperty('--bd-stripe', e.stripe || 'rgba(255,255,255,0.06)');
      wrap.style.setProperty('--bd-late', e.lateColor || '#ff6b6b');
      b.appendChild(wrap);
      if (!e.stopId) { if (ctx.editor) wrap.appendChild(el('div', 'placeholder', 'Choose a stop or station')); return { node: b }; }
      const mode = e.timeFormat || 'relative';
      let data = null;
      const draw = () => {
        const nodes = [];
        if (e.showTitle !== false) {
          const head = el('div', 'bd-title');
          head.append(el('span', '', e.title || (data && data.stop) || e.stopName || ''), el('span', 'bd-clock', fmtDate(ctx, new Date(), { hour: '2-digit', minute: '2-digit' })));
          nodes.push(head);
        }
        const cols = el('div', 'bd-row bd-cols');
        cols.append(el('div', 'bd-time', w.departure), el('div', 'bd-line', w.line), el('div', 'bd-dest', w.destination), e.showPlatform !== false ? el('div', 'bd-plat', w.platform) : null);
        if (e.showHeader !== false) nodes.push(cols);
        const rows = (data && data.departures) || [];
        if (data && !rows.length) nodes.push(el('div', 'bd-empty', w.noDepartures));
        for (const d of rows.slice(0, Math.max(1, Number(e.maxRows) || 8))) {
          const r = el('div', `bd-row${d.cancelled ? ' cancelled' : ''}`);
          const t = el('div', 'bd-time');
          const at = new Date(d.time);
          const mins = Math.round((at - Date.now()) / 60000);
          const clock = fmtDate(ctx, new Date(d.planned || d.time), { hour: '2-digit', minute: '2-digit' });
          if (mode === 'relative' && mins < 60) t.textContent = mins <= 0 ? w.due : `${mins} ${w.min}`;
          else t.textContent = clock;
          if (mode !== 'relative' && d.delay > 0 && !d.cancelled) t.appendChild(el('span', 'bd-delay', ` +${d.delay}`));
          const line = el('div', 'bd-line');
          const badge = el('span', `bd-badge bd-${d.mode}`, d.line || '');
          if (d.color) Object.assign(badge.style, { background: d.color, color: d.textColor || '#ffffff' });
          line.appendChild(badge);
          const dest = el('div', 'bd-dest', d.destination);
          if (d.cancelled) dest.appendChild(el('span', 'bd-note', w.cancelled));
          r.append(t, line, dest);
          if (e.showPlatform !== false) r.appendChild(el('div', `bd-plat${d.platformChanged ? ' changed' : ''}`, d.platform || ''));
          nodes.push(r);
        }
        wrap.replaceChildren(...nodes);
      };
      const load = async () => {
        try {
          data = await getJSON(`/api/player/departures?${new URLSearchParams({ stop: e.stopId, n: String(Math.max(1, Number(e.maxRows) || 8)), modes: (e.modes || []).join(',') })}`);
        } catch { if (!data) data = { departures: [], stop: e.stopName }; }
        draw();
      };
      load();
      if (ctx.thumb) return { node: b };
      const iv = setInterval(load, 30000);
      const redraw = setInterval(() => data && draw(), 10000);
      const stop = () => { clearInterval(iv); clearInterval(redraw); };
      ctx.onHide.push(stop);
      if (ctx.signal) ctx.signal.addEventListener('abort', stop, { once: true });
      return { node: b };
    },

    // A live stream: YouTube, Twitch, HLS (.m3u8) or a direct video address. Reconnects by itself.
    livestream(e, ctx) {
      const b = box(e);
      b.style.background = '#000';
      const src = streamSource(e.url);
      if (!src) { if (ctx.editor) b.appendChild(el('div', 'placeholder', 'Enter the address of the live stream')); return { node: b }; }
      const label = { youtube: 'YouTube', twitch: 'Twitch', hls: 'HLS', video: 'Video' }[src.kind];
      if (ctx.editor) {
        if (src.kind === 'youtube' && src.id) {
          const img = el('img', 'fill fit-cover');
          img.src = `https://img.youtube.com/vi/${src.id}/hqdefault.jpg`;
          img.onerror = () => img.remove();
          b.appendChild(img);
        } else b.appendChild(el('div', 'placeholder', `${label} live stream`));
        if (!ctx.thumb) b.appendChild(badge(`Live stream · ${label}`));
        return { node: b };
      }
      const muted = !e.audio;
      if (src.kind === 'youtube' || src.kind === 'twitch') {
        const f = el('iframe', 'fill');
        f.allow = 'autoplay; encrypted-media';
        f.setAttribute('scrolling', 'no');
        const yt = new URLSearchParams({ autoplay: '1', mute: muted ? '1' : '0', controls: '0', rel: '0', playsinline: '1', modestbranding: '1', iv_load_policy: '3' });
        if (src.id) { yt.set('loop', '1'); yt.set('playlist', src.id); }
        if (src.channel && src.kind === 'youtube') yt.set('channel', src.channel);
        const url = src.kind === 'twitch'
          ? `https://player.twitch.tv/?${new URLSearchParams({ channel: src.channel, parent: location.hostname || 'localhost', muted: String(muted), autoplay: 'true' })}`
          : `https://www.youtube-nocookie.com/embed/${src.id || 'live_stream'}?${yt}`;
        ctx.onShow.push(() => { f.src = url; });
        ctx.onHide.push(() => f.removeAttribute('src'));
        b.appendChild(f);
        return { node: b };
      }
      const v = el('video', `fill fit-${e.fit || 'contain'}`);
      Object.assign(v, { playsInline: true, muted, autoplay: true });
      b.appendChild(v);
      let on = false;
      let hls = null;
      let retry;
      const reconnect = () => { clearTimeout(retry); if (on) retry = setTimeout(start, 5000); };
      const play = () => v.play().catch(() => { v.muted = true; v.play().catch(() => {}); });
      async function start() {
        if (!on) return;
        if (hls) { hls.destroy(); hls = null; }
        if (src.kind === 'hls' && !v.canPlayType('application/vnd.apple.mpegurl')) {
          try { await loadScript(`${base}/player/vendor/hls.min.js`); } catch { reconnect(); return; }
          if (!on) return;
          hls = new window.Hls({ liveDurationInfinity: true, lowLatencyMode: false });
          hls.on(window.Hls.Events.ERROR, (ev, err) => { if (err.fatal) reconnect(); });
          hls.on(window.Hls.Events.MANIFEST_PARSED, play);
          hls.loadSource(src.url);
          hls.attachMedia(v);
        } else {
          v.src = src.url;
          play();
        }
      }
      v.addEventListener('error', reconnect);
      v.addEventListener('ended', reconnect);
      const stop = () => { on = false; clearTimeout(retry); if (hls) { hls.destroy(); hls = null; } v.pause(); v.removeAttribute('src'); v.load(); };
      ctx.onShow.push(() => { on = true; start(); });
      ctx.onHide.push(stop);
      if (ctx.signal) ctx.signal.addEventListener('abort', stop, { once: true });
      return { node: b };
    },

    webpage(e, ctx) {
      const b = box(e);
      if (!e.url) { if (ctx.editor) b.appendChild(el('div', 'placeholder', 'No URL set')); return { node: b }; }
      if (ctx.thumb) { b.appendChild(el('div', 'placeholder', 'Web page')); return { node: b }; }
      const f = el('iframe', 'fill');
      f.src = e.url;
      f.setAttribute('scrolling', 'no');
      const z = (Number(e.zoom) || 100) / 100;
      if (z !== 1) Object.assign(f.style, { width: `${100 / z}%`, height: `${100 / z}%`, transform: `scale(${z})`, transformOrigin: '0 0' });
      if (ctx.editor) f.style.pointerEvents = 'none';
      b.appendChild(f);
      return { node: b };
    },

    clock(e, ctx) {
      const b = box(e);
      const t = el('div', 'clock');
      Object.assign(t.style, { color: e.color || '#ffffff', fontSize: `${Number(e.fontSize) || 64}px`, textAlign: e.align || 'center', fontFamily: e.fontFamily || '', fontWeight: String(e.fontWeight || 700) });
      b.appendChild(t);
      const mode = e.mode || 'time';
      const tick = () => {
        const now = new Date();
        const parts = [];
        if (mode !== 'date') parts.push(fmtDate(ctx, now, { hour: '2-digit', minute: '2-digit', second: e.showSeconds ? '2-digit' : undefined, hour12: !!e.hour12 }));
        if (mode !== 'time') parts.push(fmtDate(ctx, now, { weekday: 'long', day: 'numeric', month: 'long', year: e.showYear ? 'numeric' : undefined }));
        t.textContent = parts.join(mode === 'both' ? '\n' : '');
      };
      tick();
      const iv = setInterval(tick, 1000);
      ctx.onHide.push(() => clearInterval(iv));
      return { node: b };
    },

    weather(e, ctx) {
      const b = box(e);
      const w = el('div', 'weather');
      Object.assign(w.style, { color: e.color || '#ffffff', fontSize: `${Number(e.fontSize) || 48}px`, fontFamily: e.fontFamily || '' });
      b.appendChild(w);
      getJSON(`/api/player/weather?lat=${encodeURIComponent(e.lat || 52.37)}&lon=${encodeURIComponent(e.lon || 4.9)}`).then((data) => {
        const [, icon, label] = wmo(data.current.weather_code);
        const head = el('div', 'w-now');
        head.append(el('span', 'w-icon', icon), el('span', 'w-temp', `${Math.round(data.current.temperature_2m)}°`));
        if (e.label) w.appendChild(el('div', 'w-place', e.label));
        w.append(head, el('div', 'w-desc', label));
        if (e.forecast !== false && data.daily) {
          const days = el('div', 'w-days');
          for (let d = 1; d < Math.min(4, data.daily.time.length); d++) {
            const day = el('div', 'w-day');
            day.append(
              el('div', '', fmtDate(ctx, new Date(`${data.daily.time[d]}T12:00:00`), { weekday: 'short' })),
              el('div', '', wmo(data.daily.weather_code[d])[1]),
              el('div', '', `${Math.round(data.daily.temperature_2m_max[d])}° / ${Math.round(data.daily.temperature_2m_min[d])}°`),
            );
            days.appendChild(day);
          }
          w.appendChild(days);
        }
      }).catch(() => { w.textContent = 'Weather unavailable'; });
      return { node: b };
    },

    ticker(e, ctx) {
      const b = box(e);
      const wrap = el('div', 'ticker');
      Object.assign(wrap.style, { background: e.background || '#c8102e', color: e.color || '#ffffff', fontSize: `${Number(e.fontSize) || 40}px`, fontFamily: e.fontFamily || '', fontWeight: String(e.fontWeight || 600) });
      if (e.label) {
        const label = el('div', 'tk-label', e.label);
        Object.assign(label.style, { background: e.labelBackground || '#000000', color: e.labelColor || '#ffffff' });
        wrap.appendChild(label);
      }
      const track = el('div', 'tk-track');
      wrap.appendChild(track);
      b.appendChild(wrap);
      let stopped = false;
      ctx.onHide.push(() => { stopped = true; });
      const lines = async () => {
        if (e.source === 'feed' && e.feedId) {
          try {
            const data = await feedItems(e.feedId);
            const list = (data.items || []).slice(0, Number(e.maxItems) || undefined).map((i) => i.title).filter(Boolean);
            if (list.length) return list;
          } catch { /* fall back to static text */ }
        }
        return String(e.text || '').split('\n').map((s) => s.trim()).filter(Boolean);
      };
      const loop = async () => {
        while (!stopped && b.isConnected !== false) {
          const list = await lines();
          track.innerHTML = '';
          const run = el('div', 'tk-run');
          list.forEach((line, i) => {
            if (i) run.appendChild(el('span', 'tk-sep', e.separator || '•'));
            run.appendChild(el('span', '', line));
          });
          track.appendChild(run);
          await new Promise(requestAnimationFrame);
          const from = track.clientWidth || Number(e.w) || 1000;
          const to = -run.scrollWidth;
          const speed = Number(e.speed) || 150;
          const anim = run.animate([{ transform: `translate(${from}px,-50%)` }, { transform: `translate(${to}px,-50%)` }], { duration: Math.max(1000, ((from - to) / speed) * 1000), easing: 'linear' });
          await anim.finished.catch(() => {});
          if (!list.length) await sleep(3000);
        }
      };
      ctx.onShow.push(loop);
      return { node: b };
    },
  };

  const WMO = [
    [[0], '☀️', 'Clear'], [[1, 2], '🌤️', 'Partly cloudy'], [[3], '☁️', 'Cloudy'], [[45, 48], '🌫️', 'Fog'],
    [[51, 53, 55, 56, 57], '🌦️', 'Drizzle'], [[61, 63, 65, 66, 67, 80, 81, 82], '🌧️', 'Rain'],
    [[71, 73, 75, 77, 85, 86], '🌨️', 'Snow'], [[95, 96, 99], '⛈️', 'Thunderstorm'],
  ];
  const wmo = (code) => WMO.find(([codes]) => codes.includes(code)) || [null, '🌡️', ''];

  function renderElement(e, ctx) {
    const r = renderers[e.type];
    if (!r) return { node: el('div') };
    const out = r(e, ctx);
    out.node.dataset.id = e.id || '';
    return out;
  }

  // Builds one slide (or the overlay layer). Returns { node, videoDone, show(), hide() }.
  function renderSlide(slide, ctx0) {
    const ctx = { ...ctx0, onShow: [], onHide: [] };
    const node = el('div', 'slide');
    node.style.background = slide.background || ctx.playoutBackground || '#000000';
    if (slide.backgroundMedia) {
      const isVideo = slide.backgroundMedia.type === 'video';
      const bg = el(isVideo ? 'video' : 'img', 'fill fit-cover slide-bg');
      bg.src = slide.backgroundMedia.url;
      if (isVideo) {
        Object.assign(bg, { muted: true, loop: true, playsInline: true });
        if (!ctx.editor) ctx.onShow.push(() => bg.play().catch(() => {}));
      }
      node.appendChild(bg);
    }
    const videos = [];
    for (const e of [...(slide.elements || [])].sort((a, b) => (Number(a.z) || 0) - (Number(b.z) || 0))) {
      const r = renderElement(e, ctx);
      node.appendChild(r.node);
      if (r.done && !e.loop) videos.push(r.done);
    }
    return {
      node,
      videoDone: videos.length ? Promise.all(videos) : null,
      show() { ctx.onShow.forEach((f) => f()); },
      hide() { ctx.onHide.forEach((f) => f()); },
    };
  }

  window.Beeldkrant = { base, renderSlide, renderElement, feedItems, getJSON, sleep, fill, zonedDate, streamSource };
})();
