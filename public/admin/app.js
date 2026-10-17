/* Beeldkrant admin panel (no build step, plain DOM). */
(() => {
  'use strict';

  const app = document.getElementById('app');
  let me = null;

  // ---------- helpers ----------
  function h(tag, attrs, ...children) {
    const e = document.createElement(tag);
    for (const [k, v] of Object.entries(attrs || {})) {
      if (v == null || v === false) continue;
      if (k === 'class') e.className = v;
      else if (k === 'style' && typeof v === 'object') Object.assign(e.style, v);
      else if (k.startsWith('on')) e.addEventListener(k.slice(2), v);
      else if (k === 'value') e.value = v;
      else if (k === 'checked') e.checked = !!v;
      else if (k === 'html') e.innerHTML = v;
      else e.setAttribute(k, v === true ? '' : v);
    }
    for (const c of children.flat(Infinity)) {
      if (c == null || c === false) continue;
      e.appendChild(c instanceof Node ? c : document.createTextNode(String(c)));
    }
    return e;
  }

  // replaceChildren that skips null/false, so conditional children can be written inline.
  function put(el, ...children) {
    el.replaceChildren(...children.flat(Infinity).filter((c) => c != null && c !== false));
  }

  async function api(method, url, body) {
    const opts = { method, headers: {}, credentials: 'same-origin' };
    if (body instanceof FormData) opts.body = body;
    else if (body !== undefined) { opts.headers['Content-Type'] = 'application/json'; opts.body = JSON.stringify(body); }
    const res = await fetch(url, opts);
    const data = await res.json().catch(() => ({}));
    if (res.status === 401 && !url.endsWith('/login')) { me = null; route(); throw new Error('Please log in'); }
    if (res.status === 403 && data.mustChangePassword) { me.user.mustChangePassword = true; route(); throw new Error(data.error); }
    if (!res.ok) throw new Error(data.error || `Request failed (${res.status})`);
    return data;
  }
  const GET = (u) => api('GET', u);
  const POST = (u, b) => api('POST', u, b ?? {});
  const PUT = (u, b) => api('PUT', u, b);
  const DEL = (u) => api('DELETE', u);

  function toast(msg, kind = '') {
    const t = h('div', { class: `toast ${kind}` }, msg);
    document.getElementById('toasts').appendChild(t);
    setTimeout(() => t.remove(), kind === 'err' ? 6000 : 3000);
  }
  const fail = (err) => toast(err.message || String(err), 'err');

  const clone = (o) => JSON.parse(JSON.stringify(o));
  const uid = () => Math.random().toString(16).slice(2, 10);
  const thumb = (m) => h('div', { class: 'thumb', style: m.thumbUrl ? { backgroundImage: `url("${m.thumbUrl}")` } : {} },
    m.thumbUrl ? null : h('div', { class: 'audio-icon' }, m.external ? '📻' : '♪'),
    h('span', { class: 'badge kind' }, m.external ? 'stream' : m.type));
  const fmtBytes = (n) => (n > 1e9 ? `${(n / 1e9).toFixed(1)} GB` : n > 1e6 ? `${(n / 1e6).toFixed(1)} MB` : `${Math.round(n / 1e3)} kB`);

  function field(label, input, opts = {}) {
    return h('label', { class: `field ${opts.wide ? 'wide' : ''}` }, h('span', null, label), input, opts.hint ? h('div', { class: 'hint' }, opts.hint) : null);
  }

  // Inputs bound to obj[key]; onChange is called after every change.
  function bind(obj, key, onChange, type = 'text', extra = {}) {
    const get = () => obj[key];
    if (type === 'checkbox') {
      return h('input', { type: 'checkbox', checked: !!get(), onchange: (e) => { obj[key] = e.target.checked; onChange(); } });
    }
    if (type === 'select') {
      const sel = h('select', { onchange: (e) => { obj[key] = e.target.value === '' ? null : e.target.value; onChange(); } },
        (extra.options || []).map(([v, l]) => h('option', { value: v ?? '' }, l)));
      sel.value = get() ?? '';
      if (sel.selectedIndex === -1) sel.selectedIndex = 0;
      return sel;
    }
    if (type === 'color') {
      const text = h('input', { type: 'text', value: get() || '', placeholder: extra.placeholder || '' });
      const pick = h('input', { type: 'color', value: /^#[0-9a-f]{6}$/i.test(get() || '') ? get() : (extra.fallback || '#000000') });
      pick.addEventListener('input', () => { obj[key] = pick.value; text.value = pick.value; onChange(); });
      text.addEventListener('change', () => { obj[key] = text.value.trim() || undefined; if (/^#[0-9a-f]{6}$/i.test(text.value)) pick.value = text.value; onChange(); });
      return h('div', { class: 'color-field' }, pick, text);
    }
    if (type === 'textarea') {
      return h('textarea', { value: get() ?? '', placeholder: extra.placeholder || '', oninput: (e) => { obj[key] = e.target.value; onChange(); } });
    }
    const input = h('input', { type, value: get() ?? '', placeholder: extra.placeholder || '', min: extra.min, max: extra.max, step: extra.step });
    input.addEventListener(type === 'number' ? 'input' : 'input', (e) => {
      obj[key] = type === 'number' ? (e.target.value === '' ? undefined : Number(e.target.value)) : e.target.value;
      onChange();
    });
    return input;
  }

  function modal(title, body, actions) {
    const back = h('div', { class: 'modal-back', onclick: (e) => { if (e.target === back) close(); } });
    const close = () => back.remove();
    back.appendChild(h('div', { class: 'modal' }, h('h2', null, title), body, h('div', { class: 'row', style: { justifyContent: 'flex-end', marginTop: '16px' } }, actions(close))));
    document.body.appendChild(back);
    return close;
  }

  function confirmBox(text) {
    return new Promise((resolve) => {
      modal('Are you sure?', h('p', null, text), (close) => [
        h('button', { onclick: () => { close(); resolve(false); } }, 'Cancel'),
        h('button', { class: 'danger', onclick: () => { close(); resolve(true); } }, 'Delete'),
      ]);
    });
  }

  // ---------- branding and theme ----------
  function brand() {
    const name = (me && me.panelName) || 'Beeldkrant';
    document.title = `${name} admin`;
    // The default name keeps its two-tone logo; a custom name is shown as typed.
    return name === 'Beeldkrant' ? h('div', { class: 'brand' }, 'Beeld', h('span', null, 'krant')) : h('div', { class: 'brand brand-plain' }, name);
  }

  function applyTheme(theme) {
    document.documentElement.dataset.theme = theme || 'system';
    try { localStorage.setItem('bk-theme', document.documentElement.dataset.theme); } catch { /* private mode */ }
  }
  try { applyTheme(localStorage.getItem('bk-theme')); } catch { applyTheme('system'); }

  function themeSwitch() {
    const current = (me.user && me.user.theme) || 'system';
    return h('div', { class: 'theme-switch', title: 'Theme' }, [['light', 'Light'], ['dark', 'Dark'], ['system', 'Auto']].map(([value, label]) => h('button', {
      class: current === value ? 'active' : '',
      onclick: async () => {
        applyTheme(value);
        try { await PUT('/api/me/theme', { theme: value }); me.user.theme = value; route(); } catch (err) { fail(err); }
      },
    }, label)));
  }

  // ---------- routing ----------
  const NAV = [
    ['dashboard', 'Dashboard'],
    ['playouts', 'Playouts'],
    ['media', 'Media'],
    ['feeds', 'RSS feeds'],
    ['schedule', 'Schedule'],
    ['output', 'Stream output'],
    ['settings', 'Settings'],
  ];
  let cleanup = null;

  async function route() {
    if (cleanup) { cleanup(); cleanup = null; }
    if (!me) {
      try { me = await GET('/api/me'); } catch { me = { user: null }; }
    }
    if (me.user) applyTheme(me.user.theme);
    if (!me.user) return renderLogin();
    if (me.user.mustChangePassword) return renderChangePassword(true);
    const [page, arg] = (location.hash.slice(1) || 'dashboard').split('/');
    if (page === 'playout' && arg) return renderEditor(arg);
    const main = h('main', { class: 'main' });
    put(app, h('div', { class: 'shell' },
      h('nav', { class: 'nav' },
        brand(),
        NAV.map(([id, label]) => h('a', { href: `#${id}`, class: page === id ? 'active' : '' }, label)),
        h('div', { class: 'spacer' }),
        themeSwitch(),
        h('div', { class: 'who' }, `${me.user.username} (${me.user.role})`),
        h('a', { href: '#', onclick: async (e) => { e.preventDefault(); await POST('/api/logout'); me = null; route(); } }, 'Log out'),
      ),
      main));
    const pages = { dashboard: pageDashboard, playouts: pagePlayouts, media: pageMedia, feeds: pageFeeds, schedule: pageSchedule, output: pageOutput, settings: pageSettings };
    try { await (pages[page] || pageDashboard)(main); } catch (err) { fail(err); }
  }
  window.addEventListener('hashchange', () => { if (!editorGuard()) route(); });

  // ---------- login ----------
  function renderLogin() {
    const user = h('input', { value: 'admin', autocomplete: 'username' });
    const pass = h('input', { type: 'password', autocomplete: 'current-password' });
    const submit = async (e) => {
      e.preventDefault();
      try {
        const res = await POST('/api/login', { username: user.value, password: pass.value });
        applyTheme(res.user.theme);
        me = { ...me, user: res.user };
        route();
      } catch (err) { fail(err); }
    };
    put(app, h('div', { class: 'login' }, h('form', { class: 'card stack', onsubmit: submit },
      brand(),
      field('Username', user), field('Password', pass),
      h('button', { class: 'primary', type: 'submit' }, 'Log in'),
      h('div', { class: 'hint' }, 'First login: use the one-time password shown at the end of the installation.'),
    )));
    pass.focus();
  }

  function renderChangePassword(forced) {
    const cur = h('input', { type: 'password', autocomplete: 'current-password' });
    const p1 = h('input', { type: 'password', autocomplete: 'new-password' });
    const p2 = h('input', { type: 'password', autocomplete: 'new-password' });
    const submit = async (e) => {
      e.preventDefault();
      if (p1.value !== p2.value) return toast('The new passwords do not match', 'err');
      try {
        await POST('/api/password', { current: cur.value, password: p1.value });
        me.user.mustChangePassword = false;
        toast('Password changed', 'ok');
        if (forced) route();
        else { cur.value = p1.value = p2.value = ''; }
      } catch (err) { fail(err); }
    };
    const form = h('form', { class: 'card stack', onsubmit: submit },
      forced ? brand() : null,
      forced ? h('p', null, 'You are using a one-time password. Choose your own password to continue.') : null,
      field(forced ? 'One-time password' : 'Current password', cur), field('New password (at least 8 characters)', p1), field('Repeat new password', p2),
      h('button', { class: 'primary', type: 'submit' }, 'Change password'));
    if (forced) put(app, h('div', { class: 'login' }, form));
    return form;
  }

  // ---------- dashboard ----------
  async function pageDashboard(main) {
    const statusBox = h('div');
    const logs = h('div', { class: 'logs' });
    main.append(
      h('h1', null, 'Dashboard'),
      h('div', { class: 'grid two' },
        h('div', { class: 'card stack' }, h('h2', null, 'On air'), statusBox),
        h('div', { class: 'card' }, h('div', { class: 'row between' }, h('h2', null, 'Live preview'), h('a', { href: '/player/', target: '_blank' }, 'Open full screen')),
          h('iframe', { class: 'preview-frame', src: '/player/' })),
      ),
      h('div', { class: 'card', style: { marginTop: '16px' } }, h('h2', null, 'Renderer log'), logs));

    async function refresh() {
      try {
        const [s, settings, playouts, logLines] = await Promise.all([GET('/api/stream'), GET('/api/settings'), GET('/api/playouts'), GET('/api/stream/logs')]);
        const onAir = playouts.find((p) => p.id === settings.activePlayoutId);
        const cls = { live: 'ok', starting: 'warn', restarting: 'warn', stopped: '', error: 'err' }[s.state] || '';
        const missing = ['xvfb', 'chromium', 'ffmpeg'].filter((t) => !s.tools[t]);
        put(statusBox, 
          h('div', { class: 'row' }, h('span', { class: `badge ${cls}` }, h('span', { class: 'dot' }), s.state.toUpperCase()),
            s.lastError && s.state !== 'live' ? h('span', { class: 'muted' }, s.lastError) : null),
          h('div', { class: 'row', style: { gap: '28px' } },
            h('div', { class: 'stat' }, h('small', null, 'Playout'), h('b', null, onAir ? onAir.name : 'none')),
            h('div', { class: 'stat' }, h('small', null, 'Output'), h('b', null, s.resolution || '-')),
            h('div', { class: 'stat' }, h('small', null, 'FPS'), h('b', null, s.stats.fps || '-')),
            h('div', { class: 'stat' }, h('small', null, 'Bitrate'), h('b', null, s.stats.bitrate || '-')),
            h('div', { class: 'stat' }, h('small', null, 'Speed'), h('b', null, s.stats.speed || '-'))),
          h('div', null, h('small', null, 'Destination: '), s.destination || h('a', { href: '#output' }, 'not set')),
          missing.length ? h('div', { class: 'badge err' }, `Missing on this server: ${missing.join(', ')}`) : null,
          h('div', { class: 'row' },
            s.wanted
              ? [h('button', { class: 'danger', onclick: () => POST('/api/stream/stop').then(refresh).catch(fail) }, 'Stop stream'),
                h('button', { onclick: () => POST('/api/stream/restart').then(refresh).catch(fail) }, 'Restart')]
              : h('button', { class: 'primary', onclick: () => POST('/api/stream/start').then(refresh).catch(fail) }, 'Start stream')),
        );
        const atBottom = logs.scrollTop + logs.clientHeight >= logs.scrollHeight - 10;
        logs.textContent = logLines.map((l) => `${l.t.slice(11, 19)} [${l.source}] ${l.line}`).join('\n') || 'No output yet.';
        if (atBottom) logs.scrollTop = logs.scrollHeight;
      } catch (err) { /* shown on next action */ }
    }
    await refresh();
    const iv = setInterval(refresh, 3000);
    cleanup = () => clearInterval(iv);
  }

  // ---------- playouts ----------
  const RESOLUTIONS = [
    [1920, 1080, 'Full HD', '16:9 landscape'],
    [1280, 720, 'HD', '16:9 landscape'],
    [3840, 2160, '4K UHD', '16:9 landscape'],
    [1080, 1920, 'Full HD portrait', '9:16 portrait'],
    [720, 1280, 'HD portrait', '9:16 portrait'],
    [1024, 768, 'XGA', '4:3'],
  ];

  async function pagePlayouts(main) {
    const [playouts, settings] = await Promise.all([GET('/api/playouts'), GET('/api/settings')]);
    main.append(
      h('div', { class: 'row between' }, h('h1', null, 'Playouts'), h('button', { class: 'primary', onclick: newPlayoutWizard }, '+ New playout')),
      playouts.length ? h('div', { class: 'card' }, h('table', null,
        h('tr', null, h('th', null, 'Name'), h('th', null, 'Resolution'), h('th', null, 'Scenes'), h('th', null, 'Status'), h('th', null, '')),
        playouts.map((p) => h('tr', null,
          h('td', null, h('a', { href: `#playout/${p.id}` }, p.name)),
          h('td', null, `${p.width} x ${p.height}`),
          h('td', null, String((p.slides || []).length)),
          h('td', null, p.id === settings.activePlayoutId ? h('span', { class: 'badge ok' }, h('span', { class: 'dot' }), 'On air') : ''),
          h('td', { style: { textAlign: 'right' } },
            h('a', { class: 'btn', href: `/player/?playout=${p.id}`, target: '_blank' }, 'Preview'), ' ',
            h('button', { onclick: async () => { const c = clone(p); delete c.id; c.name += ' (copy)'; await POST('/api/playouts', c); route(); } }, 'Duplicate'), ' ',
            h('button', { class: 'ghost', onclick: async () => { if (await confirmBox(`Delete playout "${p.name}"?`)) { await DEL(`/api/playouts/${p.id}`); route(); } } }, 'Delete')),
        )))) : h('div', { class: 'card' }, h('p', null, 'No playouts yet. A playout is a channel: a resolution and a series of scenes.')),
    );
  }

  function newPlayoutWizard() {
    const data = { name: 'New playout', width: 1920, height: 1080 };
    const presets = h('div', { class: 'res-presets' });
    const wIn = h('input', { type: 'number', value: data.width, min: 160, max: 7680 });
    const hIn = h('input', { type: 'number', value: data.height, min: 120, max: 4320 });
    const draw = () => put(presets, ...RESOLUTIONS.map(([w, hh, name, note]) => h('button', {
      class: data.width === w && data.height === hh ? 'active' : '',
      onclick: () => { data.width = w; data.height = hh; wIn.value = w; hIn.value = hh; draw(); },
    }, h('b', null, name), h('small', null, `${w} x ${hh} · ${note}`))));
    wIn.oninput = () => { data.width = Number(wIn.value); draw(); };
    hIn.oninput = () => { data.height = Number(hIn.value); draw(); };
    draw();
    modal('New playout', h('div', { class: 'stack' },
      h('p', { class: 'muted' }, 'Step 1: name the playout and choose its resolution. You add scenes in the next step.'),
      field('Name', bind(data, 'name', () => {})),
      h('h3', null, 'Resolution'), presets,
      h('div', { class: 'fields' }, field('Width (px)', wIn), field('Height (px)', hIn))),
    (close) => [
      h('button', { onclick: close }, 'Cancel'),
      h('button', { class: 'primary', onclick: async () => {
        try {
          const w = Math.round(data.width) - (Math.round(data.width) % 2);
          const hh = Math.round(data.height) - (Math.round(data.height) % 2);
          const p = await POST('/api/playouts', { name: data.name || 'Playout', width: w, height: hh, backgroundColor: '#000000', transition: 'fade', transitionMs: 800, slides: [], overlays: [] });
          close();
          location.hash = `playout/${p.id}`;
        } catch (err) { fail(err); }
      } }, 'Next: add scenes'),
    ]);
  }

  // ---------- playout editor ----------
  const ELEMENT_TYPES = {
    text: { label: 'Text', w: 800, h: 160, defaults: { text: 'New text', fontSize: 64, fontWeight: 700, color: '#ffffff', align: 'left', valign: 'middle' } },
    image: { label: 'Image', w: 640, h: 360, defaults: { fit: 'cover' } },
    video: { label: 'Video', w: 960, h: 540, defaults: { fit: 'cover', audio: true } },
    ticker: { label: 'Ticker', w: 1920, h: 80, defaults: { source: 'text', text: 'Breaking news\nMore headlines here', fontSize: 40, speed: 150, background: '#c8102e', color: '#ffffff', label: 'News' } },
    clock: { label: 'Clock', w: 300, h: 110, defaults: { mode: 'time', fontSize: 72, color: '#ffffff' } },
    weather: { label: 'Weather', w: 520, h: 360, defaults: { lat: 52.37, lon: 4.9, label: 'Amsterdam', fontSize: 56, color: '#ffffff' } },
    webpage: { label: 'Web page', w: 1280, h: 720, defaults: { url: 'https://', zoom: 100 } },
    box: { label: 'Box', w: 600, h: 300, defaults: { background: 'rgba(0,0,0,0.5)', radius: 16 } },
  };
  const TRANSITIONS = ['fade', 'crossfade', 'cut', 'slide-left', 'slide-right', 'slide-up', 'slide-down', 'zoom', 'wipe', 'wipe-down', 'circle', 'blur'];
  const DAY_LABELS = [['mon', 'Mon'], ['tue', 'Tue'], ['wed', 'Wed'], ['thu', 'Thu'], ['fri', 'Fri'], ['sat', 'Sat'], ['sun', 'Sun']];

  let editorDirty = false;
  function editorGuard() {
    if (editorDirty && !confirm('You have unsaved changes. Leave the editor anyway?')) {
      history.back();
      return true;
    }
    editorDirty = false;
    return false;
  }
  window.addEventListener('beforeunload', (e) => { if (editorDirty) { e.preventDefault(); e.returnValue = ''; } });

  async function renderEditor(id) {
    let playout;
    let media;
    let feeds;
    let allPlayouts;
    let region;
    try {
      [playout, media, feeds, allPlayouts, region] = await Promise.all([GET(`/api/playouts/${id}`), GET('/api/media'), GET('/api/feeds'), GET('/api/playouts'), GET('/api/settings')]);
    } catch (err) { fail(err); location.hash = 'playouts'; return; }
    playout.slides = playout.slides || [];
    playout.overlays = playout.overlays || [];
    playout.adBlocks = playout.adBlocks || [];
    playout.music = playout.music || { mediaId: null, volume: 60, duck: 15 };
    const mediaById = Object.fromEntries(media.map((m) => [m.id, m]));
    const feedOptions = [['', '— choose a feed —'], ...feeds.map((f) => [f.id, f.name])];

    const S = { slideIndex: playout.slides.length ? 0 : -1, mode: 'slide', selected: null };
    const saveBtn = h('button', { class: 'primary', onclick: save }, 'Save');
    const markDirty = () => { editorDirty = true; saveBtn.textContent = 'Save *'; };

    const sideEl = h('div', { class: 'side' });
    const propsEl = h('div', { class: 'props' });
    const area = h('div', { class: 'canvas-area' });
    const stage = h('div', { class: 'canvas-stage' });
    area.appendChild(stage);
    const toolbar = h('div', { class: 'toolbar' },
      Object.entries(ELEMENT_TYPES).map(([type, def]) => h('button', { class: 'small', onclick: () => addElement(type) }, `+ ${def.label}`)));

    put(app, h('div', { class: 'editor' },
      h('div', { class: 'topbar' },
        h('a', { href: '#playouts', class: 'btn' }, '← Playouts'),
        h('span', { class: 'title' }, playout.name),
        h('span', { class: 'muted' }, `${playout.width} x ${playout.height}`),
        h('div', { class: 'grow' }),
        h('div', { class: 'tabs', style: { margin: 0 } },
          h('button', { id: 'tab-slide', onclick: () => { S.mode = 'slide'; S.selected = null; renderAll(); } }, 'Scenes'),
          h('button', { id: 'tab-overlay', onclick: () => { S.mode = 'overlay'; S.selected = null; renderAll(); } }, 'Overlays')),
        h('button', { onclick: () => { S.selected = null; S.mode = 'settings'; renderAll(); } }, 'Playout settings'),
        h('a', { class: 'btn', href: `/player/?playout=${playout.id}`, target: '_blank' }, 'Preview ▶'),
        saveBtn),
      sideEl,
      h('div', { class: 'canvas-wrap' }, toolbar, area),
      propsEl));

    async function save() {
      try {
        await PUT(`/api/playouts/${playout.id}`, playout);
        editorDirty = false;
        saveBtn.textContent = 'Save';
        toast('Saved. The stream picks up the changes right away.', 'ok');
      } catch (err) { fail(err); }
    }
    const onKey = (e) => {
      if ((e.ctrlKey || e.metaKey) && e.key === 's') { e.preventDefault(); save(); }
      if ((e.key === 'Delete' || e.key === 'Backspace') && S.selected && !/INPUT|TEXTAREA|SELECT/.test(document.activeElement.tagName)) { e.preventDefault(); removeElement(S.selected); }
    };
    document.addEventListener('keydown', onKey);
    const onResize = () => drawCanvas();
    window.addEventListener('resize', onResize);
    cleanup = () => { document.removeEventListener('keydown', onKey); window.removeEventListener('resize', onResize); };

    const slide = () => playout.slides[S.slideIndex] || null;
    const elements = () => (S.mode === 'overlay' ? playout.overlays : (slide() ? slide().elements : null));
    const selectedEl = () => (elements() || []).find((e) => e.id === S.selected) || null;

    function renderAll() {
      document.getElementById('tab-slide').classList.toggle('active', S.mode === 'slide');
      document.getElementById('tab-overlay').classList.toggle('active', S.mode === 'overlay');
      toolbar.style.display = S.mode === 'settings' || (S.mode === 'slide' && !slide()) ? 'none' : '';
      renderSide();
      renderProps();
      drawCanvas();
    }

    // ----- left column: slides and layers -----
    function renderSide() {
      const parts = [];
      if (S.mode !== 'overlay') {
        parts.push(h('div', { class: 'row between' }, h('h3', { style: { margin: 0 } }, 'Scenes'),
          h('div', { class: 'row', style: { gap: '4px' } },
            h('button', { class: 'small', onclick: addSlide }, '+ Scene'),
            h('button', { class: 'small', onclick: slidesFromMedia, title: 'Create one scene per image or video' }, '+ From media'))));
        let dragFrom = null;
        parts.push(h('div', { class: 'slide-list', style: { marginTop: '8px' } }, playout.slides.map((sl, i) => {
          const desc = [sl.feedId ? 'RSS' : null, sl.advance === 'video' ? 'until video ends' : `${sl.duration || 10}s`, sl.window ? 'scheduled' : null].filter(Boolean).join(' · ');
          const item = h('div', {
            class: `slide-item ${S.mode === 'slide' && i === S.slideIndex ? 'active' : ''} ${sl.enabled === false ? 'disabled' : ''}`,
            draggable: 'true',
            onclick: () => { S.mode = 'slide'; S.slideIndex = i; S.selected = null; renderAll(); },
            ondragstart: () => { dragFrom = i; item.classList.add('dragging'); },
            ondragend: () => item.classList.remove('dragging'),
            ondragover: (e) => e.preventDefault(),
            ondrop: (e) => {
              e.preventDefault();
              if (dragFrom == null || dragFrom === i) return;
              const [moved] = playout.slides.splice(dragFrom, 1);
              playout.slides.splice(i, 0, moved);
              S.slideIndex = i;
              markDirty(); renderAll();
            },
          },
          h('div', { class: 'num' }, String(i + 1)),
          h('div', { class: 'info' }, h('div', { class: 'n' }, sl.name || `Scene ${i + 1}`), h('div', { class: 'd' }, desc)),
          h('input', { type: 'checkbox', title: 'Enabled', checked: sl.enabled !== false, onclick: (e) => e.stopPropagation(), onchange: (e) => { sl.enabled = e.target.checked; markDirty(); renderSide(); } }));
          return item;
        })));
        if (!playout.slides.length) parts.push(h('p', { class: 'muted' }, 'No scenes yet. Add a scene to start building.'));
      } else {
        parts.push(h('p', { class: 'muted' }, 'Overlays stay on screen above every scene: a ticker, a clock, a logo. A scene can hide them.'));
      }
      const els = elements();
      if (els && S.mode !== 'settings') {
        parts.push(h('h3', null, 'Layers'));
        parts.push(h('div', { class: 'layer-list' }, [...els].sort((a, b) => (b.z || 0) - (a.z || 0)).map((e) => h('div', {
          class: `layer-item ${S.selected === e.id ? 'active' : ''}`,
          onclick: () => { S.selected = e.id; renderAll(); },
        }, h('span', null, layerName(e)), h('small', null, `z ${e.z || 0}`)))));
        if (!els.length) parts.push(h('p', { class: 'muted' }, 'Use the toolbar to add text, media, a ticker and more.'));
      }
      put(sideEl, ...parts);
    }

    function layerName(e) {
      const label = ELEMENT_TYPES[e.type] ? ELEMENT_TYPES[e.type].label : e.type;
      const m = e.mediaId && mediaById[e.mediaId];
      const detail = e.type === 'text' ? String(e.text || '').split('\n')[0] : m ? m.name : e.type === 'image' && e.source === 'feed' ? 'feed image' : '';
      return detail ? `${label}: ${detail.slice(0, 24)}` : label;
    }

    function addSlide() {
      playout.slides.push({ id: uid(), name: `Scene ${playout.slides.length + 1}`, duration: 10, advance: 'duration', background: '#0b1f3a', elements: [] });
      S.mode = 'slide'; S.slideIndex = playout.slides.length - 1; S.selected = null;
      markDirty(); renderAll();
    }

    function slidesFromMedia() {
      const chosen = new Set();
      const grid = h('div', { class: 'pick-grid' }, media.filter((m) => m.type !== 'audio').map((m) => {
        const card = h('div', { class: 'media-item', onclick: () => { chosen.has(m.id) ? chosen.delete(m.id) : chosen.add(m.id); card.classList.toggle('sel'); } },
          thumb(m),
          h('div', { class: 'meta' }, h('div', { class: 'name' }, m.name)));
        return card;
      }));
      modal('Create scenes from media', h('div', { class: 'stack' },
        h('p', { class: 'muted' }, 'Each file becomes a full-screen scene. Video scenes move on as soon as the video ends.'),
        media.length ? grid : h('p', null, 'Upload media first.')),
      (close) => [h('button', { onclick: close }, 'Cancel'), h('button', { class: 'primary', onclick: () => {
        for (const m of media.filter((x) => chosen.has(x.id))) {
          const isVideo = m.type === 'video';
          playout.slides.push({
            id: uid(), name: m.name, duration: isVideo ? Math.ceil(m.duration || 10) : 10, advance: isVideo ? 'video' : 'duration', background: '#000000',
            elements: [{ id: uid(), type: m.type, mediaId: m.id, x: 0, y: 0, w: playout.width, h: playout.height, z: 0, fit: isVideo ? 'contain' : 'cover', audio: isVideo }],
          });
        }
        if (chosen.size) { S.mode = 'slide'; S.slideIndex = playout.slides.length - 1; S.selected = null; markDirty(); renderAll(); }
        close();
      } }, 'Add scenes')]);
    }

    function addElement(type) {
      const els = elements();
      if (!els) return;
      const def = ELEMENT_TYPES[type];
      const w = Math.min(def.w, playout.width);
      const hh = Math.min(def.h, playout.height);
      const e = { id: uid(), type, x: type === 'ticker' ? 0 : Math.round((playout.width - w) / 2), y: type === 'ticker' ? playout.height - hh : Math.round((playout.height - hh) / 2), w: type === 'ticker' ? playout.width : w, h: hh, z: els.reduce((m, x) => Math.max(m, x.z || 0), 0) + 1, ...clone(def.defaults) };
      els.push(e);
      S.selected = e.id;
      markDirty(); renderAll();
    }

    function removeElement(elId) {
      const els = elements();
      const i = els.findIndex((e) => e.id === elId);
      if (i >= 0) els.splice(i, 1);
      S.selected = null;
      markDirty(); renderAll();
    }

    // ----- canvas -----
    let scale = 1;
    let feedPreview = {};
    async function previewItem(feedId) {
      if (!feedId) return null;
      if (!feedPreview[feedId]) {
        feedPreview[feedId] = window.Beeldkrant.feedItems(feedId).then((d) => ({ ...(d.items || [])[0], feedTitle: d.title })).catch(() => null);
      }
      return feedPreview[feedId];
    }

    const resolveEl = (e) => {
      const m = e.mediaId && mediaById[e.mediaId];
      return m ? { ...e, src: m.url, mediaType: m.type } : { ...e };
    };

    let drawToken = 0;
    let stageHides = []; // stop clocks and tickers of the previous canvas render
    async function drawCanvas() {
      const token = ++drawToken;
      const W = playout.width;
      const H = playout.height;
      const rect = area.getBoundingClientRect();
      scale = Math.min((rect.width - 40) / W, (rect.height - 40) / H);
      Object.assign(stage.style, { width: `${W}px`, height: `${H}px`, transform: `translate(${(rect.width - W * scale) / 2}px, ${(rect.height - H * scale) / 2}px) scale(${scale})` });
      if (S.mode === 'settings') {
        put(stage, h('div', { class: 'slide', style: { background: playout.backgroundColor || '#000', display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: `${H / 20}px`, color: '#667' } }, `${W} x ${H}`));
        return;
      }
      stageHides.forEach((x) => x.hide());
      stageHides = [];
      const stageShows = [];
      const ctxBase = { editor: true, timezone: region.timezone, locale: region.locale, playoutBackground: playout.backgroundColor };
      const sl = slide();
      const children = [];
      if (S.mode === 'slide' && sl) {
        const item = await previewItem(sl.feedId);
        if (token !== drawToken) return;
        const bg = sl.backgroundMediaId && mediaById[sl.backgroundMediaId];
        const r = window.Beeldkrant.renderSlide({ ...sl, backgroundMedia: bg ? { url: bg.url, type: bg.type } : null, elements: (sl.elements || []).map(resolveEl) }, { ...ctxBase, item });
        children.push(r.node);
        if (!sl.hideOverlays && playout.overlays.length) {
          const ov = window.Beeldkrant.renderSlide({ elements: playout.overlays.map(resolveEl) }, ctxBase);
          ov.node.style.background = 'transparent';
          ov.node.classList.add('overlay-ghost');
          children.push(ov.node);
          stageShows.push(ov);
        }
        put(stage, ...children);
        r.show();
        stageShows.forEach((x) => x.show());
        stageHides = [r, ...stageShows];
      } else if (S.mode === 'overlay') {
        const r = window.Beeldkrant.renderSlide({ elements: playout.overlays.map(resolveEl), background: '#1b2130' }, ctxBase);
        put(stage, r.node);
        r.show();
        stageHides = [r];
      } else {
        put(stage, h('div', { class: 'slide', style: { display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: `${H / 24}px`, color: '#667' } }, 'Add a scene to start'));
        return;
      }
      // Make elements selectable/draggable.
      const live = stage.firstChild;
      live.querySelectorAll('.el').forEach((node) => {
        node.addEventListener('mousedown', (ev) => startDrag(ev, node.dataset.id, 'move'));
      });
      live.addEventListener('mousedown', (ev) => { if (ev.target === live || ev.target.classList.contains('slide-bg')) { S.selected = null; renderSide(); renderProps(); drawSelection(); } });
      drawSelection();
    }

    function drawSelection() {
      stage.querySelectorAll('.sel-box').forEach((b) => b.remove());
      const e = selectedEl();
      if (!e) return;
      const box = h('div', { class: 'sel-box', style: { left: `${e.x}px`, top: `${e.y}px`, width: `${e.w}px`, height: `${e.h}px`, borderWidth: `${2 / scale}px` } });
      for (const dir of ['nw', 'n', 'ne', 'e', 'se', 's', 'sw', 'w']) {
        const hd = h('div', { class: `h ${dir}`, style: { transform: `scale(${1 / scale})` } });
        hd.addEventListener('mousedown', (ev) => startDrag(ev, e.id, dir));
        box.appendChild(hd);
      }
      stage.appendChild(box);
    }

    function startDrag(ev, elId, mode) {
      ev.preventDefault();
      ev.stopPropagation();
      const e = (elements() || []).find((x) => x.id === elId);
      if (!e) return;
      if (S.selected !== elId) { S.selected = elId; renderSide(); renderProps(); drawSelection(); }
      if (e.locked) return;
      const start = { mx: ev.clientX, my: ev.clientY, x: e.x, y: e.y, w: e.w, h: e.h };
      const node = stage.querySelector(`.slide .el[data-id="${elId}"]`);
      const snap = (v) => (ev.shiftKey ? v : Math.round(v / 5) * 5);
      let moved = false;
      const move = (m) => {
        const dx = (m.clientX - start.mx) / scale;
        const dy = (m.clientY - start.my) / scale;
        if (Math.abs(dx) + Math.abs(dy) > 1) moved = true;
        if (mode === 'move') { e.x = snap(start.x + dx); e.y = snap(start.y + dy); } else {
          if (mode.includes('e')) e.w = Math.max(10, snap(start.w + dx));
          if (mode.includes('s')) e.h = Math.max(10, snap(start.h + dy));
          if (mode.includes('w')) { const nx = snap(start.x + dx); e.w = Math.max(10, start.w + start.x - nx); e.x = start.x + start.w - e.w; }
          if (mode.includes('n')) { const ny = snap(start.y + dy); e.h = Math.max(10, start.h + start.y - ny); e.y = start.y + start.h - e.h; }
        }
        if (node) Object.assign(node.style, { left: `${e.x}px`, top: `${e.y}px`, width: `${e.w}px`, height: `${e.h}px` });
        drawSelection();
      };
      const up = () => {
        document.removeEventListener('mousemove', move);
        document.removeEventListener('mouseup', up);
        if (moved) { markDirty(); renderProps(); if (mode !== 'move') drawCanvas(); }
      };
      document.addEventListener('mousemove', move);
      document.addEventListener('mouseup', up);
    }

    // ----- right column: properties -----
    function mediaPicker(obj, key, type, onChange) {
      const m = obj[key] && mediaById[obj[key]];
      const label = m ? m.name : 'None';
      return h('div', { class: 'row', style: { gap: '6px' } },
        h('span', { class: 'grow', style: { overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' } }, label),
        h('button', { class: 'small', onclick: () => {
          const list = media.filter((x) => (type === 'any' ? x.type !== 'audio' : x.type === type));
          let pick = obj[key];
          const grid = h('div', { class: 'pick-grid' }, list.map((x) => {
            const card = h('div', { class: `media-item ${pick === x.id ? 'sel' : ''}`, onclick: () => { pick = x.id; grid.querySelectorAll('.media-item').forEach((c) => c.classList.remove('sel')); card.classList.add('sel'); } },
              thumb(x),
              h('div', { class: 'meta' }, h('div', { class: 'name' }, x.name)));
            return card;
          }));
          modal('Choose media', list.length ? grid : h('p', null, 'No matching media. Upload files under Media first.'), (close) => [
            h('button', { onclick: () => { obj[key] = null; close(); onChange(); } }, 'None'),
            h('button', { onclick: close }, 'Cancel'),
            h('button', { class: 'primary', onclick: () => { obj[key] = pick; close(); onChange(); } }, 'Choose'),
          ]);
        } }, 'Choose…'));
    }

    function renderProps() {
      const changed = () => { markDirty(); drawCanvas(); };
      const changedSide = () => { markDirty(); renderSide(); drawCanvas(); };
      const parts = [];
      const e = selectedEl();
      if (S.mode === 'settings') {
        parts.push(h('h2', null, 'Playout settings'),
          h('div', { class: 'fields' },
            field('Name', bind(playout, 'name', () => { markDirty(); document.querySelector('.topbar .title').textContent = playout.name; }), { wide: true }),
            field('Width', h('input', { value: playout.width, disabled: true })),
            field('Height', h('input', { value: playout.height, disabled: true })),
            field('Default transition', bind(playout, 'transition', changed, 'select', { options: TRANSITIONS.map((t) => [t, t]) })),
            field('Transition time (ms)', bind(playout, 'transitionMs', changed, 'number', { min: 0, max: 5000, step: 100 })),
            field('Background colour', bind(playout, 'backgroundColor', changed, 'color'), { wide: true })),
          h('p', { class: 'hint' }, 'The resolution is fixed once the playout exists.'),
          h('h3', null, 'Background music'),
          h('div', { class: 'fields' },
            field('Audio file or stream', mediaPicker(playout.music, 'mediaId', 'audio', () => { markDirty(); renderProps(); }), { wide: true, hint: 'Add a Shoutcast/Icecast stream under Media → Add audio stream.' }),
            field(`Volume: ${playout.music.volume ?? 60}%`, slider(playout.music, 'volume', 60), { wide: true }),
            field(`Under videos with sound: ${playout.music.duck ?? 15}%`, slider(playout.music, 'duck', 15), { wide: true, hint: 'The music fades down while a scene plays a video with audio.' })),
          h('h3', null, 'Ad blocks'),
          h('p', { class: 'hint' }, 'An ad block plays all scenes of another playout (for example one called "Ads"), after every X scenes or at set times.'),
          playout.adBlocks.map((ad, i) => adBlockFields(ad, i)),
          h('button', { class: 'small', disabled: allPlayouts.length < 2, onclick: () => {
            const src = allPlayouts.find((x) => x.id !== playout.id);
            playout.adBlocks.push({ id: uid(), name: `Ad block ${playout.adBlocks.length + 1}`, playoutId: src && src.id, mode: 'every', everyScenes: 5, times: [], days: [], enabled: true });
            markDirty(); renderProps();
          } }, '+ Add ad block'),
          allPlayouts.length < 2 ? h('p', { class: 'hint' }, 'Create a second playout with your ads first.') : null);
      } else if (e) {
        parts.push(...elementProps(e, changed));
      } else if (S.mode === 'slide' && slide()) {
        const sl = slide();
        sl.window = sl.window || null;
        parts.push(h('h2', null, 'Scene'),
          h('div', { class: 'fields' },
            field('Name', bind(sl, 'name', changedSide), { wide: true }),
            field('Move on', bind(sl, 'advance', () => { changedSide(); renderProps(); }, 'select', { options: [['duration', 'After the duration'], ['video', 'When the video ends']] })),
            field(sl.advance === 'video' ? 'Fallback duration (s)' : 'Duration (s)', bind(sl, 'duration', changedSide, 'number', { min: 1, step: 1 })),
            field('Transition in', bind(sl, 'transition', changed, 'select', { options: [['', `Playout default (${playout.transition || 'fade'})`], ...TRANSITIONS.map((t) => [t, t])] })),
            field('Transition time (ms)', bind(sl, 'transitionMs', changed, 'number', { min: 0, max: 5000, step: 100, placeholder: String(playout.transitionMs ?? 800) })),
            field('Background colour', bind(sl, 'background', changed, 'color'), { wide: true }),
            field('Background image or video', mediaPicker(sl, 'backgroundMediaId', 'any', () => { changed(); renderProps(); }), { wide: true }),
            h('label', { class: 'check wide' }, bind(sl, 'hideOverlays', changed, 'checkbox'), 'Hide overlays on this scene')),
          h('h3', null, 'RSS template'),
          h('p', { class: 'hint' }, 'Link a feed to turn this scene into a template: it is shown once per feed item. Use {{title}}, {{description}}, {{date}} and {{feed}} in text, and an image set to "Feed item image".'),
          h('div', { class: 'fields' },
            field('Feed', bind(sl, 'feedId', () => { feedPreview = {}; changedSide(); }, 'select', { options: [['', 'None (plain scene)'], ...feeds.map((f) => [f.id, f.name])] }), { wide: true }),
            field('Number of items', bind(sl, 'feedMaxItems', changed, 'number', { min: 1, max: 50, placeholder: '5' }))),
          h('h3', null, 'Time window'),
          h('label', { class: 'check' }, h('input', { type: 'checkbox', checked: !!sl.window, onchange: (ev) => { sl.window = ev.target.checked ? { days: [], start: '08:00', end: '18:00' } : null; changedSide(); renderProps(); } }), 'Only show this scene at certain times'),
          sl.window ? windowFields(sl.window, changedSide) : null,
          h('div', { class: 'row', style: { marginTop: '18px' } },
            h('button', { onclick: () => { const c = clone(sl); c.id = uid(); c.name += ' (copy)'; c.elements.forEach((x) => { x.id = uid(); }); playout.slides.splice(S.slideIndex + 1, 0, c); S.slideIndex++; markDirty(); renderAll(); } }, 'Duplicate'),
            h('button', { class: 'ghost', onclick: async () => { if (await confirmBox(`Delete scene "${sl.name}"?`)) { playout.slides.splice(S.slideIndex, 1); S.slideIndex = Math.min(S.slideIndex, playout.slides.length - 1); S.selected = null; markDirty(); renderAll(); } } }, 'Delete scene')));
      } else if (S.mode === 'overlay') {
        parts.push(h('h2', null, 'Overlays'), h('p', { class: 'muted' }, 'Select an element on the canvas to edit it.'));
      } else {
        parts.push(h('p', { class: 'muted' }, 'Add a scene to begin.'));
      }
      put(propsEl, ...parts);
    }

    function slider(obj, key, def) {
      const input = h('input', { type: 'range', min: 0, max: 100, value: obj[key] ?? def });
      input.addEventListener('input', () => { obj[key] = Number(input.value); input.parentElement.querySelector('span').textContent = input.parentElement.querySelector('span').textContent.replace(/\d+%/, `${input.value}%`); markDirty(); });
      return input;
    }

    function adBlockFields(ad, i) {
      const onChange = () => markDirty();
      const sources = allPlayouts.filter((x) => x.id !== playout.id).map((x) => [x.id, x.name]);
      return h('div', { class: 'card stack', style: { padding: '10px', marginBottom: '8px' } },
        h('div', { class: 'row between' }, h('label', { class: 'check' }, bind(ad, 'enabled', onChange, 'checkbox'), h('b', null, ad.name || 'Ad block')),
          h('button', { class: 'small ghost', onclick: () => { playout.adBlocks.splice(i, 1); markDirty(); renderProps(); } }, 'Remove')),
        h('div', { class: 'fields' },
          field('Name', bind(ad, 'name', onChange), { wide: true }),
          field('Scenes from playout', bind(ad, 'playoutId', onChange, 'select', { options: sources }), { wide: true }),
          field('When', bind(ad, 'mode', () => { markDirty(); renderProps(); }, 'select', { options: [['every', 'After every X scenes'], ['times', 'At set times']] }), { wide: true }),
          ad.mode === 'times'
            ? field('Times (comma separated)', h('input', { value: (ad.times || []).join(', '), placeholder: '10:00, 12:30, 17:00', onchange: (e) => { ad.times = e.target.value.split(/[ ,;]+/).filter((t) => /^\d{1,2}:\d{2}$/.test(t)); e.target.value = ad.times.join(', '); markDirty(); } }), { wide: true })
            : field('Every X scenes', bind(ad, 'everyScenes', onChange, 'number', { min: 1 }))),
        ad.mode === 'times' ? h('div', { class: 'days' }, DAY_LABELS.map(([d, l]) => h('label', null,
          h('input', { type: 'checkbox', checked: (ad.days || []).includes(d), onchange: (ev) => { ad.days = (ad.days || []).filter((x) => x !== d); if (ev.target.checked) ad.days.push(d); markDirty(); } }), l))) : null);
    }

    function windowFields(win, onChange) {
      return h('div', { class: 'stack', style: { marginTop: '8px' } },
        h('div', { class: 'days' }, DAY_LABELS.map(([d, l]) => h('label', null,
          h('input', { type: 'checkbox', checked: (win.days || []).includes(d), onchange: (ev) => { win.days = (win.days || []).filter((x) => x !== d); if (ev.target.checked) win.days.push(d); onChange(); } }), l))),
        h('div', { class: 'hint' }, 'No days ticked means every day.'),
        h('div', { class: 'fields' },
          field('From', bind(win, 'start', onChange, 'time')), field('Until', bind(win, 'end', onChange, 'time')),
          field('Start date', bind(win, 'startDate', onChange, 'date')), field('End date', bind(win, 'endDate', onChange, 'date'))));
    }

    function elementProps(e, changed) {
      const t = ELEMENT_TYPES[e.type] || { label: e.type };
      const rerender = () => { changed(); renderProps(); };
      const out = [h('div', { class: 'row between' }, h('h2', { style: { margin: 0 } }, t.label),
        h('button', { class: 'small ghost', onclick: () => { S.selected = null; renderAll(); } }, 'Done'))];
      out.push(h('h3', null, 'Position'), h('div', { class: 'fields' },
        field('X', bind(e, 'x', changed, 'number')), field('Y', bind(e, 'y', changed, 'number')),
        field('Width', bind(e, 'w', changed, 'number', { min: 1 })), field('Height', bind(e, 'h', changed, 'number', { min: 1 })),
        field('Layer (z)', bind(e, 'z', () => { changed(); renderSide(); }, 'number')), field('Opacity %', bind(e, 'opacity', changed, 'number', { min: 0, max: 100, placeholder: '100' })),
        field('Corner radius', bind(e, 'radius', changed, 'number', { min: 0 })), field('Rotation°', bind(e, 'rotate', changed, 'number')),
        h('div', { class: 'row wide' },
          h('button', { class: 'small', onclick: () => { Object.assign(e, { x: 0, y: 0, w: playout.width, h: playout.height }); rerender(); } }, 'Full screen'),
          h('button', { class: 'small', onclick: () => { e.x = Math.round((playout.width - e.w) / 2); e.y = Math.round((playout.height - e.h) / 2); rerender(); } }, 'Centre'),
          h('label', { class: 'check' }, bind(e, 'locked', () => {}, 'checkbox'), 'Lock'))));
      out.push(h('h3', null, 'Content'));
      const fontFields = (size = 48) => [
        field('Font size (px)', bind(e, 'fontSize', changed, 'number', { min: 6, placeholder: String(size) })),
        field('Weight', bind(e, 'fontWeight', changed, 'select', { options: [['300', 'Light'], ['400', 'Regular'], ['600', 'Semibold'], ['700', 'Bold'], ['800', 'Extra bold']] })),
        field('Text colour', bind(e, 'color', changed, 'color', { fallback: '#ffffff' }), { wide: true }),
        field('Font family', bind(e, 'fontFamily', changed, 'text', { placeholder: 'DejaVu Sans' }), { wide: true }),
      ];
      switch (e.type) {
        case 'text':
          out.push(h('div', { class: 'fields' },
            field('Text', bind(e, 'text', changed, 'textarea'), { wide: true, hint: 'In an RSS scene: {{title}}, {{description}}, {{date}}, {{feed}}' }),
            ...fontFields(48),
            field('Align', bind(e, 'align', changed, 'select', { options: [['left', 'Left'], ['center', 'Centre'], ['right', 'Right']] })),
            field('Vertical', bind(e, 'valign', changed, 'select', { options: [['top', 'Top'], ['middle', 'Middle'], ['bottom', 'Bottom']] })),
            field('Line height', bind(e, 'lineHeight', changed, 'number', { step: 0.05, placeholder: '1.25' })),
            field('Max lines', bind(e, 'maxLines', changed, 'number', { min: 0, placeholder: 'no limit' })),
            field('Padding', bind(e, 'padding', changed, 'number', { min: 0 })),
            field('Background', bind(e, 'background', changed, 'color'), { wide: true }),
            h('label', { class: 'check' }, bind(e, 'uppercase', changed, 'checkbox'), 'Uppercase'),
            h('label', { class: 'check' }, bind(e, 'shadow', changed, 'checkbox'), 'Text shadow')));
          break;
        case 'image':
          out.push(h('div', { class: 'fields' },
            field('Source', bind(e, 'source', rerender, 'select', { options: [['', 'Media library'], ['feed', 'Feed item image (RSS scene)']] }), { wide: true }),
            e.source === 'feed' ? null : field('Image', mediaPicker(e, 'mediaId', 'image', rerender), { wide: true }),
            field('Fit', bind(e, 'fit', changed, 'select', { options: [['cover', 'Fill (crop)'], ['contain', 'Fit (letterbox)'], ['fill', 'Stretch']] }))));
          break;
        case 'video':
          out.push(h('div', { class: 'fields' },
            field('Video', mediaPicker(e, 'mediaId', 'video', rerender), { wide: true }),
            field('Fit', bind(e, 'fit', changed, 'select', { options: [['cover', 'Fill (crop)'], ['contain', 'Fit (letterbox)'], ['fill', 'Stretch']] })),
            h('label', { class: 'check' }, bind(e, 'audio', changed, 'checkbox'), 'Play audio'),
            h('label', { class: 'check wide' }, bind(e, 'loop', changed, 'checkbox'), 'Loop (the scene then uses its duration)')),
          h('p', { class: 'hint' }, 'Set the scene to "When the video ends" to go to the next scene automatically.'));
          break;
        case 'ticker':
          out.push(h('div', { class: 'fields' },
            field('Source', bind(e, 'source', rerender, 'select', { options: [['text', 'Own text'], ['feed', 'RSS feed headlines']] }), { wide: true }),
            e.source === 'feed'
              ? [field('Feed', bind(e, 'feedId', changed, 'select', { options: feedOptions }), { wide: true }), field('Headlines', bind(e, 'maxItems', changed, 'number', { min: 1, placeholder: '15' }))]
              : field('Lines (one message per line)', bind(e, 'text', changed, 'textarea'), { wide: true }),
            field('Speed (px/s)', bind(e, 'speed', changed, 'number', { min: 10, placeholder: '150' })),
            field('Separator', bind(e, 'separator', changed, 'text', { placeholder: '•' })),
            ...fontFields(40),
            field('Background', bind(e, 'background', changed, 'color'), { wide: true }),
            field('Label', bind(e, 'label', changed, 'text', { placeholder: 'e.g. NEWS' }), { wide: true }),
            field('Label background', bind(e, 'labelBackground', changed, 'color')),
            field('Label colour', bind(e, 'labelColor', changed, 'color', { fallback: '#ffffff' }))));
          break;
        case 'clock':
          out.push(h('div', { class: 'fields' },
            field('Show', bind(e, 'mode', changed, 'select', { options: [['time', 'Time'], ['date', 'Date'], ['both', 'Time and date']] }), { wide: true }),
            ...fontFields(64),
            field('Align', bind(e, 'align', changed, 'select', { options: [['center', 'Centre'], ['left', 'Left'], ['right', 'Right']] })),
            field('Background', bind(e, 'background', changed, 'color')),
            h('label', { class: 'check' }, bind(e, 'showSeconds', changed, 'checkbox'), 'Seconds'),
            h('label', { class: 'check' }, bind(e, 'hour12', changed, 'checkbox'), '12-hour clock')));
          break;
        case 'weather':
          out.push(h('div', { class: 'fields' },
            field('Place name', bind(e, 'label', changed), { wide: true }),
            field('Latitude', bind(e, 'lat', changed, 'number', { step: 0.01 })), field('Longitude', bind(e, 'lon', changed, 'number', { step: 0.01 })),
            ...fontFields(48),
            field('Background', bind(e, 'background', changed, 'color')),
            h('label', { class: 'check' }, h('input', { type: 'checkbox', checked: e.forecast !== false, onchange: (ev) => { e.forecast = ev.target.checked; changed(); } }), '3-day forecast')),
          h('p', { class: 'hint' }, 'Weather data from Open-Meteo, refreshed every 15 minutes.'));
          break;
        case 'webpage':
          out.push(h('div', { class: 'fields' },
            field('URL', bind(e, 'url', changed, 'url'), { wide: true }),
            field('Zoom %', bind(e, 'zoom', changed, 'number', { min: 10, max: 400 }))),
          h('p', { class: 'hint' }, 'Some sites refuse to be shown inside another page.'));
          break;
        case 'box':
          out.push(h('div', { class: 'fields' }, field('Colour', bind(e, 'background', changed, 'color'), { wide: true, hint: 'rgba(0,0,0,0.5) gives a see-through panel' })));
          break;
        default:
      }
      out.push(h('div', { class: 'row', style: { marginTop: '18px' } },
        h('button', { onclick: () => { const els = elements(); const c = { ...clone(e), id: uid(), x: e.x + 20, y: e.y + 20 }; els.push(c); S.selected = c.id; markDirty(); renderAll(); } }, 'Duplicate'),
        h('button', { class: 'ghost', onclick: () => removeElement(e.id) }, 'Delete')));
      return out;
    }

    renderAll();
    requestAnimationFrame(drawCanvas);
  }

  // ---------- media ----------
  async function pageMedia(main) {
    const media = await GET('/api/media');
    const input = h('input', { type: 'file', multiple: true, accept: 'image/*,video/mp4,video/webm,video/quicktime,video/x-matroska,audio/*,.mp4,.mov,.mkv,.webm,.mp3,.m4a,.aac,.ogg,.wav,.flac', style: { display: 'none' } });
    const progress = h('div', { class: 'progress', style: { display: 'none', marginTop: '10px' } }, h('div'));
    const drop = h('div', { class: 'dropzone', onclick: () => input.click() }, 'Drop images, videos or audio here, or click to choose files', h('div', { class: 'hint' }, 'Images: jpg, png, gif, webp, svg · Video: mp4, webm, mov, mkv · Audio: mp3, m4a, aac, ogg, wav, flac'), progress);
    const addStream = () => {
      const data = { name: '', url: '' };
      modal('Add audio stream', h('div', { class: 'stack' },
        h('p', { class: 'muted' }, 'Register a Shoutcast or Icecast web stream as external media. Use it as background music in a playout.'),
        field('Name', bind(data, 'name', () => {}, 'text', { placeholder: 'e.g. Radio 1' })),
        field('Stream URL', bind(data, 'url', () => {}, 'url', { placeholder: 'https://stream.example.com:8000/live.mp3' }))),
      (close) => [h('button', { onclick: close }, 'Cancel'), h('button', { class: 'primary', onclick: async () => {
        try { await POST('/api/media/external', data); close(); route(); } catch (err) { fail(err); }
      } }, 'Add')]);
    };

    function upload(files) {
      if (!files.length) return;
      const fd = new FormData();
      for (const f of files) fd.append('files', f);
      const xhr = new XMLHttpRequest();
      xhr.open('POST', '/api/media');
      progress.style.display = '';
      xhr.upload.onprogress = (e) => { if (e.lengthComputable) progress.firstChild.style.width = `${(e.loaded / e.total) * 100}%`; };
      xhr.onload = () => {
        progress.style.display = 'none';
        if (xhr.status >= 200 && xhr.status < 300) { toast('Upload complete', 'ok'); route(); } else {
          let msg = 'Upload failed';
          try { msg = JSON.parse(xhr.responseText).error || msg; } catch { /* keep */ }
          toast(msg, 'err');
        }
      };
      xhr.onerror = () => { progress.style.display = 'none'; toast('Upload failed', 'err'); };
      xhr.send(fd);
    }
    input.onchange = () => upload(input.files);
    drop.addEventListener('dragover', (e) => { e.preventDefault(); drop.classList.add('over'); });
    drop.addEventListener('dragleave', () => drop.classList.remove('over'));
    drop.addEventListener('drop', (e) => { e.preventDefault(); drop.classList.remove('over'); upload(e.dataTransfer.files); });

    main.append(h('div', { class: 'row between' }, h('h1', null, 'Media'), h('button', { onclick: addStream }, '+ Add audio stream')), drop, input, h('div', { style: { height: '16px' } }),
      media.length ? h('div', { class: 'media-grid' }, media.slice().reverse().map((m) => h('div', { class: 'media-item' },
        h('a', { href: m.url, target: '_blank' }, thumb(m)),
        h('div', { class: 'meta' },
          h('div', { class: 'name', title: m.name }, m.name),
          h('small', null, m.external ? m.url : [m.width && `${m.width}x${m.height}`, m.duration && `${m.duration}s`, fmtBytes(m.size)].filter(Boolean).join(' · ')),
          h('div', { class: 'row', style: { marginTop: '6px', gap: '4px' } },
            h('button', { class: 'small', onclick: async () => { const n = prompt('New name', m.name); if (n) { await api('PATCH', `/api/media/${m.id}`, { name: n }); route(); } } }, 'Rename'),
            h('button', { class: 'small ghost', onclick: async () => { if (await confirmBox(`Delete "${m.name}"? Scenes that use it will show nothing in its place.`)) { await DEL(`/api/media/${m.id}`); route(); } } }, 'Delete'))),
      ))) : h('p', { class: 'muted' }, 'No media uploaded yet.'));
  }

  // ---------- feeds ----------
  async function pageFeeds(main) {
    const feeds = await GET('/api/feeds');
    const edit = (feed) => {
      const data = feed ? clone(feed) : { name: '', url: '', refreshMinutes: 10 };
      const previewBox = h('div', { class: 'stack' });
      modal(feed ? 'Edit feed' : 'Add RSS feed', h('div', { class: 'stack' },
        h('div', { class: 'fields' },
          field('Name', bind(data, 'name', () => {}), { wide: true }),
          field('Feed URL (RSS or Atom)', bind(data, 'url', () => {}, 'url', { placeholder: 'https://example.com/rss.xml' }), { wide: true }),
          field('Refresh every (minutes)', bind(data, 'refreshMinutes', () => {}, 'number', { min: 1 }))),
        previewBox),
      (close) => [
        feed ? h('button', { onclick: async () => {
          put(previewBox, h('p', { class: 'muted' }, 'Loading…'));
          try {
            await PUT(`/api/feeds/${feed.id}`, data);
            const res = await GET(`/api/feeds/${feed.id}/items?force=1`);
            put(previewBox, 
              res.error ? h('div', { class: 'badge err' }, res.error) : h('div', { class: 'badge ok' }, `${res.items.length} items`),
              ...res.items.slice(0, 6).map((i) => h('div', { class: 'card', style: { padding: '10px' } }, h('b', null, i.title), h('div', { class: 'muted' }, (i.description || '').slice(0, 160)), i.image ? h('small', null, 'with image') : null)));
          } catch (err) { put(previewBox, h('div', { class: 'badge err' }, err.message)); }
        } }, 'Test feed') : null,
        h('button', { onclick: close }, 'Cancel'),
        h('button', { class: 'primary', onclick: async () => {
          try {
            if (!/^https?:\/\//.test(data.url || '')) throw new Error('Enter a valid http(s) URL');
            if (feed) await PUT(`/api/feeds/${feed.id}`, data); else await POST('/api/feeds', data);
            close(); route();
          } catch (err) { fail(err); }
        } }, 'Save'),
      ]);
    };
    main.append(h('div', { class: 'row between' }, h('h1', null, 'RSS feeds'), h('button', { class: 'primary', onclick: () => edit(null) }, '+ Add feed')),
      h('p', { class: 'muted' }, 'Use a feed in a scene (shown once per item through the scene template) or as ticker headlines.'),
      feeds.length ? h('div', { class: 'card' }, h('table', null,
        h('tr', null, h('th', null, 'Name'), h('th', null, 'URL'), h('th', null, 'Refresh'), h('th', null, '')),
        feeds.map((f) => h('tr', null, h('td', null, f.name), h('td', { class: 'muted' }, f.url), h('td', null, `${f.refreshMinutes || 10} min`),
          h('td', { style: { textAlign: 'right' } },
            h('button', { onclick: () => edit(f) }, 'Edit'), ' ',
            h('button', { class: 'ghost', onclick: async () => { if (await confirmBox(`Delete feed "${f.name}"?`)) { await DEL(`/api/feeds/${f.id}`); route(); } } }, 'Delete')))))) : h('div', { class: 'card' }, 'No feeds yet.'));
  }

  // ---------- schedule (weekly calendar) ----------
  const PALETTE = ['#4f8cff', '#30a46c', '#f5a623', '#e5484d', '#8e4ec6', '#12a594', '#d6409f', '#978365'];
  const DAY_KEYS = ['mon', 'tue', 'wed', 'thu', 'fri', 'sat', 'sun'];
  const toMin = (t) => { const [a, b] = String(t || '0:0').split(':').map(Number); return (a || 0) * 60 + (b || 0); };
  const toHHMM = (m) => `${String(Math.floor(m / 60) % 24).padStart(2, '0')}:${String(m % 60).padStart(2, '0')}`;
  const isoDate = (d) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
  let scheduleWeek = null; // Monday of the week on screen

  async function pageSchedule(main) {
    const [rules, playouts, settings] = await Promise.all([GET('/api/schedule'), GET('/api/playouts'), GET('/api/settings')]);
    const options = playouts.map((p) => [p.id, p.name]);
    const colour = (id) => PALETTE[Math.max(0, playouts.findIndex((p) => p.id === id)) % PALETTE.length];
    const name = (id) => (playouts.find((p) => p.id === id) || {}).name || '(deleted)';
    const def = { defaultPlayoutId: settings.defaultPlayoutId };
    if (!scheduleWeek) {
      const d = new Date();
      d.setHours(0, 0, 0, 0);
      d.setDate(d.getDate() - ((d.getDay() + 6) % 7));
      scheduleWeek = d;
    }
    const days = DAY_KEYS.map((key, i) => { const d = new Date(scheduleWeek); d.setDate(d.getDate() + i); return { key, date: d, iso: isoDate(d) }; });

    const edit = (rule, preset) => {
      const data = rule ? clone(rule) : { playoutId: options[0] && options[0][0], days: [], start: '08:00', end: '09:00', priority: 0, enabled: true, ...preset };
      const repeat = { mode: data.startDate && data.startDate === data.endDate && !(data.days || []).length ? 'once' : 'weekly' };
      const body = h('div', { class: 'stack' });
      const draw = () => put(body,
        h('div', { class: 'fields' },
          field('Playout (block of scenes)', bind(data, 'playoutId', () => {}, 'select', { options }), { wide: true }),
          field('From', bind(data, 'start', () => {}, 'time')), field('Until', bind(data, 'end', () => {}, 'time')),
          field('Repeat', bind(repeat, 'mode', () => {
            if (repeat.mode === 'once') { data.days = []; data.endDate = data.startDate = data.startDate || days[0].iso; } else { data.endDate = null; data.startDate = null; }
            draw();
          }, 'select', { options: [['weekly', 'Every week'], ['once', 'Only on one date']] }), { wide: true })),
        repeat.mode === 'once'
          ? field('Date', h('input', { type: 'date', value: data.startDate || '', onchange: (e) => { data.startDate = data.endDate = e.target.value; } }))
          : [h('div', { class: 'days' }, DAY_LABELS.map(([d, l]) => h('label', null,
            h('input', { type: 'checkbox', checked: (data.days || []).includes(d), onchange: (ev) => { data.days = (data.days || []).filter((x) => x !== d); if (ev.target.checked) data.days.push(d); } }), l))),
          h('div', { class: 'hint' }, 'No days ticked means every day.'),
          h('div', { class: 'fields' },
            field('First date (optional)', bind(data, 'startDate', () => {}, 'date')), field('Last date (optional)', bind(data, 'endDate', () => {}, 'date')))],
        h('div', { class: 'fields' },
          field('Priority', bind(data, 'priority', () => {}, 'number'), { hint: 'When blocks overlap, the highest priority wins. Give one-off blocks a higher priority to override the weekly schedule.' }),
          h('label', { class: 'check' }, bind(data, 'enabled', () => {}, 'checkbox'), 'Enabled')),
        h('div', { class: 'hint' }, 'A block that ends before it starts runs past midnight.'));
      draw();
      modal(rule ? 'Edit block' : 'New block', body, (close) => [
        rule ? h('button', { class: 'ghost', onclick: async () => { close(); if (await confirmBox('Delete this block?')) { await DEL(`/api/schedule/${rule.id}`); route(); } } }, 'Delete') : null,
        rule ? h('button', { onclick: async () => { const c = clone(data); delete c.id; await POST('/api/schedule', c); close(); route(); } }, 'Duplicate') : null,
        h('button', { onclick: close }, 'Cancel'),
        h('button', { class: 'primary', onclick: async () => {
          try { if (rule) await PUT(`/api/schedule/${rule.id}`, data); else await POST('/api/schedule', data); close(); route(); } catch (err) { fail(err); }
        } }, 'Save')]);
    };

    // Which rules show on a given calendar day (same matching as the server).
    const appliesOn = (r, day) => {
      if (r.startDate && day.iso < r.startDate) return false;
      if (r.endDate && day.iso > r.endDate) return false;
      return !(r.days && r.days.length) || r.days.includes(day.key);
    };
    const HOUR = 36; // px per hour
    const grid = h('div', { class: 'cal' });
    grid.appendChild(h('div', { class: 'cal-corner' }));
    days.forEach((d) => grid.appendChild(h('div', { class: `cal-head ${isoDate(new Date()) === d.iso ? 'today' : ''}` },
      d.date.toLocaleDateString('en-GB', { weekday: 'short' }), h('small', null, d.date.toLocaleDateString('en-GB', { day: 'numeric', month: 'short' })))));
    const hours = h('div', { class: 'cal-hours' }, Array.from({ length: 24 }, (_, i) => h('div', { style: { height: `${HOUR}px` } }, `${String(i).padStart(2, '0')}:00`)));
    grid.appendChild(hours);
    days.forEach((d) => {
      const col = h('div', { class: 'cal-col', style: { height: `${HOUR * 24}px` } });
      // Drag on an empty part of the day to create a block for that time range.
      col.addEventListener('mousedown', (ev) => {
        if (ev.target !== col || !playouts.length) return;
        const top = col.getBoundingClientRect().top;
        const at = (y) => Math.max(0, Math.min(24 * 60, Math.round(((y - top) / HOUR) * 4) * 15));
        const from = at(ev.clientY);
        const ghost = h('div', { class: 'cal-block ghost', style: { top: `${(from / 60) * HOUR}px`, height: `${HOUR / 4}px` } });
        col.appendChild(ghost);
        let to = from + 60;
        const move = (m) => { to = Math.max(from + 15, at(m.clientY)); ghost.style.height = `${((to - from) / 60) * HOUR}px`; };
        const up = (m) => {
          document.removeEventListener('mousemove', move);
          document.removeEventListener('mouseup', up);
          ghost.remove();
          if (Math.abs(m.clientY - ev.clientY) < 4) to = Math.min(24 * 60, from + 60);
          edit(null, { start: toHHMM(from), end: to >= 24 * 60 ? '00:00' : toHHMM(to), days: [d.key] });
        };
        document.addEventListener('mousemove', move);
        document.addEventListener('mouseup', up);
      });
      for (const r of rules) {
        const s = toMin(r.start || '00:00');
        let e = r.end ? toMin(r.end) : 24 * 60;
        if (e === 0) e = 24 * 60;
        const pieces = [];
        if (s < e) { if (appliesOn(r, d)) pieces.push([s, e]); } else {
          // Overnight: evening part today, morning part on the next day.
          if (appliesOn(r, d)) pieces.push([s, 24 * 60]);
          const prev = { ...d, date: new Date(d.date.getTime() - 86400000) };
          prev.iso = isoDate(prev.date);
          prev.key = DAY_KEYS[(DAY_KEYS.indexOf(d.key) + 6) % 7];
          if (appliesOn(r, prev)) pieces.push([0, e]);
        }
        for (const [a, b] of pieces) {
          col.appendChild(h('div', {
            class: `cal-block ${r.enabled === false ? 'off' : ''}`,
            title: `${name(r.playoutId)} ${r.start}–${r.end}`,
            style: { top: `${(a / 60) * HOUR}px`, height: `${Math.max(14, ((b - a) / 60) * HOUR - 2)}px`, background: colour(r.playoutId) },
            onclick: () => edit(r),
          }, h('b', null, name(r.playoutId)), h('small', null, `${r.start || '00:00'}–${r.end || '24:00'}${r.startDate && r.startDate === r.endDate ? ' · once' : ''}${r.priority ? ` · p${r.priority}` : ''}`)));
        }
      }
      grid.appendChild(col);
    });
    // "Now" line
    const now = new Date();
    const todayIdx = days.findIndex((d) => d.iso === isoDate(now));
    if (todayIdx >= 0) grid.children[9 + todayIdx].appendChild(h('div', { class: 'cal-now', style: { top: `${((now.getHours() * 60 + now.getMinutes()) / 60) * HOUR}px` } }));

    const shift = (n) => { scheduleWeek = new Date(scheduleWeek.getTime() + n * 7 * 86400000); route(); };
    main.append(
      h('div', { class: 'row between' }, h('h1', null, 'Schedule'),
        h('div', { class: 'row' },
          h('button', { onclick: () => shift(-1) }, '←'),
          h('b', null, `${days[0].date.toLocaleDateString('en-GB', { day: 'numeric', month: 'short' })} – ${days[6].date.toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' })}`),
          h('button', { onclick: () => shift(1) }, '→'),
          h('button', { onclick: () => { scheduleWeek = null; route(); } }, 'This week'),
          h('button', { class: 'primary', disabled: !playouts.length, onclick: () => edit(null) }, '+ Add block'))),
      h('div', { class: 'card row', style: { marginBottom: '12px' } },
        h('b', null, 'On air now:'), settings.activePlayoutId ? h('span', { class: 'badge ok' }, h('span', { class: 'dot' }), name(settings.activePlayoutId)) : h('span', { class: 'muted' }, 'nothing'),
        h('div', { class: 'grow' }),
        h('span', { class: 'muted' }, 'Outside the blocks:'),
        h('div', { style: { width: '240px' } }, bind(def, 'defaultPlayoutId', async () => { await PUT('/api/settings', def).catch(fail); route(); }, 'select', { options: [['', 'First playout'], ...options] }))),
      h('p', { class: 'muted' }, 'Drag in a day to plan a block of scenes, click a block to change it. Weekly blocks repeat every week, which gives you a fixed linear programme.'),
      h('div', { class: 'card cal-wrap' }, grid));
    const wrap = main.querySelector('.cal-wrap');
    wrap.scrollTop = HOUR * 7;
  }

  // ---------- output ----------
  async function pageOutput(main) {
    const [out, status] = await Promise.all([GET('/api/output'), GET('/api/stream')]);
    const fixedFields = h('div', { class: 'fields' });
    const drawFixed = () => {
      fixedFields.style.display = out.resolutionMode === 'fixed' ? '' : 'none';
    };
    fixedFields.append(field('Width', bind(out, 'width', () => {}, 'number')), field('Height', bind(out, 'height', () => {}, 'number')));
    drawFixed();
    const hw = [status.tools.vaapi ? 'VAAPI (Intel/AMD)' : null, status.tools.nvenc ? 'NVENC (NVIDIA)' : null].filter(Boolean);
    main.append(h('h1', null, 'Stream output'),
      h('div', { class: 'card stack', style: { maxWidth: '760px' } },
        field('Destination', bind(out, 'url', () => {}, 'text', { placeholder: 'rtmp://server/live/streamkey  or  srt://server:9000?streamid=…' }),
          { hint: 'RTMP and RTMPS are sent as FLV, SRT as MPEG-TS. This server only sends; the stream server receives.' }),
        h('h3', null, 'Video'),
        h('div', { class: 'fields' },
          field('Resolution', bind(out, 'resolutionMode', drawFixed, 'select', { options: [['playout', 'Follow the playout on air'], ['fixed', 'Fixed output size (scaled)']] }), { wide: true }),
          h('div', { class: 'wide' }, fixedFields),
          field('Frame rate', bind(out, 'fps', () => {}, 'select', { options: [['25', '25 fps'], ['30', '30 fps'], ['50', '50 fps'], ['60', '60 fps']] })),
          field('Video bitrate (kbit/s)', bind(out, 'videoBitrate', () => {}, 'number', { min: 200 })),
          field('Encoder', bind(out, 'encoder', () => {}, 'select', { options: [['libx264', 'CPU (x264)'], ['h264_vaapi', 'GPU: Intel/AMD (VAAPI)'], ['h264_nvenc', 'GPU: NVIDIA (NVENC)']] }),
            { hint: hw.length ? `Detected: ${hw.join(', ')}` : 'No GPU detected in this container.' }),
          field('x264 preset', bind(out, 'preset', () => {}, 'select', { options: ['ultrafast', 'superfast', 'veryfast', 'faster', 'fast', 'medium'].map((p) => [p, p]) }), { hint: 'Faster presets use less CPU.' })),
        h('h3', null, 'Audio'),
        h('div', { class: 'fields' },
          h('label', { class: 'check' }, bind(out, 'audio', () => {}, 'checkbox'), 'Send audio from videos'),
          field('Audio bitrate (kbit/s)', bind(out, 'audioBitrate', () => {}, 'number', { min: 32 }))),
        h('div', { class: 'row' }, h('button', { class: 'primary', onclick: async () => {
          try { await PUT('/api/output', { ...out, fps: Number(out.fps) }); toast(status.wanted ? 'Saved. The stream restarts with the new settings.' : 'Saved', 'ok'); } catch (err) { fail(err); }
        } }, 'Save'), h('a', { href: '#dashboard' }, 'Start or stop the stream on the dashboard'))));
  }

  // ---------- settings ----------
  async function pageSettings(main) {
    const settings = await GET('/api/settings');
    const data = { timezone: settings.timezone, locale: settings.locale };
    const general = { panelName: settings.panelName || 'Beeldkrant' };
    main.append(h('h1', null, 'Settings'),
      h('div', { class: 'grid two' },
        h('div', { class: 'card stack' }, h('h2', null, 'General'),
          field('Panel name', bind(general, 'panelName', () => {}, 'text', { placeholder: 'Beeldkrant' }), { hint: 'Shown in the menu, on the login page and in the browser tab.' }),
          h('button', { class: 'primary', onclick: async () => {
            try { await PUT('/api/settings', general); me.panelName = general.panelName.trim(); toast('Saved', 'ok'); route(); } catch (err) { fail(err); }
          } }, 'Save')),
        h('div', { class: 'card stack' }, h('h2', null, 'Appearance'),
          h('p', { class: 'muted' }, 'Choose a light or dark theme for your account, or follow your device setting.'),
          themeSwitch()),
        h('div', { class: 'card stack' }, h('h2', null, 'Region'),
          field('Time zone', bind(data, 'timezone', () => {}, 'text', { placeholder: 'Europe/Amsterdam' }), { hint: 'Used by the schedule, clocks and dates.' }),
          field('Language for dates', bind(data, 'locale', () => {}, 'select', { options: [['en-GB', 'English (UK)'], ['en-US', 'English (US)'], ['nl-NL', 'Dutch'], ['de-DE', 'German'], ['fr-FR', 'French']] })),
          h('button', { class: 'primary', onclick: async () => { try { await PUT('/api/settings', data); toast('Saved', 'ok'); } catch (err) { fail(err); } } }, 'Save')),
        h('div', { class: 'card stack' }, h('h2', null, 'Change password'), renderChangePassword(false))));
  }

  route();
})();
