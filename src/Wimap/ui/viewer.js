/* Wimap viewer: the map plus search, legend, navigation tools and the findings panel.
   Used inside the app and inside exported HTML files. `host` decides what "open" means in each place. */
(function (global) {
  'use strict';

  const ICON = {
    search: '<circle cx="11" cy="11" r="7"/><path d="m20 20-3.5-3.5"/>',
    plus: '<path d="M12 5v14M5 12h14"/>',
    minus: '<path d="M5 12h14"/>',
    fit: '<path d="M4 9V5a1 1 0 0 1 1-1h4M15 4h4a1 1 0 0 1 1 1v4M20 15v4a1 1 0 0 1-1 1h-4M9 20H5a1 1 0 0 1-1-1v-4"/>',
    rotL: '<path d="M3 12a9 9 0 1 0 3-6.7L3 8"/><path d="M3 3v5h5"/>',
    rotR: '<path d="M21 12a9 9 0 1 1-3-6.7L21 8"/><path d="M21 3v5h-5"/>',
    folder: '<path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z"/>',
    link: '<path d="M14 4h6v6M20 4l-9 9M18 14v5a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1V7a1 1 0 0 1 1-1h5"/>',
    copy: '<rect x="9" y="9" width="11" height="11" rx="2"/><path d="M5 15V5a1 1 0 0 1 1-1h10"/>',
    expand: '<circle cx="12" cy="12" r="9"/><path d="M12 8v8M8 12h8"/>',
    fold: '<circle cx="12" cy="12" r="9"/><path d="M8 12h8"/>',
    target: '<circle cx="12" cy="12" r="8"/><circle cx="12" cy="12" r="2"/>',
    x: '<path d="M18 6 6 18M6 6l12 12"/>',
  };
  const svg = name => `<svg class="i" viewBox="0 0 24 24" aria-hidden="true">${ICON[name]}</svg>`;

  const KIND = {
    root: 'This PC', cat: 'Branch', group: 'Group', app: 'Desktop app', store: 'Microsoft Store app', game: 'Game',
    folder: 'Folder', file: 'File', exe: 'Program', more: 'Not drawn on the map', ai: 'AI tool', mcp: 'MCP server',
    plugin: 'Plugin', skill: 'Skill', agent: 'Agent', cmd: 'Command', doc: 'Memory file', model: 'Local model',
    browser: 'Browser', profile: 'Browser profile', bmf: 'Bookmark folder', bm: 'Bookmark', ext: 'Browser extension',
    drive: 'Drive', runtime: 'Runtime', pkg: 'npm package', vsx: 'Editor extension', startup: 'Starts with Windows',
    font: 'Font', wsl: 'WSL distro',
  };
  const ORDER = ['apps', 'ai', 'browsers', 'files', 'drives', 'dev', 'system'];
  const ROTATE_STEP = Math.PI / 12; // 15 degrees

  /* ---------- small helpers, shared with the app and the export page ---------- */

  function esc(s) { return String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c])); }
  function fmtSize(b) {
    if (typeof b !== 'number' || !isFinite(b)) return null;
    const u = ['B', 'KB', 'MB', 'GB', 'TB']; let v = b, i = 0;
    while (v >= 1024 && i < u.length - 1) { v /= 1024; i++; }
    const n = i === 0 ? b : v >= 100 ? Math.round(v) : Math.round(v * 10) / 10;
    return `${n.toLocaleString()} ${u[i]}`;
  }
  const fmtNum = n => Number(n).toLocaleString();
  function fmtWhen(iso) {
    const d = new Date(iso);
    if (isNaN(d)) return '';
    return `${d.toLocaleDateString(undefined, { dateStyle: 'medium' })}, ${d.toLocaleTimeString(undefined, { timeStyle: 'short' })}`;
  }
  function hostOf(u) { try { return new URL(u).host.replace(/^www\./, ''); } catch { return String(u); } }
  function safeUrl(u) { try { const x = new URL(u); return x.protocol === 'https:' || x.protocol === 'http:' ? x.href : null; } catch { return null; } }
  function el(html) { const t = document.createElement('template'); t.innerHTML = html.trim(); return t.content.firstElementChild; }
  const ICON_RX = /^data:image\/(png|jpeg|gif|webp);base64,[A-Za-z0-9+/=]+$/;

  /**
   * Validates and cleans map data from an untrusted source (a file someone sent you).
   * Unknown fields are dropped, strings are capped, icons must be plain base64 images.
   */
  function sanitize(data) {
    if (!data || typeof data !== 'object' || !data.root || typeof data.root !== 'object') throw new Error('This file does not contain a Wimap map.');
    const str = (v, max) => (typeof v === 'string' ? (v.length > max ? v.slice(0, max) : v) : undefined);
    const icons = {};
    if (data.icons && typeof data.icons === 'object') {
      for (const [k, v] of Object.entries(data.icons)) if (/^[a-z0-9]{1,40}$/.test(k) && typeof v === 'string' && v.length < 300000 && ICON_RX.test(v)) icons[k] = v;
    }
    let count = 0;
    const clean = (n, depth) => {
      if (!n || typeof n !== 'object') return null;
      if (++count > 1000000) throw new Error('This map has more than a million points, which is more than Wimap can open.');
      const o = { n: str(n.n, 512) ?? '', k: KIND[n.k] ? n.k : depth === 0 ? 'root' : 'folder' };
      if (typeof n.s === 'number' && isFinite(n.s) && n.s >= 0) o.s = n.s;
      for (const [f, max] of [['p', 1024], ['u', 2048], ['d', 600], ['v', 120], ['b', 200], ['t', 40]]) { const v = str(n[f], max); if (v) o[f] = v; }
      if (typeof n.i === 'string' && icons[n.i]) o.i = n.i;
      if (n.a === true) o.a = true;
      if (depth === 1 && ORDER.includes(n.ck)) o.ck = n.ck;
      if (Array.isArray(n.c) && depth < 64) {
        const kids = n.c.slice(0, 20000).map(c => clean(c, depth + 1)).filter(Boolean);
        if (kids.length) o.c = kids;
      }
      return o;
    };
    const root = clean(data.root, 0);
    root.k = 'root';
    const at = typeof data.at === 'string' && !isNaN(new Date(data.at)) ? data.at : new Date().toISOString();
    return {
      v: 1, root, icons, at,
      machine: str(data.machine, 128) || root.n, os: str(data.os, 160), home: str(data.home, 260),
      ms: typeof data.ms === 'number' && isFinite(data.ms) ? data.ms : undefined,
      export: data.export && typeof data.export === 'object' ? { title: str(data.export.title, 200) } : undefined,
    };
  }

  /* ---------- viewer ---------- */

  class Viewer {
    /**
     * @param host { reveal(path)?, url(url)?, onPrefs(prefs)?, handleKeys? }
     * @param prefs { panel: 'right'|'left'|'bottom', panelSize, panelHeight, hints, tools, legend, ...map prefs }
     */
    constructor(root, host = {}, prefs = {}) {
      this.host = host;
      this.root = root;
      this.prefs = { panel: 'right', panelSize: 360, panelHeight: 300, hints: true, tools: true, legend: true, ...Viewer.cleanPrefs(prefs) };
      const touch = typeof matchMedia === 'function' && matchMedia('(pointer: coarse)').matches;
      root.classList.add('viewer');
      root.innerHTML = `
        <div class="stage">
          <canvas tabindex="0" role="application" aria-roledescription="map" aria-label="Map of this PC" aria-describedby="v-help"></canvas>
          <p id="v-help" class="sr-only">Arrow keys move between items: left goes to the parent, right opens and goes inside, up and down move between neighbours. Enter opens or folds. Plus and minus zoom, square brackets rotate.</p>
          <div class="v-top">
            <div class="search-wrap">
              <label class="search">
                ${svg('search')}
                <input type="text" placeholder="Find" spellcheck="false" autocomplete="off" role="combobox" aria-autocomplete="list" aria-expanded="false" aria-controls="v-results" aria-label="Find on the map">
                <span class="count mono num" aria-hidden="true"></span>
                <button type="button" class="clear" aria-label="Clear search" hidden>${svg('x')}</button>
              </label>
              <div class="results" id="v-results" role="listbox" aria-label="Search results" hidden></div>
            </div>
            <div class="legend" role="group" aria-label="Show or hide branches"></div>
          </div>
          <div class="v-tools" role="toolbar" aria-label="Map navigation">
            <button type="button" class="tool" data-t="in" aria-label="Zoom in" title="Zoom in">${svg('plus')}</button>
            <button type="button" class="tool" data-t="out" aria-label="Zoom out" title="Zoom out">${svg('minus')}</button>
            <button type="button" class="tool" data-t="fit" aria-label="Fit the map" title="Fit the map">${svg('fit')}</button>
            <span class="sep" aria-hidden="true"></span>
            <button type="button" class="tool" data-t="rotl" aria-label="Rotate left" title="Rotate left">${svg('rotL')}</button>
            <button type="button" class="tool compass" data-t="north" aria-label="Reset rotation" title="Reset rotation">
              <svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="12" cy="12" r="9" class="ring"/><g class="needle"><path d="M12 4.5 14.2 12h-4.4z" class="n"/><path d="M12 19.5 9.8 12h4.4z" class="s"/></g></svg>
            </button>
            <button type="button" class="tool" data-t="rotr" aria-label="Rotate right" title="Rotate right">${svg('rotR')}</button>
          </div>
          <div class="v-status mono num"></div>
          <div class="v-hint" aria-hidden="true">${touch
            ? '<span>Drag to move</span><span>Pinch to zoom</span><span>Twist with two fingers to rotate</span>'
            : '<span>Drag to move</span><span>Scroll to zoom</span><span>Right-drag to rotate</span><span><kbd>/</kbd> to find</span>'}</div>
          <div class="sr-only" aria-live="polite" data-announce></div>
        </div>
        <aside class="panel" data-open="false" aria-label="Details">
          <div class="resizer" role="separator" tabindex="0" aria-label="Resize the details panel"></div>
          <div class="panel-in"></div>
        </aside>`;
      this.canvas = root.querySelector('canvas');
      this.input = root.querySelector('.search input');
      this.countEl = root.querySelector('.search .count');
      this.clearBtn = root.querySelector('.search .clear');
      this.results = root.querySelector('.results');
      this.legend = root.querySelector('.legend');
      this.panel = root.querySelector('.panel');
      this.panelIn = root.querySelector('.panel-in');
      this.resizer = root.querySelector('.resizer');
      this.status = root.querySelector('.v-status');
      this.hint = root.querySelector('.v-hint');
      this.announcer = root.querySelector('[data-announce]');
      this.needle = root.querySelector('.compass .needle');
      this.compass = root.querySelector('.compass');

      const mapPrefs = {};
      for (const k of ['labelScale', 'icons', 'links', 'motion', 'rotateGestures']) if (k in this.prefs) mapPrefs[k] = this.prefs[k];
      this.map = new global.WMap(this.canvas, {
        order: ORDER,
        padTop: 56,
        prefs: mapPrefs,
        onSelect: n => this.show(n),
        onView: v => this.onView(v),
      });
      this.searchCache = new WeakMap();
      this.hits = [];
      this.hitIx = -1;
      this.active = -1;
      this.wire();
      this.applyPrefs();
    }

    /* ---------- preferences and layout ---------- */

    /** Keeps only known preference values; stored settings may be old or edited by hand. */
    static cleanPrefs(p) {
      const out = {};
      if (!p || typeof p !== 'object') return out;
      if (['right', 'left', 'bottom'].includes(p.panel)) out.panel = p.panel;
      for (const k of ['panelSize', 'panelHeight', 'labelScale']) if (typeof p[k] === 'number' && isFinite(p[k]) && p[k] > 0) out[k] = p[k];
      for (const k of ['hints', 'tools', 'legend', 'icons', 'motion', 'rotateGestures']) if (typeof p[k] === 'boolean') out[k] = p[k];
      if (p.links === 'curved' || p.links === 'straight') out.links = p.links;
      return out;
    }

    setPrefs(p) {
      Object.assign(this.prefs, Viewer.cleanPrefs(p));
      const mapPrefs = {};
      for (const k of ['labelScale', 'icons', 'links', 'motion', 'rotateGestures']) if (k in p) mapPrefs[k] = p[k];
      if (Object.keys(mapPrefs).length) this.map.setPrefs(mapPrefs);
      this.applyPrefs();
    }

    applyPrefs() {
      const p = this.prefs;
      this.root.dataset.panel = p.panel;
      this.root.style.setProperty('--panel-size', `${p.panelSize}px`);
      this.root.style.setProperty('--panel-height', `${p.panelHeight}px`);
      this.hint.hidden = !p.hints || this.hintDismissed;
      this.root.querySelector('.v-tools').hidden = !p.tools;
      this.legend.hidden = !p.legend;
      const vertical = p.panel === 'bottom';
      this.resizer.setAttribute('aria-orientation', vertical ? 'horizontal' : 'vertical');
      this.updateResizerValue();
    }

    savePrefs() { if (this.host.onPrefs) this.host.onPrefs({ ...this.prefs }); }

    limits() {
      const r = this.root.getBoundingClientRect();
      return this.prefs.panel === 'bottom'
        ? { min: 180, max: Math.max(200, Math.round(r.height * 0.7)), key: 'panelHeight' }
        : { min: 280, max: Math.max(300, Math.round(Math.min(720, r.width * 0.6))), key: 'panelSize' };
    }

    setPanelSize(v, save = true) {
      const { min, max, key } = this.limits();
      this.prefs[key] = Math.round(Math.min(max, Math.max(min, v)));
      this.applyPrefs();
      if (save) this.savePrefs();
    }

    updateResizerValue() {
      const { min, max, key } = this.limits();
      this.resizer.setAttribute('aria-valuemin', min);
      this.resizer.setAttribute('aria-valuemax', max);
      this.resizer.setAttribute('aria-valuenow', this.prefs[key]);
    }

    /* ---------- events ---------- */

    wire() {
      // Search
      let timer;
      this.input.addEventListener('input', () => { clearTimeout(timer); timer = setTimeout(() => this.find(this.input.value), 120); });
      this.input.addEventListener('keydown', e => this.searchKeys(e));
      this.input.addEventListener('focus', () => { if (this.hits.length && this.input.value.trim()) this.openResults(); });
      this.input.addEventListener('blur', () => setTimeout(() => this.closeResults(), 120));
      this.clearBtn.addEventListener('click', () => { this.input.value = ''; this.find(''); this.input.focus(); });
      this.results.addEventListener('mousedown', e => e.preventDefault()); // keep focus in the field
      this.results.addEventListener('click', e => {
        const row = e.target.closest('[data-ix]');
        if (row) this.pick(+row.dataset.ix);
      });

      // Navigation tools
      this.root.querySelector('.v-tools').addEventListener('click', e => {
        const b = e.target.closest('[data-t]');
        if (b) this.command(b.dataset.t);
      });

      // Canvas keyboard navigation
      this.canvas.addEventListener('keydown', e => this.mapKeys(e));
      this.canvas.addEventListener('pointerdown', () => this.dismissHint(), { once: true });
      this.canvas.addEventListener('wheel', () => this.dismissHint(), { once: true, passive: true });

      // Panel resizing
      let drag = null, pending = null, raf = 0;
      this.resizer.addEventListener('pointerdown', e => {
        e.preventDefault();
        this.resizer.setPointerCapture(e.pointerId);
        drag = this.root.getBoundingClientRect();
        this.root.classList.add('resizing');
      });
      this.resizer.addEventListener('pointermove', e => {
        if (!drag) return;
        const p = this.prefs.panel;
        pending = p === 'right' ? drag.right - e.clientX : p === 'left' ? e.clientX - drag.left : drag.bottom - e.clientY;
        // One layout per frame while dragging, so the map never stutters.
        if (!raf) raf = requestAnimationFrame(() => { raf = 0; if (pending != null) this.setPanelSize(pending, false); });
      });
      const stop = () => { if (!drag) return; drag = null; this.root.classList.remove('resizing'); this.savePrefs(); };
      this.resizer.addEventListener('pointerup', stop);
      this.resizer.addEventListener('pointercancel', stop);
      this.resizer.addEventListener('dblclick', () => this.setPanelSize(this.prefs.panel === 'bottom' ? 300 : 360));
      this.resizer.addEventListener('keydown', e => {
        const { key } = this.limits();
        const grow = this.prefs.panel === 'left' ? 'ArrowRight' : this.prefs.panel === 'bottom' ? 'ArrowUp' : 'ArrowLeft';
        const shrink = { ArrowRight: 'ArrowLeft', ArrowLeft: 'ArrowRight', ArrowUp: 'ArrowDown' }[grow];
        const step = e.shiftKey ? 64 : 16;
        if (e.key === grow) this.setPanelSize(this.prefs[key] + step);
        else if (e.key === shrink) this.setPanelSize(this.prefs[key] - step);
        else if (e.key === 'Home') this.setPanelSize(0);
        else if (e.key === 'End') this.setPanelSize(1e6);
        else return;
        e.preventDefault();
      });

      if (this.host.handleKeys) {
        document.addEventListener('keydown', e => {
          const typing = /^(INPUT|TEXTAREA|SELECT)$/.test(document.activeElement?.tagName || '');
          if ((e.key === '/' && !typing) || (e.key.toLowerCase() === 'f' && (e.ctrlKey || e.metaKey))) { e.preventDefault(); this.focusSearch(); }
          else if (!typing && document.activeElement !== this.canvas) this.globalKeys(e);
        });
      }
    }

    dismissHint() { this.hintDismissed = true; this.hint.hidden = true; }

    /** Toolbar and shortcut commands. Returns true when handled. */
    command(name) {
      const m = this.map, sel = m.selected;
      switch (name) {
        case 'in': m.zoomBy(1.4); break;
        case 'out': m.zoomBy(1 / 1.4); break;
        case 'fit': m.fit(); break;
        case 'rotl': m.rotateBy(-ROTATE_STEP); break;
        case 'rotr': m.rotateBy(ROTATE_STEP); break;
        case 'north': m.resetRotation(); break;
        case 'center': if (sel) m.centerOn(sel, Math.max(m.view.k, 1.1)); break;
        // On a selection the node stays put; on the whole map the result is fitted to the window.
        case 'openall': if (sel) m.openAll(sel); else { m.openAll(m.root); m.fit(); } break;
        case 'foldall': if (sel) m.foldAll(sel); else { m.foldAll(m.root); m.fit(); } break;
        case 'parent': if (sel && sel.parent) this.focusNode(sel.parent, { keepOpen: true }); break;
        case 'deselect': m.select(null); break;
        default: return false;
      }
      return true;
    }

    globalKeys(e) {
      if (e.ctrlKey || e.metaKey || e.altKey) return;
      const map = { '+': 'in', '=': 'in', '-': 'out', '0': 'fit', '[': 'rotl', ']': 'rotr', Escape: 'deselect' };
      if (map[e.key] && this.command(map[e.key])) e.preventDefault();
    }

    mapKeys(e) {
      const m = this.map;
      const sel = m.selected;
      const go = n => { if (!n) return; this.focusNode(n, { keepOpen: true, quiet: true }); };
      const siblings = n => (n.parent ? n.parent.vk : [n]);
      switch (e.key) {
        case 'ArrowLeft': if (!sel) go(m.root); else go(sel.parent || sel); break;
        case 'ArrowRight':
          if (!sel) go(m.root);
          else if (sel.kids.length) { if (!sel.open) m.toggle(sel); go(sel.vk[0] || sel.kids[0]); }
          break;
        case 'ArrowUp': case 'ArrowDown': {
          if (!sel) { go(m.root); break; }
          const sib = siblings(sel), i = sib.indexOf(sel);
          go(sib[(i + (e.key === 'ArrowDown' ? 1 : -1) + sib.length) % sib.length]);
          break;
        }
        case 'Home': go(m.root); break;
        case 'Enter': case ' ': if (sel) m.toggle(sel); break;
        default: this.globalKeys(e); return;
      }
      e.preventDefault();
    }

    onView(v) {
      const deg = Math.round((((v.r * 180) / Math.PI) % 360 + 360) % 360);
      if (deg === this.lastDeg) return;
      this.lastDeg = deg;
      this.needle.style.transform = `rotate(${deg}deg)`;
      this.compass.classList.toggle('turned', deg !== 0);
      this.compass.setAttribute('aria-label', deg ? `Reset rotation, now ${deg} degrees` : 'Rotation is reset');
    }

    /* ---------- data ---------- */

    load(data, opts = {}) {
      this.data = data;
      this.searchCache = new WeakMap();
      this.map.setData(data.root, data.icons || {}, opts);
      this.renderLegend();
      this.renderStatus();
      if (this.input.value.trim()) this.find(this.input.value); else this.show(null);
    }

    renderLegend() {
      this.legend.innerHTML = '';
      for (const c of this.map.root.kids) {
        const pend = !!c.raw.pend;
        const b = el(`<button type="button" class="chip" aria-pressed="${!this.map.hiddenCats.has(c.cat)}" style="--c: var(--c-${esc(c.cat)})"><span class="dot"></span>${esc(c.name)}${pend ? '' : `<span class="n num">${fmtNum(c.total)}</span>`}</button>`);
        b.addEventListener('click', () => {
          const hide = b.getAttribute('aria-pressed') === 'true';
          b.setAttribute('aria-pressed', String(!hide));
          this.map.setCategoryHidden(c.cat, hide);
        });
        this.legend.appendChild(b);
      }
    }

    renderStatus(extra) {
      if (extra !== undefined) this.statusExtra = extra;
      const parts = [`${fmtNum(this.map.nodes.length - 1)} points`];
      if (this.data && this.data.at && !this.data.root.c?.some(c => c.pend)) parts.push(`mapped ${fmtWhen(this.data.at)}`);
      if (this.statusExtra) parts.push(this.statusExtra);
      this.status.innerHTML = parts.map(p => `<span>${esc(p)}</span>`).join('');
    }

    /* ---------- search ---------- */

    focusSearch() { this.input.focus(); this.input.select(); }

    find(q) {
      const S = global.WimapSearch;
      this.query = S.parseQuery(q);
      const on = !!q.trim();
      this.clearBtn.hidden = !on;
      if (!on) {
        this.hits = []; this.map.setMatches(null);
        this.countEl.textContent = '';
        this.closeResults();
        return;
      }
      const items = this.map.nodes.length > 1 ? this.map.nodes.slice(1) : [];
      const ranked = S.rank(items, this.query, this.searchCache, 2000);
      this.hits = ranked.map(r => r.item);
      this.fuzzy = ranked.length > 0 && ranked[0].fuzzy;
      this.hitIx = -1;
      this.map.setMatches(this.hits);
      this.countEl.textContent = this.hits.length ? fmtNum(this.hits.length) : 'none';
      this.renderResults();
      if (document.activeElement === this.input) this.openResults();
      this.announce(this.hits.length ? `${fmtNum(this.hits.length)} results` : 'No results');
    }

    renderResults() {
      const S = global.WimapSearch;
      const shown = this.hits.slice(0, 60);
      this.active = shown.length ? 0 : -1;
      if (!shown.length) {
        this.results.innerHTML = `<div class="r-empty">Nothing on the map matches. Try fewer words, or filters like <span class="mono">in:browsers</span> or <span class="mono">is:extension</span>.</div>`;
        return;
      }
      const rows = shown.map((n, i) => {
        const ranges = S.highlight(n.name, this.query.terms);
        let name = '', at = 0;
        for (const [a, b] of ranges) { name += esc(n.name.slice(at, a)) + '<mark>' + esc(n.name.slice(a, b)) + '</mark>'; at = b; }
        name += esc(n.name.slice(at));
        const trail = [];
        for (let a = n.parent; a && a.depth > 0; a = a.parent) trail.unshift(a.name);
        return `<div class="r-row" role="option" id="v-r${i}" data-ix="${i}" aria-selected="${i === this.active}" style="--c:var(--c-${esc(n.cat)})">
          <span class="dot"></span>
          <span class="r-t"><span class="r-n">${name}</span><span class="r-m">${esc(KIND[n.kind] || n.kind)}${trail.length ? ' · ' + esc(trail.join(' › ')) : ''}</span></span>
        </div>`;
      }).join('');
      const more = this.hits.length > shown.length ? `<div class="r-more mono num">${fmtNum(this.hits.length - shown.length)} more lit on the map</div>` : '';
      const fuzzy = this.fuzzy ? '<div class="r-more">No exact matches. These have the same letters in order.</div>' : '';
      this.results.innerHTML = fuzzy + rows + more;
      this.input.setAttribute('aria-activedescendant', 'v-r0');
    }

    openResults() {
      if (!this.input.value.trim()) return;
      this.results.hidden = false;
      this.input.setAttribute('aria-expanded', 'true');
    }

    closeResults() {
      this.results.hidden = true;
      this.input.setAttribute('aria-expanded', 'false');
    }

    setActive(i) {
      const rows = this.results.querySelectorAll('.r-row');
      if (!rows.length) return;
      this.active = (i + rows.length) % rows.length;
      rows.forEach((r, j) => r.setAttribute('aria-selected', String(j === this.active)));
      rows[this.active].scrollIntoView({ block: 'nearest' });
      this.input.setAttribute('aria-activedescendant', `v-r${this.active}`);
    }

    searchKeys(e) {
      const open = !this.results.hidden;
      if (e.key === 'ArrowDown') { e.preventDefault(); if (!open) this.openResults(); else this.setActive(this.active + 1); }
      else if (e.key === 'ArrowUp') { e.preventDefault(); if (open) this.setActive(this.active - 1); }
      else if (e.key === 'Enter') {
        e.preventDefault();
        if (open && this.active >= 0) this.pick(this.active);
        else this.step(e.shiftKey ? -1 : 1); // with the list closed, Enter walks through every match
      } else if (e.key === 'Escape') {
        e.preventDefault();
        if (open) this.closeResults(); else { this.input.value = ''; this.find(''); this.canvas.focus(); }
      }
    }

    pick(i) {
      const n = this.hits[i];
      if (!n) return;
      this.hitIx = i;
      this.closeResults();
      this.focusNode(n);
    }

    step(d) {
      if (!this.hits.length) return;
      this.hitIx = (this.hitIx + d + this.hits.length) % this.hits.length;
      this.countEl.textContent = `${fmtNum(this.hitIx + 1)} / ${fmtNum(this.hits.length)}`;
      this.focusNode(this.hits[this.hitIx]);
    }

    /** Open the branches above a node, select it and bring it into view. */
    focusNode(n, { keepOpen = false, quiet = false } = {}) {
      const m = this.map;
      m.reveal(n);
      if (!keepOpen && n.kids.length && !n.open) n.open = true;
      m.layout(false);
      m.select(n);
      if (quiet) m.ensureVisible(n); else m.centerOn(n, Math.max(m.view.k, 1.1));
    }

    announce(text) { this.announcer.textContent = ''; setTimeout(() => { this.announcer.textContent = text; }, 30); }

    /* ---------- findings panel ---------- */

    show(n) {
      if (!n) { this.panel.dataset.open = 'false'; this.panelIn.innerHTML = ''; return; }
      const r = n.raw;
      const chain = [];
      for (let a = n.parent; a; a = a.parent) chain.unshift(a);
      const icons = this.data.icons || {};
      const icon = r.i && icons[r.i] && ICON_RX.test(icons[r.i]) ? icons[r.i] : null;
      const c = n.depth === 0 ? 'var(--accent)' : `var(--c-${esc(n.cat)})`;
      const facts = [];
      const size = fmtSize(r.s);
      if (size) facts.push(['Size', esc((r.a ? 'at least ' : '') + size)]);
      if (n.kids.length) facts.push(['Inside', `${fmtNum(n.total)} ${n.total === 1 ? 'item' : 'items'}`]);
      if (r.v) facts.push(['Version', esc(r.v)]);
      if (r.b) facts.push(['Publisher', esc(r.b)]);
      if (r.t) facts.push(['Installed', esc(r.t)]);
      if (n.depth === 0 && this.data.os) facts.push(['System', esc(this.data.os)]);
      if (r.p) facts.push(['Path', `<span class="mono">${esc(r.p)}</span>`, 'mono']);
      const url = r.u && safeUrl(r.u);
      if (url) facts.push(['Link', `<a href="${esc(url)}" target="_blank" rel="noopener noreferrer">${esc(hostOf(url))}</a>`]);

      const kids = n.kids.slice(0, 120);
      this.panelIn.innerHTML = `
        <div class="p-main">
          <div class="p-head">
            <nav class="trail" aria-label="Where this sits">${chain.map((a, i) => `<button type="button" data-up="${chain.length - i}">${esc(a.name)}</button><i aria-hidden="true">›</i>`).join('')}<span>${esc(n.name)}</span></nav>
            <button type="button" class="icon-btn sm p-close" aria-label="Close details">${svg('x')}</button>
            <div class="p-title" style="--c:${c}">
              ${icon ? `<img src="${icon}" alt="">` : '<span class="swatch"></span>'}
              <div><h2>${esc(n.name)}</h2><div class="kind">${esc(KIND[n.kind] || n.kind)}</div></div>
            </div>
          </div>
          <div class="p-body">
            ${r.d ? `<p class="desc">${esc(r.d)}</p>` : ''}
            ${facts.length ? `<dl class="facts">${facts.map(([k, v, cls]) => `<dt>${k}</dt><dd class="${cls || ''}">${v}</dd>`).join('')}</dl>` : ''}
            <div class="p-actions">
              ${r.p && this.host.reveal && (!this.host.canReveal || this.host.canReveal()) ? `<button type="button" class="btn sm" data-act="reveal">${svg('folder')}Show in Explorer</button>` : ''}
              ${url ? `<button type="button" class="btn sm" data-act="url">${svg('link')}Open link</button>` : ''}
              ${r.p ? `<button type="button" class="btn sm" data-act="copy">${svg('copy')}Copy path</button>` : `<button type="button" class="btn sm" data-act="copyname">${svg('copy')}Copy name</button>`}
              ${n.kids.length && n.depth > 0 ? `<button type="button" class="btn sm" data-act="openall">${svg('expand')}Open all inside</button><button type="button" class="btn sm" data-act="foldall">${svg('fold')}Fold</button>` : ''}
              <button type="button" class="btn sm" data-act="center">${svg('target')}Center</button>
            </div>
          </div>
        </div>
        ${kids.length ? `<div class="p-kids"><h3><span>Inside</span><span class="mono num">${fmtNum(n.kids.length)}</span></h3>
          <div class="kids">${kids.map((k, i) => {
            const kic = k.raw.i && icons[k.raw.i] && ICON_RX.test(icons[k.raw.i]) ? icons[k.raw.i] : null;
            return `<button type="button" data-kid="${i}" style="--c:var(--c-${esc(k.cat)})">${kic ? `<img src="${kic}" alt="">` : `<span class="kd ${k.kids.length ? 'folded' : ''}"></span>`}<span class="nm">${esc(k.name)}</span><span class="sz mono num">${k.kids.length ? fmtNum(k.total) : esc(fmtSize(k.raw.s) || '')}</span></button>`;
          }).join('')}</div>
          ${n.kids.length > kids.length ? `<p class="more mono num">${fmtNum(n.kids.length - kids.length)} more on the map</p>` : ''}
        </div>` : ''}`;
      this.panel.dataset.open = 'true';
      this.updateResizerValue();
      const pi = this.panelIn;
      pi.querySelector('.p-close').addEventListener('click', () => { this.map.select(null); this.canvas.focus(); });
      pi.querySelectorAll('[data-up]').forEach(b => b.addEventListener('click', () => {
        let a = n; for (let i = 0; i < +b.dataset.up; i++) a = a.parent;
        this.focusNode(a, { keepOpen: true });
      }));
      pi.querySelectorAll('[data-kid]').forEach(b => b.addEventListener('click', () => this.focusNode(n.kids[+b.dataset.kid])));
      pi.querySelectorAll('[data-act]').forEach(b => b.addEventListener('click', () => this.act(b.dataset.act, n, url)));
      const a = pi.querySelector('a[href]');
      if (a && this.host.url) a.addEventListener('click', e => { e.preventDefault(); this.host.url(url); });
      this.announce(`${n.name}. ${KIND[n.kind] || ''}${n.kids.length ? `, ${fmtNum(n.total)} items inside` : ''}${chain.length > 1 ? `, in ${chain[chain.length - 1].name}` : ''}`);
    }

    act(action, n, url) {
      const r = n.raw;
      if (action === 'reveal') this.host.reveal(r.p);
      else if (action === 'url') (this.host.url || (u => window.open(u, '_blank', 'noopener')))(url);
      else if (action === 'copy') this.copy(r.p, 'Path copied');
      else if (action === 'copyname') this.copy(n.name, 'Name copied');
      else if (action === 'openall') this.map.openAll(n);
      else if (action === 'foldall') this.map.foldAll(n);
      else if (action === 'center') this.command('center');
    }

    copy(text, done) {
      const ok = () => this.toast(done);
      if (navigator.clipboard) navigator.clipboard.writeText(text).then(ok, () => this.toast('Could not copy'));
      else this.toast('Copying is not available here');
    }

    toast(text) {
      let t = document.querySelector('.toast');
      if (!t) { t = el('<div class="toast" role="status"></div>'); document.body.appendChild(t); }
      t.textContent = text;
      t.classList.add('show');
      clearTimeout(this.toastTimer);
      this.toastTimer = setTimeout(() => t.classList.remove('show'), 2000);
    }
  }

  global.WimapViewer = Viewer;
  global.WimapUtil = { esc, fmtSize, fmtNum, fmtWhen, safeUrl, hostOf, svg, el, sanitize, KIND, ORDER };
})(window);
