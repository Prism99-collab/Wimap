/* SvgRecorder: a small stand-in for CanvasRenderingContext2D that writes SVG.
   It covers exactly the drawing calls the map uses, so the SVG export reuses the map's own draw code.
   Works in the browser (window.SvgRecorder) and in Node for tests (module.exports). */
(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.SvgRecorder = api.SvgRecorder;
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  const esc = s => String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const num = v => (Math.abs(v) < 1e-6 ? '0' : (+v.toFixed(2)).toString());
  // Text that cannot be valid XML (control characters other than tab, newline, return) is dropped.
  const xmlText = s => esc(String(s).replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\ufffe\uffff]/g, ''));

  class SvgRecorder {
    constructor(width, height, measureCtx) {
      this.width = width;
      this.height = height;
      this.measureCtx = measureCtx;
      this.out = [];
      this.stack = [];
      this.m = [1, 0, 0, 1, 0, 0];
      this.d = '';
      this.fillStyle = '#000';
      this.strokeStyle = '#000';
      this.lineWidth = 1;
      this.globalAlpha = 1;
      this.font = '10px sans-serif';
      this.textAlign = 'start';
      this.textBaseline = 'alphabetic';
      this.lineCap = 'butt';
      this.lineJoin = 'miter';
    }

    // --- state ---
    save() { this.stack.push({ m: this.m.slice(), fillStyle: this.fillStyle, strokeStyle: this.strokeStyle, lineWidth: this.lineWidth, globalAlpha: this.globalAlpha, font: this.font, textAlign: this.textAlign, textBaseline: this.textBaseline }); }
    restore() { const s = this.stack.pop(); if (s) Object.assign(this, s); }
    setTransform(a, b, c, d, e, f) { this.m = [a, b, c, d, e, f]; }
    transform(a, b, c, d, e, f) {
      const [A, B, C, D, E, F] = this.m;
      this.m = [A * a + C * b, B * a + D * b, A * c + C * d, B * c + D * d, A * e + C * f + E, B * e + D * f + F];
    }
    translate(x, y) { this.transform(1, 0, 0, 1, x, y); }
    rotate(a) { const c = Math.cos(a), s = Math.sin(a); this.transform(c, s, -s, c, 0, 0); }
    scale(x, y) { this.transform(x, 0, 0, y, 0, 0); }
    measureText(t) { this.measureCtx.font = this.font; return this.measureCtx.measureText(t); }

    pt(x, y) { const [a, b, c, d, e, f] = this.m; return [a * x + c * y + e, b * x + d * y + f]; }
    get unit() { const [a, b, c, d] = this.m; return Math.sqrt(Math.abs(a * d - b * c)) || 1; }
    alpha() { return this.globalAlpha < 1 ? ` opacity="${num(this.globalAlpha)}"` : ''; }
    matrix() { return this.m.map(num).join(' '); }

    // --- paths (points are transformed when added, like a real canvas) ---
    beginPath() { this.d = ''; }
    closePath() { this.d += 'Z'; }
    moveTo(x, y) { const [X, Y] = this.pt(x, y); this.d += `M${num(X)} ${num(Y)}`; }
    lineTo(x, y) { const [X, Y] = this.pt(x, y); this.d += `L${num(X)} ${num(Y)}`; }
    bezierCurveTo(a, b, c, d, x, y) {
      const p1 = this.pt(a, b), p2 = this.pt(c, d), p3 = this.pt(x, y);
      this.d += `C${num(p1[0])} ${num(p1[1])} ${num(p2[0])} ${num(p2[1])} ${num(p3[0])} ${num(p3[1])}`;
    }
    /** Full circles only, which is all the map draws. */
    arc(x, y, r) {
      const [cx, cy] = this.pt(x, y), R = r * this.unit;
      this.d += `M${num(cx + R)} ${num(cy)}A${num(R)} ${num(R)} 0 1 0 ${num(cx - R)} ${num(cy)}A${num(R)} ${num(R)} 0 1 0 ${num(cx + R)} ${num(cy)}Z`;
    }
    fill() { if (this.d) this.out.push(`<path d="${this.d}" fill="${esc(this.fillStyle)}"${this.alpha()}/>`); }
    stroke() {
      if (!this.d) return;
      this.out.push(`<path d="${this.d}" fill="none" stroke="${esc(this.strokeStyle)}" stroke-width="${num(this.lineWidth * this.unit)}" stroke-linecap="${this.lineCap}" stroke-linejoin="${this.lineJoin}"${this.alpha()}/>`);
    }
    clearRect() { /* an SVG starts empty */ }
    fillRect(x, y, w, h) {
      const [a, b] = this.pt(x, y), [c, d] = this.pt(x + w, y + h);
      this.out.push(`<rect x="${num(Math.min(a, c))}" y="${num(Math.min(b, d))}" width="${num(Math.abs(c - a))}" height="${num(Math.abs(d - b))}" fill="${esc(this.fillStyle)}"${this.alpha()}/>`);
    }

    // --- text and images ---
    textAttrs() {
      const m = /^\s*(?:(italic|normal)\s+)?(?:(\d{3}|bold|normal)\s+)?([\d.]+)px\s+(.+)$/.exec(this.font) || [];
      const anchor = { left: 'start', start: 'start', right: 'end', end: 'end', center: 'middle' }[this.textAlign] || 'start';
      const base = this.textBaseline === 'middle' ? ' dominant-baseline="central"' : '';
      return `transform="matrix(${this.matrix()})" font-family="${esc(m[4] || 'sans-serif')}" font-size="${m[3] || 10}" font-weight="${m[2] || 400}" text-anchor="${anchor}"${base}`;
    }
    fillText(t, x, y) { this.out.push(`<text x="${num(x)}" y="${num(y)}" ${this.textAttrs()} fill="${esc(this.fillStyle)}"${this.alpha()}>${xmlText(t)}</text>`); }
    strokeText(t, x, y) {
      this.out.push(`<text x="${num(x)}" y="${num(y)}" ${this.textAttrs()} fill="none" stroke="${esc(this.strokeStyle)}" stroke-width="${num(this.lineWidth)}" stroke-linejoin="round"${this.alpha()}>${xmlText(t)}</text>`);
    }
    drawImage(img, x, y, w, h) {
      const src = img && img.src;
      if (!src || !/^data:image\/(png|jpeg|gif|webp);base64,[A-Za-z0-9+/=]+$/.test(src)) return;
      this.out.push(`<image href="${src}" x="${num(x)}" y="${num(y)}" width="${num(w)}" height="${num(h)}" transform="matrix(${this.matrix()})"${this.alpha()}/>`);
    }

    toString() {
      return `<?xml version="1.0" encoding="UTF-8"?>\n<svg xmlns="http://www.w3.org/2000/svg" width="${num(this.width)}" height="${num(this.height)}" viewBox="0 0 ${num(this.width)} ${num(this.height)}">\n${this.out.join('\n')}\n</svg>\n`;
    }
  }

  return { SvgRecorder };
});
