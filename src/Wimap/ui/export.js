/* Builds the single-file HTML export from the scan data and the app's own renderer sources. */
(function (global) {
  'use strict';

  const SOURCES = ['viewer.css', 'export.css', 'search.js', 'map.js', 'viewer.js', 'export-page.js'];
  // The exported page runs only its own inline code and never contacts the network.
  const CSP = "default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; img-src data:; base-uri 'none'; form-action 'none'";

  let sources = null;
  async function loadSources() {
    if (sources) return sources;
    const texts = await Promise.all(SOURCES.map(n => fetch(n).then(r => {
      if (!r.ok) throw new Error(`Could not read ${n}`);
      return r.text();
    })));
    sources = Object.fromEntries(SOURCES.map((n, i) => [n, texts[i]]));
    return sources;
  }

  /** A filtered deep copy of the scan, shaped by the export options. */
  function shape(data, o) {
    const out = JSON.parse(JSON.stringify(data));
    out.root.c = (out.root.c || []).filter(c => o.branches.includes(c.ck));
    const SEP = ['/', String.fromCharCode(92)];
    let home = (data.home || '').toLowerCase();
    while (home && SEP.includes(home[home.length - 1])) home = home.slice(0, -1);
    // "C:\Users\Al" must not also match "C:\Users\Alice": the next character has to end the folder name.
    const underHome = s => { const l = s.toLowerCase(); return !!home && l.startsWith(home) && (l.length === home.length || SEP.includes(l[home.length])); };
    const strip = n => {
      if (!o.bookmarks && n.c) n.c = n.c.filter(k => !(k.k === 'group' && k.n === 'Bookmarks') && k.k !== 'bm' && k.k !== 'bmf');
      if (o.hideUser && home) {
        for (const f of ['p', 'd']) {
          if (typeof n[f] === 'string' && underHome(n[f])) n[f] = '%USERPROFILE%' + n[f].slice(home.length);
        }
      }
      if (!o.icons) delete n.i;
      (n.c || []).forEach(strip);
    };
    strip(out.root);
    delete out.user;
    delete out.timings;
    if (o.hideUser) delete out.home;
    // Ship only the icons the remaining nodes still use.
    const used = new Set();
    const collect = n => { if (n.i) used.add(n.i); (n.c || []).forEach(collect); };
    collect(out.root);
    out.icons = o.icons ? Object.fromEntries(Object.entries(data.icons || {}).filter(([k]) => used.has(k))) : {};
    out.export = { title: o.title, at: new Date().toISOString() };
    return out;
  }

  /** JSON that is safe inside a script element: no "</script>", no raw line separators. */
  function scriptJson(value) {
    const LS = String.fromCharCode(0x2028), PS = String.fromCharCode(0x2029);
    return JSON.stringify(value).replace(/</g, '\\u003c').split(LS).join('\\u2028').split(PS).join('\\u2029');
  }

  async function build(data, o) {
    const s = await loadSources();
    const shaped = shape(data, o);
    const esc = global.WimapUtil.esc;
    const mark = document.querySelector('.mark');
    const html = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta http-equiv="Content-Security-Policy" content="${CSP}">
<meta name="generator" content="Wimap">
<title>${esc(o.title)}</title>
<style>${s['viewer.css']}
${s['export.css']}</style>
</head>
<body>
<header class="x-head">
  ${mark ? mark.outerHTML : ''}
  <div class="x-title"><h1>${esc(o.title)}</h1><p class="mono num" id="x-sub"></p></div>
  <div class="tabs" role="tablist" aria-label="View">
    <button type="button" role="tab" id="tab-map" aria-controls="x-map-tab" data-tab="map" aria-selected="true">Map</button>
    <button type="button" role="tab" id="tab-list" aria-controls="x-list" data-tab="list" aria-selected="false" tabindex="-1">Reinstall list</button>
  </div>
</header>
<main class="x-main">
  <section id="x-map-tab" role="tabpanel" aria-labelledby="tab-map"><div id="x-map"></div></section>
  <section id="x-list" class="list" role="tabpanel" aria-labelledby="tab-list" hidden></section>
</main>
<script type="application/json" id="wimap-data">${scriptJson(shaped)}</script>
<script>${s['search.js']}
${s['map.js']}
${s['viewer.js']}
${s['export-page.js']}</script>
</body>
</html>`;
    return { html, shaped };
  }

  global.WimapExport = { build, shape, scriptJson };
})(window);
