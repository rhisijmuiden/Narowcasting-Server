/* Beeldkrant player: plays the playout that is on air. Runs in the stream renderer and in the admin preview.
 * Query parameters: output=1 (renderer), playout=<id> (preview a specific playout). */
(() => {
  'use strict';

  const { renderSlide, feedItems, getJSON, sleep } = window.Beeldkrant;
  const params = new URLSearchParams(location.search);
  const forcedPlayout = params.get('playout');
  const stage = document.getElementById('stage');
  const slidesLayer = document.createElement('div');
  const overlayLayer = document.createElement('div');
  slidesLayer.className = 'slides';
  overlayLayer.className = 'overlays';
  stage.append(slidesLayer, overlayLayer);

  let state = null;
  let playoutCtrl = new AbortController(); // aborted when another playout goes on air
  let overlay = null;
  let overlayKey = '';
  let current = null; // { rendered, layer }
  let wake = null;

  // ---------- background music ----------
  const music = new Audio();
  music.preload = 'none';
  let musicUrl = null;
  let musicTarget = 0;
  let musicRetry = null;
  function syncMusic() {
    const m = state.music;
    const url = m ? m.url : null;
    if (url !== musicUrl) {
      musicUrl = url;
      clearTimeout(musicRetry);
      if (!url) { music.pause(); music.removeAttribute('src'); music.load(); return; }
      music.src = url;
      music.loop = !m.live;
      music.volume = 0;
      music.play().catch(() => {});
    }
    setMusicLevel(current && current.ducked);
  }
  function setMusicLevel(ducked) {
    const m = state && state.music;
    if (!m) return;
    musicTarget = Math.max(0, Math.min(1, (ducked ? m.duck : m.volume) / 100));
  }
  // Smooth volume changes (fade in, ducking under videos with sound).
  setInterval(() => {
    const diff = musicTarget - music.volume;
    if (Math.abs(diff) > 0.01) music.volume = Math.max(0, Math.min(1, music.volume + Math.sign(diff) * Math.min(Math.abs(diff), 0.05)));
  }, 50);
  // Live streams drop now and then: reconnect.
  const reconnect = () => {
    if (!musicUrl) return;
    clearTimeout(musicRetry);
    musicRetry = setTimeout(() => { const u = musicUrl; musicUrl = null; if (state.music && state.music.url === u) syncMusic(); }, 3000);
  };
  music.addEventListener('error', reconnect);
  music.addEventListener('ended', () => { if (state.music && state.music.live) reconnect(); });
  music.addEventListener('stalled', reconnect);

  function fitStage() {
    const p = state && state.playout;
    const w = (p && p.width) || 1920;
    const h = (p && p.height) || 1080;
    const scale = Math.min(window.innerWidth / w, window.innerHeight / h);
    stage.style.width = `${w}px`;
    stage.style.height = `${h}px`;
    stage.style.transform = `translate(${(window.innerWidth - w * scale) / 2}px, ${(window.innerHeight - h * scale) / 2}px) scale(${scale})`;
  }
  window.addEventListener('resize', fitStage);

  const baseCtx = () => ({ timezone: state.timezone, locale: state.locale, playoutBackground: state.playout && state.playout.backgroundColor });

  async function load() {
    try {
      const next = await getJSON(`/api/player/state${forcedPlayout ? `?playout=${encodeURIComponent(forcedPlayout)}` : ''}`);
      const prevId = state && state.playout && state.playout.id;
      const nextId = next.playout && next.playout.id;
      state = next;
      fitStage();
      stage.style.background = (next.playout && next.playout.backgroundColor) || '#000';
      if (prevId !== nextId) {
        // Another playout is on air (schedule or first load): cut over right away.
        playoutCtrl.abort();
        playoutCtrl = new AbortController();
      }
      syncOverlays();
      syncMusic();
      if (wake) wake();
    } catch (err) {
      console.error(err);
    }
  }

  function syncOverlays() {
    const p = state.playout;
    const key = JSON.stringify(p ? [p.id, p.overlays, p.width, p.height, state.locale, state.timezone] : null);
    if (key === overlayKey) return;
    overlayKey = key;
    if (overlay) overlay.hide();
    overlayLayer.innerHTML = '';
    overlay = null;
    if (!p || !(p.overlays || []).length) return;
    overlay = renderSlide({ elements: p.overlays, background: 'transparent' }, { ...baseCtx(), signal: playoutCtrl.signal });
    overlay.node.style.background = 'transparent';
    overlayLayer.appendChild(overlay.node);
    overlay.show();
  }

  // Waits until load() brings new state (used when there is nothing to play).
  function waitForState(ms) {
    return new Promise((resolve) => {
      const t = setTimeout(done, ms);
      function done() { clearTimeout(t); wake = null; resolve(); }
      wake = done;
    });
  }

  // ---------- transitions ----------
  const EASE = 'cubic-bezier(.4,0,.2,1)';
  const TRANSITIONS = {
    cut: null,
    fade: { in: [{ opacity: 0 }, { opacity: 1 }], out: null },
    crossfade: { in: [{ opacity: 0 }, { opacity: 1 }], out: [{ opacity: 1 }, { opacity: 0 }] },
    'slide-left': { in: [{ transform: 'translateX(100%)' }, { transform: 'translateX(0)' }], out: [{ transform: 'translateX(0)' }, { transform: 'translateX(-100%)' }] },
    'slide-right': { in: [{ transform: 'translateX(-100%)' }, { transform: 'translateX(0)' }], out: [{ transform: 'translateX(0)' }, { transform: 'translateX(100%)' }] },
    'slide-up': { in: [{ transform: 'translateY(100%)' }, { transform: 'translateY(0)' }], out: [{ transform: 'translateY(0)' }, { transform: 'translateY(-100%)' }] },
    'slide-down': { in: [{ transform: 'translateY(-100%)' }, { transform: 'translateY(0)' }], out: [{ transform: 'translateY(0)' }, { transform: 'translateY(100%)' }] },
    zoom: { in: [{ opacity: 0, transform: 'scale(1.12)' }, { opacity: 1, transform: 'scale(1)' }], out: [{ opacity: 1, transform: 'scale(1)' }, { opacity: 0, transform: 'scale(.94)' }] },
    wipe: { in: [{ clipPath: 'inset(0 100% 0 0)' }, { clipPath: 'inset(0 0 0 0)' }], out: null },
    'wipe-down': { in: [{ clipPath: 'inset(0 0 100% 0)' }, { clipPath: 'inset(0 0 0 0)' }], out: null },
    circle: { in: [{ clipPath: 'circle(0% at 50% 50%)' }, { clipPath: 'circle(75% at 50% 50%)' }], out: null },
    blur: { in: [{ opacity: 0, filter: 'blur(24px)' }, { opacity: 1, filter: 'blur(0)' }], out: [{ opacity: 1, filter: 'blur(0)' }, { opacity: 0, filter: 'blur(24px)' }] },
  };

  async function present(slide, ctxExtra) {
    const p = state.playout;
    const ctrl = new AbortController();
    const outer = playoutCtrl.signal;
    outer.addEventListener('abort', () => ctrl.abort(), { once: true });
    const rendered = renderSlide(slide, { ...baseCtx(), ...ctxExtra, signal: ctrl.signal });
    const layer = rendered.node;
    slidesLayer.appendChild(layer);
    overlayLayer.style.visibility = slide.hideOverlays ? 'hidden' : 'visible';

    const type = slide.transition || p.transition || 'fade';
    const ms = Number(slide.transitionMs ?? p.transitionMs ?? 800);
    const tr = TRANSITIONS[type] || TRANSITIONS.fade;
    rendered.show();
    const prev = current;
    const ducked = (slide.elements || []).some((e) => e.audio && ((e.type === 'video' && e.src) || (e.type === 'playlist' && (e.sources || []).length)));
    current = { rendered, layer, ducked };
    setMusicLevel(ducked);
    if (tr && ms > 0 && prev) {
      const anims = [layer.animate(tr.in, { duration: ms, easing: EASE, fill: 'both' })];
      if (tr.out) anims.push(prev.layer.animate(tr.out, { duration: ms, easing: EASE, fill: 'both' }));
      await Promise.all(anims.map((a) => a.finished.catch(() => {})));
    }
    if (prev) { prev.rendered.hide(); prev.layer.remove(); }

    // Hold the slide: until its video(s) end, or for its duration.
    const seconds = Math.max(1, Number(slide.duration) || 10);
    if (slide.advance === 'video' && rendered.videoDone) {
      const cap = Number(slide.maxDuration);
      await Promise.race([rendered.videoDone, cap ? sleep(cap * 1000, ctrl.signal) : new Promise(() => {}), new Promise((r) => ctrl.signal.addEventListener('abort', r, { once: true }))]);
    } else {
      await sleep(seconds * 1000, ctrl.signal);
    }
    return ctrl;
  }

  // Feed-driven slides repeat once per feed item; every other slide plays once.
  async function pagesFor(slide) {
    if (!slide.feedId) return [{}];
    try {
      const data = await feedItems(slide.feedId);
      // The feed already holds the number of items set on the feed; a scene can show fewer.
      return (data.items || []).slice(0, Number(slide.feedMaxItems) || undefined).map((item) => ({ item: { ...item, feedTitle: data.title } }));
    } catch {
      return [];
    }
  }

  // ---------- ad blocks ----------
  const adCounters = new Map(); // ad block id -> scenes since it last ran
  const adFired = new Set(); // "blockId date time" already played today
  function clockNow() {
    const parts = Object.fromEntries(new Intl.DateTimeFormat('en-GB', {
      timeZone: state.timezone, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', weekday: 'short', hour12: false,
    }).formatToParts(new Date()).map((x) => [x.type, x.value]));
    return { date: `${parts.year}-${parts.month}-${parts.day}`, minutes: (Number(parts.hour) % 24) * 60 + Number(parts.minute), day: parts.weekday.toLowerCase().slice(0, 3) };
  }

  // Returns the ad block that is due now, if any. Called between scenes.
  function dueAdBlock(p) {
    const now = clockNow();
    for (const ad of p.adBlocks || []) {
      if (ad.mode === 'times') {
        if (ad.days && ad.days.length && !ad.days.includes(now.day)) continue;
        for (const t of ad.times || []) {
          const [hh, mm] = String(t).split(':').map(Number);
          const at = (hh || 0) * 60 + (mm || 0);
          const key = `${ad.id} ${now.date} ${t}`;
          // Due from the set time until 30 minutes later (so a restart does not replay the whole day).
          if (now.minutes >= at && now.minutes < at + 30 && !adFired.has(key)) { adFired.add(key); return ad; }
        }
      } else {
        const n = Math.max(1, Number(ad.everyScenes) || 5);
        if ((adCounters.get(ad.id) || 0) >= n) { adCounters.set(ad.id, 0); return ad; }
      }
    }
    return null;
  }

  async function playSlide(slide, signal) {
    const pages = await pagesFor(slide);
    for (const page of pages) {
      if (signal.aborted) break;
      await present(slide, page);
    }
    return pages.length;
  }

  async function run() {
    let index = -1;
    let playoutId = null;
    for (;;) {
      const p = state && state.playout;
      if (!p) {
        if (current) { current.rendered.hide(); current.layer.remove(); current = null; }
        slidesLayer.innerHTML = '<div class="empty">Nothing on air. Create a playout in the admin panel.</div>';
        await waitForState(5000);
        slidesLayer.innerHTML = '';
        continue;
      }
      if (p.id !== playoutId) { playoutId = p.id; index = -1; adCounters.clear(); }
      const ad = dueAdBlock(p);
      if (ad) {
        const signal = playoutCtrl.signal;
        for (const slide of ad.slides) {
          if (signal.aborted) break;
          await playSlide(slide, signal);
        }
        continue;
      }
      const playable = p.slides.filter((s) => s.active !== false);
      if (!playable.length) { await waitForState(5000); continue; }
      // Continue after the slide we just played, even if slides were added or removed in the meantime.
      const lastId = index >= 0 && p.slides[index] ? p.slides[index].id : null;
      let pos = lastId ? playable.findIndex((s) => s.id === lastId) : -1;
      pos = (pos + 1) % playable.length;
      const slide = playable[pos];
      index = p.slides.indexOf(slide);
      const shown = await playSlide(slide, playoutCtrl.signal);
      if (!shown) { await sleep(1000); continue; }
      for (const a of p.adBlocks || []) if (a.mode !== 'times') adCounters.set(a.id, (adCounters.get(a.id) || 0) + 1);
    }
  }

  function listen() {
    const es = new EventSource('/api/player/events');
    let first = true;
    es.onmessage = () => { if (first) { first = false; return; } load(); };
    es.onerror = () => { es.close(); setTimeout(() => { listen(); load(); }, 5000); };
  }

  // Re-check the schedule regularly so time-based playouts and slide windows switch on their own.
  setInterval(load, 15000);
  load().then(() => { listen(); run(); });
})();
