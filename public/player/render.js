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

    webpage(e, ctx) {
      const b = box(e);
      if (!e.url) { if (ctx.editor) b.appendChild(el('div', 'placeholder', 'No URL set')); return { node: b }; }
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
            const list = (data.items || []).slice(0, Number(e.maxItems) || 15).map((i) => i.title).filter(Boolean);
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
