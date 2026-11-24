/* Boot script for an exported map: header, Map tab, and the reinstall checklist.
   An exported file can travel to other people, so its data is cleaned before use like any other input. */
(function () {
  'use strict';
  const { esc, fmtNum, fmtWhen, safeUrl, hostOf, svg, sanitize } = window.WimapUtil;
  const normalize = window.WimapSearch.normalize;
  const $ = id => document.getElementById(id);

  let data;
  try { data = sanitize(JSON.parse($('wimap-data').textContent)); }
  catch (e) { document.body.textContent = 'This map could not be read: ' + (e.message || e); return; }
  const icons = data.icons;

  const store = {
    get(key, fallback) { try { const v = localStorage.getItem(key); return v ? JSON.parse(v) : fallback; } catch { return fallback; } },
    set(key, value) { try { localStorage.setItem(key, JSON.stringify(value)); } catch { /* private window: kept for this visit only */ } },
  };
  const TICKS = `wimap:ticks:${data.machine || ''}:${data.at}`;
  const checked = store.get(TICKS, {});

  const total = (n => { let c = 0; const w = x => { c++; (x.c || []).forEach(w); }; w(n); return c - 1; })(data.root);
  $('x-sub').textContent = [data.os, `mapped ${fmtWhen(data.at)}`, `${fmtNum(total)} points`].filter(Boolean).join(' · ');

  const viewer = new window.WimapViewer($('x-map'), { handleKeys: true, onPrefs: p => store.set('wimap:viewer', p) }, store.get('wimap:viewer', {}));
  viewer.load(data);

  /* ---------- tabs ---------- */

  const tabs = [...document.querySelectorAll('.tabs [role="tab"]')];
  const show = id => {
    tabs.forEach(t => { const on = t.dataset.tab === id; t.setAttribute('aria-selected', String(on)); t.tabIndex = on ? 0 : -1; });
    $('x-map-tab').hidden = id !== 'map';
    $('x-list').hidden = id !== 'list';
    if (id === 'map') viewer.map.resize();
  };
  tabs.forEach(t => t.addEventListener('click', () => show(t.dataset.tab)));
  document.querySelector('.tabs').addEventListener('keydown', e => {
    if (e.key !== 'ArrowLeft' && e.key !== 'ArrowRight') return;
    const i = tabs.indexOf(document.activeElement);
    const next = tabs[(i + 1) % tabs.length];
    next.focus();
    show(next.dataset.tab);
  });

  /* ---------- reinstall checklist: what a fresh Windows will not bring back by itself ---------- */

  const branch = key => (data.root.c || []).find(c => c.ck === key);
  const all = (n, pred, out = []) => { if (pred(n)) out.push(n); (n.c || []).forEach(c => all(c, pred, out)); return out; };
  const KIND_LABEL = { mcp: 'MCP server', plugin: 'Plugin', skill: 'Skill', model: 'Model', app: 'App', store: 'App' };
  const sections = [];

  const apps = branch('apps');
  if (apps) sections.push({
    key: 'apps', title: 'Apps',
    // Runtimes and drivers come back with Windows Update or with the apps that need them.
    groups: (apps.c || []).filter(g => g.n !== 'Runtimes and frameworks' && g.n !== 'Drivers and hardware').map(g => ({
      title: g.n,
      items: (g.c || []).map(a => ({ n: a, meta: [a.v, a.b].filter(Boolean).join(' · '), link: a.u || 'https://www.bing.com/search?q=' + encodeURIComponent(a.n + ' download'), label: a.u ? null : 'Search the web' })),
    })),
  });
  const browsers = branch('browsers');
  if (browsers) sections.push({
    key: 'browsers', title: 'Browser extensions',
    groups: (browsers.c || []).map(b => ({ title: b.n, items: all(b, x => x.k === 'ext').map(e => ({ n: e, meta: e.v ? 'v' + e.v : '', link: e.u })) })).filter(g => g.items.length),
  });
  const ai = branch('ai');
  if (ai) sections.push({
    key: 'ai', title: 'AI setup',
    groups: (ai.c || []).map(t => ({
      title: t.n,
      items: all(t, x => ['mcp', 'plugin', 'model', 'app', 'store'].includes(x.k) || (x.k === 'skill' && !/built-in/.test(x.d || '')))
        .map(x => ({ n: x, meta: [KIND_LABEL[x.k], x.d && x.k !== 'skill' ? x.d : ''].filter(Boolean).join(' · '), link: x.u })),
    })).filter(g => g.items.length),
  });
  const dev = branch('dev');
  if (dev) sections.push({ key: 'dev', title: 'Dev kit', groups: (dev.c || []).map(g => ({ title: g.n, items: (g.c || []).map(x => ({ n: x, meta: [x.v, x.k === 'vsx' ? x.d : ''].filter(Boolean).join(' · '), link: x.u })) })) });
  const sys = branch('system');
  if (sys) sections.push({ key: 'system', title: 'Startup and fonts', groups: (sys.c || []).map(g => ({ title: g.n, items: (g.c || []).map(x => ({ n: x, meta: x.d || '', link: null })) })) });

  // Index in the group keeps two items with the same name apart.
  const keyOf = (s, g, x, i) => [s.key, g.title, x.n.n, i].join('/');
  const allKeys = sections.flatMap(s => s.groups.flatMap(g => g.items.map((x, i) => keyOf(s, g, x, i))));
  const list = $('x-list');
  list.innerHTML = `<div class="list-in">
    <div class="l-top">
      <div><h2>Reinstall list</h2><p>Everything from the old PC that a fresh Windows will not bring back by itself. Tick items off as you set up the new one. Ticks stay in this browser.</p></div>
      <div class="progress"><div class="bar" role="progressbar" aria-label="Done" aria-valuemin="0" aria-valuemax="${allKeys.length}"><i></i></div><span class="mono num"></span></div>
    </div>
    <div class="l-tools">
      <label class="search">${svg('search')}<input type="text" placeholder="Filter" aria-label="Filter the list" spellcheck="false" autocomplete="off"></label>
      <label class="hide"><input type="checkbox">Hide ticked items</label>
    </div>
    ${sections.map(s => `<section class="l-sec" style="--c:var(--c-${s.key})">
      <h3><span class="dot"></span>${esc(s.title)}<span class="n num">${fmtNum(s.groups.reduce((a, g) => a + g.items.length, 0))}</span></h3>
      ${s.groups.map(g => `<h4>${esc(g.title)}</h4><div class="l-rows">${g.items.map((x, i) => {
        const k = keyOf(s, g, x, i), url = x.link && safeUrl(x.link), ic = x.n.i && icons[x.n.i];
        return `<label class="l-row ${checked[k] ? 'done' : ''}" data-k="${esc(k)}" data-q="${esc(normalize(x.n.n + ' ' + x.meta))}">
          <input type="checkbox" ${checked[k] ? 'checked' : ''}>
          ${ic ? `<img src="${ic}" alt="">` : '<span class="kd"></span>'}
          <span class="t"><b>${esc(x.n.n)}</b>${x.meta ? `<small>${esc(x.meta)}</small>` : ''}</span>
          ${url ? `<a href="${esc(url)}" target="_blank" rel="noopener noreferrer">${esc(x.label || hostOf(url))}</a>` : '<span></span>'}
        </label>`;
      }).join('')}</div>`).join('')}
    </section>`).join('')}
    <p class="l-foot">Made with Wimap</p>
  </div>`;

  const bar = list.querySelector('.progress .bar'), fill = bar.querySelector('i'), label = list.querySelector('.progress span');
  const update = () => {
    const done = allKeys.filter(k => checked[k]).length;
    fill.style.width = (allKeys.length ? (done / allKeys.length) * 100 : 0) + '%';
    bar.setAttribute('aria-valuenow', done);
    label.textContent = `${fmtNum(done)} of ${fmtNum(allKeys.length)} done`;
  };
  update();
  list.addEventListener('change', e => {
    const row = e.target.closest('.l-row');
    if (row) {
      if (e.target.checked) checked[row.dataset.k] = true; else delete checked[row.dataset.k];
      row.classList.toggle('done', e.target.checked);
      store.set(TICKS, checked);
      update();
    } else if (e.target.closest('label.hide')) list.classList.toggle('hide-done', e.target.checked);
  });
  list.querySelector('.search input').addEventListener('input', e => {
    const q = normalize(e.target.value.trim());
    list.querySelectorAll('.l-row').forEach(r => { r.hidden = !!q && !r.dataset.q.includes(q); });
  });
})();
