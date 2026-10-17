/* Beeldkrant admin panel (no build step, plain DOM). */
(() => {
  'use strict';

  const app = document.getElementById('app');
  // The path the app is served under: '' at the root, e.g. /channel1 behind a station proxy (see render.js).
  const BASE = window.Beeldkrant.base;
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
    const res = await fetch(BASE + url, opts);
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

  // ---------- uploads ----------
  // One upload per file, a few at a time, listed in a panel that stays open while you move around
  // the admin panel: progress, speed and time left per file, with cancel and retry.
  const UPLOAD_PARALLEL = 3;
  const UPLOAD_TYPES = /\.(jpe?g|png|gif|webp|svg|bmp|mp4|m4v|webm|mov|mkv|mp3|m4a|aac|ogg|oga|opus|wav|flac)$/i;
  const uploads = { items: [], panel: null, list: null, title: null, collapsed: false, listeners: new Set() };
  const fmtLeft = (s) => (!isFinite(s) ? '' : s >= 3600 ? `${Math.floor(s / 3600)} h ${Math.round((s % 3600) / 60)} min left` : s >= 60 ? `${Math.floor(s / 60)} min ${Math.round(s % 60)} s left` : `${Math.max(1, Math.round(s))} s left`);

  function queueUploads(files, query, folderName) {
    for (const file of files) {
      const ok = UPLOAD_TYPES.test(file.name) || /^(image|video|audio)\//.test(file.type);
      uploads.items.push({ id: uid(), file, query: String(query), folderName, state: ok ? 'queued' : 'failed', loaded: 0, speed: 0, error: ok ? null : 'Not a supported file type' });
    }
    uploads.collapsed = false;
    pumpUploads();
  }
  function pumpUploads() {
    while (uploads.items.filter((u) => u.state === 'uploading' || u.state === 'processing').length < UPLOAD_PARALLEL) {
      const next = uploads.items.find((u) => u.state === 'queued');
      if (!next) break;
      sendUpload(next);
    }
    drawUploads();
  }
  function sendUpload(u) {
    const fd = new FormData();
    fd.append('files', u.file);
    const xhr = new XMLHttpRequest();
    u.xhr = xhr;
    u.state = 'uploading';
    u.loaded = 0;
    u.error = null;
    u.started = performance.now();
    u.samples = [[u.started, 0]];
    xhr.open('POST', `${BASE}/api/media?${u.query}`);
    xhr.upload.onprogress = (e) => {
      const now = performance.now();
      u.loaded = e.loaded;
      u.samples.push([now, e.loaded]);
      while (u.samples.length > 2 && now - u.samples[0][0] > 3000) u.samples.shift(); // speed over the last few seconds
      const [t0, b0] = u.samples[0];
      if (now > t0) u.speed = ((e.loaded - b0) / (now - t0)) * 1000;
      drawUploads();
    };
    xhr.upload.onload = () => { u.loaded = u.file.size; u.state = 'processing'; drawUploads(); };
    xhr.onload = () => {
      u.xhr = null;
      if (xhr.status >= 200 && xhr.status < 300) {
        u.state = 'done';
        u.took = (performance.now() - u.started) / 1000;
        uploads.listeners.forEach((fn) => fn());
      } else {
        u.state = 'failed';
        u.error = 'Upload failed';
        try { u.error = JSON.parse(xhr.responseText).error || u.error; } catch { /* keep */ }
        if (xhr.status === 413) u.error = 'File too large';
      }
      pumpUploads();
    };
    xhr.onerror = () => { u.xhr = null; u.state = 'failed'; u.error = 'Connection lost'; pumpUploads(); };
    xhr.onabort = () => { u.xhr = null; u.state = 'cancelled'; pumpUploads(); };
    xhr.send(fd);
  }
  function cancelUpload(u) {
    if (u.xhr) u.xhr.abort(); else if (u.state === 'queued') { u.state = 'cancelled'; pumpUploads(); }
  }
  function drawUploads() {
    if (!uploads.items.length) { if (uploads.panel) { uploads.panel.remove(); uploads.panel = null; } return; }
    if (!uploads.panel) {
      uploads.title = h('div', { class: 'upload-title' });
      uploads.total = h('div', { class: 'progress' }, h('div'));
      uploads.list = h('div', { class: 'upload-list' });
      uploads.toggle = h('button', { class: 'icon-btn', title: 'Collapse', onclick: () => { uploads.collapsed = !uploads.collapsed; drawUploads(); } });
      uploads.panel = h('div', { class: 'upload-panel' },
        h('div', { class: 'upload-head' }, uploads.title,
          h('button', { class: 'small ghost', onclick: () => { uploads.items = uploads.items.filter((u) => !['done', 'failed', 'cancelled'].includes(u.state)); drawUploads(); } }, 'Clear finished'),
          uploads.toggle),
        uploads.total, uploads.list);
      document.body.appendChild(uploads.panel);
    }
    const items = uploads.items;
    const active = items.filter((u) => ['queued', 'uploading', 'processing'].includes(u.state));
    const done = items.filter((u) => u.state === 'done').length;
    const failed = items.filter((u) => u.state === 'failed').length;
    const totalSize = active.reduce((s, u) => s + u.file.size, 0);
    const totalLoaded = active.reduce((s, u) => s + u.loaded, 0);
    const speed = items.filter((u) => u.state === 'uploading').reduce((s, u) => s + u.speed, 0);
    put(uploads.title, h('b', null, active.length ? `Uploading ${active.length} of ${items.length} file${items.length === 1 ? '' : 's'}` : 'Uploads finished'),
      h('small', null, active.length
        ? [`${fmtBytes(totalLoaded)} of ${fmtBytes(totalSize)}`, speed ? `${fmtBytes(speed)}/s` : '', speed ? fmtLeft((totalSize - totalLoaded) / speed) : ''].filter(Boolean).join(' · ')
        : `${done} uploaded${failed ? ` · ${failed} failed` : ''}`));
    uploads.total.style.display = active.length ? '' : 'none';
    uploads.total.firstChild.style.width = `${totalSize ? (totalLoaded / totalSize) * 100 : 100}%`;
    uploads.panel.classList.toggle('collapsed', uploads.collapsed);
    put(uploads.toggle, icon(uploads.collapsed ? 'up' : 'down'));
    put(uploads.list, ...items.map((u) => {
      const pct = u.file.size ? Math.min(100, (u.loaded / u.file.size) * 100) : 100;
      let status;
      if (u.state === 'queued') status = `Waiting · ${fmtBytes(u.file.size)}`;
      else if (u.state === 'uploading') status = `${fmtBytes(u.loaded)} of ${fmtBytes(u.file.size)} · ${u.speed ? `${fmtBytes(u.speed)}/s · ${fmtLeft((u.file.size - u.loaded) / u.speed)}` : 'starting…'}`;
      else if (u.state === 'processing') status = 'Processing on the server…';
      else if (u.state === 'done') status = `Done · ${fmtBytes(u.file.size)} in ${u.took < 1 ? '<1' : Math.round(u.took)} s · ${u.folderName}`;
      else if (u.state === 'failed') status = u.error;
      else status = 'Cancelled';
      return h('div', { class: `upload-item ${u.state}` },
        h('div', { class: 'row between' },
          h('span', { class: 'upload-name', title: u.file.name }, u.file.name),
          h('span', { class: 'upload-pct' }, u.state === 'uploading' ? `${Math.floor(pct)}%` : '')),
        h('div', { class: 'progress' }, h('div', { style: { width: `${['done', 'processing'].includes(u.state) ? 100 : pct}%` } })),
        h('div', { class: 'row between' },
          h('small', { class: 'upload-status' }, status),
          u.state === 'failed' || u.state === 'cancelled' ? h('button', { class: 'small ghost', onclick: () => { u.state = 'queued'; pumpUploads(); } }, 'Retry')
            : ['queued', 'uploading'].includes(u.state) ? h('button', { class: 'small ghost', onclick: () => cancelUpload(u) }, 'Cancel') : null));
    }));
  }
  window.addEventListener('beforeunload', (e) => { if (uploads.items.some((u) => ['queued', 'uploading', 'processing'].includes(u.state))) e.preventDefault(); });

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

  function modal(title, body, actions, opts = {}) {
    const back = h('div', { class: 'modal-back', onclick: (e) => { if (e.target === back) close(); } });
    const close = () => { back.remove(); if (opts.onClose) opts.onClose(); };
    back.appendChild(h('div', { class: `modal ${opts.wide ? 'wide' : ''}` }, h('h2', null, title), body, h('div', { class: 'row', style: { justifyContent: 'flex-end', marginTop: '16px' } }, actions(close))));
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
      ['cameras', 'IP cameras'],
    ], { dropdown: true }],
    '-',
    ['schedule', 'Schedule'],
    '-',
    ['output', 'Outputs', [['routing', 'Routing']]],
    '-',
    ['settings', 'Settings', [['settings', 'Application'], ['users', 'Users and roles', [['sso', 'Configure SSO']], { admin: true }], ['security', 'Security', null, { admin: true }], ['backups', 'Backups', null, { perm: 'backups' }]]],
  ];
  let cleanup = null;

  const menuHashes = (item) => [item[0], ...(item[2] || []).flatMap(menuHashes)];

  function renderMenu(current) {
    const isAdmin = me.user.role === 'admin';
    const link = ([hash, label, children, opts = {}], depth) => {
      if (opts.admin && !isAdmin) return null;
      if (opts.perm && !can(opts.perm)) return null;
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
        h('a', { href: '#account', class: `who ${page === 'account' ? 'active' : ''}`, title: 'Your account' }, `${me.user.displayName || me.user.username} (${ROLE_LABELS[me.user.role] || me.user.role})`),
        h('a', { href: '#', onclick: async (e) => { e.preventDefault(); await POST('/api/logout'); me = null; route(); } }, 'Log out'),
      ),
      main));
    if (me.user.role === 'admin' && page !== 'info') updateBanner(main);
    if (me.user.role === 'readonly') main.append(h('div', { class: 'ro-banner' }, icon('eye'), 'Read only: you can look at everything, but not change anything.'));
    const pages = {
      dashboard: pageDashboard, stats: pageStats, playouts: pagePlayouts, library: pageLibrary, media: pageMedia, feeds: pageFeeds, streams: pageStreams, cameras: pageCameras,
      schedule: pageSchedule, output: pageOutput, routing: pageRouting, settings: pageSettings, backups: pageBackups, info: pageInfo, account: pageAccount,
      users: pageUsers, sso: pageSso, security: pageSecurity,
    };
    try { await (pages[page] || pageDashboard)(main, arg); } catch (err) { fail(err); }
  }
  window.addEventListener('hashchange', () => { if (!editorGuard()) route(); });

  // ---------- login ----------
  const ROLE_LABELS = { admin: 'Admin', user: 'User', readonly: 'Read only' };
  const can = (perm) => !!me && !!me.user && (me.user.role === 'admin' || !!(me.user.permissions || {})[perm]);
  const MS_LOGO = '<svg viewBox="0 0 21 21" width="18" height="18" aria-hidden="true"><rect x="1" y="1" width="9" height="9" fill="#f25022"/><rect x="11" y="1" width="9" height="9" fill="#7fba00"/><rect x="1" y="11" width="9" height="9" fill="#00a4ef"/><rect x="11" y="11" width="9" height="9" fill="#ffb900"/></svg>';
  const msLogo = () => { const s = document.createElement('span'); s.className = 'ms-logo'; s.innerHTML = MS_LOGO; return s; };
  const loggedIn = (res) => { applyTheme(res.user.theme); me = { ...me, user: res.user }; route(); };

  async function renderLogin() {
    const opts = await GET('/api/auth/options').catch(() => ({}));
    const params = new URLSearchParams(location.search);
    const ssoError = params.get('sso_error');
    if (ssoError) history.replaceState(null, '', location.pathname + location.hash);
    const user = h('input', { value: '', autocomplete: 'username', placeholder: 'admin' });
    const pass = h('input', { type: 'password', autocomplete: 'current-password' });
    const submit = async (e) => {
      e.preventDefault();
      try {
        const res = await POST('/api/login', { username: user.value || 'admin', password: pass.value });
        if (res.mfa) renderMfa(res); else loggedIn(res);
      } catch (err) { fail(err); }
    };
    put(app, h('div', { class: 'login' }, h('form', { class: 'card stack', onsubmit: submit },
      brand(),
      ssoError ? h('div', { class: 'cam-result err' }, h('b', null, 'Microsoft sign-in failed'), h('span', null, ssoError)) : null,
      opts.sso ? h('a', { class: 'btn ms-btn', href: `${BASE}/api/sso/start` }, msLogo(), opts.sso.label) : null,
      opts.sso ? h('div', { class: 'login-or' }, h('span', null, 'or with a password')) : null,
      field('Username', user), field('Password', pass),
      h('button', { class: 'primary', type: 'submit' }, 'Log in'),
      h('div', { class: 'hint' }, 'First login: use the one-time password shown at the end of the installation.'),
    )));
    (opts.sso ? user : pass).focus();
  }

  // The second login step: a code from the authenticator app, or setting the app up.
  function renderMfa(step) {
    const code = h('input', { inputmode: 'numeric', autocomplete: 'one-time-code', placeholder: '123 456', class: 'code-input', maxlength: 11 });
    const submit = async (e) => {
      e.preventDefault();
      try {
        const res = await POST('/api/login/mfa', { ticket: step.ticket, code: code.value });
        if (res.recoveryCodes) showRecoveryCodes(res.recoveryCodes, () => loggedIn(res)); else loggedIn(res);
      } catch (err) { fail(err); code.select(); }
    };
    const back = h('a', { href: '#', onclick: (e) => { e.preventDefault(); renderLogin(); } }, 'Back to login');
    const form = step.mfa === 'setup'
      ? h('form', { class: 'card stack mfa-card', onsubmit: submit },
        brand(),
        h('h2', null, 'Set up two-step verification'),
        h('p', { class: 'muted' }, 'Your account needs a code from an authenticator app at every login.'),
        mfaSetupSteps(step.secret, step.otpauth, code),
        h('div', { class: 'login-actions' }, h('button', { class: 'primary', type: 'submit' }, 'Turn on and log in'), back))
      : h('form', { class: 'card stack', onsubmit: submit },
        brand(),
        h('h2', null, 'Two-step verification'),
        h('p', { class: 'muted' }, 'Enter the 6-digit code from your authenticator app.'),
        field('Code', code, { hint: 'Lost your phone? Enter one of your recovery codes instead.' }),
        h('div', { class: 'login-actions' }, h('button', { class: 'primary', type: 'submit' }, 'Verify'), back));
    put(app, h('div', { class: 'login' }, form));
    code.focus();
  }

  // QR code, key and code field for linking an authenticator app.
  function mfaSetupSteps(secret, otpauth, codeInput) {
    return h('ol', { class: 'mfa-steps' },
      h('li', null, h('b', null, 'Install an authenticator app'), h('div', { class: 'hint' }, 'Such as Microsoft Authenticator, Google Authenticator, 1Password or Authy.')),
      h('li', null, h('b', null, 'Scan this QR code with the app'),
        h('div', { class: 'mfa-qr' }, h('img', { src: `${BASE}/api/qr?text=${encodeURIComponent(otpauth)}`, alt: 'QR code for the authenticator app' }),
          h('div', { class: 'hint' }, 'Or enter this key by hand:', h('code', { class: 'mfa-key' }, secret.replace(/(.{4})/g, '$1 ').trim())))),
      h('li', null, h('b', null, 'Enter the 6-digit code the app shows'), codeInput));
  }

  function showRecoveryCodes(codes, onDone) {
    const text = codes.join('\n');
    const body = h('div', { class: 'stack' },
      h('p', null, 'Two-step verification is on. Keep these recovery codes somewhere safe: each one logs you in once if you lose your phone. They are shown only now.'),
      h('div', { class: 'recovery-codes' }, codes.map((c) => h('code', null, c))),
      h('div', { class: 'row' },
        h('button', { type: 'button', onclick: () => navigator.clipboard.writeText(text).then(() => toast('Copied', 'ok'), () => toast('Copy did not work; select the codes instead', 'err')) }, icon('copy'), 'Copy'),
        h('button', { type: 'button', onclick: () => { const a = h('a', { href: URL.createObjectURL(new Blob([`${text}\n`], { type: 'text/plain' })), download: 'beeldkrant-recovery-codes.txt' }); a.click(); } }, 'Download')));
    if (me && me.user && !me.user.mustChangePassword && document.querySelector('.shell')) {
      modal('Your recovery codes', body, (close) => [h('button', { class: 'primary', onclick: () => { close(); onDone(); } }, 'I have saved them')]);
    } else {
      put(app, h('div', { class: 'login' }, h('div', { class: 'card stack mfa-card' }, brand(), h('h2', null, 'Save your recovery codes'), body,
        h('button', { class: 'primary', onclick: onDone }, 'I have saved them, continue'))));
    }
  }

  function renderChangePassword(forced) {
    const cur = h('input', { type: 'password', autocomplete: 'current-password' });
    const p1 = h('input', { type: 'password', autocomplete: 'new-password' });
    const p2 = h('input', { type: 'password', autocomplete: 'new-password' });
    const pol = (me && me.passwordPolicy) || { minLength: 8 };
    const rules = [`at least ${pol.minLength} characters`, pol.requireSpecial ? 'a special character' : null, pol.requireMixed ? 'upper and lower case letters and a number' : null].filter(Boolean).join(', ');
    const submit = async (e) => {
      e.preventDefault();
      if (p1.value !== p2.value) return toast('The new passwords do not match', 'err');
      try {
        await POST('/api/password', { current: cur.value, password: p1.value });
        me.user.mustChangePassword = false;
        me.user.passwordExpired = false;
        toast('Password changed', 'ok');
        if (forced) route();
        else { cur.value = p1.value = p2.value = ''; }
      } catch (err) { fail(err); }
    };
    const expired = me && me.user && me.user.passwordExpired;
    const form = h('form', { class: 'card stack', onsubmit: submit },
      forced ? brand() : null,
      forced ? h('p', null, expired ? 'Your password has expired. Choose a new password to continue.' : 'You are using a one-time password. Choose your own password to continue.') : null,
      field(forced && !expired ? 'One-time password' : 'Current password', cur), field('New password', p1, { hint: `Use ${rules}.` }), field('Repeat new password', p2),
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
        h('div', { class: 'card' }, h('div', { class: 'row between' }, h('h2', null, 'Live preview'), h('a', { href: `${BASE}/player/`, target: '_blank' }, 'Open full screen')),
          h('iframe', { class: 'preview-frame', src: `${BASE}/player/` })),
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
            h('a', { class: 'btn', href: `${BASE}/player/?playout=${p.id}`, target: '_blank' }, 'Preview'), ' ',
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
  // Line icons (24x24, drawn with currentColor) for the editor.
  const ICONS = {
    text: 'M4 7V5h16v2M9 19h6M12 5v14',
    image: '<rect x="3" y="3" width="18" height="18" rx="2"/><circle cx="9" cy="9" r="2"/><path d="m21 15-5-5L5 21"/>',
    video: '<rect x="2" y="6" width="14" height="12" rx="2"/><path d="m22 8-6 4 6 4V8z"/>',
    slideshow: '<rect x="7" y="3" width="14" height="14" rx="2"/><path d="M3 7v12a2 2 0 0 0 2 2h12"/><path d="m21 13-4-4-7 7"/>',
    playlist: '<rect x="2" y="4" width="20" height="16" rx="2"/><path d="M7 4v16M17 4v16M2 9h5M2 15h5M17 9h5M17 15h5"/>',
    rss: '<path d="M4 11a9 9 0 0 1 9 9M4 4a16 16 0 0 1 16 16"/><circle cx="5" cy="19" r="1"/>',
    ticker: '<rect x="2" y="8" width="20" height="8" rx="2"/><path d="M6 12h8M17 12h1"/>',
    clock: '<circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 2"/>',
    weather: '<path d="M12 3v2M5.6 5.6l1.4 1.4M3 12h2M18.4 5.6 17 7"/><path d="M8.5 11a3.5 3.5 0 0 1 6.8-1"/><path d="M17 20H8a3.5 3.5 0 1 1 .9-6.9A5 5 0 0 1 18 14a3 3 0 0 1-1 6z"/>',
    camera: '<path d="M3 7h3l2-3h8l2 3h3v13H3z"/><circle cx="12" cy="13" r="4"/>',
    webpage: '<circle cx="12" cy="12" r="9"/><path d="M3 12h18M12 3a14 14 0 0 1 0 18M12 3a14 14 0 0 0 0 18"/>',
    box: '<rect x="4" y="4" width="16" height="16" rx="3"/>',
    plus: 'M12 5v14M5 12h14',
    trash: '<path d="M3 6h18M8 6V4h8v2M6 6l1 14h10l1-14"/>',
    copy: '<rect x="9" y="9" width="12" height="12" rx="2"/><path d="M5 15V5a2 2 0 0 1 2-2h10"/>',
    eye: '<path d="M2 12s4-7 10-7 10 7 10 7-4 7-10 7S2 12 2 12z"/><circle cx="12" cy="12" r="3"/>',
    eyeOff: '<path d="M3 3l18 18M10.6 5.1A10 10 0 0 1 12 5c6 0 10 7 10 7a17 17 0 0 1-3.2 3.9M6.6 6.6A17 17 0 0 0 2 12s4 7 10 7a9.7 9.7 0 0 0 4.4-1"/>',
    lock: '<rect x="5" y="11" width="14" height="10" rx="2"/><path d="M8 11V7a4 4 0 0 1 8 0v4"/>',
    unlock: '<rect x="5" y="11" width="14" height="10" rx="2"/><path d="M8 11V7a4 4 0 0 1 7.5-2"/>',
    up: 'm18 15-6-6-6 6',
    down: 'm6 9 6 6 6-6',
    back: 'M19 12H5M12 19l-7-7 7-7',
    play: '<path d="M7 4v16l13-8z"/>',
    save: '<path d="M5 3h11l3 3v15H5z"/><path d="M8 3v5h8M8 21v-7h8v7"/>',
    scenes: '<rect x="3" y="4" width="18" height="12" rx="2"/><path d="M7 20h10"/>',
    layers: '<path d="m12 3 9 5-9 5-9-5 9-5z"/><path d="m3 13 9 5 9-5"/>',
    settings: '<path d="M4 6h10M18 6h2M4 12h4M12 12h8M4 18h12"/><circle cx="16" cy="6" r="2"/><circle cx="10" cy="12" r="2"/><circle cx="18" cy="18" r="2"/>',
    grip: '<circle cx="9" cy="6" r="1"/><circle cx="15" cy="6" r="1"/><circle cx="9" cy="12" r="1"/><circle cx="15" cy="12" r="1"/><circle cx="9" cy="18" r="1"/><circle cx="15" cy="18" r="1"/>',
    shuffle: '<path d="M16 3h5v5M4 20 21 3M21 16v5h-5M15 15l6 6M4 4l5 5"/>',
    list: 'M8 6h13M8 12h13M8 18h13M3 6h.01M3 12h.01M3 18h.01',
    close: 'M18 6 6 18M6 6l12 12',
    maximize: '<path d="M8 3H3v5M16 3h5v5M8 21H3v-5M16 21h5v-5"/>',
    center: '<circle cx="12" cy="12" r="3"/><path d="M12 2v4M12 18v4M2 12h4M18 12h4"/>',
  };
  function icon(name) {
    const p = ICONS[name] || '';
    const span = document.createElement('span');
    span.className = 'ic';
    span.innerHTML = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${p.startsWith('<') ? p : `<path d="${p}"/>`}</svg>`;
    return span;
  }

  const ELEMENT_TYPES = {
    text: { label: 'Text', w: 800, h: 160, defaults: { text: 'New text', fontSize: 64, fontWeight: 700, color: '#ffffff', align: 'left', valign: 'middle' } },
    image: { label: 'Image', w: 640, h: 360, defaults: { fit: 'cover' } },
    video: { label: 'Video', w: 960, h: 540, defaults: { fit: 'cover', audio: true } },
    slideshow: { label: 'Photo carousel', w: 960, h: 540, defaults: { items: [], order: 'fixed', interval: 5, transition: 'fade', transitionMs: 800, fit: 'cover' } },
    playlist: { label: 'Video carousel', w: 960, h: 540, defaults: { items: [], order: 'fixed', fit: 'cover', audio: true } },
    rss: { label: 'RSS feed', w: 1600, h: 860, defaults: { feedId: null, layout: 'list', perPage: 4, columns: 3, interval: 8, fontSize: 40, color: '#ffffff', cardBackground: 'rgba(0,0,0,0.45)', gap: 20, showImage: true, showDescription: true } },
    ticker: { label: 'Ticker', w: 1920, h: 80, defaults: { source: 'text', text: 'Breaking news\nMore headlines here', fontSize: 40, speed: 150, background: '#c8102e', color: '#ffffff', label: 'News' } },
    clock: { label: 'Clock', w: 300, h: 110, defaults: { mode: 'time', fontSize: 72, color: '#ffffff' } },
    weather: { label: 'Weather', w: 520, h: 360, defaults: { lat: 52.37, lon: 4.9, label: 'Amsterdam', fontSize: 56, color: '#ffffff' } },
    camera: { label: 'IP camera', w: 960, h: 540, defaults: { cameraId: null, fit: 'cover' } },
    webpage: { label: 'Web page', w: 1280, h: 720, defaults: { url: 'https://', zoom: 100 } },
    box: { label: 'Box', w: 600, h: 300, defaults: { background: 'rgba(0,0,0,0.5)', radius: 16 } },
  };
  // How the "Add" toolbar of the editor groups the element types.
  const TOOL_GROUPS = [['Text and info', ['text', 'ticker', 'clock', 'weather', 'rss']], ['Media', ['image', 'video', 'slideshow', 'playlist', 'camera']], ['Other', ['box', 'webpage']]];
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
    let cams = [];
    let allPlayouts;
    let region;
    let folders;
    try {
      [playout, media, feeds, allPlayouts, region, folders] = await Promise.all([GET(`/api/playouts/${id}`), GET('/api/media'), GET('/api/feeds'), GET('/api/playouts'), GET('/api/settings'), GET('/api/folders'), GET('/api/cameras').then((c) => { cams = c; })]);
    } catch (err) { fail(err); location.hash = 'playouts'; return; }
    playout.slides = playout.slides || [];
    playout.overlays = playout.overlays || [];
    playout.adBlocks = playout.adBlocks || [];
    playout.music = playout.music || { mediaId: null, volume: 60, duck: 15 };
    const mediaById = Object.fromEntries(media.map((m) => [m.id, m]));
    const feedOptions = [['', '— choose a feed —'], ...feeds.map((f) => [f.id, f.name])];

    const S = { slideIndex: playout.slides.length ? 0 : -1, mode: 'slide', selected: null };
    const saveBtn = h('button', { class: 'primary', title: 'Save (Ctrl+S)', onclick: save }, icon('save'), 'Save');
    const unsaved = h('span', { class: 'unsaved', style: { display: 'none' } }, 'Unsaved changes');
    const setDirty = (on) => { editorDirty = on; unsaved.style.display = on ? '' : 'none'; };
    const markDirty = () => setDirty(true);

    const sideEl = h('div', { class: 'side' });
    const propsEl = h('div', { class: 'props' });
    const area = h('div', { class: 'canvas-area' });
    const stage = h('div', { class: 'canvas-stage' });
    area.appendChild(stage);
    const toolbar = h('div', { class: 'toolbar' },
      TOOL_GROUPS.map(([group, types]) => h('div', { class: 'tool-group' },
        h('span', { class: 'tool-group-label' }, group),
        h('div', { class: 'tool-row' }, types.map((type) => h('button', { class: 'tool-tile', title: `Add ${ELEMENT_TYPES[type].label.toLowerCase()}`, onclick: () => addElement(type) },
          icon(type), h('span', null, ELEMENT_TYPES[type].label)))))));
    const tab = (id, mode, ic, label) => h('button', { id, onclick: () => { S.mode = mode; S.selected = null; renderAll(); } }, icon(ic), label);

    put(app, h('div', { class: 'editor' },
      h('div', { class: 'topbar' },
        h('a', { href: '#playouts', class: 'btn ghost', title: 'Back to the playouts' }, icon('back'), 'Playouts'),
        h('div', { class: 'ed-title' }, h('span', { class: 'title' }, playout.name), h('span', { class: 'chip' }, `${playout.width} × ${playout.height}`)),
        h('div', { class: 'seg' },
          tab('tab-slide', 'slide', 'scenes', 'Scenes'),
          tab('tab-overlay', 'overlay', 'layers', 'Overlays'),
          tab('tab-settings', 'settings', 'settings', 'Playout settings')),
        h('div', { class: 'grow' }),
        unsaved,
        h('a', { class: 'btn', href: `${BASE}/player/?playout=${playout.id}`, target: '_blank', title: 'Open the playout full screen in a new tab' }, icon('play'), 'Preview'),
        h('button', { title: 'Make a full copy of this playout', onclick: async () => {
          if (editorDirty) await save();
          if (!editorDirty) cloneDialog(playout, (c) => { location.hash = `playout/${c.id}`; });
        } }, icon('copy'), 'Clone'),
        saveBtn),
      sideEl,
      h('div', { class: 'canvas-wrap' }, toolbar, area),
      propsEl));

    async function save() {
      try {
        await PUT(`/api/playouts/${playout.id}`, playout);
        setDirty(false);
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
      document.getElementById('tab-settings').classList.toggle('active', S.mode === 'settings');
      toolbar.style.display = S.mode === 'settings' || (S.mode === 'slide' && !slide()) ? 'none' : '';
      renderSide();
      renderProps();
      drawCanvas();
    }

    // ----- left column: slides and layers -----
    function renderSide() {
      const parts = [];
      thumbHides.forEach((x) => x.hide());
      thumbHides = [];
      if (S.mode !== 'overlay') {
        parts.push(h('div', { class: 'side-head' }, h('h3', null, `Scenes (${playout.slides.length})`)),
          h('div', { class: 'side-actions' },
            h('button', { class: 'primary small', onclick: addSlide, title: 'Add an empty scene' }, icon('plus'), 'New scene'),
            h('button', { class: 'small', onclick: slidesFromMedia, title: 'Create one full-screen scene per image or video' }, icon('image'), 'From media')));
        let dragFrom = null;
        parts.push(h('div', { class: 'slide-list' }, playout.slides.map((sl, i) => {
          const desc = [sl.feedId ? 'RSS' : null, sl.advance === 'video' ? 'until media ends' : `${sl.duration || 10}s`, sl.window ? 'scheduled' : null].filter(Boolean).join(' · ');
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
          sceneThumb(sl, i + 1),
          h('div', { class: 'info' }, h('div', { class: 'n' }, sl.name || `Scene ${i + 1}`), h('div', { class: 'd' }, desc)),
          h('label', { class: 'switch small', title: sl.enabled !== false ? 'On: plays in the playout. Click to skip it.' : 'Off: skipped. Click to play it.', onclick: (e) => e.stopPropagation() },
            h('input', { type: 'checkbox', checked: sl.enabled !== false, onchange: (e) => { sl.enabled = e.target.checked; markDirty(); renderSide(); } }), h('span')));
          return item;
        })));
        if (!playout.slides.length) parts.push(h('p', { class: 'muted' }, 'No scenes yet. Add a scene to start building.'));
      } else {
        parts.push(h('p', { class: 'muted' }, 'Overlays stay on screen above every scene: a ticker, a clock, a logo. A scene can hide them.'));
      }
      const els = elements();
      if (els && S.mode !== 'settings') {
        parts.push(h('div', { class: 'side-head' }, h('h3', null, `Layers (${els.length})`)));
        const toggle = (e, key, on, offIcon, onIcon, title) => h('button', { class: `icon-btn ${on ? '' : 'off'}`, title, onclick: (ev) => { ev.stopPropagation(); e[key] = key === 'enabled' ? !on : on; markDirty(); renderSide(); drawCanvas(); } }, icon(on ? onIcon : offIcon));
        parts.push(h('div', { class: 'layer-list' }, [...els].sort((a, b) => (b.z || 0) - (a.z || 0)).map((e) => h('div', {
          class: `layer-item ${S.selected === e.id ? 'active' : ''} ${e.enabled === false ? 'hidden' : ''}`,
          onclick: () => { S.selected = e.id; renderAll(); },
        }, icon(ELEMENT_TYPES[e.type] ? e.type : 'box'), h('span', { class: 'ln' }, layerName(e)),
          toggle(e, 'enabled', e.enabled !== false, 'eyeOff', 'eye', e.enabled !== false ? 'Visible. Click to hide it on air.' : 'Hidden on air. Click to show it.'),
          toggle(e, 'locked', !e.locked, 'lock', 'unlock', e.locked ? 'Locked. Click to unlock.' : 'Click to lock it in place.')))));
        if (!els.length) parts.push(h('p', { class: 'muted' }, 'Add text, media, a ticker and more with the buttons above the canvas.'));
      }
      put(sideEl, ...parts);
    }

    // A small, still preview of a scene for the scene list.
    let thumbHides = [];
    function sceneThumb(sl, n) {
      const W = 112;
      const H = Math.round((W * playout.height) / playout.width);
      const inner = h('div', { class: 'thumb-stage', style: { width: `${playout.width}px`, height: `${playout.height}px`, transform: `scale(${W / playout.width})` } });
      const bg = sl.backgroundMediaId && mediaById[sl.backgroundMediaId];
      const r = window.Beeldkrant.renderSlide({ ...sl, backgroundMedia: bg ? { url: bg.url, type: bg.type } : null, elements: (sl.elements || []).map(resolveEl) },
        { editor: true, thumb: true, timezone: region.timezone, locale: region.locale, playoutBackground: playout.backgroundColor });
      inner.appendChild(r.node);
      thumbHides.push(r);
      return h('div', { class: 'scene-thumb', style: { width: `${W}px`, height: `${H}px` } }, inner, h('span', { class: 'num' }, String(n)));
    }

    function layerName(e) {
      const label = ELEMENT_TYPES[e.type] ? ELEMENT_TYPES[e.type].label : e.type;
      const m = e.mediaId && mediaById[e.mediaId];
      const feed = e.feedId && feeds.find((f) => f.id === e.feedId);
      const detail = e.type === 'text' ? String(e.text || '').split('\n')[0] : m ? m.name : e.type === 'image' && e.source === 'feed' ? 'feed image'
        : e.items ? `${e.items.length} item${e.items.length === 1 ? '' : 's'}` : e.type === 'rss' && feed ? feed.name
          : e.type === 'camera' ? ((cams.find((c) => c.id === e.cameraId) || {}).name || '') : '';
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
      const out = m ? { ...e, src: m.url, mediaType: m.type } : { ...e };
      if (Array.isArray(e.items)) out.sources = e.items.map((id) => mediaById[id]).filter(Boolean).map((x) => ({ id: x.id, src: x.url, type: x.type }));
      const cam = e.type === 'camera' && cams.find((c) => c.id === e.cameraId);
      if (cam) Object.assign(out, { src: `${BASE}/api/player/camera/${cam.id}`, snapshot: `${BASE}/api/player/camera/${cam.id}/snapshot`, cameraName: cam.name });
      if (e.enabled === false) out.opacity = 25; // hidden on air: faint in the editor
      return out;
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
            field('Move on', bind(sl, 'advance', () => { changedSide(); renderProps(); }, 'select', { options: [['duration', 'After the duration'], ['video', 'When the media has played']] }),
              { hint: sl.advance === 'video' ? 'Waits for videos to end, and for carousels and RSS feeds to show every item once.' : null }),
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
            h('button', { onclick: () => { const c = clone(sl); c.id = uid(); c.name += ' (copy)'; c.elements.forEach((x) => { x.id = uid(); }); playout.slides.splice(S.slideIndex + 1, 0, c); S.slideIndex++; markDirty(); renderAll(); } }, icon('copy'), 'Duplicate scene'),
            h('button', { class: 'danger-outline', onclick: async () => { if (await confirmBox(`Delete scene "${sl.name}"?`)) { playout.slides.splice(S.slideIndex, 1); S.slideIndex = Math.min(S.slideIndex, playout.slides.length - 1); S.selected = null; markDirty(); renderAll(); } } }, icon('trash'), 'Delete scene')));
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

    // In order or random, for carousels.
    function orderField(e, onChange, what) {
      return h('div', { class: 'seg seg-wide', role: 'group', 'aria-label': 'Order' },
        [['fixed', 'list', 'In this order'], ['random', 'shuffle', 'Random']].map(([v, ic, label]) => h('button', {
          class: (e.order || 'fixed') === v ? 'active' : '',
          title: v === 'random' ? `Shuffles the ${what} every round` : `Plays the ${what} top to bottom; drag to change the order`,
          onclick: () => { e.order = v; onChange(); },
        }, icon(ic), label)));
    }

    // The media of a carousel: add from the library, drag or use the arrows to reorder, remove.
    function mediaListEditor(e, type, onChange) {
      e.items = (e.items || []).filter((id) => mediaById[id]);
      const random = e.order === 'random';
      let dragFrom = null;
      const move = (from, to) => { const [x] = e.items.splice(from, 1); e.items.splice(to, 0, x); onChange(); };
      const rows = e.items.map((id, i) => {
        const m = mediaById[id];
        const row = h('div', {
          class: 'media-row', draggable: 'true',
          ondragstart: () => { dragFrom = i; row.classList.add('dragging'); },
          ondragend: () => row.classList.remove('dragging'),
          ondragover: (ev) => ev.preventDefault(),
          ondrop: (ev) => { ev.preventDefault(); if (dragFrom != null && dragFrom !== i) move(dragFrom, i); },
        },
        h('span', { class: 'grip', title: 'Drag to reorder' }, icon('grip')),
        random ? null : h('span', { class: 'pos' }, String(i + 1)),
        h('div', { class: 'mthumb', style: m.thumbUrl ? { backgroundImage: `url("${m.thumbUrl}")` } : {} }, m.thumbUrl ? null : icon(type)),
        h('div', { class: 'mname' }, h('div', { title: m.name }, m.name), m.duration ? h('small', null, `${Math.round(m.duration)} s`) : null),
        h('button', { class: 'icon-btn', title: 'Move up', disabled: i === 0, onclick: () => move(i, i - 1) }, icon('up')),
        h('button', { class: 'icon-btn', title: 'Move down', disabled: i === e.items.length - 1, onclick: () => move(i, i + 1) }, icon('down')),
        h('button', { class: 'icon-btn del', title: 'Remove from the carousel', onclick: () => { e.items.splice(i, 1); onChange(); } }, icon('close')));
        return row;
      });
      const add = () => {
        const chosen = new Set();
        const filter = (x) => x.type === type;
        modal(`Add ${type === 'image' ? 'photos' : 'videos'}`, h('div', { class: 'stack' },
          h('p', { class: 'muted' }, 'Click the files to add, in the order you want them. You can reorder them afterwards.'),
          media.some(filter) ? folderBrowser(media, folders, { filter, multi: chosen }) : h('p', null, 'No matching media. Upload files under Media management first.')),
        (close) => [h('button', { onclick: close }, 'Cancel'), h('button', { class: 'primary', onclick: () => { e.items.push(...chosen); close(); onChange(); } }, 'Add')]);
      };
      const total = type === 'video' ? e.items.reduce((sum, id) => sum + (Number(mediaById[id].duration) || 0), 0) : 0;
      return h('div', { class: 'media-list' },
        h('div', { class: 'row between' },
          h('b', null, `${e.items.length} ${type === 'image' ? 'photo' : 'video'}${e.items.length === 1 ? '' : 's'}`, total ? h('small', { class: 'muted' }, ` · ${Math.floor(total / 60)}:${String(Math.round(total % 60)).padStart(2, '0')} in total`) : null),
          h('button', { class: 'small primary', onclick: add }, icon('plus'), type === 'image' ? 'Add photos' : 'Add videos')),
        rows.length ? h('div', { class: 'media-rows' }, rows) : h('p', { class: 'muted' }, `No ${type === 'image' ? 'photos' : 'videos'} yet.`),
        random && rows.length > 1 ? h('p', { class: 'hint' }, 'Random: the order changes every round, and no item plays twice in a row.') : null);
    }

    function elementProps(e, changed) {
      const t = ELEMENT_TYPES[e.type] || { label: e.type };
      const rerender = () => { changed(); renderProps(); };
      const out = [h('div', { class: 'props-head' }, icon(ELEMENT_TYPES[e.type] ? e.type : 'box'), h('h2', null, t.label),
        h('button', { class: 'icon-btn', title: 'Duplicate', onclick: () => { const els = elements(); const c = { ...clone(e), id: uid(), x: e.x + 20, y: e.y + 20 }; els.push(c); S.selected = c.id; markDirty(); renderAll(); } }, icon('copy')),
        h('button', { class: 'icon-btn del', title: 'Delete', onclick: () => removeElement(e.id) }, icon('trash')),
        h('button', { class: 'icon-btn', title: 'Close (deselect)', onclick: () => { S.selected = null; renderAll(); } }, icon('close')))];
      out.push(h('h3', null, 'Position'), h('div', { class: 'fields' },
        field('X', bind(e, 'x', changed, 'number')), field('Y', bind(e, 'y', changed, 'number')),
        field('Width', bind(e, 'w', changed, 'number', { min: 1 })), field('Height', bind(e, 'h', changed, 'number', { min: 1 })),
        field('Layer (z)', bind(e, 'z', () => { changed(); renderSide(); }, 'number')), field('Opacity %', bind(e, 'opacity', changed, 'number', { min: 0, max: 100, placeholder: '100' })),
        field('Corner radius', bind(e, 'radius', changed, 'number', { min: 0 })), field('Rotation°', bind(e, 'rotate', changed, 'number')),
        h('div', { class: 'row wide' },
          h('button', { class: 'small', onclick: () => { Object.assign(e, { x: 0, y: 0, w: playout.width, h: playout.height }); rerender(); } }, icon('maximize'), 'Full screen'),
          h('button', { class: 'small', onclick: () => { e.x = Math.round((playout.width - e.w) / 2); e.y = Math.round((playout.height - e.h) / 2); rerender(); } }, icon('center'), 'Centre'),
          h('label', { class: 'check' }, bind(e, 'locked', () => renderSide(), 'checkbox'), 'Lock'))));
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
        case 'slideshow':
          out.push(orderField(e, rerender, 'photos'), mediaListEditor(e, 'image', rerender), h('div', { class: 'fields' },
            field('Each photo (s)', bind(e, 'interval', changed, 'number', { min: 1, placeholder: '5' })),
            field('Fit', bind(e, 'fit', changed, 'select', { options: [['cover', 'Fill (crop)'], ['contain', 'Fit (letterbox)'], ['fill', 'Stretch']] })),
            field('Transition', bind(e, 'transition', changed, 'select', { options: [['fade', 'Fade'], ['slide-left', 'Slide'], ['slide-up', 'Slide up'], ['zoom', 'Zoom'], ['cut', 'Cut']] })),
            field('Transition time (ms)', bind(e, 'transitionMs', changed, 'number', { min: 0, max: 5000, step: 100, placeholder: '800' })),
            field('Background', bind(e, 'background', changed, 'color', { fallback: '#000000' }), { wide: true })),
          h('p', { class: 'hint' }, 'The carousel keeps going round while the scene is on screen. Set the scene to "When the media has played" to move on after every photo was shown once.'));
          break;
        case 'playlist':
          out.push(orderField(e, rerender, 'videos'), mediaListEditor(e, 'video', rerender), h('div', { class: 'fields' },
            field('Fit', bind(e, 'fit', changed, 'select', { options: [['cover', 'Fill (crop)'], ['contain', 'Fit (letterbox)'], ['fill', 'Stretch']] })),
            h('label', { class: 'check' }, bind(e, 'audio', changed, 'checkbox'), 'Play audio')),
          h('p', { class: 'hint' }, 'The videos play back to back and start over while the scene is on screen. Set the scene to "When the media has played" to move on after the last video.'));
          break;
        case 'rss': {
          const feed = feeds.find((f) => f.id === e.feedId);
          out.push(h('div', { class: 'fields' },
            field('Feed', bind(e, 'feedId', () => { feedPreview = {}; rerender(); renderSide(); }, 'select', { options: feedOptions }), { wide: true, hint: feed ? `This feed shows its ${feed.maxItems || 10} newest items (set under Media management → RSS feeds).` : 'Add feeds under Media management → RSS feeds.' }),
            field('Layout', bind(e, 'layout', rerender, 'select', { options: [['list', 'List: photo left, text right'], ['grid', 'Grid of cards'], ['single', 'One item at a time, photo full size']] }), { wide: true }),
            e.layout === 'single' ? null : field('Items per page', bind(e, 'perPage', changed, 'number', { min: 1, max: 24, placeholder: e.layout === 'grid' ? '6' : '4' })),
            e.layout === 'grid' ? field('Columns', bind(e, 'columns', changed, 'number', { min: 1, max: 8, placeholder: '3' })) : null,
            field(e.layout === 'single' ? 'Each item (s)' : 'Each page (s)', bind(e, 'interval', changed, 'number', { min: 2, placeholder: '8' })),
            field('Show at most', bind(e, 'maxItems', changed, 'number', { min: 1, placeholder: 'all' }), { hint: 'Fewer than the feed setting, if you like.' }),
            h('label', { class: 'check' }, h('input', { type: 'checkbox', checked: e.showImage !== false, onchange: (ev) => { e.showImage = ev.target.checked; changed(); } }), 'Photos'),
            h('label', { class: 'check' }, h('input', { type: 'checkbox', checked: e.showDescription !== false, onchange: (ev) => { e.showDescription = ev.target.checked; changed(); } }), 'Text'),
            h('label', { class: 'check' }, bind(e, 'showDate', changed, 'checkbox'), 'Date'),
            field('Text lines', bind(e, 'descLines', changed, 'number', { min: 1, max: 12, placeholder: e.layout === 'single' ? '4' : '2' })),
            field('Title size (px)', bind(e, 'fontSize', changed, 'number', { min: 8, placeholder: '40' })),
            field('Spacing (px)', bind(e, 'gap', changed, 'number', { min: 0, placeholder: '20' })),
            field('Text colour', bind(e, 'color', changed, 'color', { fallback: '#ffffff' }), { wide: true }),
            field('Card background', bind(e, 'cardBackground', changed, 'color'), { wide: true, hint: 'rgba(0,0,0,0.45) gives see-through cards' }),
            field('Font family', bind(e, 'fontFamily', changed, 'text', { placeholder: 'DejaVu Sans' }), { wide: true })),
          h('p', { class: 'hint' }, 'Pages through the items when they do not all fit, and picks up new items every round. Set the scene to "When the media has played" to move on after the last page.'));
          break;
        }
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
        case 'camera':
          out.push(h('div', { class: 'fields' },
            field('Camera', bind(e, 'cameraId', rerender, 'select', { options: [['', '— choose a camera —'], ...cams.map((c) => [c.id, `${c.name} (${c.protocol.toUpperCase()})`])] }), { wide: true }),
            field('Fit', bind(e, 'fit', changed, 'select', { options: [['cover', 'Fill (crop)'], ['contain', 'Fit (letterbox)'], ['fill', 'Stretch']] }))),
          h('p', { class: 'hint' }, cams.length ? 'Shows the camera live on air; the editor shows one picture. Add cameras under Media management → IP cameras.' : 'No cameras yet: add them under Media management → IP cameras.'));
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
        h('button', { onclick: () => { const els = elements(); const c = { ...clone(e), id: uid(), x: e.x + 20, y: e.y + 20 }; els.push(c); S.selected = c.id; markDirty(); renderAll(); } }, icon('copy'), 'Duplicate'),
        h('button', { class: 'danger-outline', onclick: () => removeElement(e.id) }, icon('trash'), 'Delete')));
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
    const dropLabel = h('span');
    const drop = h('div', { class: 'dropzone', onclick: () => input.click() }, dropLabel, h('div', { class: 'hint' }, 'You can select or drop many files at once; each one shows its own progress, speed and time left. Images: jpg, png, gif, webp, svg · Video: mp4, webm, mov, mkv · Audio: mp3, m4a, aac, ogg, wav, flac'));
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
      const query = new URLSearchParams();
      if (cur) query.set('folderId', cur);
      if (arg === 'ads') query.set('ad', '1');
      queueUploads(files, query, cur ? folderTrail(folders, cur).map((f) => f.name).join(' / ') : 'Media');
    }
    // Refresh the list as files finish, while this page is open.
    let reloadTimer;
    const onUploaded = () => { if (!document.body.contains(listEl)) { uploads.listeners.delete(onUploaded); return; } clearTimeout(reloadTimer); reloadTimer = setTimeout(reload, 400); };
    uploads.listeners.add(onUploaded);
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
      const data = feed ? clone(feed) : { name: '', url: '', refreshMinutes: 10, maxItems: 10 };
      const previewBox = h('div', { class: 'stack' });
      modal(feed ? 'Edit feed' : 'Add RSS feed', h('div', { class: 'stack' },
        h('div', { class: 'fields' },
          field('Name', bind(data, 'name', () => {}), { wide: true }),
          field('Feed URL (RSS or Atom)', bind(data, 'url', () => {}, 'url', { placeholder: 'https://example.com/rss.xml' }), { wide: true }),
          field('Refresh every (minutes)', bind(data, 'refreshMinutes', () => {}, 'number', { min: 1 })),
          field('Number of items', bind(data, 'maxItems', () => {}, 'number', { min: 1, max: 100, placeholder: '10' }), { hint: 'How many of the newest items scenes, tickers and RSS elements show.' })),
        previewBox),
      (close) => [
        feed ? h('button', { onclick: async () => {
          put(previewBox, h('p', { class: 'muted' }, 'Loading…'));
          try {
            await PUT(`/api/feeds/${feed.id}`, data);
            const res = await GET(`/api/feeds/${feed.id}/items?force=1`);
            put(previewBox, 
              res.error ? h('div', { class: 'badge err' }, res.error) : h('div', { class: 'badge ok' }, `Showing ${res.items.length} of ${res.total ?? res.items.length} items`),
              ...res.items.slice(0, 6).map((i) => h('div', { class: 'feed-preview-item' },
                i.image ? h('img', { src: i.image, alt: '', loading: 'lazy' }) : h('div', { class: 'feed-noimg' }, 'No photo'),
                h('div', null, h('b', null, i.title), h('div', { class: 'muted' }, (i.description || '').slice(0, 160))))));
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
      h('p', { class: 'muted' }, 'Show a feed with photos and text with the RSS feed element, repeat a scene once per item (scene template), or use it as ticker headlines.'),
      feeds.length ? h('div', { class: 'card' }, h('table', null,
        h('tr', null, h('th', null, 'Name'), h('th', null, 'URL'), h('th', null, 'Items'), h('th', null, 'Refresh'), h('th', null, '')),
        feeds.map((f) => h('tr', null, h('td', null, f.name), h('td', { class: 'muted' }, f.url), h('td', null, String(f.maxItems || 10)), h('td', null, `${f.refreshMinutes || 10} min`),
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
    const panelUrl = () => `http://${server.serverAddress || location.hostname}:${server.port}${BASE}/admin/`;
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
            setTimeout(() => { location.href = `${location.protocol}//${location.hostname}:${r.port}${BASE}/admin/#settings`; }, 1200);
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
    const [all, folders, feeds, playouts, cams] = await Promise.all([GET('/api/media'), GET('/api/folders'), GET('/api/feeds'), GET('/api/playouts'), GET('/api/cameras')]);
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
        card('#streams', 'Input streams', String(streams.length), 'Icecast / Shoutcast audio', streams.map((m) => (musicUse(m.id).length ? `${m.name} (music in ${musicUse(m.id).join(', ')})` : m.name))),
        card('#cameras', 'IP cameras', String(cams.length), 'RTSP, RTMP(S) and RTP', cams.map((c) => `${c.name} (${c.protocol.toUpperCase()})`))));
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

  // ---------- media management: IP cameras ----------
  const CAMERA_PROTOCOLS = [['rtsp', 'RTSP'], ['rtmp', 'RTMP'], ['rtmps', 'RTMPS'], ['rtp', 'RTP']];
  const CAMERA_HINTS = {
    rtsp: ['rtsp://192.168.1.20:554/stream1', 'Most IP cameras. The path differs per make; see the camera manual (e.g. /stream1, /h264, /cam/realmonitor).'],
    rtmp: ['rtmp://192.168.1.20:1935/live/camera1', 'A camera or media server that offers its stream over RTMP.'],
    rtmps: ['rtmps://cam.example.com:443/live/camera1', 'RTMP over TLS. Tick "Ignore SSL errors" for a camera with a self-signed certificate.'],
    rtp: ['rtp://0.0.0.0:5004', 'Beeldkrant listens on this UDP port (use a multicast address such as rtp://239.0.0.1:5004 to join a group). MPEG-TS over RTP works as is; for other RTP streams paste the SDP description.'],
  };
  const camState = (st) => {
    if (st.state === 'live') return h('span', { class: 'badge ok' }, `Live · ${st.width}×${st.height} · ${st.fps} fps`);
    if (st.state === 'connecting') return h('span', { class: 'badge' }, 'Connecting…');
    if (st.state === 'error') return h('span', { class: 'badge err', title: st.error || '' }, 'Error');
    return h('span', { class: 'badge' }, 'Idle');
  };
  const camResult = (res) => (res.ok
    ? h('div', { class: 'cam-result ok' }, h('b', null, 'Connected'), h('span', null, `${res.summary}${res.ms ? ` · answered in ${(res.ms / 1000).toFixed(1)} s` : ''}`))
    : h('div', { class: 'cam-result err' }, h('b', null, 'Could not connect'), h('span', null, res.error)));

  async function pageCameras(main) {
    let cams = await GET('/api/cameras');
    const playouts = await GET('/api/playouts');
    const usedIn = (id) => playouts.filter((p) => [...(p.overlays || []), ...(p.slides || []).flatMap((s) => s.elements || [])].some((e) => e.type === 'camera' && e.cameraId === id)).map((p) => p.name);
    const listEl = h('div');

    const edit = (cam) => {
      const data = cam ? { ...clone(cam), password: '' } : { name: '', protocol: 'rtsp', url: '', username: '', password: '', transport: 'tcp', ignoreSsl: false, sdp: '', fps: 25, maxWidth: 1920 };
      const result = h('div');
      const body = h('div', { class: 'stack' });
      const draw = () => {
        const [placeholder, hint] = CAMERA_HINTS[data.protocol];
        put(body,
          h('div', { class: 'fields' },
            field('Name', bind(data, 'name', () => {}, 'text', { placeholder: 'e.g. Main entrance' }), { wide: true }),
            field('Protocol', h('div', { class: 'seg seg-wide' }, CAMERA_PROTOCOLS.map(([v, label]) => h('button', {
              type: 'button', class: data.protocol === v ? 'active' : '',
              onclick: () => {
                // Swap the scheme of an address that was typed for another protocol.
                if (data.url) data.url = data.url.replace(/^[a-z]+:\/\//i, `${v}://`);
                data.protocol = v; put(result); draw();
              },
            }, label))), { wide: true }),
            field('Address', bind(data, 'url', () => {}, 'text', { placeholder }), { wide: true, hint }),
            data.protocol === 'rtp' ? null : field('User name', bind(data, 'username', () => {}, 'text', { placeholder: 'optional' })),
            data.protocol === 'rtp' ? null : field('Password', bind(data, 'password', () => {}, 'password', { placeholder: cam && cam.hasPassword ? '•••••• (unchanged)' : 'optional' })),
            data.protocol === 'rtsp' ? field('Transport', bind(data, 'transport', () => {}, 'select', { options: [['tcp', 'TCP (most reliable)'], ['udp', 'UDP']] })) : null,
            data.protocol === 'rtmps' ? h('label', { class: 'check wide cam-ssl' }, bind(data, 'ignoreSsl', () => {}, 'checkbox'), 'Ignore SSL errors (self-signed or expired certificate, or a name that does not match)') : null,
            data.protocol === 'rtp' ? field('SDP description (optional)', h('textarea', { rows: 6, class: 'mono', placeholder: 'v=0\no=- 0 0 IN IP4 192.168.1.20\ns=Camera\nc=IN IP4 0.0.0.0\nt=0 0\nm=video 5004 RTP/AVP 96\na=rtpmap:96 H264/90000', oninput: (ev) => { data.sdp = ev.target.value; } }, data.sdp || ''), { wide: true, hint: 'Needed for H.264/H.265 over RTP; not needed for MPEG-TS over RTP.' }) : null,
            field('Frame rate on air', bind(data, 'fps', () => {}, 'number', { min: 1, max: 60 }), { hint: 'Pictures per second in scenes and the preview' }),
            field('Maximum width', bind(data, 'maxWidth', () => {}, 'number', { min: 160, max: 3840, step: 10 }), { hint: 'Larger pictures are scaled down' })),
          result);
      };
      draw();
      const test = async (btn) => {
        btn.disabled = true;
        put(result, h('div', { class: 'cam-result' }, h('b', null, 'Testing…'), h('span', null, 'Connecting to the camera')));
        try { put(result, camResult(await POST('/api/cameras/test', { ...data, id: cam ? cam.id : undefined, changed: true }))); } catch (err) { put(result, camResult({ ok: false, error: err.message })); }
        btn.disabled = false;
      };
      modal(cam ? 'Edit IP camera' : 'Add IP camera', body, (close) => {
        const testBtn = h('button', { onclick: () => test(testBtn) }, 'Test connection');
        return [testBtn, h('button', { onclick: close }, 'Cancel'), h('button', { class: 'primary', onclick: async () => {
          try {
            if (cam) await PUT(`/api/cameras/${cam.id}`, data); else await POST('/api/cameras', data);
            close(); route();
          } catch (err) { fail(err); }
        } }, cam ? 'Save' : 'Add camera')];
      });
    };

    const preview = (cam) => {
      const img = h('img', { class: 'cam-live', alt: `${cam.name}, live` });
      const info = h('div', { class: 'row between cam-live-info' });
      const logEl = h('pre', { class: 'logs cam-log' });
      img.src = `${BASE}/api/player/camera/${cam.id}?t=${Date.now()}`;
      img.onerror = () => setTimeout(() => { if (document.body.contains(img)) img.src = `${BASE}/api/player/camera/${cam.id}?t=${Date.now()}`; }, 3000);
      const tick = async () => {
        const all = await GET('/api/cameras').catch(() => null);
        const c = all && all.find((x) => x.id === cam.id);
        if (!c || !document.body.contains(img)) return;
        put(info, camState(c.status), h('span', { class: 'muted' }, c.address));
        put(logEl, (c.status.log || []).slice(-6).join('\n') || 'Nothing logged yet.');
        if (c.status.state === 'error' && c.status.error) info.append(h('div', { class: 'cam-result err wide' }, h('span', null, c.status.error)));
      };
      tick();
      const iv = setInterval(tick, 1000);
      const stop = () => { clearInterval(iv); img.removeAttribute('src'); };
      modal(`${cam.name}: live preview`, h('div', { class: 'stack' }, h('div', { class: 'cam-frame' }, img), info, logEl), (close) => [
        h('button', { onclick: async () => { const r = await POST('/api/cameras/test', { ...cam, id: cam.id }); toast(r.ok ? `Connected · ${r.summary}` : r.error, r.ok ? 'ok' : 'err'); } }, 'Test connection'),
        h('button', { class: 'primary', onclick: () => { stop(); close(); } }, 'Close'),
      ], { wide: true, onClose: stop });
    };

    const draw = () => put(listEl, cams.length ? h('div', { class: 'cam-grid' }, cams.map((c) => {
      const used = usedIn(c.id);
      const thumb = h('div', { class: 'cam-thumb', onclick: () => preview(c) }, h('span', { class: 'cam-proto' }, c.protocol.toUpperCase()), h('span', { class: 'cam-play' }, icon('play'), 'Live preview'));
      const shot = new Image();
      shot.onload = () => { thumb.style.backgroundImage = `url("${shot.src}")`; thumb.classList.add('has-pic'); };
      shot.src = `${BASE}/api/player/camera/${c.id}/snapshot?t=${Date.now()}`;
      return h('div', { class: 'card cam-card' }, thumb,
        h('div', { class: 'row between' }, h('b', null, c.name), camState(c.status)),
        h('code', { class: 'cam-addr' }, c.address),
        h('div', { class: 'hint' }, [c.protocol === 'rtsp' ? `RTSP over ${(c.transport || 'tcp').toUpperCase()}` : null, c.protocol === 'rtmps' && c.ignoreSsl ? 'SSL errors ignored' : null, c.protocol === 'rtp' && c.sdp ? 'with SDP' : null, c.hasPassword ? 'with password' : null, used.length ? `In ${used.join(', ')}` : 'Not used in a playout'].filter(Boolean).join(' · ')),
        h('div', { class: 'row', style: { gap: '6px', marginTop: '4px' } },
          h('button', { class: 'small', onclick: () => preview(c) }, 'Preview'),
          h('button', { class: 'small', onclick: async (ev) => {
            const b = ev.target; b.disabled = true; b.textContent = 'Testing…';
            const r = await POST('/api/cameras/test', { ...c, id: c.id }).catch((err) => ({ ok: false, error: err.message }));
            toast(r.ok ? `${c.name}: connected · ${r.summary}` : `${c.name}: ${r.error}`, r.ok ? 'ok' : 'err');
            b.disabled = false; b.textContent = 'Test';
          } }, 'Test'),
          h('button', { class: 'small', onclick: () => edit(c) }, 'Edit'),
          h('button', { class: 'small ghost', onclick: async () => { if (await confirmBox(`Delete camera "${c.name}"?${used.length ? ' Scenes that show it go black.' : ''}`)) { await DEL(`/api/cameras/${c.id}`).catch(fail); route(); } } }, 'Delete')));
    })) : h('div', { class: 'card' }, h('p', { class: 'muted' }, 'No cameras yet. Add an RTSP, RTMP, RTMPS or RTP camera, test the connection and show it live in a scene with the IP camera element.')));

    main.append(h('div', { class: 'row between' }, h('h1', null, 'IP cameras'), h('button', { class: 'primary', onclick: () => edit(null) }, '+ Add camera')),
      h('p', { class: 'muted' }, 'Live cameras for your scenes. A camera only connects while someone watches it: a preview here, or a scene on air with the IP camera element.'),
      listEl);
    draw();
    // Keep the states fresh.
    const iv = setInterval(async () => {
      const next = await GET('/api/cameras').catch(() => null);
      if (!next) return;
      for (const c of next) {
        const card = [...listEl.querySelectorAll('.cam-card')][cams.findIndex((x) => x.id === c.id)];
        const badgeEl = card && card.querySelector('.row.between .badge');
        if (badgeEl) badgeEl.replaceWith(camState(c.status));
      }
    }, 3000);
    cleanup = () => clearInterval(iv);
  }

  // ---------- account ----------
  async function pageAccount(main) {
    main.append(h('h1', null, 'Your account'),
      h('div', { class: 'grid two' },
        h('div', { class: 'card stack' }, h('h2', null, 'Appearance'),
          h('p', { class: 'muted' }, 'Choose a light or dark theme for your account, or follow your device setting.'),
          themeSwitch()),
        me.user.authMethod === 'sso'
          ? h('div', { class: 'card stack' }, h('h2', null, 'Sign-in'), h('div', { class: 'row' }, msLogo(), h('b', null, 'You sign in with Microsoft')),
            h('p', { class: 'muted' }, 'Your password and two-step verification are managed by Microsoft Entra ID.'))
          : h('div', { class: 'card stack' }, h('h2', null, 'Change password'), renderChangePassword(false)),
        me.user.authMethod === 'sso' ? null : mfaCard(),
        h('div', { class: 'card stack' }, h('h2', null, 'Role'),
          h('p', null, h('b', null, ROLE_LABELS[me.user.role]), ' · ', me.user.role === 'admin' ? 'you can do everything.' : me.user.role === 'readonly' ? 'you can look at everything, but not change anything.' : 'you can change:'),
          me.user.role === 'user' ? h('ul', { class: 'perm-list' }, Object.entries(me.permissionLabels || {}).map(([k, label]) => h('li', { class: me.user.permissions[k] ? 'on' : 'off' }, me.user.permissions[k] ? '✓ ' : '✕ ', label))) : null)));
  }

  function mfaCard() {
    const card = h('div', { class: 'card stack' });
    const draw = () => put(card, h('h2', null, 'Two-step verification'),
      h('p', { class: 'muted' }, 'Asks for a code from an authenticator app on your phone at every login.'),
      h('div', { class: 'row' }, me.user.mfaEnabled ? h('span', { class: 'badge ok' }, 'On') : h('span', { class: 'badge' }, 'Off'),
        me.user.mfaRequired ? h('span', { class: 'hint', style: { marginTop: 0 } }, 'Required for your account by an admin') : null),
      me.user.mfaEnabled
        ? (me.user.mfaRequired ? null : h('button', { class: 'danger-outline', onclick: turnOff }, 'Turn off'))
        : h('button', { class: 'primary', onclick: setup }, 'Set up'));
    const setup = async () => {
      const s = await POST('/api/me/mfa/setup').catch(fail);
      if (!s) return;
      const code = h('input', { inputmode: 'numeric', autocomplete: 'one-time-code', placeholder: '123 456', class: 'code-input', maxlength: 7 });
      modal('Set up two-step verification', mfaSetupSteps(s.secret, s.otpauth, code), (close) => [
        h('button', { onclick: close }, 'Cancel'),
        h('button', { class: 'primary', onclick: async () => {
          try {
            const r = await POST('/api/me/mfa/enable', { secret: s.secret, code: code.value });
            close(); me.user.mfaEnabled = true; draw();
            showRecoveryCodes(r.recoveryCodes, () => {});
          } catch (err) { fail(err); }
        } }, 'Turn on')]);
      code.focus();
    };
    const turnOff = () => {
      const pw = h('input', { type: 'password', autocomplete: 'current-password' });
      modal('Turn off two-step verification', field('Your password', pw), (close) => [h('button', { onclick: close }, 'Cancel'),
        h('button', { class: 'danger', onclick: async () => { try { await api('DELETE', '/api/me/mfa', { password: pw.value }); close(); me.user.mfaEnabled = false; draw(); } catch (err) { fail(err); } } }, 'Turn off')]);
      pw.focus();
    };
    draw();
    return card;
  }

  // ---------- settings: users and roles ----------
  const AUTH_LABEL = (u) => (u.authMethod === 'sso' ? 'Microsoft' : 'Password');
  const ago = (iso) => {
    if (!iso) return 'Never';
    const s = Math.round((Date.now() - Date.parse(iso)) / 1000);
    return s < 60 ? 'Just now' : s < 3600 ? `${Math.round(s / 60)} min ago` : s < 86400 ? `${Math.round(s / 3600)} h ago` : `${Math.round(s / 86400)} days ago`;
  };
  function roleSeg(data, onChange) {
    return h('div', { class: 'seg seg-wide' }, ['admin', 'user', 'readonly'].map((r) => h('button', { type: 'button', class: data.role === r ? 'active' : '', onclick: () => { data.role = r; onChange(); } }, ROLE_LABELS[r])));
  }
  const ROLE_HELP = { admin: 'Can do everything, including users, security and updates.', user: 'Can change only the parts you switch on below; can look at everything else.', readonly: 'Can look at everything, but not change anything.' };
  function permissionChecks(perms, labels) {
    return h('div', { class: 'perm-grid' }, Object.entries(labels).map(([k, label]) => h('label', { class: 'check' },
      h('input', { type: 'checkbox', checked: !!perms[k], onchange: (e) => { perms[k] = e.target.checked; } }), label)));
  }

  async function pageUsers(main) {
    const [users, ssoCfg] = await Promise.all([GET('/api/users'), GET('/api/sso')]);
    const labels = me.permissionLabels || {};
    const ssoOn = ssoCfg.enabled && ssoCfg.tenantId && ssoCfg.clientId && ssoCfg.hasClientSecret;

    const edit = (u) => {
      const data = u ? { ...clone(u), password: '', permissions: { ...u.permissions } } : { username: '', displayName: '', email: '', role: 'user', permissions: { playouts: true, media: true, schedule: true }, authMethod: 'password', password: '', mustChangePassword: true, mfaRequired: false };
      const body = h('div', { class: 'stack' });
      const draw = () => put(body,
        h('div', { class: 'fields' },
          field('User name', bind(data, 'username', () => {}, 'text', { placeholder: 'e.g. jdevries or j.devries@example.com' })),
          field('Display name', bind(data, 'displayName', () => {}, 'text', { placeholder: 'Jan de Vries' })),
          field('E-mail', bind(data, 'email', () => {}, 'email', { placeholder: 'j.devries@example.com' }), { wide: true, hint: data.authMethod === 'sso' ? 'The address (user principal name) this user signs in with at Microsoft.' : null })),
        h('div', null, h('div', { class: 'label' }, 'Role'), roleSeg(data, draw), h('div', { class: 'hint' }, ROLE_HELP[data.role])),
        data.role === 'user' ? h('div', null, h('div', { class: 'label' }, 'This user can change'), permissionChecks(data.permissions, labels)) : null,
        h('div', null, h('div', { class: 'label' }, 'Sign-in'),
          h('div', { class: 'seg seg-wide' },
            h('button', { type: 'button', class: data.authMethod === 'password' ? 'active' : '', onclick: () => { data.authMethod = 'password'; draw(); } }, 'Password'),
            h('button', { type: 'button', class: data.authMethod === 'sso' ? 'active' : '', onclick: () => { data.authMethod = 'sso'; draw(); } }, msLogo(), 'Microsoft Entra SSO')),
          data.authMethod === 'sso' && !ssoOn ? h('div', { class: 'cam-result err' }, h('span', null, 'Microsoft sign-in is not set up yet. ', h('a', { href: '#sso' }, 'Configure SSO'))) : null),
        data.authMethod === 'password' ? h('div', { class: 'fields' },
          field(u ? 'New password (leave empty to keep it)' : 'Password', bind(data, 'password', () => {}, 'password', { autocomplete: 'new-password' }), { hint: policyHint() }),
          h('div', { class: 'stack', style: { paddingTop: '20px' } },
            u ? null : h('label', { class: 'check' }, bind(data, 'mustChangePassword', () => {}, 'checkbox'), 'Must choose a new password at first login'),
            h('label', { class: 'check' }, bind(data, 'mfaRequired', () => {}, 'checkbox'), 'Two-step verification required'))) : h('p', { class: 'hint' }, 'The password policy and two-step verification of Beeldkrant do not apply: Microsoft Entra ID handles them.'),
        u ? h('label', { class: 'check' }, bind(data, 'disabled', () => {}, 'checkbox'), 'Disabled (cannot log in)') : null,
        u && u.mfaEnabled ? h('div', { class: 'row' }, h('span', { class: 'badge ok' }, 'Two-step verification set up'),
          h('button', { class: 'small', type: 'button', onclick: async () => { if (await confirmBox(`Reset two-step verification of ${u.username}? They set it up again at their next login.`)) { await POST(`/api/users/${u.id}/mfa/reset`).catch(fail); toast('Two-step verification reset', 'ok'); } } }, 'Reset')) : null);
      draw();
      modal(u ? `Edit ${u.username}` : 'Add user', body, (close) => [h('button', { onclick: close }, 'Cancel'), h('button', { class: 'primary', onclick: async () => {
        try {
          const payload = { username: data.username, displayName: data.displayName, email: data.email, role: data.role, permissions: data.permissions, authMethod: data.authMethod, mfaRequired: data.mfaRequired, disabled: data.disabled };
          if (data.password) payload.password = data.password;
          if (!u) payload.mustChangePassword = data.mustChangePassword;
          if (u) await PUT(`/api/users/${u.id}`, payload); else await POST('/api/users', payload);
          close(); route();
        } catch (err) { fail(err); }
      } }, u ? 'Save' : 'Add user')], { wide: false });
    };

    const fromEntra = () => {
      const q = h('input', { type: 'search', placeholder: 'Search by name or e-mail' });
      const role = { role: 'readonly', permissions: {} };
      const list = h('div', { class: 'entra-list' }, h('p', { class: 'muted' }, 'Searching…'));
      const roleBox = h('div');
      const drawRole = () => put(roleBox, h('div', { class: 'label' }, 'Role for users you add'), roleSeg(role, drawRole), role.role === 'user' ? permissionChecks(role.permissions, labels) : null);
      drawRole();
      let timer;
      const search = async () => {
        try {
          const found = await GET(`/api/sso/directory?q=${encodeURIComponent(q.value)}`);
          put(list, found.length ? found.map((x) => h('div', { class: 'entra-row' },
            h('div', { class: 'avatar' }, (x.name || '?').split(' ').map((w) => w[0]).slice(0, 2).join('')),
            h('div', { style: { flex: 1, minWidth: 0 } }, h('b', null, x.name), h('div', { class: 'muted small' }, x.email, x.jobTitle ? ` · ${x.jobTitle}` : '')),
            x.exists ? h('span', { class: 'badge ok' }, 'Added') : h('button', { class: 'small', onclick: async (ev) => {
              try {
                await POST('/api/users', { username: x.email, displayName: x.name, email: x.email, authMethod: 'sso', ssoOid: x.id, role: role.role, permissions: role.permissions });
                ev.target.replaceWith(h('span', { class: 'badge ok' }, 'Added'));
              } catch (err) { fail(err); }
            } }, '+ Add'))) : h('p', { class: 'muted' }, 'Nobody found.'));
        } catch (err) { put(list, h('div', { class: 'cam-result err' }, h('b', null, 'Could not search the directory'), h('span', null, err.message))); }
      };
      q.addEventListener('input', () => { clearTimeout(timer); timer = setTimeout(search, 300); });
      modal('Add users from Microsoft Entra', h('div', { class: 'stack' }, h('p', { class: 'muted' }, 'They sign in with their Microsoft account; no password needed.'), roleBox, q, list),
        (close) => [h('button', { class: 'primary', onclick: () => { close(); route(); } }, 'Done')]);
      search();
      q.focus();
    };

    main.append(h('div', { class: 'row between' }, h('h1', null, 'Users and roles'),
      h('div', { class: 'row' },
        h('a', { class: 'btn', href: '#sso' }, msLogo(), 'Configure SSO'),
        ssoOn ? h('button', { onclick: fromEntra }, 'Add from Entra') : null,
        h('button', { class: 'primary', onclick: () => edit(null) }, '+ Add user'))),
      h('div', { class: 'role-cards' }, ['admin', 'user', 'readonly'].map((r) => h('div', { class: 'card role-card' },
        h('div', { class: 'row between' }, h('b', null, ROLE_LABELS[r]), h('span', { class: 'badge' }, `${users.filter((u) => u.role === r).length} user${users.filter((u) => u.role === r).length === 1 ? '' : 's'}`)),
        h('div', { class: 'hint' }, ROLE_HELP[r])))),
      h('div', { class: 'card' }, h('table', { class: 'list users-table' },
        h('thead', null, h('tr', null, h('th', null, 'User'), h('th', null, 'Role'), h('th', null, 'Can change'), h('th', null, 'Sign-in'), h('th', null, 'Two-step'), h('th', null, 'Last login'), h('th'))),
        h('tbody', null, users.map((u) => h('tr', { class: u.disabled ? 'disabled' : '' },
          h('td', null, h('b', null, u.displayName || u.username), u.id === me.user.id ? h('span', { class: 'badge', style: { marginLeft: '6px' } }, 'you') : null,
            h('div', { class: 'muted small' }, [u.displayName ? u.username : null, u.email && u.email !== u.username ? u.email : null].filter(Boolean).join(' · '))),
          h('td', null, h('span', { class: `badge role-${u.role}` }, ROLE_LABELS[u.role]), u.disabled ? h('span', { class: 'badge err', style: { marginLeft: '6px' } }, 'Disabled') : null),
          h('td', { class: 'small' }, u.role === 'admin' ? 'Everything' : u.role === 'readonly' ? h('span', { class: 'muted' }, 'Nothing') : (Object.entries(u.permissions).filter(([, v]) => v).map(([k]) => k[0].toUpperCase() + k.slice(1)).join(', ') || h('span', { class: 'muted' }, 'Nothing'))),
          h('td', null, u.authMethod === 'sso' ? h('span', { class: 'row', style: { gap: '6px', flexWrap: 'nowrap' } }, msLogo(), 'Microsoft') : 'Password'),
          h('td', null, u.authMethod === 'sso' ? h('span', { class: 'muted small' }, 'Via Microsoft') : u.mfaEnabled ? h('span', { class: 'badge ok' }, 'On') : u.mfaRequired ? h('span', { class: 'badge warn' }, 'Required, not set up') : h('span', { class: 'muted small' }, 'Off')),
          h('td', { class: 'muted small' }, ago(u.lastLoginAt)),
          h('td', { style: { textAlign: 'right', whiteSpace: 'nowrap' } },
            h('button', { class: 'small', onclick: () => edit(u) }, 'Edit'), ' ',
            u.id === me.user.id ? null : h('button', { class: 'small ghost', onclick: async () => { if (await confirmBox(`Delete user "${u.username}"?`)) { await DEL(`/api/users/${u.id}`).catch(fail); route(); } } }, 'Delete'))))))));
  }

  const policyHint = () => {
    const pol = me.passwordPolicy || { minLength: 8 };
    return `At least ${pol.minLength} characters${pol.requireSpecial ? ', a special character' : ''}${pol.requireMixed ? ', upper and lower case and a number' : ''}.`;
  };

  // ---------- settings: users and roles → configure SSO ----------
  async function pageSso(main) {
    const cfg = await GET('/api/sso');
    const labels = me.permissionLabels || {};
    const data = { ...cfg, clientSecret: '', defaultPermissions: { ...cfg.defaultPermissions }, roleClaims: { ...cfg.roleClaims } };
    const result = h('div');
    const provBox = h('div');
    const drawProv = () => put(provBox, h('label', { class: 'check' }, h('input', { type: 'checkbox', checked: data.provisioning, onchange: (e) => { data.provisioning = e.target.checked; drawProv(); } }),
      h('span', null, h('b', null, 'Create accounts automatically'), h('div', { class: 'hint' }, 'Someone from your organisation who signs in with Microsoft for the first time gets an account. Turn off to let in only users you added.'))),
    data.provisioning ? h('div', { class: 'stack', style: { marginLeft: '26px' } }, h('div', { class: 'label' }, 'Role of new accounts'), roleSeg(data, drawProv),
      (data.defaultRole === 'user') ? permissionChecks(data.defaultPermissions, labels) : null) : null);
    Object.defineProperty(data, 'role', { get: () => data.defaultRole, set: (v) => { data.defaultRole = v; }, enumerable: false, configurable: true });
    drawProv();
    const copyBtn = h('button', { type: 'button', class: 'small', onclick: () => navigator.clipboard.writeText(cfg.redirectUri).then(() => toast('Copied', 'ok'), () => {}) }, icon('copy'), 'Copy');
    const test = async (btn) => {
      btn.disabled = true;
      put(result, h('div', { class: 'cam-result' }, h('b', null, 'Testing…')));
      const r = await POST('/api/sso/test', data).catch((err) => ({ ok: false, steps: [{ ok: false, text: err.message }] }));
      put(result, h('div', { class: `cam-result ${r.ok ? 'ok' : 'err'}` }, h('b', null, r.ok ? 'Configuration works' : 'Configuration does not work yet'),
        h('ul', { class: 'test-steps' }, r.steps.map((st) => h('li', { class: st.ok === true ? 'ok' : st.ok === false ? 'err' : 'warn' }, st.ok === true ? '✓ ' : st.ok === false ? '✕ ' : '! ', st.text)))));
      btn.disabled = false;
    };
    const save = async () => {
      try { await PUT('/api/sso', data); toast('SSO settings saved', 'ok'); route(); } catch (err) { fail(err); }
    };
    const testBtn = h('button', { onclick: () => test(testBtn) }, 'Test configuration');
    main.append(h('div', { class: 'row between' }, h('div', null, h('a', { href: '#users', class: 'muted small' }, '← Users and roles'), h('h1', null, 'Configure SSO')),
      h('div', { class: 'row' }, testBtn, h('button', { class: 'primary', onclick: save }, 'Save'))),
      h('div', { class: 'grid two' },
        h('div', { class: 'stack' },
          h('div', { class: 'card stack' },
            h('div', { class: 'row between' }, h('div', { class: 'row' }, msLogo(), h('h2', { style: { margin: 0 } }, 'Microsoft Entra ID')),
              h('label', { class: 'row', style: { gap: '8px' } }, h('span', null, 'Sign-in on'), h('label', { class: 'switch' }, h('input', { type: 'checkbox', checked: data.enabled, onchange: (e) => { data.enabled = e.target.checked; } }), h('span')))),
            h('div', { class: 'fields' },
              field('Directory (tenant) ID', bind(data, 'tenantId', () => {}, 'text', { placeholder: '00000000-0000-0000-0000-000000000000' }), { wide: true }),
              field('Application (client) ID', bind(data, 'clientId', () => {}, 'text', { placeholder: '00000000-0000-0000-0000-000000000000' }), { wide: true }),
              field('Client secret', bind(data, 'clientSecret', () => {}, 'password', { placeholder: cfg.hasClientSecret ? '•••••••• (saved, leave empty to keep)' : 'The secret value, not its ID' }), { wide: true }),
              field('Button text on the login page', bind(data, 'buttonLabel', () => {}), { wide: true })),
            h('div', null, h('div', { class: 'label' }, 'Redirect URI'), h('div', { class: 'row', style: { flexWrap: 'nowrap' } }, h('code', { class: 'redirect-uri' }, cfg.redirectUri), copyBtn),
              h('div', { class: 'hint' }, 'Register this as a Web redirect URI in the app registration. It follows the server address under Settings → Application.')),
            result),
          h('div', { class: 'card stack' }, h('h2', null, 'Users'), provBox,
            h('div', null, h('div', { class: 'label' }, 'Roles from Entra (optional)'),
              h('div', { class: 'hint', style: { marginBottom: '8px' } }, 'Give app roles in the app registration and enter their values here; a user then gets that role at every sign-in. Leave empty to set roles in Beeldkrant.'),
              h('div', { class: 'fields' }, ['admin', 'user', 'readonly'].map((r) => field(ROLE_LABELS[r], bind(data.roleClaims, r, () => {}, 'text', { placeholder: `e.g. Beeldkrant.${ROLE_LABELS[r].replace(' ', '')}` }))))))),
        h('div', { class: 'card stack sso-steps' }, h('h2', null, 'Setting up in Microsoft Entra'),
          h('ol', null,
            h('li', null, 'Open the ', h('b', null, 'Microsoft Entra admin center'), ' → Identity → Applications → ', h('b', null, 'App registrations'), ' → New registration.'),
            h('li', null, 'Name it, e.g. "Beeldkrant". Supported account types: ', h('i', null, 'Accounts in this organizational directory only'), '.'),
            h('li', null, 'Redirect URI: platform ', h('b', null, 'Web'), ', with the address shown here.'),
            h('li', null, 'Copy the ', h('b', null, 'Application (client) ID'), ' and ', h('b', null, 'Directory (tenant) ID'), ' from the Overview page.'),
            h('li', null, 'Certificates & secrets → New client secret; copy its ', h('b', null, 'Value'), '.'),
            h('li', null, 'To add users from Entra: API permissions → Add → Microsoft Graph → ', h('b', null, 'Application permissions'), ' → User.Read.All, then ', h('b', null, 'Grant admin consent'), '.'),
            h('li', null, 'Optional: App roles → create roles (e.g. Beeldkrant.Admin) and assign them under Enterprise applications → Users and groups.'),
            h('li', null, 'Enter the values here, ', h('b', null, 'Test configuration'), ', switch sign-in on and Save.')),
          h('p', { class: 'hint' }, 'Two-step verification and password rules for these users are set in Entra (Conditional Access). Keep at least one admin with a password, so you can still log in if Microsoft sign-in stops working.'))));
  }

  // ---------- settings: security ----------
  async function pageSecurity(main) {
    const [sec, users] = await Promise.all([GET('/api/security'), GET('/api/users')]);
    const pol = { ...sec.passwordPolicy };
    const local = users.filter((u) => u.authMethod !== 'sso');
    const ssoUsers = users.filter((u) => u.authMethod === 'sso');
    const setRequired = async (u, on) => {
      try { await PUT(`/api/users/${u.id}`, { mfaRequired: on }); u.mfaRequired = on; toast(`${u.displayName || u.username}: two-step verification ${on ? 'required' : 'no longer required'}`, 'ok'); } catch (err) { fail(err); route(); }
    };
    const mfaRows = local.map((u) => h('tr', null,
      h('td', null, h('b', null, u.displayName || u.username), h('div', { class: 'muted small' }, ROLE_LABELS[u.role])),
      h('td', null, u.mfaEnabled ? h('span', { class: 'badge ok' }, 'Set up') : h('span', { class: 'muted small' }, u.mfaRequired ? 'Sets it up at next login' : 'Not set up')),
      h('td', null, h('label', { class: 'switch', title: 'Required' }, h('input', { type: 'checkbox', checked: u.mfaRequired, onchange: (e) => setRequired(u, e.target.checked) }), h('span'))),
      h('td', { style: { textAlign: 'right' } }, u.mfaEnabled ? h('button', { class: 'small ghost', onclick: async () => { if (await confirmBox(`Reset two-step verification of ${u.username}? Their authenticator app stops working for Beeldkrant.`)) { await POST(`/api/users/${u.id}/mfa/reset`).catch(fail); route(); } } }, 'Reset') : null)));
    main.append(h('h1', null, 'Security'),
      h('div', { class: 'grid two' },
        h('div', { class: 'card stack' }, h('h2', null, 'Two-step verification (MFA)'),
          h('p', { class: 'muted' }, 'A user with MFA required needs a code from an authenticator app (such as Microsoft Authenticator) at every login. They set up the app at their next login and get recovery codes.'),
          h('div', { class: 'row' },
            h('button', { class: 'small', onclick: async () => { for (const u of local.filter((x) => !x.mfaRequired)) await PUT(`/api/users/${u.id}`, { mfaRequired: true }).catch(fail); route(); } }, 'Require for everyone'),
            h('button', { class: 'small', onclick: async () => { for (const u of local.filter((x) => x.role === 'admin' && !x.mfaRequired)) await PUT(`/api/users/${u.id}`, { mfaRequired: true }).catch(fail); route(); } }, 'Require for admins')),
          h('table', { class: 'list' }, h('thead', null, h('tr', null, h('th', null, 'User'), h('th', null, 'Status'), h('th', null, 'Required'), h('th'))), h('tbody', null, mfaRows)),
          ssoUsers.length ? h('p', { class: 'hint' }, `${ssoUsers.length} user${ssoUsers.length === 1 ? '' : 's'} sign${ssoUsers.length === 1 ? 's' : ''} in with Microsoft; Entra ID handles their two-step verification.`) : null),
        h('div', { class: 'card stack' }, h('h2', null, 'Password policy'),
          h('div', { class: `notice ${sec.ssoEnabled ? 'strong' : ''}` }, msLogo(), h('span', null, h('b', null, 'Microsoft Entra SSO: '), 'users who sign in with Microsoft do not use this policy. Their password (and its rules and expiry) is managed in Microsoft Entra ID.')),
          h('div', { class: 'fields' },
            field('Minimum length', bind(pol, 'minLength', () => {}, 'number', { min: 6, max: 128 }), { hint: 'Characters, 6 or more' }),
            field('Password expires after (days)', bind(pol, 'expiryDays', () => {}, 'number', { min: 0, max: 3650 }), { hint: '0 = never. An expired password must be changed at the next login.' }),
            h('label', { class: 'check wide' }, bind(pol, 'requireSpecial', () => {}, 'checkbox'), 'Require a special character (such as ! ? # %)'),
            h('label', { class: 'check wide' }, bind(pol, 'requireMixed', () => {}, 'checkbox'), 'Require upper case and lower case letters and a number')),
          h('p', { class: 'hint' }, 'The policy applies when a password is set or changed; existing passwords keep working until they expire.'),
          h('div', null, h('button', { class: 'primary', onclick: async () => {
            try { const r = await PUT('/api/security', { passwordPolicy: pol }); me.passwordPolicy = r.passwordPolicy; toast('Password policy saved', 'ok'); } catch (err) { fail(err); }
          } }, 'Save policy')))));
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
            location === 'local' ? set.files.map((f) => h('a', { class: 'btn small', style: { marginLeft: '4px' }, href: `${BASE}/api/backups/download/${encodeURIComponent(f.name)}`, title: f.name }, set.files.length > 1 ? `↓ ${f.parts.map((p) => PART_LABELS[p]).join(', ')}` : '↓ Download')) : null,
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
