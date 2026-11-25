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
    else $('x-list').dispatchEvent(new Event('scroll')); // refresh the outline highlight
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
  const CHEV = '<svg class="i chev" viewBox="0 0 24 24" aria-hidden="true"><path d="m9 6 6 6-6 6"/></svg>';
  const list = $('x-list');
  list.innerHTML = `<div class="l-wrap">
    <aside class="l-nav" aria-label="Sections">
      <div class="l-progress"><div class="bar" role="progressbar" aria-label="Done" aria-valuemin="0" aria-valuemax="${allKeys.length}"><i></i></div><span class="mono num"></span></div>
      <nav class="l-toc">${sections.map(s => `
        <a class="sec" href="#sec-${s.key}" data-sec="${s.key}" style="--c:var(--c-${s.key})"><span class="dot"></span><span class="nm">${esc(s.title)}</span><span class="n num"></span></a>
        ${s.groups.map((g, gi) => `<a class="grp" href="#grp-${s.key}-${gi}" data-grp="${s.key}-${gi}"><span class="nm">${esc(g.title)}</span><span class="n num"></span></a>`).join('')}`).join('')}
      </nav>
    </aside>
    <div class="l-main">
      <div class="l-top"><h2>Reinstall list</h2><p>Everything from the old PC that a fresh Windows will not bring back by itself. Tick items off as you set up the new one. Ticks stay in this browser.</p></div>
      <div class="l-bar">
        <label class="search">${svg('search')}<input type="text" placeholder="Filter" aria-label="Filter the list" spellcheck="false" autocomplete="off"><kbd>/</kbd></label>
        <div class="seg" role="group" aria-label="Show">
          <button type="button" data-show="all" aria-pressed="true">All</button>
          <button type="button" data-show="todo" aria-pressed="false">To do</button>
          <button type="button" data-show="done" aria-pressed="false">Done</button>
        </div>
        <button type="button" class="btn sm ghost fold">Fold all</button>
      </div>
      ${sections.map(s => `<section class="l-sec" id="sec-${s.key}" data-sec="${s.key}" style="--c:var(--c-${s.key})">
        <h3><span class="dot"></span>${esc(s.title)}<span class="n num"></span></h3>
        ${s.groups.map((g, gi) => `<details class="l-grp" id="grp-${s.key}-${gi}" data-grp="${s.key}-${gi}" open>
          <summary>${CHEV}<span>${esc(g.title)}</span><span class="n num"></span></summary>
          <div class="l-rows">${g.items.map((x, i) => {
            const k = keyOf(s, g, x, i), url = x.link && safeUrl(x.link), ic = x.n.i && icons[x.n.i];
            return `<label class="l-row ${checked[k] ? 'done' : ''}" data-k="${esc(k)}" data-q="${esc(normalize(x.n.n + ' ' + x.meta))}">
              <input type="checkbox" ${checked[k] ? 'checked' : ''}>
              ${ic ? `<img src="${ic}" alt="" loading="lazy">` : '<span class="kd"></span>'}
              <span class="t"><b>${esc(x.n.n)}</b>${x.meta ? `<small>${esc(x.meta)}</small>` : ''}</span>
              ${url ? `<a href="${esc(url)}" target="_blank" rel="noopener noreferrer"${x.label ? ' class="web"' : ''}>${esc(x.label || hostOf(url))}</a>` : '<span></span>'}
            </label>`;
          }).join('')}</div>
        </details>`).join('')}
      </section>`).join('')}
      <p class="l-empty" hidden>Nothing here matches. Try another word, or show All.</p>
      <p class="l-foot">Made with Wimap</p>
    </div>
  </div>`;

  const q = sel => list.querySelector(sel), qa = sel => [...list.querySelectorAll(sel)];
  const rows = qa('.l-row'), groups = qa('.l-grp'), secs = qa('.l-sec');
  const toc = new Map(qa('.l-toc a').map(a => [a.dataset.sec || a.dataset.grp, a]));
  const input = q('.l-bar input'), barEl = q('.l-bar');
  let showing = 'all';

  /** Counts always cover the whole list; the filter only decides what is visible. */
  function counts() {
    const done = allKeys.filter(k => checked[k]).length;
    const bar = q('.l-progress .bar');
    bar.querySelector('i').style.width = (allKeys.length ? (done / allKeys.length) * 100 : 0) + '%';
    bar.setAttribute('aria-valuenow', done);
    q('.l-progress span').textContent = `${fmtNum(done)} of ${fmtNum(allKeys.length)} done`;
    for (const sec of secs) {
      let sd = 0, st = 0;
      for (const g of sec.querySelectorAll('.l-grp')) {
        const r = g.querySelectorAll('.l-row'), d = g.querySelectorAll('.l-row.done').length;
        sd += d; st += r.length;
        const text = `${fmtNum(d)} / ${fmtNum(r.length)}`;
        g.querySelector('summary .n').textContent = text;
        g.classList.toggle('all-done', d === r.length && r.length > 0);
        const link = toc.get(g.dataset.grp);
        link.querySelector('.n').textContent = text;
        link.classList.toggle('all-done', d === r.length && r.length > 0);
      }
      const text = `${fmtNum(sd)} / ${fmtNum(st)}`;
      sec.querySelector('h3 .n').textContent = text;
      toc.get(sec.dataset.sec).querySelector('.n').textContent = text;
      toc.get(sec.dataset.sec).classList.toggle('all-done', sd === st && st > 0);
    }
  }

  function filter() {
    const term = normalize(input.value.trim());
    let any = false;
    for (const r of rows) {
      const done = r.classList.contains('done');
      r.hidden = (!!term && !r.dataset.q.includes(term)) || (showing === 'todo' && done) || (showing === 'done' && !done);
    }
    for (const g of groups) {
      const visible = [...g.querySelectorAll('.l-row')].some(r => !r.hidden);
      g.hidden = !visible;
      toc.get(g.dataset.grp).hidden = !visible;
      // A search opens the groups it found something in, so a match is never hidden behind a fold.
      if (visible && term) g.open = true;
    }
    for (const s of secs) {
      const visible = [...s.querySelectorAll('.l-grp')].some(g => !g.hidden);
      s.hidden = !visible;
      toc.get(s.dataset.sec).hidden = !visible;
      any = any || visible;
    }
    q('.l-empty').hidden = any;
    markCurrent();
  }

  // The outline follows the scroll position; the toolbar gets a hairline once it sticks.
  let raf = 0;
  function markCurrent() {
    raf = 0;
    const top = list.getBoundingClientRect().top + 96;
    let current = null;
    for (const s of secs) if (!s.hidden && s.getBoundingClientRect().top <= top) current = s;
    current = current || secs.find(s => !s.hidden);
    for (const [key, a] of toc) if (a.classList.contains('sec')) a.setAttribute('aria-current', String(!!current && key === current.dataset.sec));
    barEl.classList.toggle('stuck', barEl.getBoundingClientRect().top <= list.getBoundingClientRect().top + 1);
  }
  list.addEventListener('scroll', () => { if (!raf) raf = requestAnimationFrame(markCurrent); }, { passive: true });

  q('.l-toc').addEventListener('click', e => {
    const a = e.target.closest('a'); if (!a) return;
    e.preventDefault();
    const target = document.getElementById(a.getAttribute('href').slice(1));
    if (target.tagName === 'DETAILS') target.open = true;
    target.scrollIntoView({ block: 'start' });
  });

  list.addEventListener('change', e => {
    const row = e.target.closest('.l-row');
    if (!row) return;
    if (e.target.checked) checked[row.dataset.k] = true; else delete checked[row.dataset.k];
    row.classList.toggle('done', e.target.checked);
    store.set(TICKS, checked);
    counts();
    if (showing !== 'all') filter();
  });

  let timer;
  input.addEventListener('input', () => { clearTimeout(timer); timer = setTimeout(filter, 80); });
  input.addEventListener('keydown', e => { if (e.key === 'Escape' && input.value) { e.preventDefault(); input.value = ''; filter(); } });
  q('.l-bar .seg').addEventListener('click', e => {
    const b = e.target.closest('button'); if (!b) return;
    showing = b.dataset.show;
    for (const x of q('.l-bar .seg').children) x.setAttribute('aria-pressed', String(x === b));
    filter();
  });
  const foldBtn = q('.l-bar .fold');
  foldBtn.addEventListener('click', () => {
    const open = groups.some(g => g.open);
    for (const g of groups) g.open = !open;
    foldBtn.textContent = open ? 'Open all' : 'Fold all';
  });
  // "/" jumps to the filter while the list is showing.
  document.addEventListener('keydown', e => {
    if (e.key !== '/' || list.hidden || /^(INPUT|TEXTAREA)$/.test(document.activeElement?.tagName || '')) return;
    e.preventDefault();
    input.focus();
  });

  counts();
  filter();
})();
