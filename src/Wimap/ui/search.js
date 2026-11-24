/* Wimap search: language-neutral matching and ranking.
   Works in the browser (window.WimapSearch) and in Node for tests (module.exports). */
(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.WimapSearch = api;
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  // Letters that Unicode decomposition does not split into base + accent.
  const FOLD = { 'ß': 'ss', 'ẞ': 'ss', 'ı': 'i', 'İ': 'i', 'ł': 'l', 'Ł': 'l', 'ø': 'o', 'Ø': 'o', 'đ': 'd', 'Đ': 'd', 'æ': 'ae', 'Æ': 'ae', 'œ': 'oe', 'Œ': 'oe', 'þ': 'th', 'ð': 'd' };
  const FOLD_RX = /[ßẞıİłŁøØđĐæÆœŒþð]/g;
  const MARKS = /[\u0300-\u036f\u0610-\u061a\u064b-\u065f\u0670\u06d6-\u06ed\u0591-\u05c7\u3099\u309a]/g;

  /** Lower-case, accent-free, width-folded text, so "Résumé", "RESUME" and "ｒｅｓｕｍｅ" all match "resume". */
  function normalize(s) {
    if (!s) return '';
    return String(s).replace(FOLD_RX, c => FOLD[c]).normalize('NFKD').replace(MARKS, '').toLowerCase();
  }

  // Word starts: after a space, punctuation, path separator, or a lower-to-upper case change in the original.
  function wordStarts(original, norm) {
    const starts = new Set([0]);
    for (let i = 1; i < norm.length; i++) {
      const p = norm[i - 1];
      if (/[\s\-_.\/\\:@()[\]·,+]/.test(p)) starts.add(i);
    }
    // camelCase and PascalCase boundaries from the original text, when lengths line up.
    if (original && original.length === norm.length) {
      for (let i = 1; i < original.length; i++) {
        const a = original[i - 1], b = original[i];
        if (a === a.toLowerCase() && a !== a.toUpperCase() && b === b.toUpperCase() && b !== b.toLowerCase()) starts.add(i);
      }
    }
    return starts;
  }

  const KIND_ALIAS = {
    app: ['app', 'store', 'game'], apps: ['app', 'store', 'game'], game: ['game'], folder: ['folder'], file: ['file', 'exe'],
    exe: ['exe'], program: ['exe'], ai: ['ai'], tool: ['ai'], mcp: ['mcp'], server: ['mcp'], plugin: ['plugin'], skill: ['skill'],
    agent: ['agent'], command: ['cmd'], cmd: ['cmd'], model: ['model'], browser: ['browser'], profile: ['profile'],
    bookmark: ['bm', 'bmf'], bm: ['bm', 'bmf'], extension: ['ext', 'vsx'], ext: ['ext', 'vsx'], drive: ['drive'],
    runtime: ['runtime'], package: ['pkg'], pkg: ['pkg'], font: ['font'], startup: ['startup'], wsl: ['wsl'],
  };

  const KIND_WEIGHT = {
    app: 12, store: 12, game: 12, browser: 14, ai: 12, ext: 10, plugin: 10, mcp: 10, vsx: 8, runtime: 8, model: 8,
    skill: 6, pkg: 6, drive: 6, bm: 2, exe: -12, file: -10, more: -20,
  };

  /**
   * Parses a query into terms and filters.
   * Supports "quoted phrases", in:<branch> (apps, ai, browsers, files, drives, dev, system) and is:<kind>.
   */
  function parseQuery(q) {
    const out = { terms: [], branch: null, kinds: null };
    const rx = /"([^"]*)"|(\S+)/g;
    let m;
    while ((m = rx.exec(String(q || '')))) {
      const raw = m[1] !== undefined ? m[1] : m[2];
      const f = m[1] === undefined && /^(in|is|type):(.+)$/i.exec(raw);
      if (f) {
        const key = f[1].toLowerCase(), val = normalize(f[2]);
        if (key === 'in') out.branch = val;
        else out.kinds = KIND_ALIAS[val] || [val];
        continue;
      }
      const t = normalize(raw).trim();
      if (t) out.terms.push(t);
    }
    return out;
  }

  /** Cached, normalized text for one node. Fields: name, by (publisher), detail, path, url, version. */
  function prepare(raw) {
    const name = normalize(raw.n);
    return {
      name, nameStarts: wordStarts(raw.n, name),
      by: normalize(raw.b), detail: normalize(raw.d), path: normalize(raw.p),
      url: normalize(hostOf(raw.u)), version: normalize(raw.v),
    };
  }

  function hostOf(u) {
    if (!u) return '';
    const m = /^[a-z]+:\/\/([^/?#]+)/i.exec(u);
    return m ? m[1].replace(/^www\./i, '') : u;
  }

  function bestInName(p, t) {
    if (p.name === t) return 120;
    if (p.name.startsWith(t)) return 90;
    let i = p.name.indexOf(t), best = 0;
    while (i !== -1) {
      best = Math.max(best, p.nameStarts.has(i) ? 70 : 45);
      if (best === 70) break;
      i = p.name.indexOf(t, i + 1);
    }
    return best;
  }

  /** Score for one term; 0 means the term is not in this node. */
  function scoreTerm(p, t) {
    const n = bestInName(p, t);
    if (n) return n;
    if (p.by.includes(t)) return 28;
    if (p.url.includes(t)) return 24;
    if (p.detail.includes(t)) return 20;
    if (p.version && p.version.startsWith(t)) return 16;
    if (p.path.includes(t)) return 12;
    return 0;
  }

  /** Letters of the term appear in order in the name ("vscd" finds "VS Code"). Used only when nothing matches exactly. */
  function subsequence(name, t) {
    let j = 0;
    for (let i = 0; i < name.length && j < t.length; i++) if (name[i] === t[j]) j++;
    return j === t.length;
  }

  /**
   * Ranks nodes for a query.
   * @param items array of { raw, depth, cat, kind } (any object with these fields)
   * @param cache Map used to keep prepared text between calls
   * @returns array of { item, score }, best first
   */
  function rank(items, query, cache, limit = 500) {
    const q = typeof query === 'string' ? parseQuery(query) : query;
    if (!q.terms.length && !q.kinds && !q.branch) return [];
    const out = [];
    for (const it of items) {
      if (q.branch && it.cat !== q.branch) continue;
      if (q.kinds && !q.kinds.includes(it.kind)) continue;
      let p = cache.get(it);
      if (!p) { p = prepare(it.raw); cache.set(it, p); }
      let score = 0, ok = true;
      for (const t of q.terms) {
        const s = scoreTerm(p, t);
        if (!s) { ok = false; break; }
        score += s;
      }
      if (!ok) continue;
      // Shorter names and shallower items win ties: "Chrome" before "Chrome Remote Desktop Host".
      // Things people install rank above the files inside them: "Google Chrome" before "chrome.exe".
      score += Math.max(0, 12 - p.name.length / 4) - it.depth * 0.5 + (KIND_WEIGHT[it.kind] || 0);
      out.push({ item: it, score });
    }
    if (!out.length && q.terms.length === 1 && q.terms[0].length >= 3) {
      const t = q.terms[0];
      for (const it of items) {
        if (q.branch && it.cat !== q.branch) continue;
        if (q.kinds && !q.kinds.includes(it.kind)) continue;
        const p = cache.get(it) || prepare(it.raw);
        if (subsequence(p.name, t)) out.push({ item: it, score: 1 - p.name.length / 1000, fuzzy: true });
      }
    }
    out.sort((a, b) => b.score - a.score);
    return out.length > limit ? out.slice(0, limit) : out;
  }

  /** Ranges in the original name to highlight for the query terms. */
  function highlight(name, terms) {
    const norm = normalize(name);
    if (norm.length !== name.length) return [];
    const ranges = [];
    for (const t of terms) {
      const i = norm.indexOf(t);
      if (i !== -1) ranges.push([i, i + t.length]);
    }
    ranges.sort((a, b) => a[0] - b[0]);
    const merged = [];
    for (const r of ranges) {
      const last = merged[merged.length - 1];
      if (last && r[0] <= last[1]) last[1] = Math.max(last[1], r[1]); else merged.push(r.slice());
    }
    return merged;
  }

  return { normalize, parseQuery, rank, highlight, prepare, scoreTerm };
});
