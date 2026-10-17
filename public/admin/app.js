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

  // ---------- software update ----------
  async function updateBanner(main) {
    try {
      const u = await GET('/api/system/update');
      if (!u.available) return;
      main.prepend(h('div', { class: 'update-banner' },
        h('span', null, h('b', null, 'A new version of Beeldkrant is available.'), ` You run ${u.commit.slice(0, 7)}, the latest is ${u.latest.slice(0, 7)}.`),
        u.canUpdate ? h('button', { class: 'primary small', onclick: () => runUpdate(u) }, 'Update now') : h('span', { class: 'muted' }, 'Run update in the container shell.')));
    } catch { /* not important enough to show an error */ }
  }

  // The bottom-left Info button; a dot marks an available update.
  function infoButton(active) {
    const btn = h('a', { href: '#info', class: `info-btn ${active ? 'active' : ''}` }, h('span', { class: 'info-i' }, 'i'), 'Info', h('small', null, me.version ? `v${me.version}` : ''));
    GET('/api/system/update').then((u) => { if (u.available) btn.appendChild(h('span', { class: 'update-dot', title: 'A new version is available' })); }).catch(() => {});
    return btn;
  }

  // Asks whether to make a local backup first, then starts the update.
  function runUpdate(before) {
    const opts = { backup: true, media: false };
    const mediaBox = h('label', { class: 'check' }, bind(opts, 'media', () => {}, 'checkbox'), h('span', null, 'Also back up the media', h('div', { class: 'hint' }, 'All media folders and files. Takes longer and needs more disk space.')));
    modal('Update Beeldkrant', h('div', { class: 'stack' },
      h('p', null, 'Beeldkrant restarts during the update. The stream pauses briefly.'),
      h('label', { class: 'check' }, bind(opts, 'backup', () => { mediaBox.style.opacity = opts.backup ? '' : '.5'; mediaBox.querySelector('input').disabled = !opts.backup; }, 'checkbox'),
        h('span', null, h('b', null, 'Make a local backup first'), h('div', { class: 'hint' }, 'Backs up the application and the database on this server, so you can go back from Settings → Backups.'))),
      mediaBox),
    (close) => [h('button', { onclick: close }, 'Cancel'), h('button', { class: 'primary', onclick: () => { close(); followUpdate(before, opts); } }, 'Update now')]);
  }

  // Starts the update and follows it until the restarted server runs the new version.
  async function followUpdate(before, opts) {
    const logBox = h('div', { class: 'logs', style: { height: '220px' } }, 'Starting…');
    const statusLine = h('p', null, opts.backup ? 'Making a backup before the update…' : 'Beeldkrant is updating. The stream pauses briefly while the service restarts.');
    let closeModal = () => {};
    let stopped = false;
    closeModal = modal('Updating Beeldkrant', h('div', { class: 'stack' }, statusLine, logBox), (close) => [h('button', { onclick: () => { stopped = true; close(); } }, 'Close')]);
    try { await POST('/api/system/update', { backup: opts.backup, media: opts.backup && opts.media }); } catch (err) { fail(err); closeModal(); return; }
    const started = Date.now();
    while (!stopped && Date.now() - started < 30 * 60 * 1000) {
      await new Promise((r) => setTimeout(r, 2000));
      let u;
      try { u = await GET('/api/system/update'); } catch { statusLine.textContent = 'Restarting Beeldkrant…'; continue; }
      if (u.prepare) {
        if (u.prepare.state === 'failed') { statusLine.textContent = u.prepare.message; return; }
        try { const b = await GET('/api/backups/status'); logBox.textContent = b.log.join('\n'); logBox.scrollTop = logBox.scrollHeight; } catch { /* keep the last log */ }
        continue;
      }
      statusLine.textContent = 'Beeldkrant is updating. The stream pauses briefly while the service restarts.';
      if (u.log) { logBox.textContent = u.log; logBox.scrollTop = logBox.scrollHeight; }
      if (u.commit && u.commit !== before.commit) {
        toast('Beeldkrant is updated', 'ok');
        setTimeout(() => location.reload(), 1200);
        return;
      }
      if (!u.requested && /already up to date|✖/.test(u.log || '') && Date.now() - started > 4000) {
        statusLine.textContent = /✖/.test(u.log) ? 'The update failed. See the log below.' : 'Beeldkrant is already up to date.';
        return;
      }
    }
  }

  async function updateCard() {
    const box = h('div', { class: 'card stack' });
    const draw = (u) => put(box,
      h('h2', null, 'Software update'),
      h('div', null, 'Version ', h('b', null, u.version || '?'), u.commit ? h('span', { class: 'muted' }, ` (${u.commit.slice(0, 7)}, branch ${u.branch})`) : null),
      u.error ? h('div', { class: 'badge err' }, u.error)
        : u.available ? h('div', { class: 'badge warn' }, `New version available: ${u.latest.slice(0, 7)}`)
          : u.checkedAt ? h('div', { class: 'badge ok' }, 'Up to date') : null,
      h('div', { class: 'hint' }, u.checkedAt ? `Last checked ${new Date(u.checkedAt).toLocaleString()}. Checked automatically once a day.` : 'Checked automatically once a day.'),
      h('div', { class: 'row' },
        h('button', { onclick: async () => { try { draw(await POST('/api/system/update/check')); } catch (err) { fail(err); } } }, 'Check now'),
        u.canUpdate ? h('button', { class: u.available ? 'primary' : '', onclick: () => runUpdate(u) }, u.available ? 'Update now' : 'Reinstall latest') : null),
      u.canUpdate ? null : h('div', { class: 'hint' }, 'Updating from the panel works on an installed container. You can always run update in the container shell.'),
      u.available && u.incoming ? h('details', { class: 'whats-new' }, h('summary', null, 'What the new version brings'), markdown(newEntries(u.incoming, u.version))) : null);
    try { draw(await GET('/api/system/update')); } catch (err) { put(box, h('h2', null, 'Software update'), h('div', { class: 'badge err' }, err.message)); }
    return box;
  }

  // ---------- routing ----------
  // Menu: groups separated by lines ('-'). Items are [hash, label, children?]; a dropdown group
  // folds its children away until it is opened.
  const MENU = [
    ['dashboard', 'Dashboard', [['stats', 'Statistics']]],
    '-',
    ['playouts', 'Playouts'],
    '-',
    ['library', 'Media management', [
      ['media', 'Media folders', [['media/video', 'Video'], ['media/audio', 'Audio'], ['media/ads', 'Ads']]],
      ['feeds', 'RSS feeds'],
      ['streams', 'Input streams'],
    ], { dropdown: true }],
    '-',
    ['schedule', 'Schedule'],
    '-',
    ['output', 'Outputs', [['routing', 'Routing']]],
    '-',
    ['settings', 'Settings', [['settings', 'Application'], ['backups', 'Backups', null, { admin: true }]]],
  ];
  let cleanup = null;

  const menuHashes = (item) => [item[0], ...(item[2] || []).flatMap(menuHashes)];

  function renderMenu(current) {
    const isAdmin = me.user.role === 'admin';
    const link = ([hash, label, children, opts = {}], depth) => {
      if (opts.admin && !isAdmin) return null;
      const inside = menuHashes([hash, label, children]).includes(current);
      let open = !opts.dropdown || inside;
      if (opts.dropdown) { try { open = open || localStorage.getItem(`bk-menu-${hash}`) === 'open'; } catch { /* private mode */ } }
      const kids = children ? h('div', { class: 'nav-kids', style: { display: open ? '' : 'none' } }, children.map((c) => link(c, depth + 1))) : null;
      const a = h('a', {
        href: `#${hash}`,
        // A group whose first child opens the same page is only highlighted through that child.
        class: [depth ? `sub d${depth}` : '', current === hash && !(children || []).some((c) => c[0] === hash) ? 'active' : '', inside && current !== hash ? 'open' : ''].join(' '),
        onclick: opts.dropdown ? () => { try { localStorage.setItem(`bk-menu-${hash}`, 'open'); } catch { /* private mode */ } } : null,
      }, label, opts.dropdown ? h('span', {
        class: `caret ${open ? 'up' : ''}`,
        onclick: (e) => {
          e.preventDefault(); e.stopPropagation();
          const show = kids.style.display === 'none';
          kids.style.display = show ? '' : 'none';
          e.target.classList.toggle('up', show);
          try { localStorage.setItem(`bk-menu-${hash}`, show ? 'open' : 'closed'); } catch { /* private mode */ }
        },
      }) : null);
      return [a, kids];
    };
    return MENU.map((item) => (item === '-' ? h('hr', { class: 'nav-sep' }) : link(item, 0)));
  }

  async function route() {
    if (cleanup) { cleanup(); cleanup = null; }
    if (!me) {
      try { me = await GET('/api/me'); } catch { me = { user: null }; }
    }
    if (me.user) applyTheme(me.user.theme);
    if (!me.user) return renderLogin();
    if (me.user.mustChangePassword) return renderChangePassword(true);
    const hash = location.hash.slice(1) || 'dashboard';
    const [page, arg] = hash.split('/');
    if (page === 'playout' && arg) return renderEditor(arg);
    const main = h('main', { class: 'main' });
    put(app, h('div', { class: 'shell' },
      h('nav', { class: 'nav' },
        brand(),
        renderMenu(hash),
        h('div', { class: 'spacer' }),
        me.user.role === 'admin' ? infoButton(page === 'info') : null,
        themeSwitch(),
        h('a', { href: '#account', class: `who ${page === 'account' ? 'active' : ''}`, title: 'Your account' }, `${me.user.username} (${me.user.role})`),
        h('a', { href: '#', onclick: async (e) => { e.preventDefault(); await POST('/api/logout'); me = null; route(); } }, 'Log out'),
      ),
      main));
    if (me.user.role === 'admin' && page !== 'info') updateBanner(main);
    const pages = {
      dashboard: pageDashboard, stats: pageStats, playouts: pagePlayouts, library: pageLibrary, media: pageMedia, feeds: pageFeeds, streams: pageStreams,
      schedule: pageSchedule, output: pageOutput, routing: pageRouting, settings: pageSettings, backups: pageBackups, info: pageInfo, account: pageAccount,
    };
    try { await (pages[page] || pageDashboard)(main, arg); } catch (err) { fail(err); }
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
        const cls = { live: 'ok', starting: 'warn', restarting: 'warn', stopped: '', idle: '', error: 'err' }[s.state] || '';
        const missing = ['xvfb', 'chromium', 'ffmpeg'].filter((t) => !s.tools[t]);
        put(statusBox, 
          h('div', { class: 'row' }, h('span', { class: `badge ${cls}` }, h('span', { class: 'dot' }), s.state.toUpperCase()),
            s.lastError && s.state !== 'live' ? h('span', { class: 'muted' }, s.lastError) : null),
          h('div', { class: 'row', style: { gap: '28px' } },
            h('div', { class: 'stat' }, h('small', null, 'Playout'), h('b', null, onAir ? onAir.name : 'none')),
            (s.pipelines || []).some((p) => p.source !== 'schedule') ? h('div', { class: 'stat' }, h('small', null, 'Routed playouts'), h('a', { href: '#routing' }, h('b', null, s.pipelines.filter((p) => p.source !== 'schedule').map((p) => p.label).join(', ')))) : null,
            h('div', { class: 'stat' }, h('small', null, 'Output'), h('b', null, s.resolution || '-')),
            h('div', { class: 'stat' }, h('small', null, 'FPS'), h('b', null, s.stats.fps || '-')),
            h('div', { class: 'stat' }, h('small', null, 'Bitrate'), h('b', null, s.stats.bitrate || '-')),
            h('div', { class: 'stat' }, h('small', null, 'Speed'), h('b', null, s.stats.speed || '-'))),
          h('div', null, h('small', null, 'Outputs: '), s.outputs.filter((o) => o.enabled).length
            ? s.outputs.filter((o) => o.enabled).map((o) => h('span', { class: `badge ${(STATE_BADGE[o.state] || [''])[0]}`, style: { marginRight: '6px' } }, o.name))
            : h('a', { href: '#output' }, 'none turned on')),
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
    const [playouts, settings, outs] = await Promise.all([GET('/api/playouts'), GET('/api/settings'), GET('/api/outputs')]);
    const routed = (p) => outs.filter((o) => o.source === p.id);
    main.append(
      h('div', { class: 'row between' }, h('h1', null, 'Playouts'), h('button', { class: 'primary', onclick: newPlayoutWizard }, '+ New playout')),
      playouts.length ? h('div', { class: 'card' }, h('table', null,
        h('tr', null, h('th', null, 'Name'), h('th', null, 'Resolution'), h('th', null, 'Scenes'), h('th', null, 'Status'), h('th', null, '')),
        playouts.map((p) => h('tr', null,
          h('td', null, h('a', { href: `#playout/${p.id}` }, p.name)),
          h('td', null, `${p.width} x ${p.height}`),
          h('td', null, String((p.slides || []).length)),
          h('td', null, p.id === settings.activePlayoutId ? h('span', { class: 'badge ok' }, h('span', { class: 'dot' }), 'On air') : '', ' ',
            routed(p).length ? h('a', { class: 'badge', href: '#routing', title: routed(p).map((o) => o.name).join(', ') }, `Routed to ${routed(p).length} output${routed(p).length === 1 ? '' : 's'}`) : ''),
          h('td', { style: { textAlign: 'right' } },
            h('a', { class: 'btn', href: `/player/?playout=${p.id}`, target: '_blank' }, 'Preview'), ' ',
            h('button', { onclick: () => cloneDialog(p, () => route()) }, 'Clone'), ' ',
            h('button', { class: 'ghost', onclick: async () => { if (await confirmBox(`Delete playout "${p.name}"?`)) { await DEL(`/api/playouts/${p.id}`); route(); } } }, 'Delete')),
        )))) : h('div', { class: 'card' }, h('p', null, 'No playouts yet. A playout is a channel: a resolution and a series of scenes.')),
    );
  }

  // A full copy of a playout, e.g. a clean feed without overlays or ads for another output.
  function cloneDialog(p, onCloned) {
    const data = { name: `${p.name} (copy)` };
    modal(`Clone ${p.name}`, h('div', { class: 'stack' },
      field('Name of the copy', bind(data, 'name', () => {})),
      h('p', { class: 'muted', style: { margin: 0 } }, 'Copies every scene, overlay, ad block and the music. The copy is not on the schedule; route an output to it under Outputs → Routing to send it.')),
    (close) => [h('button', { onclick: close }, 'Cancel'), h('button', { class: 'primary', onclick: async () => {
      try { const c = await POST(`/api/playouts/${p.id}/clone`, data); close(); toast(`Cloned as ${c.name}`, 'ok'); onCloned(c); } catch (err) { fail(err); }
    } }, 'Clone')]);
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
    let folders;
    try {
      [playout, media, feeds, allPlayouts, region, folders] = await Promise.all([GET(`/api/playouts/${id}`), GET('/api/media'), GET('/api/feeds'), GET('/api/playouts'), GET('/api/settings'), GET('/api/folders')]);
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
        h('button', { title: 'Make a full copy of this playout', onclick: async () => {
          if (editorDirty) await save();
          if (!editorDirty) cloneDialog(playout, (c) => { location.hash = `playout/${c.id}`; });
        } }, 'Clone'),
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
      const visual = (m) => m.type !== 'audio';
      modal('Create scenes from media', h('div', { class: 'stack' },
        h('p', { class: 'muted' }, 'Each file becomes a full-screen scene, in the order you click them. Video scenes move on as soon as the video ends.'),
        media.some(visual) ? folderBrowser(media, folders, { filter: visual, multi: chosen }) : h('p', null, 'Upload media first.')),
      (close) => [h('button', { onclick: close }, 'Cancel'), h('button', { class: 'primary', onclick: () => {
        for (const m of [...chosen].map((x) => mediaById[x]).filter(Boolean)) {
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
          const filter = (x) => (type === 'any' ? x.type !== 'audio' : x.type === type);
          let pick = obj[key];
          const body = media.some(filter) ? folderBrowser(media, folders, { filter, selected: pick, onPick: (id) => { pick = id; } }) : h('p', null, 'No matching media. Upload files under Media first.');
          modal('Choose media', body, (close) => [
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

  // ---------- media folders ----------
  // The folder last opened, shared by the media page and the media pickers in the editor.
  let lastFolderId = null;
  const byName = (a, b) => a.name.localeCompare(b.name, undefined, { numeric: true });

  // Folders from the top level down to folderId.
  function folderTrail(folders, folderId) {
    const byId = Object.fromEntries(folders.map((f) => [f.id, f]));
    const trail = [];
    for (let f = byId[folderId]; f && trail.length < 50; f = byId[f.parentId]) trail.unshift(f);
    return trail;
  }

  // [[id, 'Parent / Child'], ...] for a folder select, starting with the top level.
  function folderOptions(folders) {
    const opts = folders.map((f) => [f.id, folderTrail(folders, f.id).map((x) => x.name).join(' / ')]);
    return [['', 'Media (top level)'], ...opts.sort((a, b) => a[1].localeCompare(b[1], undefined, { numeric: true }))];
  }

  function crumbs(folders, folderId, go) {
    const parts = [{ id: null, name: 'Media' }, ...folderTrail(folders, folderId)];
    return h('div', { class: 'crumbs' }, parts.map((f, i) => [
      i ? h('span', { class: 'sep' }, '/') : null,
      h('button', { class: `crumb ${i === parts.length - 1 ? 'cur' : ''}`, 'data-folder': f.id || '', onclick: () => go(f.id) }, f.name),
    ]));
  }

  const folderCount = (media, folders, id) => media.filter((m) => (m.folderId || null) === id).length + folders.filter((f) => (f.parentId || null) === id).length;

  // Browses media by folder with a search across all folders. multi: Set of chosen ids, otherwise a single pick.
  function folderBrowser(media, folders, { filter = () => true, multi = null, selected = null, onPick = () => {} } = {}) {
    let cur = folders.some((f) => f.id === lastFolderId) ? lastFolderId : null;
    let pick = selected;
    if (pick && !multi) cur = (media.find((m) => m.id === pick) || {}).folderId || cur;
    let q = '';
    const crumbsEl = h('div');
    const grid = h('div', { class: 'pick-grid' });
    const search = h('input', { type: 'search', placeholder: 'Search all folders', oninput: (e) => { q = e.target.value.trim().toLowerCase(); draw(); } });
    const open = (id) => { cur = id; lastFolderId = id; draw(); };
    function draw() {
      put(crumbsEl, q ? h('div', { class: 'crumbs muted' }, 'Search results') : crumbs(folders, cur, open));
      const subs = q ? [] : folders.filter((f) => (f.parentId || null) === cur).sort(byName);
      const items = media.filter(filter).filter((m) => (q ? m.name.toLowerCase().includes(q) : (m.folderId || null) === cur));
      put(grid,
        subs.map((f) => h('div', { class: 'folder-tile', onclick: () => open(f.id) },
          h('div', { class: 'folder-icon' }), h('div', { class: 'name' }, f.name), h('small', null, `${folderCount(media, folders, f.id)} items`))),
        items.map((m) => {
          const on = multi ? multi.has(m.id) : pick === m.id;
          const card = h('div', { class: `media-item ${on ? 'sel' : ''}`, onclick: () => {
            if (multi) { multi.has(m.id) ? multi.delete(m.id) : multi.add(m.id); card.classList.toggle('sel'); } else {
              pick = m.id; grid.querySelectorAll('.media-item').forEach((c) => c.classList.remove('sel')); card.classList.add('sel');
            }
            onPick(pick);
          } }, thumb(m), h('div', { class: 'meta' }, h('div', { class: 'name', title: m.name }, m.name)));
          return card;
        }),
        !subs.length && !items.length ? h('p', { class: 'muted' }, q ? 'Nothing found.' : 'No matching media in this folder.') : null);
    }
    draw();
    return h('div', { class: 'stack' }, h('div', { class: 'row between', style: { gap: '8px', flexWrap: 'nowrap' } }, crumbsEl, h('div', { style: { width: '220px', flex: '0 0 220px' } }, search)), grid);
  }

  // ---------- media ----------
  // Media folders, or one of the views across all folders: video, audio or ads (arg).
  const MEDIA_VIEWS = { video: ['Video', (m) => m.type === 'video'], audio: ['Audio', (m) => m.type === 'audio'], ads: ['Ads', (m) => !!m.isAd] };
  async function pageMedia(main, arg) {
    const view = MEDIA_VIEWS[arg] || null;
    const files = (list) => list.filter((m) => !m.external); // input streams have their own page
    let [media, folders] = await Promise.all([GET('/api/media').then(files), GET('/api/folders')]);
    let cur = folders.some((f) => f.id === lastFolderId) ? lastFolderId : null;
    let q = '';
    const input = h('input', { type: 'file', multiple: true, accept: 'image/*,video/mp4,video/webm,video/quicktime,video/x-matroska,audio/*,.mp4,.mov,.mkv,.webm,.mp3,.m4a,.aac,.ogg,.wav,.flac', style: { display: 'none' } });
    const progress = h('div', { class: 'progress', style: { display: 'none', marginTop: '10px' } }, h('div'));
    const dropLabel = h('span');
    const drop = h('div', { class: 'dropzone', onclick: () => input.click() }, dropLabel, h('div', { class: 'hint' }, 'Images: jpg, png, gif, webp, svg · Video: mp4, webm, mov, mkv · Audio: mp3, m4a, aac, ogg, wav, flac'), progress);
    const crumbsEl = h('div');
    const listEl = h('div');
    const search = h('input', { type: 'search', placeholder: 'Search all folders', oninput: (e) => { q = e.target.value.trim().toLowerCase(); draw(); } });
    const curName = () => (cur ? folderTrail(folders, cur).map((f) => f.name).join(' / ') : 'the top level');

    async function reload() {
      [media, folders] = await Promise.all([GET('/api/media').then(files), GET('/api/folders')]);
      if (!folders.some((f) => f.id === cur)) cur = null;
      draw();
    }
    const open = (id) => { cur = id; lastFolderId = id; q = ''; search.value = ''; draw(); };
    const moveMedia = (id, folderId) => api('PATCH', `/api/media/${id}`, { folderId }).then(reload, fail);
    const moveFolder = (id, parentId) => PUT(`/api/folders/${id}`, { parentId }).then(reload, fail);

    // Media items and folders can be dragged onto a folder tile or a breadcrumb.
    function dropTarget(el, folderId) {
      el.addEventListener('dragover', (e) => {
        if (!e.dataTransfer.types.includes('text/bk-media') && !e.dataTransfer.types.includes('text/bk-folder')) return;
        e.preventDefault(); el.classList.add('over');
      });
      el.addEventListener('dragleave', () => el.classList.remove('over'));
      el.addEventListener('drop', (e) => {
        el.classList.remove('over');
        const m = e.dataTransfer.getData('text/bk-media');
        const f = e.dataTransfer.getData('text/bk-folder');
        if (!m && !f) return;
        e.preventDefault(); e.stopPropagation();
        if (m) moveMedia(m, folderId);
        else if (f && f !== folderId) moveFolder(f, folderId);
      });
    }
    const draggable = (el, type, id) => {
      el.draggable = true;
      el.addEventListener('dragstart', (e) => { e.dataTransfer.setData(type, id); e.dataTransfer.effectAllowed = 'move'; });
      return el;
    };

    function moveDialog(title, current, exclude, onMove) {
      const data = { folderId: current || '' };
      const opts = folderOptions(folders).filter(([id]) => !exclude || !exclude(id));
      modal(title, field('Folder', bind(data, 'folderId', () => {}, 'select', { options: opts })), (close) => [
        h('button', { onclick: close }, 'Cancel'),
        h('button', { class: 'primary', onclick: () => { close(); onMove(data.folderId || null); } }, 'Move'),
      ]);
    }

    function newFolder() {
      const data = { name: '' };
      const nameInput = bind(data, 'name', () => {}, 'text', { placeholder: 'e.g. Commercials' });
      const create = async (close) => {
        try { const f = await POST('/api/folders', { name: data.name, parentId: cur }); close(); folders.push(f); draw(); } catch (err) { fail(err); }
      };
      const close = modal('New folder', h('div', { class: 'stack' },
        h('p', { class: 'muted' }, `Creates a folder in ${curName()}.`), field('Name', nameInput)),
      (c) => [h('button', { onclick: c }, 'Cancel'), h('button', { class: 'primary', onclick: () => create(c) }, 'Create')]);
      nameInput.addEventListener('keydown', (e) => { if (e.key === 'Enter') create(close); });
      nameInput.focus();
    }

    function upload(files) {
      if (!files.length) return;
      const fd = new FormData();
      for (const f of files) fd.append('files', f);
      const xhr = new XMLHttpRequest();
      const query = new URLSearchParams();
      if (cur) query.set('folderId', cur);
      if (arg === 'ads') query.set('ad', '1');
      xhr.open('POST', `/api/media?${query}`);
      progress.style.display = '';
      xhr.upload.onprogress = (e) => { if (e.lengthComputable) progress.firstChild.style.width = `${(e.loaded / e.total) * 100}%`; };
      xhr.onload = () => {
        progress.style.display = 'none';
        if (xhr.status >= 200 && xhr.status < 300) { toast('Upload complete', 'ok'); reload(); } else {
          let msg = 'Upload failed';
          try { msg = JSON.parse(xhr.responseText).error || msg; } catch { /* keep */ }
          toast(msg, 'err');
        }
      };
      xhr.onerror = () => { progress.style.display = 'none'; toast('Upload failed', 'err'); };
      xhr.send(fd);
    }
    input.onchange = () => { upload(input.files); input.value = ''; };
    const isFileDrag = (e) => e.dataTransfer.types.includes('Files');
    drop.addEventListener('dragover', (e) => { if (!isFileDrag(e)) return; e.preventDefault(); drop.classList.add('over'); });
    drop.addEventListener('dragleave', () => drop.classList.remove('over'));
    drop.addEventListener('drop', (e) => { if (!isFileDrag(e)) return; e.preventDefault(); drop.classList.remove('over'); upload(e.dataTransfer.files); });

    function folderTile(f) {
      const tile = h('div', { class: 'folder-tile', onclick: () => open(f.id) },
        h('div', { class: 'folder-icon' }),
        h('div', { class: 'name', title: f.name }, f.name),
        h('small', null, `${folderCount(media, folders, f.id)} items`),
        h('div', { class: 'row', style: { marginTop: '6px', gap: '4px' }, onclick: (e) => e.stopPropagation() },
          h('button', { class: 'small', onclick: async () => { const n = prompt('Folder name', f.name); if (n) { await PUT(`/api/folders/${f.id}`, { name: n }).catch(fail); reload(); } } }, 'Rename'),
          h('button', { class: 'small', onclick: () => {
            const inside = (id) => id === f.id || folderTrail(folders, id).some((x) => x.id === f.id);
            moveDialog(`Move folder "${f.name}"`, f.parentId, inside, (to) => moveFolder(f.id, to));
          } }, 'Move'),
          h('button', { class: 'small ghost', onclick: async () => {
            if (await confirmBox(`Delete folder "${f.name}"? Its files and subfolders are kept and move up one level.`)) { await DEL(`/api/folders/${f.id}`).catch(fail); reload(); }
          } }, 'Delete')));
      dropTarget(tile, f.id);
      return draggable(tile, 'text/bk-folder', f.id);
    }

    function mediaTile(m) {
      const where = (q || view) && m.folderId ? folderTrail(folders, m.folderId).map((f) => f.name).join(' / ') : null;
      return draggable(h('div', { class: 'media-item' },
        h('a', { href: m.url, target: '_blank' }, thumb(m)),
        h('div', { class: 'meta' },
          h('div', { class: 'name', title: m.name }, m.name),
          h('small', null, m.external ? m.url : [m.width && `${m.width}x${m.height}`, m.duration && `${m.duration}s`, fmtBytes(m.size)].filter(Boolean).join(' · ')),
          where ? h('div', null, h('small', null, `📁 ${where}`)) : null,
          h('div', { class: 'row', style: { marginTop: '6px', gap: '4px' } },
            h('button', { class: 'small', onclick: async () => { const n = prompt('New name', m.name); if (n) { await api('PATCH', `/api/media/${m.id}`, { name: n }).catch(fail); reload(); } } }, 'Rename'),
            h('button', { class: 'small', onclick: () => moveDialog(`Move "${m.name}"`, m.folderId, null, (to) => moveMedia(m.id, to)) }, 'Move'),
            h('button', { class: `small ${m.isAd ? 'on' : ''}`, title: m.isAd ? 'Marked as an ad. Click to unmark.' : 'Mark as an ad (commercial)', onclick: () => api('PATCH', `/api/media/${m.id}`, { isAd: !m.isAd }).then(reload, fail) }, m.isAd ? 'Ad ✓' : 'Ad'),
            h('button', { class: 'small ghost', onclick: async () => { if (await confirmBox(`Delete "${m.name}"? Scenes that use it will show nothing in its place.`)) { await DEL(`/api/media/${m.id}`).catch(fail); reload(); } } }, 'Delete')))),
      'text/bk-media', m.id);
    }

    function draw() {
      dropLabel.textContent = `Drop images, videos or audio here, or click to choose files. They go into ${curName()}${arg === 'ads' ? ' and are marked as ads' : ''}.`;
      if (view) {
        const items = media.filter(view[1]).filter((m) => !q || m.name.toLowerCase().includes(q)).reverse();
        put(crumbsEl, h('div', { class: 'crumbs muted' }, `${items.length} ${view[0].toLowerCase()} file${items.length === 1 ? '' : 's'} in all folders`));
        put(listEl, items.length ? h('div', { class: 'media-grid' }, items.map(mediaTile))
          : h('p', { class: 'muted' }, q ? 'Nothing found.' : arg === 'ads' ? 'No ads yet. Upload them here, or mark files as an ad with the Ad button.' : `No ${view[0].toLowerCase()} files yet.`));
        return;
      }
      if (q) put(crumbsEl, h('div', { class: 'crumbs muted' }, 'Search results in all folders'));
      else {
        const c = crumbs(folders, cur, open);
        c.querySelectorAll('.crumb').forEach((b) => dropTarget(b, b.dataset.folder || null));
        put(crumbsEl, c);
      }
      const subs = q ? [] : folders.filter((f) => (f.parentId || null) === cur).sort(byName);
      const items = media.filter((m) => (q ? m.name.toLowerCase().includes(q) : (m.folderId || null) === cur)).reverse();
      put(listEl, subs.length || items.length
        ? h('div', { class: 'media-grid' }, subs.map(folderTile), items.map(mediaTile))
        : h('p', { class: 'muted' }, q ? 'Nothing found.' : media.length || folders.length ? 'This folder is empty.' : 'No media uploaded yet.'));
    }

    main.append(
      h('div', { class: 'row between' }, h('h1', null, view ? view[0] : 'Media folders'), h('div', { class: 'row', style: { gap: '8px' } },
        view ? null : h('button', { onclick: newFolder }, '+ New folder'))),
      drop, input,
      h('div', { class: 'row between', style: { margin: '16px 0 12px', flexWrap: 'nowrap' } }, crumbsEl, h('div', { style: { width: '260px', flex: '0 0 260px' } }, search)),
      listEl);
    draw();
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
  // ---------- outputs ----------
  const OUTPUT_TYPES = { custom: 'RTMP / RTMPS / SRT', youtube: 'YouTube', facebook: 'Facebook' };
  const STATE_BADGE = { live: ['ok', 'Live'], connecting: ['warn', 'Connecting'], reconnecting: ['warn', 'Reconnecting'], error: ['err', 'Error'], stopped: ['', 'Stopped'] };

  // Links a YouTube or Facebook account with a device code: shows the code and waits for the user.
  async function linkAccount(provider, onLinked) {
    let link;
    try { link = await POST('/api/accounts/link', { provider }); } catch (err) { fail(err); return; }
    const name = provider === 'youtube' ? 'Google' : 'Facebook';
    const state = h('p', { class: 'muted' }, 'Waiting for you to enter the code…');
    let done = false;
    const close = modal(`Connect ${provider === 'youtube' ? 'YouTube' : 'Facebook'}`, h('div', { class: 'stack', style: { textAlign: 'center' } },
      h('p', null, `1. Open `, h('a', { href: link.url, target: '_blank', rel: 'noopener' }, link.url), ` on any device and sign in with ${name}.`),
      h('p', null, '2. Enter this code:'),
      h('div', { class: 'device-code' }, link.userCode),
      h('p', null, `3. Allow Beeldkrant to manage your ${provider === 'youtube' ? 'YouTube live streams' : 'live videos'}.`),
      state),
    (c) => [h('button', { onclick: () => { done = true; DEL(`/api/accounts/link/${link.id}`).catch(() => {}); c(); } }, 'Cancel')]);
    while (!done) {
      await new Promise((r) => setTimeout(r, 3000));
      if (done) return;
      let st;
      try { st = await GET(`/api/accounts/link/${link.id}`); } catch (err) { state.textContent = err.message; return; }
      if (st.state === 'linked') { done = true; close(); toast('Account connected', 'ok'); onLinked(st.accountId); return; }
      if (st.state !== 'waiting') { state.textContent = st.error || 'Linking stopped.'; state.className = 'badge err'; return; }
    }
  }

  function credentialsDialog(onSaved) {
    const data = { googleClientId: '', facebookAppId: '' };
    const secrets = {};
    GET('/api/connections').then((c) => {
      data.googleClientId = c.googleClientId; data.facebookAppId = c.facebookAppId;
      gId.value = c.googleClientId || ''; fId.value = c.facebookAppId || '';
      gSecret.placeholder = c.hasGoogleClientSecret ? 'Saved. Type to replace it.' : '';
      fToken.placeholder = c.hasFacebookClientToken ? 'Saved. Type to replace it.' : '';
    }).catch(fail);
    const gId = bind(data, 'googleClientId', () => {});
    const fId = bind(data, 'facebookAppId', () => {});
    const gSecret = h('input', { type: 'password', autocomplete: 'new-password', oninput: (e) => { secrets.googleClientSecret = e.target.value; } });
    const fToken = h('input', { type: 'password', autocomplete: 'new-password', oninput: (e) => { secrets.facebookClientToken = e.target.value; } });
    modal('Account linking', h('div', { class: 'stack' },
      h('h3', { style: { marginTop: 0 } }, 'YouTube'),
      h('ol', { class: 'steps' },
        h('li', null, 'In ', h('a', { href: 'https://console.cloud.google.com/apis/library/youtube.googleapis.com', target: '_blank', rel: 'noopener' }, 'Google Cloud Console'), ' enable the YouTube Data API v3 for a project.'),
        h('li', null, 'Under APIs & Services → Credentials, create an OAuth client ID of type ', h('b', null, 'TVs and Limited Input devices'), '.'),
        h('li', null, 'Copy its client ID and secret here. Add your Google account as a test user while the app is in testing.')),
      h('div', { class: 'fields' }, field('Client ID', gId), field('Client secret', gSecret)),
      h('h3', null, 'Facebook'),
      h('ol', { class: 'steps' },
        h('li', null, 'Create an app at ', h('a', { href: 'https://developers.facebook.com/apps', target: '_blank', rel: 'noopener' }, 'Meta for Developers'), ' and add Facebook Login.'),
        h('li', null, 'Under Facebook Login → Settings, switch on ', h('b', null, 'Login from Devices'), '.'),
        h('li', null, 'Copy the App ID and the Client token (Settings → Advanced) here. Until Meta has reviewed the app, only people with a role on the app can go live through it.')),
      h('div', { class: 'fields' }, field('App ID', fId), field('Client token', fToken))),
    (close) => [h('button', { onclick: close }, 'Cancel'), h('button', { class: 'primary', onclick: async () => {
      try { await PUT('/api/connections', { ...data, ...secrets }); close(); toast('Saved', 'ok'); if (onSaved) onSaved(); } catch (err) { fail(err); }
    } }, 'Save')]);
  }

  async function outputDialog(existing, accounts, onSaved) {
    const o = existing ? clone(existing) : { name: '', type: 'custom', mode: 'account', url: '', title: '', description: '', privacy: 'unlisted', enabled: true, source: 'schedule' };
    let playouts = [];
    try { playouts = await GET('/api/playouts'); } catch { /* the list stays empty */ }
    o.mode = o.mode || 'account';
    const secrets = {};
    const body = h('div', { class: 'stack' });
    const pagesCache = {};
    async function draw() {
      const own = accounts.filter((a) => a.provider === o.type);
      if (o.type !== 'custom' && o.mode === 'account' && !own.some((a) => a.id === o.accountId)) o.accountId = own[0] ? own[0].id : null;
      let pageField = null;
      if (o.type === 'facebook' && o.mode === 'account' && o.accountId) {
        if (!pagesCache[o.accountId]) {
          pagesCache[o.accountId] = 'loading';
          GET(`/api/accounts/${o.accountId}/pages`).then((p) => { pagesCache[o.accountId] = p; draw(); }).catch((err) => { pagesCache[o.accountId] = []; toast(err.message, 'err'); draw(); });
        }
        const pages = Array.isArray(pagesCache[o.accountId]) ? pagesCache[o.accountId] : [];
        pageField = field('Go live on', bind(o, 'facebookPageId', () => {}, 'select', { options: [['', 'My profile'], ...pages.map((p) => [p.id, `Page: ${p.name}`])] }),
          { hint: pagesCache[o.accountId] === 'loading' ? 'Loading your pages…' : 'A page needs the account to be an admin of that page.' });
      }
      const keyInput = h('input', { type: 'password', autocomplete: 'new-password', placeholder: existing && existing.hasStreamKey ? 'Saved. Type to replace it.' : 'xxxx-xxxx-xxxx-xxxx', oninput: (e) => { secrets.streamKey = e.target.value; } });
      put(body,
        h('div', { class: 'fields' },
          field('Name', bind(o, 'name', () => {}, 'text', { placeholder: 'e.g. YouTube channel' })),
          field('Type', bind(o, 'type', draw, 'select', { options: Object.entries(OUTPUT_TYPES) }))),
        field('Sends', bind(o, 'source', () => {}, 'select', { options: [['schedule', 'The schedule (whatever is on air)'], ...playouts.map((p) => [p.id, `Playout: ${p.name}`])] }),
          { hint: 'Send a fixed playout, for example a clean feed, instead of the schedule. See Outputs → Routing.' }),
        o.type === 'custom' ? field('Destination', bind(o, 'url', () => {}, 'text', { placeholder: 'rtmp://server/live/streamkey  or  srt://server:9000?streamid=…' }),
          { hint: 'RTMP and RTMPS are sent as FLV, SRT as MPEG-TS.' }) : [
          field('Connect with', bind(o, 'mode', draw, 'select', { options: [['account', 'Connected account (goes live automatically)'], ['key', 'Stream key']] })),
          o.mode === 'key' ? field('Stream key', keyInput, { hint: o.type === 'youtube' ? 'From YouTube Studio → Go live → Stream. Sent to rtmps://a.rtmps.youtube.com/live2.' : 'From Facebook Live Producer → Streaming software. Sent to rtmps://live-api-s.facebook.com:443/rtmp.' }) : [
            own.length ? field('Account', bind(o, 'accountId', draw, 'select', { options: own.map((a) => [a.id, a.name]) }))
              : h('div', { class: 'row' }, h('span', { class: 'muted' }, `No ${OUTPUT_TYPES[o.type]} account connected yet.`), me.user.role === 'admin' ? h('button', { class: 'small', onclick: () => linkAccount(o.type, async (id) => { accounts = await GET('/api/accounts'); o.accountId = id; draw(); }) }, `Connect ${OUTPUT_TYPES[o.type]}`) : null),
            pageField,
            field('Title', bind(o, 'title', () => {}, 'text', { placeholder: o.name || 'Live' }), { hint: 'Title of the live broadcast. Empty uses the output name.' }),
            field('Description', bind(o, 'description', () => {}, 'textarea')),
            o.type === 'youtube' ? field('Privacy', bind(o, 'privacy', () => {}, 'select', { options: [['public', 'Public'], ['unlisted', 'Unlisted'], ['private', 'Private']] })) : null,
          ]],
        h('label', { class: 'check' }, bind(o, 'enabled', () => {}, 'checkbox'), 'On (sends whenever the stream runs)'));
    }
    draw();
    modal(existing ? `Edit ${existing.name}` : 'Add output', body, (close) => [h('button', { onclick: close }, 'Cancel'), h('button', { class: 'primary', onclick: async () => {
      try {
        const payload = { ...o, ...secrets };
        if (existing) await PUT(`/api/outputs/${existing.id}`, payload); else await POST('/api/outputs', payload);
        close(); toast('Saved', 'ok'); onSaved();
      } catch (err) { fail(err); }
    } }, 'Save')]);
  }

  async function pageOutput(main) {
    let [list, accounts, out, status, playouts] = await Promise.all([GET('/api/outputs'), GET('/api/accounts'), GET('/api/output'), GET('/api/stream'), GET('/api/playouts')]);
    const isAdmin = me.user.role === 'admin';
    const listEl = h('div');
    const streamLine = h('div');
    const accountsEl = h('div', { class: 'stack' });
    const openLogs = new Set();
    async function reload() { [list, accounts] = await Promise.all([GET('/api/outputs'), GET('/api/accounts')]); refresh(); drawAccounts(); }

    async function refresh() {
      try { status = await GET('/api/stream'); } catch { return; }
      const running = status.wanted;
      put(streamLine, h('div', { class: 'row between' },
        h('div', null, running ? h('span', { class: `badge ${status.state === 'live' ? 'ok' : 'warn'}` }, h('span', { class: 'dot' }), `Stream ${status.state}`) : h('span', { class: 'muted' }, 'The stream is stopped. Outputs that are on start when it starts.')),
        running ? h('button', { class: 'danger small', onclick: () => POST('/api/stream/stop').then(refresh).catch(fail) }, 'Stop stream')
          : h('button', { class: 'primary small', onclick: () => POST('/api/stream/start').then(refresh).catch(fail) }, 'Start stream')));
      const byId = Object.fromEntries(status.outputs.map((s) => [s.id, s]));
      if (!list.length) { put(listEl, h('p', { class: 'muted' }, 'No outputs yet. Add one to send the stream to a server, YouTube or Facebook.')); return; }
      put(listEl, list.map((o) => {
        const st = byId[o.id] || { state: 'stopped', stats: {} };
        const [cls, label] = o.enabled ? STATE_BADGE[st.state] || ['', st.state] : ['', 'Off'];
        const toggle = h('label', { class: 'switch', title: o.enabled ? 'Turn off' : 'Turn on' }, h('input', { type: 'checkbox', checked: o.enabled, onchange: (e) => POST(`/api/outputs/${o.id}/enable`, { enabled: e.target.checked }).then(reload).catch(fail) }), h('span'));
        return h('div', { class: 'output-row' },
          toggle,
          h('div', { class: 'output-main' },
            h('div', { class: 'row', style: { gap: '8px' } }, h('b', null, o.name), h('span', { class: `badge type-${o.type}` }, OUTPUT_TYPES[o.type]), h('span', { class: `badge ${cls}` }, label),
              st.stats && st.stats.bitrate && st.state === 'live' ? h('small', { class: 'muted' }, st.stats.bitrate) : null,
              st.watchUrl ? h('a', { href: st.watchUrl, target: '_blank', rel: 'noopener' }, 'Watch ↗') : null),
            h('small', { class: 'muted' }, st.destination || '', ' · sends ', h('a', { href: '#routing' }, sourceLabel(o.source, playouts))),
            st.error && o.enabled ? h('div', { class: 'hint', style: { color: 'var(--danger)' } }, st.error) : null,
            openLogs.has(o.id) ? h('div', { class: 'logs', style: { height: '120px', marginTop: '6px' } }, st.log.join('\n') || 'Nothing logged yet.') : null),
          h('div', { class: 'row', style: { gap: '4px' } },
            h('button', { class: 'small ghost', onclick: () => { openLogs.has(o.id) ? openLogs.delete(o.id) : openLogs.add(o.id); refresh(); } }, openLogs.has(o.id) ? 'Hide log' : 'Log'),
            h('button', { class: 'small', onclick: () => outputDialog(o, accounts, reload) }, 'Edit'),
            h('button', { class: 'small ghost', onclick: async () => { if (await confirmBox(`Delete the output "${o.name}"?`)) { await DEL(`/api/outputs/${o.id}`).catch(fail); reload(); } } }, 'Delete')));
      }));
    }

    function drawAccounts() {
      put(accountsEl,
        accounts.length ? h('table', { class: 'list' }, h('tbody', null, accounts.map((a) => h('tr', null,
          h('td', null, h('span', { class: `badge type-${a.provider}` }, OUTPUT_TYPES[a.provider])), h('td', null, a.name),
          h('td', { style: { textAlign: 'right' } }, isAdmin ? h('button', { class: 'small ghost', onclick: async () => {
            if (await confirmBox(`Disconnect ${a.name}? Outputs that use it stop going live until you choose another account.`)) { await DEL(`/api/accounts/${a.id}`).catch(fail); reload(); }
          } }, 'Disconnect') : null)))))
          : h('p', { class: 'muted' }, 'No accounts connected. Connect YouTube or Facebook so outputs can create the live broadcast for you.'),
        isAdmin ? h('div', { class: 'row' },
          h('button', { onclick: () => linkAccount('youtube', reload) }, 'Connect YouTube'),
          h('button', { onclick: () => linkAccount('facebook', reload) }, 'Connect Facebook'),
          h('button', { class: 'ghost', onclick: () => credentialsDialog() }, 'Linking settings…')) : null);
    }

    const fixedFields = h('div', { class: 'fields' });
    const drawFixed = () => { fixedFields.style.display = out.resolutionMode === 'fixed' ? '' : 'none'; };
    fixedFields.append(field('Width', bind(out, 'width', () => {}, 'number')), field('Height', bind(out, 'height', () => {}, 'number')));
    drawFixed();
    const hw = [status.tools.vaapi ? 'VAAPI (Intel/AMD)' : null, status.tools.nvenc ? 'NVENC (NVIDIA)' : null].filter(Boolean);

    main.append(h('div', { class: 'row between' }, h('h1', null, 'Outputs'), h('button', { class: 'primary', onclick: () => outputDialog(null, accounts, reload) }, '+ Add output')),
      h('div', { class: 'card stack' }, streamLine, listEl),
      h('div', { class: 'grid two', style: { marginTop: '16px' } },
        h('div', { class: 'card stack' }, h('h2', null, 'Encoding'),
          h('p', { class: 'muted', style: { margin: 0 } }, 'Each playout on air is encoded once and sent as is to every output routed to it. These settings apply to all of them.'),
          h('div', { class: 'fields' },
            field('Resolution', bind(out, 'resolutionMode', drawFixed, 'select', { options: [['playout', 'Follow the playout'], ['fixed', 'Fixed output size (scaled)']] }), { wide: true }),
            h('div', { class: 'wide' }, fixedFields),
            field('Frame rate', bind(out, 'fps', () => {}, 'select', { options: [['25', '25 fps'], ['30', '30 fps'], ['50', '50 fps'], ['60', '60 fps']] })),
            field('Video bitrate (kbit/s)', bind(out, 'videoBitrate', () => {}, 'number', { min: 200 })),
            field('Encoder', bind(out, 'encoder', () => {}, 'select', { options: [['libx264', 'CPU (x264)'], ['h264_vaapi', 'GPU: Intel/AMD (VAAPI)'], ['h264_nvenc', 'GPU: NVIDIA (NVENC)']] }),
              { hint: hw.length ? `Detected: ${hw.join(', ')}` : 'No GPU detected in this container.' }),
            field('x264 preset', bind(out, 'preset', () => {}, 'select', { options: ['ultrafast', 'superfast', 'veryfast', 'faster', 'fast', 'medium'].map((p) => [p, p]) }), { hint: 'Faster presets use less CPU.' }),
            h('label', { class: 'check' }, bind(out, 'audio', () => {}, 'checkbox'), 'Send audio'),
            field('Audio bitrate (kbit/s)', bind(out, 'audioBitrate', () => {}, 'number', { min: 32 }))),
          h('div', { class: 'row' }, h('button', { class: 'primary', onclick: async () => {
            try { await PUT('/api/output', { ...out, fps: Number(out.fps) }); toast(status.wanted ? 'Saved. The stream restarts with the new settings.' : 'Saved', 'ok'); } catch (err) { fail(err); }
          } }, 'Save encoding'))),
        h('div', { class: 'card stack' }, h('h2', null, 'Accounts'), accountsEl)));
    drawAccounts();
    await refresh();
    const iv = setInterval(refresh, 3000);
    cleanup = () => clearInterval(iv);
  }


  // ---------- outputs: routing ----------
  const sourceLabel = (source, playouts) => {
    if (!source || source === 'schedule') return 'Schedule';
    const p = playouts.find((x) => x.id === source);
    return p ? p.name : 'deleted playout';
  };

  // Which playout goes to which output: a matrix with one row per source and one column per output.
  async function pageRouting(main) {
    let [list, playouts, status, settings] = await Promise.all([GET('/api/outputs'), GET('/api/playouts'), GET('/api/stream'), GET('/api/settings')]);
    const onAirEl = h('div');
    const matrixEl = h('div', { class: 'route-wrap' });
    const onAirNow = () => playouts.find((p) => p.id === settings.activePlayoutId);

    function drawOnAir() {
      const pipes = status.pipelines || [];
      const outsFor = (source) => list.filter((o) => o.enabled && (o.source || 'schedule') === source);
      put(onAirEl,
        h('div', { class: 'row between' }, h('h2', { style: { margin: 0 } }, 'On air now'),
          status.wanted ? h('button', { class: 'danger small', onclick: () => POST('/api/stream/stop').then(refresh).catch(fail) }, 'Stop stream')
            : h('button', { class: 'primary small', onclick: () => POST('/api/stream/start').then(refresh).catch(fail) }, 'Start stream')),
        !status.wanted ? h('p', { class: 'muted' }, 'The stream is stopped. When it starts, every playout below that an output is routed to goes on air.')
          : !pipes.length ? h('p', { class: 'muted' }, 'Nothing is on air: no output is turned on.')
            : h('div', { class: 'source-tiles' }, pipes.map((p) => {
              const [cls, label] = { live: ['ok', 'Live'], starting: ['warn', 'Starting'], restarting: ['warn', 'Restarting'], error: ['err', 'Error'] }[p.state] || ['', p.state];
              return h('div', { class: 'source-tile' },
                h('div', { class: 'row between' }, h('b', null, p.label), h('span', { class: `badge ${cls}` }, h('span', { class: 'dot' }), label)),
                p.source === 'schedule' ? h('small', { class: 'muted' }, `Now: ${p.playoutName || 'nothing scheduled'}`) : h('small', { class: 'muted' }, 'Fixed playout'),
                h('small', { class: 'muted' }, [p.resolution, p.stats && p.stats.bitrate].filter(Boolean).join(' · ') || '—'),
                h('div', { class: 'row', style: { gap: '4px', marginTop: '4px' } }, outsFor(p.source).map((o) => h('span', { class: `badge type-${o.type}` }, o.name))));
            })),
        status.wanted && pipes.length > 1 ? h('p', { class: 'hint' }, `${pipes.length} playouts are on air, each with its own renderer and encoder. Every extra playout adds roughly the CPU (or GPU) load of one stream.`) : null);
    }

    function drawMatrix() {
      if (!list.length) { put(matrixEl, h('p', { class: 'muted' }, 'No outputs yet. ', h('a', { href: '#output' }, 'Add an output'), ' first.')); return; }
      const live = new Set((status.pipelines || []).map((p) => p.source));
      const now = onAirNow();
      const sources = [
        { id: 'schedule', name: 'Schedule', sub: `Follows the schedule · now ${now ? now.name : 'nothing'}` },
        ...playouts.map((p) => ({ id: p.id, name: p.name, sub: `${p.width} x ${p.height}${p.id === settings.activePlayoutId ? ' · on the schedule now' : ''}` })),
      ];
      const choose = async (o, source) => {
        if ((o.source || 'schedule') === source) return;
        try { await PUT(`/api/outputs/${o.id}/source`, { source }); o.source = source; drawMatrix(); drawOnAir(); toast(`${o.name} now sends ${sourceLabel(source, playouts)}`, 'ok'); } catch (err) { fail(err); }
      };
      put(matrixEl, h('table', { class: 'route-table' },
        h('thead', null, h('tr', null, h('th', null, 'Playout'), list.map((o) => h('th', { class: o.enabled ? '' : 'off', title: o.enabled ? '' : 'This output is turned off' },
          h('div', null, o.name), h('span', { class: `badge type-${o.type}` }, OUTPUT_TYPES[o.type]))))),
        h('tbody', null, sources.map((src) => h('tr', null,
          h('td', null, h('div', { class: 'row', style: { gap: '6px' } }, h('b', null, src.name), status.wanted && live.has(src.id) ? h('span', { class: 'badge ok' }, h('span', { class: 'dot' }), 'On air') : null),
            h('small', { class: 'muted' }, src.sub)),
          list.map((o) => {
            const on = (o.source || 'schedule') === src.id;
            return h('td', { class: `route-cell ${o.enabled ? '' : 'off'}` },
              h('button', { class: `route-dot ${on ? 'on' : ''}`, 'aria-pressed': String(on), title: on ? `${o.name} sends ${src.name}` : `Send ${src.name} to ${o.name}`, onclick: () => choose(o, src.id) }));
          }))))));
    }

    async function refresh() {
      try { [status, list, settings] = await Promise.all([GET('/api/stream'), GET('/api/outputs'), GET('/api/settings')]); } catch { return; }
      drawOnAir();
      drawMatrix();
    }

    main.append(h('div', { class: 'row between' }, h('h1', null, 'Routing'), h('a', { class: 'btn', href: '#output' }, 'Outputs')),
      h('p', { class: 'muted', style: { marginTop: 0 } }, 'Choose which playout each output sends. Outputs on the same playout share one encoder. Clone a playout to make a variant, such as a clean feed without overlays, and route it to its own output.'),
      h('div', { class: 'card stack' }, onAirEl),
      h('div', { class: 'card stack', style: { marginTop: '16px' } }, h('h2', { style: { margin: 0 } }, 'Routing'), matrixEl,
        h('p', { class: 'hint' }, 'Each output sends one playout. Turned-off outputs are dimmed; their routing is kept for when you turn them on.')));
    drawOnAir();
    drawMatrix();
    const iv = setInterval(refresh, 4000);
    cleanup = () => clearInterval(iv);
  }

  // ---------- settings ----------
  async function pageSettings(main) {
    const settings = await GET('/api/settings');
    const isAdmin = me.user.role === 'admin';
    const general = { panelName: settings.panelName || 'Beeldkrant' };
    const server = { serverAddress: settings.serverAddress || '', port: settings.port };
    const region = { timezone: settings.timezone, locale: settings.locale };
    const panelUrl = () => `http://${server.serverAddress || location.hostname}:${server.port}/admin/`;
    const urlHint = h('div', { class: 'hint' });
    const showUrl = () => { urlHint.textContent = `The panel is reached at ${panelUrl()}`; };
    showUrl();
    async function saveApp() {
      try {
        await PUT('/api/settings', general);
        me.panelName = general.panelName.trim();
        if (isAdmin) {
          const r = await PUT('/api/settings/server', server);
          if (r.moved) {
            toast(`Beeldkrant now listens on port ${r.port}. Taking you there…`, 'ok');
            setTimeout(() => { location.href = `${location.protocol}//${location.hostname}:${r.port}/admin/#settings`; }, 1200);
            return;
          }
        }
        toast('Saved', 'ok'); route();
      } catch (err) { fail(err); }
    }
    main.append(h('h1', null, 'Application'),
      h('div', { class: 'grid two' },
        h('div', { class: 'card stack' }, h('h2', null, 'Application'),
          field('Name', bind(general, 'panelName', () => {}, 'text', { placeholder: 'Beeldkrant' }), { hint: 'Shown in the menu, on the login page and in the browser tab.' }),
          isAdmin ? [
            field('Server address', bind(server, 'serverAddress', showUrl, 'text', { placeholder: location.hostname }), { hint: 'The host name or IP address people use to reach this server. Leave empty to use the address in your browser.' }),
            field('Port', bind(server, 'port', showUrl, 'number', { min: 1, max: 65535 }), { hint: 'The web port of the admin panel. Changing it moves the panel to the new port right away.' }),
            urlHint,
          ] : null,
          h('button', { class: 'primary', onclick: saveApp }, 'Save')),
        h('div', { class: 'card stack' }, h('h2', null, 'Region'),
          field('Time zone', bind(region, 'timezone', () => {}, 'text', { placeholder: 'Europe/Amsterdam' }), { hint: 'Used by the schedule, backups, clocks and dates.' }),
          field('Language for dates', bind(region, 'locale', () => {}, 'select', { options: [['en-GB', 'English (UK)'], ['en-US', 'English (US)'], ['nl-NL', 'Dutch'], ['de-DE', 'German'], ['fr-FR', 'French']] })),
          h('button', { class: 'primary', onclick: async () => { try { await PUT('/api/settings', region); toast('Saved', 'ok'); } catch (err) { fail(err); } } }, 'Save'))));
  }


  // ---------- dashboard: statistics ----------
  // A single-series line chart over the stats history with a hover crosshair and tooltip.
  function lineChart(history, pick, { unit, digits = 1, max: fixedMax, empty = 'Collecting data…' } = {}) {
    const W = 600;
    const H = 120;
    const pts = history.map((p) => ({ t: p.t, v: pick(p) }));
    const vals = pts.map((p) => p.v).filter((v) => v != null);
    const max = fixedMax || Math.max(1e-6, ...vals) * 1.15;
    const x = (i) => (pts.length > 1 ? (i / (pts.length - 1)) * W : 0);
    const y = (v) => H - (v / max) * H;
    let line = '';
    let started = false;
    pts.forEach((p, i) => {
      if (p.v == null) { started = false; return; }
      line += `${started ? 'L' : 'M'}${x(i).toFixed(1)},${y(p.v).toFixed(1)}`;
      started = true;
    });
    const first = pts.findIndex((p) => p.v != null);
    const lastIdx = pts.length - 1 - [...pts].reverse().findIndex((p) => p.v != null);
    const area = vals.length > 1 && pts.slice(first, lastIdx + 1).every((p) => p.v != null) ? `${line}L${x(lastIdx)},${H}L${x(first)},${H}Z` : '';
    const svgNS = 'http://www.w3.org/2000/svg';
    const svg = document.createElementNS(svgNS, 'svg');
    svg.setAttribute('viewBox', `0 0 ${W} ${H}`);
    svg.setAttribute('preserveAspectRatio', 'none');
    svg.setAttribute('class', 'chart-svg');
    svg.innerHTML = `<line x1="0" y1="${H / 2}" x2="${W}" y2="${H / 2}" class="grid"/><line x1="0" y1="${H - 0.5}" x2="${W}" y2="${H - 0.5}" class="base"/>${area ? `<path d="${area}" class="area"/>` : ''}<path d="${line}" class="line"/>`;
    const fmt = (v) => (v == null ? 'no data' : `${v.toFixed(digits)}${unit ? ` ${unit}` : ''}`);
    const cross = h('div', { class: 'chart-cross', style: { display: 'none' } });
    const dot = h('div', { class: 'chart-dot', style: { display: 'none' } });
    const tip = h('div', { class: 'chart-tip', style: { display: 'none' } });
    const box = h('div', { class: 'chart' }, h('span', { class: 'chart-max' }, fmt(max / 1.15 * (fixedMax ? 1.15 : 1))), svg, cross, dot, tip,
      vals.length ? null : h('div', { class: 'chart-empty' }, empty));
    box.addEventListener('mousemove', (e) => {
      if (!pts.length) return;
      const r = svg.getBoundingClientRect();
      const i = Math.max(0, Math.min(pts.length - 1, Math.round(((e.clientX - r.left) / r.width) * (pts.length - 1))));
      const px = (x(i) / W) * r.width;
      cross.style.display = ''; cross.style.left = `${px}px`;
      const p = pts[i];
      if (p.v != null) { dot.style.display = ''; dot.style.left = `${px}px`; dot.style.top = `${(y(p.v) / H) * r.height}px`; } else dot.style.display = 'none';
      tip.style.display = '';
      tip.style.left = `${Math.min(px + 10, r.width - 120)}px`;
      put(tip, h('b', null, fmt(p.v)), h('div', null, new Date(p.t).toLocaleTimeString()));
    });
    box.addEventListener('mouseleave', () => { cross.style.display = 'none'; dot.style.display = 'none'; tip.style.display = 'none'; });
    return box;
  }

  const fmtGB = (n) => `${(n / 1e9).toFixed(n > 1e11 ? 0 : 1)} GB`;

  async function pageStats(main) {
    const tiles = h('div', { class: 'stat-tiles' });
    const charts = h('div', { class: 'grid two' });
    main.append(h('h1', null, 'Statistics'), tiles, charts,
      h('p', { class: 'hint', style: { marginTop: '12px' } }, 'Updated every 5 seconds. The charts show the last 15 minutes.'));
    async function refresh() {
      let s;
      try { s = await GET('/api/stats'); } catch { return; }
      const last = s.history[s.history.length - 1] || {};
      const lastOf = (k) => [...s.history].reverse().find((p) => p[k] != null)?.[k];
      const tile = (label, value, sub, meter) => h('div', { class: 'card stat-tile' }, h('small', null, label), h('div', { class: 'stat-value' }, value), sub ? h('div', { class: 'hint' }, sub) : null,
        meter != null ? h('div', { class: 'meter' }, h('div', { style: { width: `${Math.min(100, meter * 100)}%` }, class: meter > 0.9 ? 'hot' : '' })) : null);
      const used = s.disk ? 1 - s.disk.free / s.disk.total : null;
      const stream = lastOf('streamKbit');
      put(tiles,
        tile('Load', last.load != null ? last.load.toFixed(2) : '—', `${s.cpus} CPU core${s.cpus === 1 ? '' : 's'}`, last.load != null ? last.load / s.cpus : null),
        tile('CPU', last.cpu != null ? `${Math.round(last.cpu * 100)}%` : '—', null, last.cpu),
        tile('Memory', `${Math.round((last.mem || 0) * 100)}%`, `of ${fmtGB(s.memTotal)}`, last.mem),
        tile('Stream out', last.streamKbit != null ? `${(last.streamKbit / 1000).toFixed(1)} Mbit/s` : 'Off air', stream != null && last.streamKbit == null ? 'Not streaming now' : 'Encoder bitrate'),
        tile('Network out', last.txMbit != null ? `${last.txMbit.toFixed(1)} Mbit/s` : '—', last.rxMbit != null ? `In: ${last.rxMbit.toFixed(1)} Mbit/s` : null),
        tile('Disk free', s.disk ? fmtGB(s.disk.free) : '—', s.disk ? `of ${fmtGB(s.disk.total)} (${Math.round(used * 100)}% used)` : null, used));
      put(charts,
        h('div', { class: 'card' }, h('h2', null, 'Stream bitrate (Mbit/s)'), lineChart(s.history, (p) => (p.streamKbit == null ? null : p.streamKbit / 1000), { unit: 'Mbit/s', digits: 2, empty: 'Not streaming' })),
        h('div', { class: 'card' }, h('h2', null, 'Network out (Mbit/s)'), lineChart(s.history, (p) => p.txMbit, { unit: 'Mbit/s', digits: 2 })),
        h('div', { class: 'card' }, h('h2', null, 'Load'), lineChart(s.history, (p) => p.load, { digits: 2 })),
        h('div', { class: 'card' }, h('h2', null, 'CPU (%)'), lineChart(s.history, (p) => (p.cpu == null ? null : p.cpu * 100), { unit: '%', digits: 0, max: 100 })));
    }
    await refresh();
    const iv = setInterval(refresh, 5000);
    cleanup = () => clearInterval(iv);
  }

  // ---------- media management: overview ----------
  async function pageLibrary(main) {
    const [all, folders, feeds, playouts] = await Promise.all([GET('/api/media'), GET('/api/folders'), GET('/api/feeds'), GET('/api/playouts')]);
    const files = all.filter((m) => !m.external);
    const streams = all.filter((m) => m.external);
    const size = (list) => fmtBytes(list.reduce((a, m) => a + (m.size || 0), 0));
    const videos = files.filter((m) => m.type === 'video');
    const seconds = Math.round(videos.reduce((a, m) => a + (m.duration || 0), 0));
    const length = seconds >= 3600 ? `${Math.floor(seconds / 3600)} h ${Math.round((seconds % 3600) / 60)} min` : seconds >= 60 ? `${Math.round(seconds / 60)} min` : `${seconds} s`;
    const card = (href, title, big, sub, list) => h('a', { class: 'card lib-card', href },
      h('div', { class: 'row between' }, h('h2', { style: { margin: 0 } }, title), h('span', { class: 'muted' }, '→')),
      h('div', { class: 'stat-value' }, big), sub ? h('div', { class: 'hint' }, sub) : null,
      list && list.length ? h('ul', { class: 'lib-list' }, list.slice(0, 5).map((t) => h('li', null, t)), list.length > 5 ? h('li', { class: 'muted' }, `and ${list.length - 5} more`) : null) : null);
    const musicUse = (id) => playouts.filter((p) => p.music && p.music.mediaId === id).map((p) => p.name);
    main.append(h('h1', null, 'Media management'),
      h('div', { class: 'lib-grid' },
        card('#media', 'Media folders', `${files.length} files`, `${folders.length} folder${folders.length === 1 ? '' : 's'} · ${size(files)}`),
        card('#media/video', 'Video', String(videos.length), `${length} of video · ${size(videos)}`),
        card('#media/audio', 'Audio', String(files.filter((m) => m.type === 'audio').length), size(files.filter((m) => m.type === 'audio'))),
        card('#media/ads', 'Ads', String(files.filter((m) => m.isAd).length), 'Files marked as ads (commercials)'),
        card('#feeds', 'RSS feeds', String(feeds.length), null, feeds.map((f) => f.name)),
        card('#streams', 'Input streams', String(streams.length), 'Icecast / Shoutcast audio', streams.map((m) => (musicUse(m.id).length ? `${m.name} (music in ${musicUse(m.id).join(', ')})` : m.name)))));
  }

  // ---------- media management: input streams ----------
  async function pageStreams(main) {
    const [all, playouts] = await Promise.all([GET('/api/media'), GET('/api/playouts')]);
    const streams = all.filter((m) => m.external);
    let player = null;
    const edit = (m) => {
      const data = { name: m ? m.name : '', url: m ? m.url : '' };
      modal(m ? 'Edit input stream' : 'Add input stream', h('div', { class: 'stack' },
        h('p', { class: 'muted' }, 'A Shoutcast or Icecast audio web stream. Use it as background music in a playout (Playout settings → Background music).'),
        field('Name', bind(data, 'name', () => {}, 'text', { placeholder: 'e.g. Radio 1' })),
        field('Stream URL', bind(data, 'url', () => {}, 'url', { placeholder: 'https://stream.example.com:8000/live.mp3' }))),
      (close) => [h('button', { onclick: close }, 'Cancel'), h('button', { class: 'primary', onclick: async () => {
        try {
          if (m) await api('PATCH', `/api/media/${m.id}`, data); else await POST('/api/media/external', data);
          close(); route();
        } catch (err) { fail(err); }
      } }, m ? 'Save' : 'Add')]);
    };
    const listen = (m, btn) => {
      if (player && player.dataset.id === m.id) { player.pause(); player = null; btn.textContent = '▶ Listen'; return; }
      if (player) player.pause();
      document.querySelectorAll('.listen-btn').forEach((b) => { b.textContent = '▶ Listen'; });
      player = new Audio(m.url);
      player.dataset.id = m.id;
      player.play().then(() => { btn.textContent = '■ Stop'; }).catch(() => { toast('Could not play this stream in your browser', 'err'); player = null; });
    };
    cleanup = () => { if (player) player.pause(); };
    main.append(h('div', { class: 'row between' }, h('h1', null, 'Input streams'), h('button', { class: 'primary', onclick: () => edit(null) }, '+ Add input stream')),
      streams.length ? h('div', { class: 'card' }, h('table', { class: 'list' },
        h('thead', null, h('tr', null, h('th', null, 'Name'), h('th', null, 'Address'), h('th', null, 'Used by'), h('th'))),
        h('tbody', null, streams.map((m) => {
          const used = playouts.filter((p) => p.music && p.music.mediaId === m.id).map((p) => p.name);
          const btn = h('button', { class: 'small listen-btn', onclick: () => listen(m, btn) }, '▶ Listen');
          return h('tr', null, h('td', null, h('b', null, m.name)), h('td', null, h('code', null, m.url)), h('td', null, used.length ? used.join(', ') : h('span', { class: 'muted' }, 'Not used')),
            h('td', { style: { textAlign: 'right', whiteSpace: 'nowrap' } }, btn, ' ',
              h('button', { class: 'small', onclick: () => edit(m) }, 'Edit'), ' ',
              h('button', { class: 'small ghost', onclick: async () => { if (await confirmBox(`Delete "${m.name}"?${used.length ? ' Playouts that use it lose their background music.' : ''}`)) { await DEL(`/api/media/${m.id}`).catch(fail); route(); } } }, 'Delete')));
        }))))
        : h('p', { class: 'muted' }, 'No input streams yet. Add a Shoutcast or Icecast stream to use as background music.'));
  }

  // ---------- account ----------
  async function pageAccount(main) {
    main.append(h('h1', null, 'Your account'),
      h('div', { class: 'grid two' },
        h('div', { class: 'card stack' }, h('h2', null, 'Appearance'),
          h('p', { class: 'muted' }, 'Choose a light or dark theme for your account, or follow your device setting.'),
          themeSwitch()),
        h('div', { class: 'card stack' }, h('h2', null, 'Change password'), renderChangePassword(false))));
  }

  // ---------- system: info ----------
  // Enough Markdown for CHANGELOG.md: headings, bullets, paragraphs, `code` and **bold**.
  function markdown(text) {
    const inline = (t) => t.split(/(`[^`]+`|\*\*[^*]+\*\*)/).map((part) => {
      if (/^`[^`]+`$/.test(part)) return h('code', null, part.slice(1, -1));
      if (/^\*\*[^*]+\*\*$/.test(part)) return h('b', null, part.slice(2, -2));
      return part;
    });
    const box = h('div', { class: 'md' });
    let list = null;
    for (const line of String(text || '').split('\n')) {
      const m = /^(#{1,4})\s+(.*)$/.exec(line);
      if (/^\s*[-*]\s+/.test(line)) {
        if (!list) box.appendChild(list = h('ul'));
        list.appendChild(h('li', null, inline(line.replace(/^\s*[-*]\s+/, ''))));
        continue;
      }
      list = null;
      if (m) { if (m[1].length > 1) box.appendChild(h(m[1].length === 2 ? 'h3' : 'h4', null, inline(m[2]))); } else if (line.trim()) box.appendChild(h('p', null, inline(line)));
    }
    return box;
  }

  // The part of a changelog above the entry for `version`: what a newer version adds.
  function newEntries(changelog, version) {
    const lines = String(changelog || '').split('\n');
    const at = lines.findIndex((l) => new RegExp(`^##\\s+\\[?${String(version).replace(/\./g, '\\.')}\\b`).test(l));
    return (at > 0 ? lines.slice(0, at) : lines).join('\n');
  }

  const fmtDuration = (sec) => {
    const d = Math.floor(sec / 86400); const hrs = Math.floor((sec % 86400) / 3600); const min = Math.floor((sec % 3600) / 60);
    return d ? `${d}d ${hrs}h` : hrs ? `${hrs}h ${min}m` : `${min}m`;
  };

  async function pageInfo(main) {
    const info = await GET('/api/system/info');
    const row = (label, value) => h('tr', null, h('td', { class: 'muted' }, label), h('td', null, value));
    main.append(h('h1', null, 'Info'),
      h('div', { class: 'grid two' },
        h('div', { class: 'card stack' }, h('h2', null, 'Build'),
          h('table', { class: 'kv' },
            row('Version', h('b', null, info.version || '?')),
            row('Build', info.commit ? `${info.commit.slice(0, 7)} on branch ${info.branch}` : 'Not a git checkout'),
            row('Build date', info.builtAt ? new Date(info.builtAt).toLocaleString() : '—'),
            row('Node.js', info.node),
            row('Running for', fmtDuration(info.uptime)),
            row('Data folder', h('code', null, info.dataDir)))),
        await updateCard()),
      h('div', { class: 'card', style: { marginTop: '16px' } }, h('h2', null, 'Changelog'),
        info.changelog ? markdown(info.changelog) : h('p', { class: 'muted' }, 'No changelog found.')));
  }

  // ---------- system: backups ----------
  const PART_LABELS = { app: 'Application', database: 'Database', media: 'Media' };
  const fmtSetDate = (id) => { const m = /^(\d{4})-(\d{2})-(\d{2})_(\d{2})(\d{2})(\d{2})$/.exec(id); return m ? `${m[3]}-${m[2]}-${m[1]} ${m[4]}:${m[5]}` : id; };

  async function pageBackups(main) {
    const cfg = await GET('/api/backups/config');
    const statusBox = h('div', { class: 'stack' });
    const listBox = h('div');
    const remoteBox = h('div', { class: 'fields' });
    let location = 'local';
    let wasRunning = false;

    // ----- settings -----
    const secrets = {}; // only sent when typed, so saved passwords never leave the server
    function drawRemote() {
      const r = cfg.remote;
      const type = r.type || 'none';
      if (type === 'none') { put(remoteBox, h('p', { class: 'muted wide' }, 'Backups are only kept on this server. Add an external location to keep copies elsewhere.')); return; }
      const secret = (key, has, placeholder, textarea) => {
        const attrs = { placeholder: has ? 'Saved. Type to replace it.' : placeholder, oninput: (e) => { secrets[key] = e.target.value; } };
        return textarea ? h('textarea', { ...attrs, rows: 4 }) : h('input', { ...attrs, type: 'password', autocomplete: 'new-password' });
      };
      put(remoteBox,
        field('Server', bind(r, 'host', () => {}, 'text', { placeholder: 'backup.example.com' })),
        field('Port', bind(r, 'port', () => {}, 'number', { placeholder: type === 'sftp' ? '22' : '21', min: 1, max: 65535 })),
        field('Username', bind(r, 'username', () => {}, 'text')),
        field('Password', secret('password', r.hasPassword, type === 'sftp' ? 'Leave empty when you use a key' : '')),
        type === 'sftp' ? field('Private key (optional)', secret('privateKey', r.hasPrivateKey, '-----BEGIN OPENSSH PRIVATE KEY-----', true), { wide: true, hint: 'Paste a private key to log in with a key instead of a password.' }) : null,
        field('Folder on the server', bind(r, 'path', () => {}, 'text', { placeholder: '/beeldkrant-backups' }), { hint: 'Created when it does not exist. Without a leading / it is relative to the login folder.' }),
        field('Keep external backups', bind(cfg, 'keepRemote', () => {}, 'number', { min: 1, max: 365 }), { hint: 'Older backups there are removed.' }),
        type === 'ftps' ? h('label', { class: 'check wide' }, bind(r, 'allowSelfSigned', () => {}, 'checkbox'), 'Accept a self-signed certificate') : null);
    }
    const remotePayload = () => ({ ...cfg.remote, ...secrets });
    async function save() {
      try {
        Object.assign(cfg, await PUT('/api/backups/config', { ...cfg, remote: remotePayload() }));
        for (const k of Object.keys(secrets)) delete secrets[k];
        drawRemote(); toast('Saved', 'ok'); refresh();
      } catch (err) { fail(err); }
    }
    async function test(btn) {
      btn.disabled = true; btn.textContent = 'Connecting…';
      try {
        const r = await POST('/api/backups/test', { remote: remotePayload() });
        toast(`Connected. ${r.backups} backup file${r.backups === 1 ? '' : 's'} found there.`, 'ok');
      } catch (err) { fail(err); }
      btn.disabled = false; btn.textContent = 'Test connection';
    }

    const days = new Set(cfg.schedule.days || []);
    const dayChips = h('div', { class: 'day-chips' }, DAY_LABELS.map(([d, label]) => h('button', {
      class: `small ${days.has(d) ? 'on' : ''}`,
      onclick: (e) => { days.has(d) ? days.delete(d) : days.add(d); e.target.classList.toggle('on'); cfg.schedule.days = [...days]; },
    }, label)));
    const testBtn = h('button', { onclick: () => test(testBtn) }, 'Test connection');

    // ----- status, backup now -----
    async function refresh() {
      let st;
      try { st = await GET('/api/backups/status'); } catch { return; }
      const lastLine = (kind, label) => {
        const l = st.last && st.last[kind];
        if (!l) return null;
        return h('div', null, h('span', { class: `badge ${l.ok ? 'ok' : 'err'}` }, l.ok ? 'OK' : 'Failed'), ` Last ${label} ${new Date(l.at).toLocaleString()}`, l.ok ? null : h('div', { class: 'hint' }, l.message));
      };
      const next = st.nextRun ? `Next scheduled backup: ${st.nextRun.inDays === 0 ? 'today' : st.nextRun.inDays === 1 ? 'tomorrow' : DAY_LABELS.find(([d]) => d === st.nextRun.day)[1]} at ${st.nextRun.time}` : 'No backups scheduled.';
      put(statusBox,
        h('div', { class: 'row between' },
          h('div', null, st.running ? h('span', { class: 'badge warn' }, `${st.kind === 'restore' ? 'Restoring' : 'Backing up'}: ${st.phase}`) : h('span', { class: 'muted' }, next)),
          h('button', { class: 'primary', disabled: st.running, onclick: async () => { try { await POST('/api/backups/run'); refresh(); } catch (err) { fail(err); } } }, 'Back up now')),
        lastLine('backup', 'backup'),
        lastLine('restore', 'restore'),
        st.log.length ? h('div', { class: 'logs', style: { height: '140px' } }, st.log.join('\n')) : null);
      const log = statusBox.querySelector('.logs');
      if (log) log.scrollTop = log.scrollHeight;
      if (wasRunning && !st.running) loadList();
      wasRunning = st.running;
    }

    // ----- restore -----
    async function loadList() {
      put(listBox, h('p', { class: 'muted' }, 'Loading…'));
      let sets;
      try { sets = await GET(`/api/backups?location=${location}`); } catch (err) { put(listBox, h('div', { class: 'badge err' }, err.message)); return; }
      if (!sets.length) { put(listBox, h('p', { class: 'muted' }, location === 'remote' ? 'No backups found on the external location.' : 'No backups on this server yet.')); return; }
      put(listBox, h('table', { class: 'list' },
        h('thead', null, h('tr', null, h('th', null, 'Date'), h('th', null, 'Contains'), h('th', null, 'Size'), h('th'))),
        h('tbody', null, sets.map((set) => h('tr', null,
          h('td', null, fmtSetDate(set.id)),
          h('td', null, set.parts.map((p) => h('span', { class: 'badge', style: { marginRight: '4px' } }, PART_LABELS[p]))),
          h('td', null, fmtBytes(set.size)),
          h('td', { style: { textAlign: 'right', whiteSpace: 'nowrap' } },
            h('button', { class: 'small', onclick: () => restoreDialog(set) }, 'Restore…'),
            location === 'local' ? set.files.map((f) => h('a', { class: 'btn small', style: { marginLeft: '4px' }, href: `/api/backups/download/${encodeURIComponent(f.name)}`, title: f.name }, set.files.length > 1 ? `↓ ${f.parts.map((p) => PART_LABELS[p]).join(', ')}` : '↓ Download')) : null,
            h('button', { class: 'small ghost', onclick: async () => {
              if (!(await confirmBox(`Delete the backup of ${fmtSetDate(set.id)}${location === 'remote' ? ' from the external location' : ''}?`))) return;
              try { await DEL(`/api/backups/${set.id}?location=${location}`); loadList(); } catch (err) { fail(err); }
            } }, 'Delete')))))));
    }

    function restoreDialog(set) {
      const chosen = Object.fromEntries(set.parts.map((p) => [p, p !== 'app']));
      const warn = {
        database: 'Replaces all playouts, scenes, schedule, feeds, users and settings.',
        media: 'Replaces all media files and folders on disk.',
        app: 'Puts back the program code of that backup and restarts Beeldkrant.',
      };
      modal(`Restore backup of ${fmtSetDate(set.id)}`, h('div', { class: 'stack' },
        h('p', { class: 'muted' }, `From ${location === 'remote' ? 'the external location' : 'this server'}. Choose what to put back:`),
        set.parts.map((p) => h('label', { class: 'check' }, bind(chosen, p, () => {}, 'checkbox'), h('span', null, h('b', null, PART_LABELS[p]), h('div', { class: 'hint' }, warn[p])))),
        h('p', { class: 'hint' }, 'Tip: make a fresh backup first, so you can go back.')),
      (close) => [h('button', { onclick: close }, 'Cancel'), h('button', { class: 'danger', onclick: async () => {
        const parts = Object.keys(chosen).filter((p) => chosen[p]);
        if (!parts.length) { toast('Choose what to restore', 'err'); return; }
        try { await POST('/api/backups/restore', { location, id: set.id, parts }); close(); toast('Restore started', 'ok'); refresh(); } catch (err) { fail(err); }
      } }, 'Restore')]);
    }

    const tabs = h('div', { class: 'tabs' }, [['local', 'On this server'], ['remote', 'External location']].map(([id, label]) => h('button', {
      class: id === location ? 'active' : '',
      onclick: (e) => { location = id; tabs.querySelectorAll('button').forEach((b) => b.classList.toggle('active', b === e.target)); loadList(); },
    }, label)));

    main.append(h('h1', null, 'Backups'),
      h('div', { class: 'card', style: { marginBottom: '16px' } }, statusBox),
      h('div', { class: 'grid two' },
        h('div', { class: 'card stack' }, h('h2', null, 'What to back up'),
          ['app', 'database', 'media'].map((p) => h('label', { class: 'check' }, bind(cfg.parts, p, () => {}, 'checkbox'), h('span', null, h('b', null, PART_LABELS[p]), h('div', { class: 'hint' }, {
            app: 'The program code and its settings, without installed packages.',
            database: 'Playouts, scenes, schedule, feeds, media list and folders, users and settings.',
            media: 'All uploaded files in all media folders.',
          }[p])))),
          field('Archives', bind(cfg, 'layout', () => {}, 'select', { options: [['single', 'One archive with everything'], ['separate', 'A separate archive per part']] }), { hint: 'Separate archives keep the large media apart from the application and database.' }),
          field('Keep backups on this server', bind(cfg, 'keepLocal', () => {}, 'number', { min: 0, max: 365 }), { hint: 'Older backups are removed. 0 keeps none here once they are copied to the external location.' })),
        h('div', { class: 'card stack' }, h('h2', null, 'Schedule'),
          h('label', { class: 'check' }, bind(cfg.schedule, 'enabled', () => {}, 'checkbox'), 'Make backups automatically'),
          field('Days', dayChips),
          field('Time', bind(cfg.schedule, 'time', () => {}, 'time'), { hint: 'In the time zone set under Settings.' }))),
      h('div', { class: 'card stack', style: { marginTop: '16px' } }, h('h2', null, 'External location'),
        field('Type', bind(cfg.remote, 'type', drawRemote, 'select', { options: [['none', 'None'], ['ftp', 'FTP'], ['ftps', 'FTPS (FTP over TLS)'], ['sftp', 'SCP / SFTP (SSH)']] })),
        remoteBox,
        h('div', { class: 'row' }, h('button', { class: 'primary', onclick: save }, 'Save backup settings'), testBtn)),
      h('div', { class: 'card stack', style: { marginTop: '16px' } }, h('h2', null, 'Restore'), tabs, listBox));
    drawRemote();
    refresh();
    loadList();
    const iv = setInterval(refresh, 2000);
    cleanup = () => clearInterval(iv);
  }

  route();
})();
