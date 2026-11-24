// Run with: node --test tests/ui
const test = require('node:test');
const assert = require('node:assert/strict');
const S = require('../../src/Wimap/ui/search.js');

const item = (n, extra = {}, depth = 3, cat = 'apps', kind = 'app') => ({ raw: { n, ...extra }, depth, cat, kind });
const names = (q, items) => S.rank(items, q, new Map()).map(r => r.item.raw.n);

test('normalize folds case, accents, width and special letters', () => {
  assert.equal(S.normalize('Résumé'), 'resume');
  assert.equal(S.normalize('ＲＥＳＵＭＥ'), 'resume');
  assert.equal(S.normalize('Straße'), 'strasse');
  assert.equal(S.normalize('İstanbul'), 'istanbul');
  assert.equal(S.normalize('Øresund Łódź'), 'oresund lodz');
  // Arabic vowel marks are dropped so unvowelled queries match.
  assert.equal(S.normalize('مُحَمَّد'), 'محمد');
  assert.equal(S.normalize('微信'), '微信');
});

test('exact and prefix names rank above substrings', () => {
  const items = [item('Google Chrome', { b: 'Google LLC' }), item('Chrome Remote Desktop Host'), item('Chrome', {}, 2, 'browsers', 'browser')];
  assert.deepEqual(names('chrome', items), ['Chrome', 'Chrome Remote Desktop Host', 'Google Chrome']);
});

test('every term must match somewhere', () => {
  const items = [item('Google Chrome', { b: 'Google LLC' }), item('Chrome Remote Desktop Host')];
  assert.deepEqual(names('chrome llc', items), ['Google Chrome']);
});

test('filters narrow by branch and kind', () => {
  const items = [item('Chrome'), item('Chrome', {}, 2, 'browsers', 'browser'), item('NordPass Password Manager', {}, 5, 'browsers', 'ext')];
  assert.deepEqual(names('chrome in:browsers', items), ['Chrome']);
  assert.equal(S.rank(items, 'chrome in:browsers', new Map())[0].item.cat, 'browsers');
  assert.deepEqual(names('is:extension pass', items), ['NordPass Password Manager']);
  assert.deepEqual(names('is:ext', items), ['NordPass Password Manager']);
});

test('quoted phrases match as one term', () => {
  const items = [item('Chrome Remote Desktop Host'), item('Remote Play Desktop')];
  assert.deepEqual(names('"remote desktop"', items), ['Chrome Remote Desktop Host']);
});

test('matches in publisher, link host, detail and path still count', () => {
  const items = [
    item('Thing A', { b: 'Contoso Ltd' }),
    item('Thing B', { u: 'https://www.contoso.com/x' }),
    item('Thing C', { p: 'C:\\Contoso\\c' }),
  ];
  assert.deepEqual(names('contoso', items), ['Thing A', 'Thing B', 'Thing C']);
});

test('falls back to letters in order when nothing matches exactly', () => {
  const r = S.rank([item('VS Code'), item('Visual Studio')], 'vscd', new Map());
  assert.equal(r.length, 1);
  assert.equal(r[0].item.raw.n, 'VS Code');
  assert.equal(r[0].fuzzy, true);
});

test('word starts include camelCase boundaries', () => {
  const r = S.rank([item('PowerToys'), item('Mytoys')], 'toys', new Map());
  assert.equal(r[0].item.raw.n, 'PowerToys');
});

test('highlight returns merged ranges in the original name', () => {
  assert.deepEqual(S.highlight('Google Chrome', ['chr', 'hrome']), [[7, 13]]);
  assert.deepEqual(S.highlight('Résumé', ['sum']), [[2, 5]]);
});

test('empty query returns nothing', () => {
  assert.deepEqual(S.rank([item('x')], '   ', new Map()), []);
});

test('installed things rank above files with the same name', () => {
  const items = [item('chrome.exe', {}, 5, 'apps', 'exe'), item('Google Chrome', {}, 3, 'apps', 'app')];
  assert.deepEqual(names('chrome', items), ['Google Chrome', 'chrome.exe']);
});
