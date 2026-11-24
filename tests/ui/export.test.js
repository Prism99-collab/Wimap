// Run with: node --test tests/ui
const test = require('node:test');
const assert = require('node:assert/strict');

// export.js is a browser script; it only needs window.WimapUtil to build, and nothing to shape.
globalThis.window = globalThis;
require('../../src/Wimap/ui/export.js');
const { shape, scriptJson } = globalThis.WimapExport;

const data = () => ({
  machine: 'PC', user: 'alice', home: String.raw`C:\Users\Al`, timings: { apps: 1 }, at: '2026-01-01T00:00:00Z',
  icons: { aaa: 'data:image/png;base64,AAAA', bbb: 'data:image/png;base64,BBBB' },
  root: { n: 'PC', k: 'root', c: [
    { n: 'Apps', k: 'cat', ck: 'apps', c: [{ n: 'Tool', k: 'app', i: 'aaa', p: String.raw`C:\Users\Al\Tool` }, { n: 'Other', k: 'app', p: String.raw`C:\Users\Alice\x` }] },
    { n: 'Browsers', k: 'cat', ck: 'browsers', c: [{ n: 'Chrome', k: 'browser', c: [{ n: 'Bookmarks', k: 'group', c: [{ n: 'x', k: 'bm', u: 'https://x' }] }, { n: 'Extensions', k: 'group', c: [{ n: 'e', k: 'ext', i: 'bbb' }] }] }] },
  ] },
});
const opts = o => ({ title: 'T', branches: ['apps', 'browsers'], bookmarks: true, hideUser: false, icons: true, ...o });

test('user name and timings never ship', () => {
  const out = shape(data(), opts());
  assert.equal(out.user, undefined);
  assert.equal(out.timings, undefined);
});

test('hiding the user folder respects folder boundaries', () => {
  const apps = shape(data(), opts({ hideUser: true })).root.c[0].c;
  assert.equal(apps[0].p, String.raw`%USERPROFILE%\Tool`);
  assert.equal(apps[1].p, String.raw`C:\Users\Alice\x`);
});

test('bookmarks and icons can be left out, and unused icons are dropped', () => {
  const out = shape(data(), opts({ bookmarks: false, branches: ['browsers'] }));
  const chrome = out.root.c[0].c[0];
  assert.deepEqual(chrome.c.map(c => c.n), ['Extensions']);
  assert.deepEqual(Object.keys(out.icons), ['bbb']);
  assert.deepEqual(shape(data(), opts({ icons: false })).icons, {});
});

test('data embedded in a script element cannot close it', () => {
  const s = scriptJson({ n: '</script><script>alert(1)</script>', ls: 'a' + String.fromCharCode(0x2028) + 'b' });
  assert.ok(!s.includes('</script'));
  assert.ok(!s.includes(String.fromCharCode(0x2028)));
  assert.deepEqual(JSON.parse(s).n, '</script><script>alert(1)</script>');
});
