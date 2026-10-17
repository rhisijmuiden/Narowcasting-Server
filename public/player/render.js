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

  async function getJSON(url) {
    const res = await fetch(url, { cache: 'no-store', credentials: 'same-origin' });
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

  function box(e) {
    const b = el('div', `el el-${e.type}`);
    Object.assign(b.style, {
      left: `${Number(e.x) || 0}px`, top: `${Number(e.y) || 0}px`,
      width: `${Number(e.w) || 100}px`, height: `${Number(e.h) || 100}px`,
      zIndex: String(Number(e.z) || 0),
      opacity: e.opacity != null && e.opacity !== '' ? String(Number(e.opacity) / 100) : '',
      borderRadius: e.radius ? `${Number(e.radius)}px` : '',
      background: e.type === 'text' || e.type === 'box' || e.type === 'clock' || e.type === 'weather' ? (e.background || 'transparent') : '',
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
      if (!e.feedId) { if (ctx.editor) wrap.appendChild(el('div', 'placeholder', 'Choose a feed')); return { node: b, done: null }; }
      const layout = e.layout || 'list';
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
        t.appendChild(el('div', 'rss-title', item.title || ''));
        if (e.showDescription !== false && item.description) {
          const d = el('div', 'rss-desc', item.description);
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
          return (data.items || []).slice(0, max > 0 ? max : undefined);
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
          if (pages > 1) b.appendChild(badge(`RSS · ${items.length} items · ${pages} pages`));
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

  window.Beeldkrant = { renderSlide, renderElement, feedItems, getJSON, sleep, fill };
})();
