/* Wimap app: home, live scan, map, menus, preferences and exports.
   Talks to the native host through WebView2 messages. In a plain browser a small stand-in host
   replays a recorded scan (sample.json), which is how the UI is developed and tested. */
(function () {
  'use strict';
  const { esc, fmtNum, fmtSize, fmtWhen, sanitize, ORDER } = window.WimapUtil;
  const $ = id => document.getElementById(id);

  const BRANCHES = {
    apps: { label: 'Apps', hint: 'Registry, Microsoft Store, Steam and Epic, with their folders' },
    ai: { label: 'AI tools', hint: 'MCP servers, plugins, skills, agents and local models' },
    browsers: { label: 'Browsers', hint: 'Bookmarks and extensions in every profile' },
    files: { label: 'Your files', hint: 'Desktop, Documents, Downloads, Pictures and the rest' },
    drives: { label: 'Drives', hint: 'Each disk with its space and top folders' },
    dev: { label: 'Dev kit', hint: 'Runtimes, global packages, editor extensions, WSL' },
    system: { label: 'System', hint: 'What starts with Windows and fonts you installed' },
  };
  const STAGE_NAME = { apps: 'Apps and their folders', ai: 'AI tools', browsers: 'Browsers', files: 'Your files', drives: 'Drives', dev: 'Dev kit', system: 'Startup and fonts' };

  /* ---------- preferences ---------- */

  const reduceMotion = matchMedia('(prefers-reduced-motion: reduce)').matches;
  const DEFAULTS = {
    branches: Object.keys(BRANCHES), depth: 3,
    panel: 'right', panelSize: 360, panelHeight: 300, tools: true, legend: true, hints: true,
    labelScale: 1, links: 'curved', openDepth: 2, icons: true, motion: !reduceMotion, rotateGestures: true,
    welcome: true,
  };
  const ALLOWED = { panel: ['right', 'left', 'bottom'], labelScale: [0.9, 1, 1.2], links: ['curved', 'straight'], openDepth: [1, 2, 3], depth: [2, 3, 4] };

  /** Stored preferences are checked field by field, so a damaged or old value falls back to its default. */
  function cleanPrefs(p) {
    const out = { ...DEFAULTS, branches: [...DEFAULTS.branches] };
    if (!p || typeof p !== 'object') return out;
    for (const k of Object.keys(DEFAULTS)) {
      const v = p[k];
      if (ALLOWED[k]) { if (ALLOWED[k].includes(v)) out[k] = v; }
      else if (typeof DEFAULTS[k] === 'boolean') { if (typeof v === 'boolean') out[k] = v; }
      else if (typeof DEFAULTS[k] === 'number') { if (typeof v === 'number' && isFinite(v)) out[k] = v; }
      else if (k === 'branches' && Array.isArray(v)) out[k] = v.filter(b => BRANCHES[b]);
    }
    return out;
  }
  let prefs = cleanPrefs(null);
  try { prefs = cleanPrefs(JSON.parse(localStorage.getItem('wimap:prefs') || 'null')); } catch { /* storage unavailable: defaults */ }
  const savePrefs = () => { try { localStorage.setItem('wimap:prefs', JSON.stringify(prefs)); } catch { /* not persisted */ } };
  const viewerPrefs = () => {
    const { panel, panelSize, panelHeight, tools, legend, hints, labelScale, links, icons, motion, rotateGestures } = prefs;
    return { panel, panelSize, panelHeight, tools, legend, hints, labelScale, links, icons, motion, rotateGestures };
  };

  /* ---------- host bridge ---------- */

  const wv = window.chrome && window.chrome.webview;
  const handlers = [];
  const on = fn => handlers.push(fn);
  const emit = msg => { for (const h of handlers) h(msg); };
  const send = msg => (wv ? wv.postMessage(msg) : devHost(msg));
  if (wv) wv.addEventListener('message', e => emit(e.data));
  // Outside the app (UI development in a browser) the viewer is reachable from the console.
  else Object.defineProperty(window, 'wimapDev', { get: () => ({ viewer, state, prefs }) });

  /** Stand-in host for a plain browser: replays sample.json and fakes the file dialogs. */
  async function devHost(msg) {
    const sample = () => fetch('sample.json').then(r => (r.ok ? r.json() : null)).catch(() => null);
    const later = (m, ms = 300) => setTimeout(() => emit(m), ms);
    switch (msg.type) {
      case 'hello': emit({ type: 'hello', machine: 'This PC', user: 'you', version: 'dev', last: await sample() }); break;
      case 'scan': {
        const d = await sample();
        if (!d) return;
        const t0 = performance.now();
        let files = 0;
        const tick = setInterval(() => { files += 3211; emit({ type: 'tick', files, bytes: files * 912345, path: 'C:\\Program Files\\Example\\resources\\app' }); }, 150);
        for (const c of d.root.c) emit({ type: 'stage', key: c.ck, state: 'running' });
        for (const c of [...d.root.c].reverse()) { await new Promise(r => setTimeout(r, 400)); emit({ type: 'branch', key: c.ck, node: c, icons: d.icons }); }
        clearInterval(tick);
        emit({ type: 'done', cancelled: false, data: { ...d, ms: Math.round(performance.now() - t0) } });
        break;
      }
      case 'saveFile': later({ type: 'saved', kind: msg.kind, path: `C:\\Users\\you\\Documents\\${msg.name}.${msg.kind}`, winget: msg.winget ? `C:\\Users\\you\\Documents\\${msg.name}-winget.json` : null }); break;
      case 'openMap': {
        const input = document.createElement('input');
        input.type = 'file';
        input.accept = '.html,.htm,.json';
        input.onchange = async () => { const f = input.files[0]; if (f) emit({ type: 'opened', name: f.name.replace(/\.[^.]+$/, ''), text: await f.text() }); };
        input.click();
        break;
      }
      case 'forget': later({ type: 'forgotten' }, 50); break;
      default: break;
    }
  }

  /* ---------- state ---------- */

  const state = { machine: 'This PC', version: '', data: null, last: null, scanning: false, screen: 'home' };
  const countNodes = n => { let c = 0; const w = x => { c++; (x.c || []).forEach(w); }; w(n); return c; };
  const secs = ms => (ms < 60000 ? `${(ms / 1000).toFixed(1)} s` : `${Math.floor(ms / 60000)} min ${Math.round((ms % 60000) / 1000)} s`);
  let viewer = null;
  const onMap = () => state.screen === 'map' && !!viewer;
  const hasMap = () => onMap() && !!state.data && !state.scanning;

  /* ---------- small UI helpers ---------- */

  /** Radio-style segmented control with arrow-key support. Returns a setter. */
  function bindSeg(seg, value, onChange) {
    const buttons = [...seg.querySelectorAll('[role="radio"]')];
    const val = b => b.dataset.v ?? b.dataset.depth;
    const set = v => buttons.forEach(b => { const sel = val(b) === String(v); b.setAttribute('aria-checked', String(sel)); b.tabIndex = sel ? 0 : -1; });
    set(value);
    seg.addEventListener('click', e => { const b = e.target.closest('[role="radio"]'); if (b) { set(val(b)); onChange(val(b)); } });
    seg.addEventListener('keydown', e => {
      const i = buttons.indexOf(document.activeElement);
      if (i === -1 || !['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown'].includes(e.key)) return;
      e.preventDefault();
      const b = buttons[(i + (e.key === 'ArrowRight' || e.key === 'ArrowDown' ? 1 : -1) + buttons.length) % buttons.length];
      b.focus();
      b.click();
    });
    return set;
  }

  const openDialog = dlg => { if (!dlg.open) dlg.showModal(); };
  document.querySelectorAll('dialog').forEach(dlg => {
    // A click on the dimmed backdrop lands on the dialog element itself.
    dlg.addEventListener('click', e => { if (e.target === dlg || e.target.closest('[data-close]')) dlg.close(); });
  });

  function ask(title, text, okLabel) {
    const dlg = $('confirmDlg');
    $('cfTitle').textContent = title;
    $('cfText').textContent = text;
    $('cfOk').textContent = okLabel;
    dlg.returnValue = '';
    openDialog(dlg);
    return new Promise(resolve => dlg.addEventListener('close', () => resolve(dlg.returnValue === 'ok'), { once: true }));
  }

  const toast = text => (viewer ? viewer.toast(text) : console.info(text));

  /* ---------- home ---------- */

  const rows = $('scanRows');
  for (const [key, b] of Object.entries(BRANCHES)) {
    const row = document.createElement('label');
    row.className = 'row';
    row.style.setProperty('--c', `var(--c-${key})`);
    row.innerHTML = `<span class="dot"></span><span class="t"><b>${b.label}</b><small>${b.hint}</small></span>
      <span class="switch"><input type="checkbox" data-key="${key}" ${prefs.branches.includes(key) ? 'checked' : ''} aria-label="${b.label}"><span></span></span>`;
    rows.appendChild(row);
  }
  $('startScan').disabled = prefs.branches.length === 0;
  rows.addEventListener('change', () => {
    prefs.branches = [...rows.querySelectorAll('input:checked')].map(i => i.dataset.key);
    $('startScan').disabled = prefs.branches.length === 0;
    savePrefs();
  });
  bindSeg($('depthSeg'), prefs.depth, v => { prefs.depth = +v; savePrefs(); });

  const preview = new window.WMap($('previewCanvas'), { order: ORDER, prefs: { labelScale: prefs.labelScale, icons: prefs.icons, links: prefs.links, motion: prefs.motion } });
  function showPreview() {
    if (state.last) {
      preview.setData(state.last.root, state.last.icons, { openDepth: 2 });
      $('visualNote').textContent = `Your last map · ${fmtWhen(state.last.at)} · ${fmtNum(countNodes(state.last.root) - 1)} points`;
    } else {
      preview.setData({ n: state.machine, k: 'root', c: ORDER.map(k => ({ n: BRANCHES[k].label, k: 'cat', ck: k })) }, {}, { openDepth: 2 });
      $('visualNote').textContent = 'The branches Wimap will draw';
    }
    $('openLast').hidden = !state.last;
  }

  /* ---------- screens ---------- */

  function showScreen(name) {
    state.screen = name;
    $('home').hidden = name !== 'home';
    $('mapScreen').hidden = name !== 'map';
    const mapActions = name === 'map' && !state.scanning;
    $('newScan').hidden = !mapActions;
    $('openExport').hidden = !mapActions;
    if (name === 'map' && !viewer) {
      viewer = new window.WimapViewer($('viewer'), {
        reveal: path => send({ type: 'reveal', path }),
        canReveal: () => state.source !== 'file',
        url: url => send({ type: 'url', url }),
        onPrefs: p => { prefs.panel = p.panel; prefs.panelSize = p.panelSize; prefs.panelHeight = p.panelHeight; savePrefs(); },
      }, viewerPrefs());
    }
    if (name === 'map') viewer.map.resize(); else preview.resize();
  }

  function setWhere(d) {
    $('where').innerHTML = d ? `<b>${esc(d.machine || state.machine)}</b>${d.os ? ' · ' + esc(d.os) : ''}` : '';
  }

  function openMap(d, extra, source = 'scan') {
    state.data = d;
    state.source = source;
    showScreen('map');
    viewer.load(d, { openDepth: prefs.openDepth });
    viewer.renderStatus(extra ?? (d.ms ? `took ${secs(d.ms)}` : ''));
    setWhere(d);
    viewer.canvas.focus({ preventScroll: true });
  }

  function goHome() {
    if (state.scanning) return;
    showPreview();
    setWhere(null);
    showScreen('home');
    $('startScan').focus();
  }

  /* ---------- scan ---------- */

  let t0 = 0, clock = null;
  function startScan() {
    if (state.scanning || !prefs.branches.length) return;
    state.scanning = true;
    showScreen('map');
    $('mapScreen').classList.add('scanning');
    setWhere({ machine: state.machine });
    // Branches still being read show as faint dots until their data arrives.
    viewer.load({ root: { n: state.machine, k: 'root', c: ORDER.filter(k => prefs.branches.includes(k)).map(k => ({ n: BRANCHES[k].label, k: 'cat', ck: k, pend: true })) }, icons: {} });
    viewer.renderStatus('');
    const panel = $('scanPanel');
    panel.hidden = false;
    panel.classList.remove('leaving');
    $('spTitle').textContent = `Mapping ${state.machine}`;
    $('stages').innerHTML = ORDER.filter(k => prefs.branches.includes(k)).map(k =>
      `<li data-k="${k}" style="--c:var(--c-${k})"><span class="st"></span><span>${STAGE_NAME[k]}</span><span class="v num">waiting</span></li>`).join('');
    $('spFiles').textContent = 'Starting';
    $('spPath').textContent = '';
    $('stopScan').disabled = false;
    t0 = performance.now();
    clearInterval(clock);
    clock = setInterval(() => { $('spTime').textContent = secs(performance.now() - t0); }, 100);
    const options = { depth: prefs.depth };
    for (const k of Object.keys(BRANCHES)) options[k] = prefs.branches.includes(k);
    send({ type: 'scan', options });
  }

  /** Accepts a Wimap .json file or an exported .html map. */
  function parseMapFile(text) {
    const t = String(text || '').trim();
    let raw;
    if (t.startsWith('{')) raw = JSON.parse(t);
    else {
      const m = /<script type="application\/json" id="wimap-data">([\s\S]*?)<\/script>/.exec(t);
      if (!m) throw new Error('This file is not a Wimap map.');
      raw = JSON.parse(m[1]);
    }
    return sanitize(raw);
  }

  on(msg => {
    switch (msg.type) {
      case 'hello':
        state.machine = msg.machine || state.machine;
        state.version = msg.version || '';
        try { state.last = msg.last ? sanitize(msg.last) : null; } catch { state.last = null; }
        showPreview();
        if (prefs.welcome) openWelcome();
        break;
      case 'stage': {
        const li = document.querySelector(`#stages li[data-k="${msg.key}"]`);
        if (li && !li.classList.contains('done')) { li.className = 'running'; li.querySelector('.v').textContent = 'reading'; }
        break;
      }
      case 'branch': {
        if (!state.scanning || !viewer) break;
        const li = document.querySelector(`#stages li[data-k="${msg.key}"]`);
        if (msg.node) {
          viewer.map.putBranch(msg.node, msg.icons);
          viewer.data.icons = viewer.map.icons;
          viewer.renderLegend();
          viewer.renderStatus();
          viewer.map.fit(true);
          if (li) { li.className = 'done'; li.querySelector('.v').textContent = fmtNum(countNodes(msg.node) - 1); }
        } else if (li) { li.className = 'failed'; li.querySelector('.v').textContent = 'skipped'; }
        break;
      }
      case 'tick':
        if (state.scanning) { $('spFiles').textContent = `${fmtNum(msg.files)} files · ${fmtSize(msg.bytes)}`; $('spPath').textContent = msg.path || ''; }
        break;
      case 'done': {
        state.scanning = false;
        clearInterval(clock);
        const d = msg.data;
        if (!msg.cancelled) state.last = d;
        $('spTitle').textContent = msg.cancelled ? 'Stopped' : `Mapped in ${secs(d.ms)}`;
        $('stopScan').disabled = true;
        $('mapScreen').classList.remove('scanning');
        openMap(d, msg.cancelled ? 'stopped early' : `took ${secs(d.ms)}`);
        viewer.map.fit(true);
        toast(`${fmtNum(countNodes(d.root) - 1)} points mapped in ${secs(d.ms)}`);
        setTimeout(() => { $('scanPanel').classList.add('leaving'); setTimeout(() => { $('scanPanel').hidden = true; }, 320); }, 1600);
        break;
      }
      case 'opened':
        if (msg.cancelled) break;
        try { openMap(parseMapFile(msg.text), `opened from ${msg.name}`, 'file'); }
        catch (e) { toast(e instanceof SyntaxError ? 'That file is damaged and could not be read' : e.message || 'That file could not be opened'); }
        break;
      case 'forgotten':
        state.last = null;
        showPreview();
        toast('Saved map forgotten');
        break;
      case 'error':
        toast(msg.message || 'Something went wrong');
        $('exSave').disabled = false; $('exSave').textContent = 'Save HTML';
        $('imSave').disabled = false;
        break;
      default: break;
    }
  });

  $('startScan').addEventListener('click', startScan);
  $('openLast').addEventListener('click', () => state.last && openMap(state.last));
  $('openFileBtn').addEventListener('click', () => send({ type: 'openMap' }));
  $('stopScan').addEventListener('click', () => { send({ type: 'cancel' }); $('stopScan').disabled = true; $('spFiles').textContent = 'Stopping'; });
  $('newScan').addEventListener('click', goHome);

  /* ---------- export: HTML ---------- */

  const exDlg = $('exportDlg');
  let exTimer = null, lastSaved = null;
  const fileName = t => t.replace(/[\\/:*?"<>|\u0000-\u001f]+/g, '').trim() || 'wimap';

  function exportOptions() {
    return {
      title: $('exName').value.trim() || `${state.data.machine || state.machine} map`,
      branches: [...$('exBranches').querySelectorAll('input:checked')].map(i => i.value),
      bookmarks: $('exBookmarks').checked,
      hideUser: $('exHideUser').checked,
      icons: $('exIcons').checked,
    };
  }

  function openExport() {
    if (!hasMap()) return;
    const d = state.data;
    if (!$('exName').value) $('exName').value = `${d.machine || state.machine} map`;
    $('exHome').textContent = d.home || 'C:\\Users\\you';
    $('exBranches').innerHTML = (d.root.c || []).map(c =>
      `<label class="check"><input type="checkbox" value="${esc(c.ck)}" checked><span><i class="dot" style="--c:var(--c-${esc(c.ck)})"></i>${esc(c.n)}</span><span class="n num">${fmtNum(countNodes(c) - 1)}</span></label>`).join('');
    const iconBytes = Object.values(d.icons || {}).reduce((a, s) => a + s.length, 0);
    $('exIconSize').textContent = `${fmtNum(Object.keys(d.icons || {}).length)} icons, about ${fmtSize(iconBytes)}`;
    $('exDone').hidden = true;
    $('exFoot').hidden = false;
    openDialog(exDlg);
    refreshPreview(0);
  }

  function refreshPreview(delay = 280) {
    clearTimeout(exTimer);
    exTimer = setTimeout(async () => {
      const o = exportOptions();
      $('exFile').textContent = fileName(o.title) + '.html';
      const { html } = await window.WimapExport.build(state.data, o);
      $('exSize').textContent = `${fmtSize(new Blob([html]).size)} file`;
      // The host serves the preview from a sandboxed address; a plain browser uses srcdoc.
      if (wv) send({ type: 'preview', html }); else $('exFrame').srcdoc = html;
    }, delay);
  }
  on(msg => { if (msg.type === 'previewReady' && exDlg.open) $('exFrame').src = `__preview.html?v=${msg.id}`; });

  exDlg.addEventListener('close', () => { clearTimeout(exTimer); $('exFrame').removeAttribute('src'); $('exFrame').removeAttribute('srcdoc'); });
  // Typing a title only renames the file; the preview is rebuilt when an option is committed (checkbox, or leaving the field).
  $('exName').addEventListener('input', () => { $('exFile').textContent = fileName(exportOptions().title) + '.html'; });
  $('exForm').addEventListener('change', () => { $('exDone').hidden = true; $('exFoot').hidden = false; refreshPreview(); });
  $('exForm').addEventListener('submit', async e => {
    e.preventDefault();
    const o = exportOptions();
    // Built from the options as they are right now, never from a preview that may predate the last click.
    const { html } = await window.WimapExport.build(state.data, o);
    $('exSave').disabled = true;
    $('exSave').textContent = 'Saving';
    send({ type: 'saveFile', kind: 'html', name: fileName(o.title), data: html, encoding: 'text', winget: $('exWinget').checked });
  });
  $('exOpen').addEventListener('click', () => lastSaved && send({ type: 'openFile', path: lastSaved }));
  $('exReveal').addEventListener('click', () => lastSaved && send({ type: 'reveal', path: lastSaved }));

  on(msg => {
    if (msg.type === 'saving' && msg.step === 'winget') $('exSave').textContent = 'Running winget export';
    if (msg.type !== 'saved') return;
    $('exSave').disabled = false;
    $('exSave').textContent = 'Save HTML';
    $('imSave').disabled = false;
    if (!msg.path) return; // the save dialog was cancelled
    if (msg.kind !== 'html') { toast(`Saved ${msg.path}`); if ($('imageDlg').open) $('imageDlg').close(); return; }
    lastSaved = msg.path;
    $('exPath').textContent = msg.path;
    const wm = $('exWingetMsg');
    wm.hidden = !(msg.winget || msg.wingetError);
    wm.textContent = msg.winget ? `Also saved ${msg.winget}` : msg.wingetError ? `winget file not saved: ${msg.wingetError}` : '';
    $('exDone').hidden = false;
    $('exFoot').hidden = true;
  });

  /* ---------- export: image ---------- */

  const im = { format: 'png', area: 'view', scale: 2, bg: 'dark' };
  for (const seg of $('imageDlg').querySelectorAll('.seg[data-name]')) {
    const k = seg.dataset.name;
    bindSeg(seg, im[k], v => { im[k] = k === 'scale' ? +v : v; updateImage(); });
  }

  const imageBackground = () => (im.format === 'jpeg' || im.bg === 'dark' ? viewer.map.col.bg : null);

  function updateImage() {
    const map = viewer.map;
    const vector = im.format === 'svg';
    $('imScaleOpt').hidden = vector;
    $('imBgOpt').hidden = im.format === 'jpeg';
    const s = vector ? 1 : im.scale;
    const f = map.frameFor(im.area, vector ? 20000 : 8192, s);
    $('imInfo').textContent = vector ? `${fmtNum(f.W)} × ${fmtNum(f.H)}, scales without blur` : `${fmtNum(Math.round(f.W * s))} × ${fmtNum(Math.round(f.H * s))} px`;
    const p = Math.min(1, 900 / Math.max(f.W, f.H, 1));
    $('imPreview').src = map.renderCanvas({ area: im.area, scale: p, background: imageBackground() }).toDataURL('image/png');
  }

  function openImage() {
    if (!hasMap()) return;
    openDialog($('imageDlg'));
    updateImage();
  }

  $('imForm').addEventListener('submit', e => {
    e.preventDefault();
    const map = viewer.map;
    const name = `${fileName(state.data.machine || state.machine)} map`;
    $('imSave').disabled = true;
    if (im.format === 'svg') {
      send({ type: 'saveFile', kind: 'svg', name, data: map.renderSVG({ area: im.area, background: imageBackground() }), encoding: 'text' });
      return;
    }
    const cv = map.renderCanvas({ area: im.area, scale: im.scale, background: imageBackground() });
    cv.toBlob(blob => {
      if (!blob) { $('imSave').disabled = false; toast('That image is too large. Try a lower resolution.'); return; }
      const r = new FileReader();
      r.onload = () => send({ type: 'saveFile', kind: im.format, name, data: String(r.result).split(',')[1], encoding: 'base64' });
      r.readAsDataURL(blob);
    }, im.format === 'jpeg' ? 'image/jpeg' : 'image/png', 0.92);
  });

  /* ---------- export: map data ---------- */

  function saveData() {
    if (!hasMap()) return;
    send({ type: 'saveFile', kind: 'json', name: `${fileName(state.data.machine || state.machine)} map`, data: JSON.stringify(state.data), encoding: 'text' });
  }

  /* ---------- preferences ---------- */

  const prDlg = $('prefsDlg');
  const prefSetters = {};
  for (const seg of prDlg.querySelectorAll('.seg[data-pref]')) {
    const k = seg.dataset.pref;
    prefSetters[k] = bindSeg(seg, prefs[k], v => setPref(k, typeof DEFAULTS[k] === 'number' ? +v : v));
  }
  for (const input of prDlg.querySelectorAll('input[data-pref]')) {
    input.checked = !!prefs[input.dataset.pref];
    input.addEventListener('change', () => setPref(input.dataset.pref, input.checked));
  }

  function setPref(k, v) {
    prefs[k] = v;
    savePrefs();
    applyPrefs();
  }

  function applyPrefs() {
    if (viewer) viewer.setPrefs(viewerPrefs());
    preview.setPrefs({ labelScale: prefs.labelScale, icons: prefs.icons, links: prefs.links, motion: prefs.motion });
    for (const [k, set] of Object.entries(prefSetters)) set(prefs[k]);
    for (const input of prDlg.querySelectorAll('input[data-pref]')) input.checked = !!prefs[input.dataset.pref];
  }

  $('prForget').addEventListener('click', async () => {
    if (await ask('Forget the saved map?', 'The last map stored in your app data is deleted. Maps you exported stay where you saved them.', 'Forget')) send({ type: 'forget' });
  });
  $('prReset').addEventListener('click', () => {
    prefs = { ...cleanPrefs(null), branches: prefs.branches, depth: prefs.depth };
    savePrefs();
    applyPrefs();
  });

  /* ---------- welcome ---------- */

  const wcDlg = $('welcomeDlg');
  let wcMap = null;
  /** Opens over the home screen. The map on the left grows in once (WMap.intro); nothing loops. */
  function openWelcome() {
    if (wcDlg.open || state.scanning) return;
    $('wcHide').checked = !prefs.welcome;
    wcDlg.returnValue = '';
    openDialog(wcDlg);
    if (!wcMap) wcMap = new window.WMap($('welcomeCanvas'), { order: ORDER, prefs: { icons: prefs.icons, motion: prefs.motion, links: prefs.links } });
    wcMap.resize();
    const root = state.last ? state.last.root : { n: state.machine, k: 'root', c: ORDER.map(k => ({ n: BRANCHES[k].label, k: 'cat', ck: k })) };
    wcMap.setData(root, state.last ? state.last.icons : {}, { openDepth: 2 });
    wcMap.intro();
  }
  wcDlg.addEventListener('close', () => {
    prefs.welcome = !$('wcHide').checked;
    savePrefs();
    applyPrefs();
    if (wcDlg.returnValue === 'scan' && state.screen === 'home') startScan();
  });

  /* ---------- shortcuts dialog ---------- */

  const kbd = s => s.split(' ').map(k => `<kbd>${esc(k)}</kbd>`).join('');
  $('keysBody').innerHTML = [
    ['On the map', [
      ['Move', 'Drag'], ['Zoom', 'Scroll'], ['Rotate', 'Right-drag'], ['Rotate', 'Alt Scroll'],
      ['Open or fold a branch', 'Click'], ['Zoom in on it', 'Double-click'], ['Touch: zoom and rotate', 'Pinch Twist'],
    ]],
    ['Keys', [
      ['Find', '/'], ['Next match', 'Enter'], ['Move between items', '← → ↑ ↓'], ['Open or fold', 'Enter'],
      ['Zoom', '+ −'], ['Fit the map', '0'], ['Rotate', '[ ]'], ['Reset rotation', 'R'], ['Clear selection', 'Esc'],
    ]],
    ['App', [
      ['New scan', 'Ctrl N'], ['Open a map file', 'Ctrl O'], ['Save map data', 'Ctrl S'],
      ['Export HTML', 'Ctrl E'], ['Export image', 'Ctrl Shift E'], ['Preferences', 'Ctrl ,'], ['Menu bar', 'Alt'],
    ]],
    ['Search', [
      ['Every word must match', 'chrome dev'], ['Exact phrase', '"remote desktop"'], ['One branch', 'in:browsers'],
      ['One kind', 'is:extension'], ['Accents and case are ignored', 'resume = Résumé'],
    ]],
  ].map(([title, list]) => `<section><h3>${esc(title)}</h3><dl>${list.map(([a, b]) => `<dt>${esc(a)}</dt><dd>${kbd(b)}</dd>`).join('')}</dl></section>`).join('');

  /* ---------- menus and shortcuts ---------- */

  const cmd = name => () => viewer && viewer.command(name);
  const menuSpec = [
    { label: 'File', items: [
      { label: 'New scan', keys: 'Ctrl+N', run: goHome, enabled: () => !state.scanning },
      { label: 'Open a map file…', keys: 'Ctrl+O', run: () => send({ type: 'openMap' }), enabled: () => !state.scanning },
      { label: 'Save map data…', keys: 'Ctrl+S', run: saveData, enabled: hasMap },
      '-',
      { label: 'Export HTML…', keys: 'Ctrl+E', run: openExport, enabled: hasMap },
      { label: 'Export image…', keys: 'Ctrl+Shift+E', run: openImage, enabled: hasMap },
      '-',
      { label: 'Exit', hint: 'Alt+F4', run: () => send({ type: 'exit' }) },
    ] },
    { label: 'Edit', items: [
      { label: 'Find', keys: 'Ctrl+F', run: () => viewer.focusSearch(), enabled: onMap },
      '-',
      { label: 'Copy name', run: () => viewer.copy(viewer.map.selected.name, 'Name copied'), enabled: () => onMap() && !!viewer.map.selected },
      { label: 'Copy path', keys: 'Ctrl+Shift+C', run: () => viewer.copy(viewer.map.selected.raw.p, 'Path copied'), enabled: () => onMap() && !!viewer.map.selected?.raw.p },
      '-',
      { label: 'Go to parent', keys: 'Backspace', run: cmd('parent'), enabled: () => onMap() && !!viewer.map.selected?.parent },
      { label: 'Clear selection', keys: 'Escape', hint: 'Esc', run: cmd('deselect'), enabled: () => onMap() && !!viewer.map.selected },
    ] },
    { label: 'View', items: [
      { label: 'Zoom in', keys: 'Ctrl+=', hint: 'Ctrl +', run: cmd('in'), enabled: onMap },
      { label: 'Zoom out', keys: 'Ctrl+-', hint: 'Ctrl −', run: cmd('out'), enabled: onMap },
      { label: 'Fit the map', keys: 'Ctrl+0', run: cmd('fit'), enabled: onMap },
      '-',
      { label: 'Rotate left', keys: '[', run: cmd('rotl'), enabled: onMap },
      { label: 'Rotate right', keys: ']', run: cmd('rotr'), enabled: onMap },
      { label: 'Reset rotation', keys: 'R', run: cmd('north'), enabled: onMap },
      '-',
      { label: 'Open everything', run: cmd('openall'), enabled: onMap },
      { label: 'Fold everything', run: cmd('foldall'), enabled: onMap },
      '-',
      { label: 'Navigation tools', type: 'check', checked: () => prefs.tools, run: () => setPref('tools', !prefs.tools) },
      { label: 'Branch filters', type: 'check', checked: () => prefs.legend, run: () => setPref('legend', !prefs.legend) },
      { label: 'Hints', type: 'check', checked: () => prefs.hints, run: () => setPref('hints', !prefs.hints) },
    ] },
    { label: 'Settings', items: [
      { label: 'Preferences…', keys: 'Ctrl+,', run: () => openDialog(prDlg) },
      { group: 'Details panel' },
      ...['right', 'left', 'bottom'].map(v => ({ label: v[0].toUpperCase() + v.slice(1), type: 'radio', checked: () => prefs.panel === v, run: () => setPref('panel', v) })),
      { group: 'Label size' },
      ...[[0.9, 'Small'], [1, 'Medium'], [1.2, 'Large']].map(([v, l]) => ({ label: l, type: 'radio', checked: () => prefs.labelScale === v, run: () => setPref('labelScale', v) })),
    ] },
    { label: 'Help', items: [
      { label: 'Welcome screen', run: openWelcome, enabled: () => !state.scanning },
      { label: 'Shortcuts and search', keys: 'F1', run: () => openDialog($('keysDlg')) },
      '-',
      { label: 'About Wimap', run: () => { $('abVersion').textContent = state.version; openDialog($('aboutDlg')); } },
    ] },
  ];
  const menubar = new window.WimapMenus.MenuBar($('menubar'), menuSpec);
  const accelerators = menubar.shortcuts().map(it => ({ it, match: window.WimapMenus.parseKeys(it.keys) }));

  const typing = () => /^(INPUT|TEXTAREA|SELECT)$/.test(document.activeElement?.tagName || '') || !!document.activeElement?.isContentEditable;
  let altAlone = false;
  document.addEventListener('keydown', e => {
    altAlone = e.key === 'Alt' && !e.repeat;
    if (e.defaultPrevented || document.querySelector('dialog[open]') || menubar.openIx !== -1) return;
    if (e.key === 'F10') { e.preventDefault(); menubar.focusBar(); return; }
    if (e.key === '/' && !typing() && onMap()) { e.preventDefault(); viewer.focusSearch(); return; }
    for (const { it, match } of accelerators) {
      if (!match(e)) continue;
      // Plain keys stay with a text field while typing; Ctrl shortcuts and F-keys work everywhere.
      if (typing() && !e.ctrlKey && !/^F\d+$/.test(e.key)) return;
      if (it.enabled && !it.enabled()) return;
      e.preventDefault();
      it.run();
      return;
    }
  });
  // A lone tap on Alt moves focus to the menu bar, like a native window.
  document.addEventListener('keyup', e => {
    if (e.key === 'Alt' && altAlone && !document.querySelector('dialog[open]')) { e.preventDefault(); menubar.focusBar(); }
    altAlone = false;
  });

  $('openPrefs').addEventListener('click', () => openDialog(prDlg));
  $('openExport').addEventListener('click', openExport);

  send({ type: 'hello' });
})();
