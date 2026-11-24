// Run with: node --test tests/ui
const test = require('node:test');
const assert = require('node:assert/strict');
const { SvgRecorder } = require('../../src/Wimap/ui/svg.js');

const measure = { font: '', measureText: t => ({ width: t.length * 6 }) };

test('paths are transformed when built, like a canvas', () => {
  const r = new SvgRecorder(100, 100, measure);
  r.setTransform(2, 0, 0, 2, 10, 10);
  r.beginPath(); r.moveTo(0, 0); r.lineTo(5, 5);
  r.strokeStyle = '#123456'; r.lineWidth = 1.5; r.stroke();
  const svg = r.toString();
  assert.match(svg, /d="M10 10L20 20"/);
  assert.match(svg, /stroke-width="3"/);
});

test('full circles become two arcs scaled by the transform', () => {
  const r = new SvgRecorder(100, 100, measure);
  r.setTransform(2, 0, 0, 2, 0, 0);
  r.beginPath(); r.arc(10, 10, 3, 0, Math.PI * 2); r.fillStyle = 'red'; r.fill();
  assert.match(r.toString(), /M26 20A6 6 0 1 0 14 20A6 6 0 1 0 26 20Z/);
});

test('text is escaped and keeps font, anchor and matrix', () => {
  const r = new SvgRecorder(100, 100, measure);
  r.font = '600 12px "Segoe UI",sans-serif';
  r.textAlign = 'right'; r.textBaseline = 'middle'; r.globalAlpha = 0.5;
  r.fillText('<script>&"x"', 1, 2);
  const svg = r.toString();
  assert.match(svg, /&lt;script&gt;&amp;&quot;x&quot;/);
  assert.match(svg, /font-weight="600"/);
  assert.match(svg, /font-size="12"/);
  assert.match(svg, /text-anchor="end"/);
  assert.match(svg, /dominant-baseline="central"/);
  assert.match(svg, /opacity="0.5"/);
  assert.doesNotMatch(svg, /<script>/);
});

test('control characters never reach the XML', () => {
  const r = new SvgRecorder(10, 10, measure);
  r.fillText('a' + String.fromCharCode(1) + 'b', 0, 0);
  assert.match(r.toString(), />ab</);
});

test('only base64 image data is embedded', () => {
  const r = new SvgRecorder(10, 10, measure);
  r.drawImage({ src: 'data:image/png;base64,AAAA' }, 0, 0, 16, 16);
  r.drawImage({ src: 'https://example.com/x.png' }, 0, 0, 16, 16);
  r.drawImage({ src: 'data:image/png;base64,AA"onload="x' }, 0, 0, 16, 16);
  const svg = r.toString();
  assert.equal((svg.match(/<image /g) || []).length, 1);
});

test('save and restore bring back the matrix and styles', () => {
  const r = new SvgRecorder(10, 10, measure);
  r.fillStyle = 'red'; r.save();
  r.translate(5, 5); r.fillStyle = 'blue'; r.restore();
  r.beginPath(); r.moveTo(1, 1); r.fill();
  assert.match(r.toString(), /d="M1 1" fill="red"/);
});
