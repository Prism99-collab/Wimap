/* Wimap map renderer: a canvas radial tree with folding, rotation, touch gestures and animated layout.
   Shared by the app and by exported HTML files, so it has no dependencies.

   Coordinates: every node has a polar position (radius r, angle th) around the root at the world origin.
   The view adds a rotation (view.r), a zoom (view.k) and a screen offset (view.x, view.y).
   Frames are drawn only when something changed, so an idle map costs nothing. */
(function (global) {
  'use strict';

  const TAU = Math.PI * 2;
  const EASE = t => 1 - Math.pow(1 - t, 4);
  const FONT = '"Segoe UI Variable Text","Segoe UI",system-ui,-apple-system,sans-serif';
  const MONO = '"Cascadia Mono","Cascadia Code",Consolas,ui-monospace,monospace';
  const MAX_LABEL = 38;
  const K_MIN = 0.03, K_MAX = 8;
  const HUB = 46;

  const clip = s => (s.length > MAX_LABEL ? s.slice(0, MAX_LABEL - 1) + '…' : s);
  const clampK = k => Math.min(K_MAX, Math.max(K_MIN, k));
  const wrapAngle = a => Math.atan2(Math.sin(a), Math.cos(a));
  const reducedMotion = () => typeof matchMedia === 'function' && matchMedia('(prefers-reduced-motion: reduce)').matches;

  function css(name, fallback) {
    const v = getComputedStyle(document.documentElement).getPropertyValue(name).trim();
    return v || fallback;
  }

  class WMap {
    constructor(canvas, opts = {}) {
      this.cv = canvas;
      this.ctx = canvas.getContext('2d');
      this.mctx = document.createElement('canvas').getContext('2d'); // text measuring only
      this.opts = opts;
      this.prefs = { labelScale: 1, icons: true, links: 'curved', motion: !reducedMotion(), rotateGestures: true, ...(opts.prefs || {}) };
      this.view = { k: 1, x: 0, y: 0, r: 0 };
      this.nodes = [];
      this.visible = [];
      this.exiting = [];
      this.hover = null;
      this.selected = null;
      this.matches = null;
      this.matchPath = null;
      this.hiddenCats = new Set();
      this.images = new Map();
      this.icons = {};
      this.anim = null;
      this.viewAnim = null;
      this.goal = null;      // smooth wheel target
      this.inertia = null;   // fling after a pan
      this.raf = 0;
      this.dirty = true;
      this.w = 0; this.h = 0; this.dpr = 1;
      this.readColors();
      this.bindPointer();
      new ResizeObserver(() => this.resize()).observe(canvas);
      this.resize();
    }

    readColors() {
      this.col = {
        bg: css('--map-bg', '#0e0f11'), fg: css('--fg', '#ededf0'), fg2: css('--fg-2', '#a3a4ab'), fg3: css('--fg-3', '#82838b'),
        accent: css('--accent', '#ff8a4c'), ink: css('--accent-ink', '#1a0e07'),
        cats: {
          apps: css('--c-apps', '#6ea8fe'), ai: css('--c-ai', '#c4a1ff'), browsers: css('--c-browsers', '#5fd4c4'),
          files: css('--c-files', '#f2c66d'), drives: css('--c-drives', '#a7b0be'), dev: css('--c-dev', '#86d98a'), system: css('--c-system', '#f2968c'),
        },
      };
    }

    setPrefs(p) {
      if (p.labelScale !== undefined && p.labelScale !== this.prefs.labelScale) for (const n of this.nodes) n.cw = undefined;
      Object.assign(this.prefs, p);
      this.invalidate();
    }

    /* ---------- data ---------- */

    setData(root, icons = {}, { openDepth = 2, keepView = false } = {}) {
      if (icons !== this.icons) this.images.clear();
      this.icons = icons || {};
      this.nodes = [];
      let id = 0;
      const walk = (raw, parent, depth, cat, index) => {
        const name = String(raw.n ?? '');
        const n = {
          id: id++, raw, name, kind: raw.k, parent, depth, index, kids: [],
          cat: depth === 1 ? (raw.ck || 'apps') : cat, open: depth < openDepth,
          r: 0, th: 0, cr: 0, cth: 0, fr: 0, fth: 0, px: 0, py: 0, pa: 0, vk: [],
          label: clip(name), lw: undefined, cw: undefined, vis: false, exit: false,
        };
        this.nodes.push(n);
        if (Array.isArray(raw.c)) raw.c.forEach((c, i) => n.kids.push(walk(c, n, depth + 1, n.cat, i)));
        n.total = n.kids.reduce((a, k) => a + k.total, 0) + n.kids.length;
        return n;
      };
      this.root = walk(root, null, 0, null, 0);
      this.visible = []; this.exiting = []; this.anim = null; this.anchor = null;
      this.selected = this.hover = null;
      this.matches = this.matchPath = null;
      this.layout(true);
      if (!keepView) this.fit(false);
      this.invalidate();
    }

    /** Add or replace one category branch while a scan is running, keeping what is already open. */
    putBranch(raw, icons) {
      if (!this.root) return;
      Object.assign(this.icons, icons || {});
      const rootRaw = this.root.raw;
      rootRaw.c = rootRaw.c || [];
      const i = rootRaw.c.findIndex(c => c.ck === raw.ck);
      if (i >= 0) rootRaw.c[i] = raw; else rootRaw.c.push(raw);
      const order = this.opts.order || [];
      rootRaw.c.sort((a, b) => order.indexOf(a.ck) - order.indexOf(b.ck));
      const prev = new Map(this.nodes.map(n => [this.key(n), n]));
      this.setData(rootRaw, this.icons, { openDepth: 2, keepView: true });
      for (const n of this.nodes) {
        const p = prev.get(this.key(n));
        if (p) { n.cr = p.cr; n.cth = p.cth; n.open = p.open || n.depth < 2; continue; }
        const pp = n.parent && prev.get(this.key(n.parent));
        if (pp) { n.cr = pp.cr; n.cth = pp.cth; }
      }
      this.layout(false);
    }

    /** Stable identity across reloads: category key plus names along the path. */
    key(n) {
      const a = [];
      for (let x = n; x && x.depth > 0; x = x.parent) a.push(x.depth === 1 ? x.cat : x.name + '#' + x.index);
      return a.reverse().join('/');
    }

    /** Label widths are measured on first use; thousands of hidden nodes never pay for it. */
    labelWidth(n) {
      if (n.lw === undefined) {
        this.mctx.font = n.depth === 1 ? `600 15px ${FONT}` : `500 12px ${FONT}`;
        n.lw = this.mctx.measureText(n.label).width;
      }
      return n.lw * this.prefs.labelScale;
    }

    /* ---------- layout ---------- */

    layout(instant) {
      if (!this.root) return;
      const shown = k => !(k.depth === 1 && this.hiddenCats.has(k.cat));
      const weigh = n => {
        n.vk = n.open ? n.kids.filter(shown) : [];
        n.w = n.vk.length ? n.vk.reduce((a, k) => a + weigh(k), 0) : 1;
        return n.w;
      };
      weigh(this.root);

      // Leaves need about 16px of arc on the outermost ring, so the rings grow with the number of leaves.
      let maxDepth = 0;
      const deepest = n => { if (n.depth > maxDepth) maxDepth = n.depth; n.vk.forEach(deepest); };
      deepest(this.root);
      const R1 = 190, G = 200;
      const ring = d => (d === 0 ? 0 : R1 + (d - 1) * G);
      const gap = this.root.vk.length > 1 ? Math.max(1, this.root.w * 0.02) : 0;
      const units = this.root.w + gap * this.root.vk.length;
      this.scale = Math.max(1, (16 * units) / TAU / ring(Math.max(1, maxDepth)));

      const vis = [];
      const place = (n, a0, a1) => {
        n.th = (a0 + a1) / 2;
        n.r = ring(n.depth) * this.scale;
        n.slot = a1 - a0;
        vis.push(n);
        if (!n.vk.length) return;
        const isRoot = n.depth === 0;
        const span = a1 - a0, total = isRoot ? units : n.w;
        const pad = isRoot ? (gap / total) * span : 0;
        let a = a0 + pad / 2;
        for (const k of n.vk) {
          const s = (k.w / total) * span;
          place(k, a, a + s);
          a += s + pad;
        }
      };
      place(this.root, -Math.PI / 2, -Math.PI / 2 + TAU);
      this.root.th = 0;

      const animate = !instant && this.prefs.motion;
      const prev = this.visible;
      const wasVisible = new Set(prev);
      for (const n of prev) n.vis = false;
      for (const n of vis) n.vis = true;

      for (const n of vis) {
        n.exit = false;
        if (!animate) { n.cr = n.r; n.cth = n.th; }
        else if (!wasVisible.has(n)) {
          // New nodes grow out of their nearest ancestor that was already on screen.
          let a = n.parent; while (a && !wasVisible.has(a)) a = a.parent;
          if (a) { n.cr = a.cr; n.cth = a.depth === 0 ? n.th : a.cth; }
        }
        n.fr = n.cr; n.fth = n.cth;
        const d = n.th - n.fth;
        if (d > Math.PI) n.fth += TAU; else if (d < -Math.PI) n.fth -= TAU;
      }
      this.exiting = [];
      if (animate) {
        for (const n of prev) {
          if (n.vis) continue;
          let a = n.parent; while (a && !a.vis) a = a.parent;
          n.exit = true; n.fade = 1; n.fr = n.cr; n.fth = n.cth;
          n.tr = a ? a.r : 0; n.tth = a && a.depth ? a.th : n.cth;
          this.exiting.push(n);
        }
      }
      this.visible = vis;
      this.anim = animate ? { t0: performance.now(), dur: 480 } : null;
      if (!animate) this.anchor = null;
      this.invalidate();
    }

    /** Jump every running animation to its end (used before exporting an image). */
    settle() {
      for (const n of this.visible) { n.cr = n.r; n.cth = n.th; }
      for (const n of this.exiting) n.exit = false;
      this.exiting = []; this.anim = null; this.anchor = null;
      if (this.viewAnim) { this.view = { ...this.viewAnim.to }; this.viewAnim = null; }
      if (this.goal) { this.view = { ...this.goal }; this.goal = null; }
      this.inertia = null;
    }

    /* ---------- interaction API ---------- */

    toggle(n, anchor = true) {
      if (!n || !n.kids.length || n.depth === 0) return;
      n.open = !n.open;
      this.relayout(anchor ? n : null);
    }

    openAll(n, limit = 2500) {
      let count = 0;
      const q = [n];
      for (let i = 0; i < q.length && count < limit; i++) {
        const x = q[i];
        if (!x.kids.length) continue;
        x.open = true;
        count += x.kids.length;
        for (const k of x.kids) q.push(k);
      }
      this.relayout(n);
    }

    foldAll(n) {
      const fold = x => { if (x !== n && x.depth > 0) x.open = false; x.kids.forEach(fold); };
      fold(n);
      this.relayout(n);
    }

    reveal(n) { for (let a = n.parent; a; a = a.parent) a.open = true; }

    relayout(anchor) {
      // Keep the clicked node still on screen while everything else moves around it.
      this.anchor = anchor ? { n: anchor, ...this.toScreen(anchor) } : null;
      this.layout(false);
    }

    setCategoryHidden(cat, hidden) {
      if (hidden) this.hiddenCats.add(cat); else this.hiddenCats.delete(cat);
      this.relayout(null);
    }

    select(n) {
      this.selected = n || null;
      this.invalidate();
      if (this.opts.onSelect) this.opts.onSelect(this.selected);
    }

    /** Light up nodes (and the branches holding them) without opening anything. */
    setMatches(list) {
      if (!list) { this.matches = this.matchPath = null; this.invalidate(); return; }
      this.matches = new Set(list);
      this.matchPath = new Set();
      for (const h of list) for (let a = h; a && !this.matchPath.has(a); a = a.parent) this.matchPath.add(a);
      this.invalidate();
    }

    /** Screen position of a node right now (mid-animation included). */
    toScreen(n, view = this.view) {
      const a = n.cth + view.r;
      return { sx: Math.cos(a) * n.cr * view.k + view.x, sy: Math.sin(a) * n.cr * view.k + view.y };
    }

    /** Screen position a node will have once the layout settles. */
    targetScreen(n, view = this.view) {
      const a = n.th + view.r;
      return { sx: Math.cos(a) * n.r * view.k + view.x, sy: Math.sin(a) * n.r * view.k + view.y };
    }

    centerOn(n, k) {
      const kk = clampK(k || Math.max(this.view.k, 0.9));
      const a = n.th + this.view.r;
      const x = Math.cos(a) * n.r, y = Math.sin(a) * n.r;
      const top = this.opts.padTop || 0;
      this.tweenView({ k: kk, x: this.w / 2 - x * kk, y: top / 2 + this.h / 2 - y * kk, r: this.view.r });
    }

    /** Pan just enough to bring a node inside the viewport. */
    ensureVisible(n, margin = 80) {
      const { sx, sy } = this.targetScreen(n);
      const top = (this.opts.padTop || 0) + margin;
      let dx = 0, dy = 0;
      if (sx < margin) dx = margin - sx; else if (sx > this.w - margin) dx = this.w - margin - sx;
      if (sy < top) dy = top - sy; else if (sy > this.h - margin) dy = this.h - margin - sy;
      if (dx || dy) this.tweenView({ ...this.view, x: this.view.x + dx, y: this.view.y + dy }, 320);
    }

    /** Bounding box of the settled layout in rotated world units, labels included. */
    bounds(r = this.view.r) {
      let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
      for (const n of this.visible) {
        const a = n.th + r;
        const x = Math.cos(a) * n.r, y = Math.sin(a) * n.r;
        const radial = !n.vk.length && n.depth > 0;
        if (radial) {
          const ext = 20 + Math.min(this.labelWidth(n), 260);
          const ex = x + Math.cos(a) * ext, ey = y + Math.sin(a) * ext;
          minX = Math.min(minX, x - 12, ex); maxX = Math.max(maxX, x + 12, ex);
          minY = Math.min(minY, y - 12, ey); maxY = Math.max(maxY, y + 12, ey);
        } else {
          const ext = n.depth ? 20 + this.labelWidth(n) : HUB + 8;
          minX = Math.min(minX, x - ext); maxX = Math.max(maxX, x + ext);
          minY = Math.min(minY, y - (n.depth ? 16 : ext)); maxY = Math.max(maxY, y + (n.depth ? 16 : ext));
        }
      }
      return { minX, minY, maxX, maxY };
    }

    fitView(w, h, { pad = 40, top = 0, r = this.view.r, maxK = 1 } = {}) {
      const b = this.bounds(r);
      const k = clampK(Math.min((w - pad * 2) / (b.maxX - b.minX), (h - pad * 2 - top) / (b.maxY - b.minY), maxK));
      return { k, x: w / 2 - ((b.minX + b.maxX) / 2) * k, y: top + (h - top) / 2 - ((b.minY + b.maxY) / 2) * k, r };
    }

    fit(animate = true) {
      if (!this.visible.length || !this.w) return;
      const v = this.fitView(this.w, this.h, { top: this.opts.padTop || 0 });
      if (animate) this.tweenView(v); else { this.view = v; this.invalidate(); }
    }

    zoomBy(f, cx = this.w / 2, cy = this.h / 2) {
      const base = this.goal || this.view;
      const k = clampK(base.k * f), s = k / base.k;
      this.tweenView({ k, x: cx - (cx - base.x) * s, y: cy - (cy - base.y) * s, r: base.r }, 240);
    }

    /** Rotate the whole map around a screen point (the canvas centre by default). */
    rotateBy(da, cx = this.w / 2, cy = this.h / 2, animate = true) {
      const base = this.viewAnim ? this.viewAnim.to : this.goal || this.view;
      const c = Math.cos(da), s = Math.sin(da);
      const dx = base.x - cx, dy = base.y - cy;
      const to = { k: base.k, r: base.r + da, x: cx + dx * c - dy * s, y: cy + dx * s + dy * c };
      if (animate) this.tweenView(to, 300); else { this.viewAnim = null; this.goal = null; this.view = to; this.invalidate(); }
    }

    resetRotation() {
      const r = wrapAngle(this.viewAnim ? this.viewAnim.to.r : this.view.r);
      if (Math.abs(r) > 1e-4) this.rotateBy(-r);
    }

    tweenView(to, dur = 460) {
      this.anchor = null; this.goal = null; this.inertia = null;
      if (!this.prefs.motion) { this.viewAnim = null; this.view = { ...to }; this.invalidate(); return; }
      const from = { ...this.view };
      this.viewAnim = { from, to: { ...to, r: from.r + wrapAngle(to.r - from.r) }, t0: performance.now(), dur };
      this.invalidate();
    }

    stopMotion() { this.viewAnim = null; this.goal = null; this.inertia = null; this.anchor = null; }

    /* ---------- pointer, touch and wheel ---------- */

    bindPointer() {
      const cv = this.cv;
      const pts = new Map();
      let g = null;        // current gesture
      let lastTap = null;  // for double-tap

      const pair = () => {
        const [a, b] = [...pts.values()];
        return { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2, d: Math.hypot(b.x - a.x, b.y - a.y), a: Math.atan2(b.y - a.y, b.x - a.x) };
      };
      const now = () => performance.now();

      cv.addEventListener('pointerdown', e => {
        if (e.button === 1) return;
        cv.setPointerCapture(e.pointerId);
        const p = this.local(e);
        pts.set(e.pointerId, p);
        this.stopMotion();
        if (pts.size === 1) {
          g = { mode: e.button === 2 || e.shiftKey ? 'spin' : 'pan', last: p, start: p, moved: false, touch: e.pointerType === 'touch', button: e.button, samples: [{ t: now(), x: p.x, y: p.y }] };
        } else if (pts.size === 2) {
          g = { mode: 'pinch', c0: pair(), v0: { ...this.view } };
        }
      });

      cv.addEventListener('pointermove', e => {
        const p = this.local(e);
        if (!pts.has(e.pointerId)) { this.pendingHover = p; this.invalidate(); return; }
        pts.set(e.pointerId, p);
        if (!g) return;
        if (g.mode === 'pinch') {
          if (pts.size < 2) return;
          const c = pair(), v = g.v0;
          const k = clampK(v.k * (c.d / Math.max(1, g.c0.d)));
          const dr = this.prefs.rotateGestures ? wrapAngle(c.a - g.c0.a) : 0;
          // The map point under the starting midpoint stays under the fingers.
          const wx = g.c0.x - v.x, wy = g.c0.y - v.y, s = k / v.k, cs = Math.cos(dr), sn = Math.sin(dr);
          this.view = { k, r: v.r + dr, x: c.x - (wx * cs - wy * sn) * s, y: c.y - (wx * sn + wy * cs) * s };
          this.invalidate();
          return;
        }
        if (!g.moved && Math.hypot(p.x - g.start.x, p.y - g.start.y) > (g.touch ? 8 : 4)) {
          g.moved = true;
          cv.style.cursor = g.mode === 'spin' ? 'alias' : 'grabbing';
        }
        if (!g.moved) return;
        if (g.mode === 'spin') {
          const cx = this.w / 2, cy = this.h / 2;
          const da = Math.atan2(p.y - cy, p.x - cx) - Math.atan2(g.last.y - cy, g.last.x - cx);
          this.rotateBy(wrapAngle(da), cx, cy, false);
        } else {
          this.view.x += p.x - g.last.x; this.view.y += p.y - g.last.y;
          g.samples.push({ t: now(), x: p.x, y: p.y });
          if (g.samples.length > 8) g.samples.shift();
          this.invalidate();
        }
        g.last = p;
      });

      const end = (e, cancelled) => {
        if (!pts.has(e.pointerId)) return;
        pts.delete(e.pointerId);
        cv.style.cursor = this.hover ? 'pointer' : 'grab';
        if (!g) return;
        if (g.mode === 'pinch') {
          // A finger still on the glass carries on as a pan.
          const rest = [...pts.values()][0];
          g = rest ? { mode: 'pan', last: rest, start: rest, moved: true, touch: true, samples: [] } : null;
          return;
        }
        const gesture = g;
        g = null;
        if (cancelled) return;
        if (!gesture.moved) {
          if (gesture.button !== 2) this.tap(this.local(e), lastTap, t => { lastTap = t; });
        } else if (gesture.mode === 'pan' && this.prefs.motion) this.fling(gesture.samples);
      };
      cv.addEventListener('pointerup', e => end(e, false));
      cv.addEventListener('pointercancel', e => end(e, true));
      cv.addEventListener('contextmenu', e => e.preventDefault());
      cv.addEventListener('pointerleave', () => {
        if (pts.size || !this.hover) return;
        this.hover = null;
        this.invalidate();
      });

      cv.addEventListener('wheel', e => {
        e.preventDefault();
        const p = this.local(e);
        const unit = e.deltaMode === 1 ? 33 : e.deltaMode === 2 ? this.h : 1;
        const dy = e.deltaY * unit, dx = e.deltaX * unit;
        this.viewAnim = null; this.inertia = null; this.anchor = null;
        if (e.altKey) { this.rotateBy((dy || dx) * 0.004, p.x, p.y, false); return; }
        const base = this.goal || { ...this.view };
        // Sideways scrolling (precision touchpads) and Shift+wheel pan; everything else zooms.
        if (!e.ctrlKey && (e.shiftKey || (dx !== 0 && Math.abs(dx) >= Math.abs(dy) * 0.5))) {
          this.goal = { ...base, x: base.x - (e.shiftKey && !dx ? dy : dx), y: base.y - (e.shiftKey ? 0 : dy) };
        } else {
          const k = clampK(base.k * Math.exp(-dy * (e.ctrlKey ? 0.01 : 0.0016))), s = k / base.k;
          this.goal = { k, r: base.r, x: p.x - (p.x - base.x) * s, y: p.y - (p.y - base.y) * s };
        }
        if (!this.prefs.motion) { this.view = this.goal; this.goal = null; }
        this.invalidate();
      }, { passive: false });
    }

    tap(p, lastTap, setLast) {
      const t = performance.now();
      const n = this.hit(p.x, p.y);
      const double = lastTap && t - lastTap.t < 320 && Math.hypot(p.x - lastTap.x, p.y - lastTap.y) < 24 && lastTap.n === n;
      setLast(double ? null : { t, x: p.x, y: p.y, n });
      if (double) {
        // The first tap already opened or folded the node; the second one only zooms in on it.
        if (n) this.centerOn(n, Math.max(this.view.k * 1.6, 1.1)); else this.zoomBy(1.8, p.x, p.y);
        return;
      }
      if (!n) { this.select(null); return; }
      this.select(n);
      if (n.kids.length) this.toggle(n);
    }

    fling(samples) {
      if (samples.length < 2) return;
      const last = samples[samples.length - 1];
      if (performance.now() - last.t > 60) return; // the finger stopped before lifting
      const first = samples.find(s => last.t - s.t < 100) || samples[0];
      const dt = last.t - first.t;
      if (dt <= 0) return;
      const vx = (last.x - first.x) / dt, vy = (last.y - first.y) / dt;
      if (Math.hypot(vx, vy) < 0.25) return;
      this.inertia = { vx, vy, t: performance.now() };
      this.invalidate();
    }

    local(e) { const r = this.cv.getBoundingClientRect(); return { x: e.clientX - r.left, y: e.clientY - r.top }; }

    /** Node under a screen point: its dot, or the label that runs out from it. */
    hit(sx, sy) {
      const { k, x: vx, y: vy } = this.view;
      const wx = (sx - vx) / k, wy = (sy - vy) / k;
      const s = this.prefs.labelScale;
      let best = null, bestD = Infinity;
      for (const n of this.visible) {
        const dx = wx - n.px, dy = wy - n.py;
        const reach = Math.max(this.radius(n) + 3 / k, 8 / k);
        if (Math.abs(dx) < reach && Math.abs(dy) < reach) {
          const d = Math.hypot(dx, dy);
          if (d < reach && d < bestD) { best = n; bestD = d; continue; }
        }
        if (n.depth === 0 || !this.labelShown(n, this.view)) continue;
        if (!n.vk.length) {
          const ux = Math.cos(n.pa), uy = Math.sin(n.pa);
          const along = dx * ux + dy * uy;
          if (along <= 0) continue;
          const across = Math.abs(-dx * uy + dy * ux);
          if (along < this.radius(n) + 8 + this.labelWidth(n) && across < 7 * s && across + 4 < bestD) { best = n; bestD = across + 4; }
        } else {
          const left = Math.cos(n.pa) < -0.01;
          const w = this.labelWidth(n), fs = (n.depth === 1 ? 15 : 12.5) * s;
          const x0 = left ? n.px - 10 - w : n.px + 10, x1 = left ? n.px - 10 : n.px + 10 + w;
          if (wx > x0 && wx < x1 && Math.abs(dy) < fs * 0.7 && 6 < bestD) { best = n; bestD = 6; }
        }
      }
      return best;
    }

    /* ---------- frames ---------- */

    invalidate() {
      this.dirty = true;
      if (!this.raf) this.raf = requestAnimationFrame(t => this.frame(t));
    }

    resize() {
      const r = this.cv.getBoundingClientRect();
      // Above 2x the extra pixels cost more than they show.
      const dpr = Math.min(window.devicePixelRatio || 1, 2);
      const first = !this.w;
      // Keep whatever is in the middle in the middle when the canvas changes size,
      // including where a running animation is heading (a panel often opens mid-animation).
      if (!first && r.width && r.height) {
        const dx = (r.width - this.w) / 2, dy = (r.height - this.h) / 2;
        for (const v of [this.view, this.goal, this.viewAnim && this.viewAnim.from, this.viewAnim && this.viewAnim.to]) if (v) { v.x += dx; v.y += dy; }
        if (this.anchor) { this.anchor.sx += dx; this.anchor.sy += dy; }
      }
      this.w = r.width; this.h = r.height; this.dpr = dpr;
      this.cv.width = Math.max(1, Math.round(r.width * dpr));
      this.cv.height = Math.max(1, Math.round(r.height * dpr));
      if (first && this.root) this.fit(false);
      this.invalidate();
    }

    frame(now) {
      this.raf = 0;
      let moving = false;
      const dt = Math.min(64, now - (this.lastFrame || now));
      this.lastFrame = now;

      if (this.anim) {
        const t = Math.min(1, (now - this.anim.t0) / this.anim.dur), e = EASE(t);
        for (const n of this.visible) { n.cr = n.fr + (n.r - n.fr) * e; n.cth = n.fth + (n.th - n.fth) * e; }
        for (const n of this.exiting) { n.cr = n.fr + (n.tr - n.fr) * e; n.cth = n.fth + (n.tth - n.fth) * e; n.fade = 1 - e; }
        if (this.anchor) {
          const a = this.anchor.n.cth + this.view.r, rr = this.anchor.n.cr * this.view.k;
          this.view.x = this.anchor.sx - Math.cos(a) * rr;
          this.view.y = this.anchor.sy - Math.sin(a) * rr;
        }
        if (t >= 1) { for (const n of this.exiting) n.exit = false; this.anim = null; this.exiting = []; this.anchor = null; }
        moving = true;
      }
      if (this.viewAnim) {
        const a = this.viewAnim;
        const t = Math.min(1, (now - a.t0) / a.dur), e = EASE(t);
        // Zoom moves in log space so it feels even at every scale.
        const k = Math.exp(Math.log(a.from.k) + (Math.log(a.to.k) - Math.log(a.from.k)) * e);
        this.view = { k, x: a.from.x + (a.to.x - a.from.x) * e, y: a.from.y + (a.to.y - a.from.y) * e, r: a.from.r + (a.to.r - a.from.r) * e };
        if (t >= 1) this.viewAnim = null;
        moving = true;
      }
      if (this.goal) {
        const f = 1 - Math.exp(-Math.max(dt, 8) / 70);
        const v = this.view, gl = this.goal;
        v.k = Math.exp(Math.log(v.k) + (Math.log(gl.k) - Math.log(v.k)) * f);
        v.x += (gl.x - v.x) * f; v.y += (gl.y - v.y) * f; v.r += (gl.r - v.r) * f;
        if (Math.abs(gl.k / v.k - 1) < 1e-3 && Math.abs(gl.x - v.x) < 0.3 && Math.abs(gl.y - v.y) < 0.3) { this.view = { ...gl }; this.goal = null; }
        moving = true;
      }
      if (this.inertia) {
        const it = this.inertia;
        this.view.x += it.vx * dt; this.view.y += it.vy * dt;
        const decay = Math.exp(-dt / 325);
        it.vx *= decay; it.vy *= decay;
        if (Math.hypot(it.vx, it.vy) < 0.02) this.inertia = null;
        moving = true;
      }
      if (this.dirty || moving) {
        this.dirty = false;
        this.draw(this.ctx, this.w, this.h, this.view, { dpr: this.dpr });
        if (this.opts.onView) this.opts.onView(this.view);
      }
      // Hover is resolved once per frame, not once per mouse event.
      if (this.pendingHover) {
        const p = this.pendingHover;
        this.pendingHover = null;
        const h = this.hit(p.x, p.y);
        if (h !== this.hover) {
          this.hover = h;
          this.cv.style.cursor = h ? 'pointer' : 'grab';
          this.dirty = true;
        }
      }
      if (moving || this.dirty) this.invalidate();
    }

    /* ---------- drawing ---------- */

    radius(n) {
      if (n.depth === 0) return HUB;
      if (n.depth === 1) return 9;
      if (n.kids.length) return n.open ? 5 : 5.5;
      return 3.2;
    }

    labelShown(n, view) {
      if (n.depth <= 1) return true;
      const k = view.k, s = this.prefs.labelScale;
      if (n.vk.length) return 12.5 * s * k >= 8;
      // Room between neighbours, measured on screen at the node's ring.
      return 12 * s * k >= 7.5 && n.slot * n.r * k >= 11 * s * Math.min(k, 1.3);
    }

    img(key) {
      const src = this.icons && this.icons[key];
      if (!src) return null;
      let im = this.images.get(key);
      if (!im) { im = new Image(); im.onload = () => this.invalidate(); im.src = src; this.images.set(key, im); }
      return im.complete && im.naturalWidth ? im : null;
    }

    color(n) { return n.depth === 0 ? this.col.accent : (this.col.cats[n.cat] || this.col.fg2); }

    /**
     * Draws the map into any 2D context: the screen, an offscreen canvas for PNG/JPEG, or the SVG recorder.
     * `clean` leaves out hover, selection and search dimming.
     */
    draw(c, W, H, view, { dpr = 1, background = null, clean = false } = {}) {
      const { k, x: vx, y: vy, r: rot } = view;
      const s = this.prefs.labelScale;
      c.setTransform(dpr, 0, 0, dpr, 0, 0);
      c.clearRect(0, 0, W, H);
      if (background) { c.globalAlpha = 1; c.fillStyle = background; c.fillRect(0, 0, W, H); }
      if (!this.root) return;

      const all = this.exiting.length ? this.visible.concat(this.exiting) : this.visible;
      for (const n of all) {
        const a = n.cth + rot;
        n.pa = a; n.px = Math.cos(a) * n.cr; n.py = Math.sin(a) * n.cr;
      }
      const m = 260 / k;
      const x0 = -vx / k - m, y0 = -vy / k - m, x1 = (W - vx) / k + m, y1 = (H - vy) / k + m;
      const inside = (x, y) => x > x0 && x < x1 && y > y0 && y < y1;
      const matchPath = clean ? null : this.matchPath;
      const dim = n => !!matchPath && !matchPath.has(n);
      const lit = new Set();
      if (!clean) for (const t of [this.hover, this.selected]) for (let a = t; a; a = a.parent) lit.add(a);
      const lw = 1 / Math.max(0.6, Math.min(k, 1.4));

      c.setTransform(k * dpr, 0, 0, k * dpr, vx * dpr, vy * dpr);

      // Links, batched by colour and state so each batch is one path.
      const batches = new Map();
      for (const n of all) {
        const p = n.parent;
        if (!p) continue;
        if (!inside(n.px, n.py) && !inside(p.px, p.py) && !inside((n.px + p.px) / 2, (n.py + p.py) / 2)) continue;
        const state = n.exit ? 2 : dim(n) ? 1 : 0;
        const key = n.cat + state + (n.depth === 1 ? 'a' : 'b');
        let b = batches.get(key);
        if (!b) batches.set(key, (b = { color: this.color(n), state, top: n.depth === 1, list: [] }));
        b.list.push(n);
      }
      c.lineCap = 'round';
      for (const b of batches.values()) {
        c.strokeStyle = b.color;
        c.globalAlpha = b.state === 1 ? 0.08 : b.state === 2 ? 0.15 : 0.38;
        c.lineWidth = (b.top ? 2 : 1.1) * lw;
        c.beginPath();
        for (const n of b.list) this.link(c, n);
        c.stroke();
      }
      if (lit.size) {
        c.globalAlpha = 0.95; c.lineWidth = 2 * lw;
        for (const n of lit) {
          if (!n.parent) continue;
          c.strokeStyle = this.color(n);
          c.beginPath(); this.link(c, n); c.stroke();
        }
      }

      // Dots, then labels grouped by font so the font changes a few times per frame, not once per label.
      const radial = [], strong = [], flat = [];
      for (const n of all) {
        if (n.depth === 0 || !inside(n.px, n.py)) continue;
        const fade = n.exit ? n.fade * 0.6 : dim(n) ? 0.22 : n.raw.pend ? 0.35 : 1;
        c.globalAlpha = fade;
        this.dot(c, n, k, lit.has(n), clean);
        if (n.exit) continue;
        const isMatch = !clean && !!this.matches && this.matches.has(n);
        if (!(this.labelShown(n, view) || lit.has(n) || (isMatch && 12 * s * k >= 6))) continue;
        const entry = { n, fade, emph: lit.has(n) || isMatch || (!clean && n === this.selected) };
        if (n.vk.length || n.depth === 1) flat.push(entry);
        else (entry.emph ? strong : radial).push(entry);
      }
      c.textBaseline = 'middle';
      this.radialLabels(c, radial, false, view, dpr);
      this.radialLabels(c, strong, true, view, dpr);
      c.setTransform(k * dpr, 0, 0, k * dpr, vx * dpr, vy * dpr);
      this.flatLabels(c, flat);
      this.drawRoot(c, clean);
    }

    link(c, n) {
      const p = n.parent;
      const t1 = n.pa, t0 = p.depth === 0 ? t1 : p.pa;
      // From the root, links start at the edge of the hub instead of its centre.
      c.moveTo(p.depth === 0 ? Math.cos(t1) * HUB : p.px, p.depth === 0 ? Math.sin(t1) * HUB : p.py);
      if (this.prefs.links === 'straight') { c.lineTo(n.px, n.py); return; }
      const mid = (p.cr + n.cr) / 2;
      c.bezierCurveTo(Math.cos(t0) * mid, Math.sin(t0) * mid, Math.cos(t1) * mid, Math.sin(t1) * mid, n.px, n.py);
    }

    dot(c, n, k, lit, clean) {
      const col = this.color(n), r = this.radius(n), x = n.px, y = n.py;
      const stroke = 1.6 / Math.max(0.7, Math.min(k, 1.5));
      const im = this.prefs.icons && n.raw.i && 14 * k >= 9 ? this.img(n.raw.i) : null;
      if (im) {
        c.drawImage(im, x - 8, y - 8, 16, 16);
      } else if (n.kids.length && !n.open) {
        // A folded branch is a hollow ring, so it reads as "more inside".
        c.beginPath(); c.arc(x, y, r, 0, TAU);
        c.fillStyle = this.col.bg; c.fill();
        c.lineWidth = stroke; c.strokeStyle = col; c.stroke();
      } else {
        c.beginPath(); c.arc(x, y, r, 0, TAU);
        c.fillStyle = col; c.fill();
      }
      if (clean) return;
      if (n === this.selected) {
        c.beginPath(); c.arc(x, y, r + 5, 0, TAU);
        c.lineWidth = stroke * 1.25; c.strokeStyle = this.col.fg; c.stroke();
      } else if (lit && n.depth > 1) {
        c.beginPath(); c.arc(x, y, r + 3, 0, TAU);
        c.lineWidth = stroke * 0.6; c.strokeStyle = col; c.stroke();
      }
    }

    radialLabels(c, list, emph, view, dpr) {
      if (!list.length) return;
      const s = this.prefs.labelScale, k = view.k;
      const font = `${emph ? 600 : 400} ${12 * s}px ${FONT}`, mono = `${11 * s}px ${MONO}`;
      for (const { n, fade } of list) {
        const left = Math.cos(n.pa) < -0.01;
        const a = left ? n.pa + Math.PI : n.pa;
        const cs = Math.cos(a) * k * dpr, sn = Math.sin(a) * k * dpr;
        // One matrix per label instead of save/translate/rotate/restore.
        c.setTransform(cs, sn, -sn, cs, (view.x + n.px * k) * dpr, (view.y + n.py * k) * dpr);
        c.globalAlpha = fade;
        c.font = font;
        c.textAlign = left ? 'right' : 'left';
        const off = (n.raw.i && this.prefs.icons ? 12 : this.radius(n) + 6) * (left ? -1 : 1);
        c.fillStyle = emph ? this.col.fg : this.col.fg2;
        c.fillText(n.label, off, 0.5);
        // Folded branches show how much is inside.
        if (n.kids.length && !n.open) {
          const w = this.labelWidth(n) * (emph ? 1.04 : 1);
          c.font = mono; c.fillStyle = this.col.fg3;
          c.fillText(String(n.total), off + (left ? -(w + 7) : w + 7), 0.5);
        }
      }
    }

    flatLabels(c, list) {
      if (!list.length) return;
      const s = this.prefs.labelScale;
      c.lineJoin = 'round';
      for (const { n, fade, emph } of list) {
        const left = Math.cos(n.pa) < -0.01;
        const fs = (n.depth === 1 ? 15 : 12.5) * s;
        c.globalAlpha = fade;
        c.font = `${n.depth === 1 || emph ? 600 : 500} ${fs}px ${FONT}`;
        c.textAlign = left ? 'right' : 'left';
        const lx = n.px + (left ? -1 : 1) * (this.radius(n) + 7);
        c.lineWidth = 5; c.strokeStyle = this.col.bg;
        c.strokeText(n.label, lx, n.py);
        c.fillStyle = this.col.fg;
        c.fillText(n.label, lx, n.py);
        if ((n.depth === 1 && n.total > 0) || (n.kids.length && !n.open)) {
          const t = String(n.total), gap = this.labelWidth(n) * 1.03 + 8;
          const tx = lx + (left ? -gap : gap);
          c.font = `${11 * s}px ${MONO}`;
          c.lineWidth = 4; c.strokeText(t, tx, n.py + 0.5);
          c.fillStyle = this.col.fg3; c.fillText(t, tx, n.py + 0.5);
        }
      }
    }

    drawRoot(c, clean) {
      const n = this.root;
      c.globalAlpha = 1;
      c.beginPath(); c.arc(0, 0, HUB, 0, TAU);
      c.fillStyle = this.col.accent; c.fill();
      if (!clean && n === this.selected) { c.beginPath(); c.arc(0, 0, HUB + 6, 0, TAU); c.lineWidth = 2; c.strokeStyle = this.col.fg; c.stroke(); }
      let fs = 15;
      this.mctx.font = `600 ${fs}px ${FONT}`;
      while (this.mctx.measureText(n.name).width > 78 && fs > 9) { fs -= 1; this.mctx.font = `600 ${fs}px ${FONT}`; }
      c.fillStyle = this.col.ink;
      c.textAlign = 'center'; c.textBaseline = 'middle';
      c.font = `600 ${fs}px ${FONT}`;
      c.fillText(n.name, 0, 1);
    }

    /* ---------- export ---------- */

    /** Size and view for an image of what is on screen, or of the whole map as currently opened. */
    frameFor(area, maxSide, scale) {
      this.settle();
      if (area === 'view') return { W: this.w, H: this.h, view: { ...this.view } };
      const pad = 48;
      const b = this.bounds(this.view.r);
      const bw = b.maxX - b.minX + pad * 2, bh = b.maxY - b.minY + pad * 2;
      // Very large maps are scaled down to stay inside what a canvas can hold.
      const k = Math.min(1, maxSide / (Math.max(bw, bh) * scale));
      return { W: Math.round(bw * k), H: Math.round(bh * k), view: { k, r: this.view.r, x: (pad - b.minX) * k, y: (pad - b.minY) * k } };
    }

    renderCanvas({ area = 'view', scale = 2, background = this.col.bg } = {}) {
      const f = this.frameFor(area, 8192, scale);
      const cv = document.createElement('canvas');
      cv.width = Math.max(1, Math.round(f.W * scale)); cv.height = Math.max(1, Math.round(f.H * scale));
      this.draw(cv.getContext('2d'), f.W, f.H, f.view, { dpr: scale, background, clean: true });
      this.invalidate();
      return cv;
    }

    renderSVG({ area = 'view', background = this.col.bg } = {}) {
      const f = this.frameFor(area, 20000, 1);
      const rec = new global.SvgRecorder(f.W, f.H, this.mctx);
      this.draw(rec, f.W, f.H, f.view, { dpr: 1, background, clean: true });
      this.invalidate();
      return rec.toString();
    }
  }

  global.WMap = WMap;
})(window);
