/* Wimap menu bar: File, Edit, View, Settings, Help.
   Follows the WAI-ARIA menubar pattern: Alt or F10 focuses it, arrows move, Enter runs, Escape closes. */
(function (global) {
  'use strict';

  const CHECK = '<svg class="i" viewBox="0 0 24 24" aria-hidden="true"><path d="m5 12 5 5 9-10"/></svg>';
  const DOT = '<svg class="i" viewBox="0 0 24 24" aria-hidden="true"><circle cx="12" cy="12" r="3.5" fill="currentColor" stroke="none"/></svg>';
  const esc = global.WimapUtil.esc;

  /**
   * Items: { label, keys? (active shortcut), hint? (shown instead of keys), run(), enabled?(), checked?(), type?: 'radio'|'check' } | '-' | { group: 'Label' }
   */
  class MenuBar {
    constructor(bar, menus) {
      this.bar = bar;
      this.menus = menus;
      this.openIx = -1;
      this.pop = document.createElement('div');
      this.pop.className = 'menu';
      this.pop.setAttribute('role', 'menu');
      this.pop.hidden = true;
      document.body.appendChild(this.pop);
      bar.setAttribute('role', 'menubar');
      bar.innerHTML = menus.map((m, i) => `<button type="button" class="mb" role="menuitem" aria-haspopup="menu" aria-expanded="false" data-ix="${i}" tabindex="${i === 0 ? 0 : -1}">${esc(m.label)}</button>`).join('');
      this.tops = [...bar.querySelectorAll('.mb')];
      this.wire();
    }

    wire() {
      this.bar.addEventListener('click', e => {
        const b = e.target.closest('.mb'); if (!b) return;
        const i = +b.dataset.ix;
        if (this.openIx === i) this.close(); else this.open(i, false);
      });
      this.bar.addEventListener('pointerover', e => {
        const b = e.target.closest('.mb');
        if (b && this.openIx !== -1 && +b.dataset.ix !== this.openIx) this.open(+b.dataset.ix, false);
      });
      this.bar.addEventListener('keydown', e => {
        const b = e.target.closest('.mb'); if (!b) return;
        const i = +b.dataset.ix;
        if (e.key === 'ArrowRight' || e.key === 'ArrowLeft') {
          e.preventDefault();
          const j = (i + (e.key === 'ArrowRight' ? 1 : -1) + this.tops.length) % this.tops.length;
          if (this.openIx !== -1) this.open(j, true); else this.focusTop(j);
        } else if (e.key === 'ArrowDown' || e.key === 'Enter' || e.key === ' ') { e.preventDefault(); this.open(i, true); }
        else if (e.key === 'Escape') { e.preventDefault(); this.close(); b.blur(); }
      });
      this.pop.addEventListener('keydown', e => this.menuKeys(e));
      this.pop.addEventListener('click', e => {
        const it = e.target.closest('[data-item]');
        if (it && it.getAttribute('aria-disabled') !== 'true') this.run(+it.dataset.item);
      });
      this.pop.addEventListener('pointermove', e => {
        const it = e.target.closest('[data-item]');
        if (it && document.activeElement !== it && it.getAttribute('aria-disabled') !== 'true') it.focus({ preventScroll: true });
      });
      document.addEventListener('pointerdown', e => {
        if (this.openIx !== -1 && !this.pop.contains(e.target) && !this.bar.contains(e.target)) this.close();
      }, true);
      window.addEventListener('blur', () => this.close());
      window.addEventListener('resize', () => this.close());
    }

    focusTop(i) {
      this.tops.forEach((t, j) => t.tabIndex = j === i ? 0 : -1);
      this.tops[i].focus();
    }

    /** Alt or F10 lands on the first menu, like a native menu bar. */
    focusBar() { this.focusTop(Math.max(0, this.openIx)); }

    open(i, focusFirst) {
      const menu = this.menus[i];
      this.openIx = i;
      this.tops.forEach((t, j) => t.setAttribute('aria-expanded', String(j === i)));
      this.focusTop(i);
      const items = menu.items;
      this.pop.setAttribute('aria-label', menu.label);
      this.pop.innerHTML = items.map((it, j) => {
        if (it === '-') return '<div class="m-sep" role="separator"></div>';
        if (it.group) return `<div class="m-group" role="presentation">${esc(it.group)}</div>`;
        const enabled = it.enabled ? it.enabled() : true;
        const role = it.type === 'radio' ? 'menuitemradio' : it.type === 'check' ? 'menuitemcheckbox' : 'menuitem';
        const checked = it.checked ? it.checked() : false;
        const mark = it.type === 'radio' ? (checked ? DOT : '') : it.type === 'check' ? (checked ? CHECK : '') : '';
        return `<div class="m-item" role="${role}" tabindex="-1" data-item="${j}" aria-disabled="${!enabled}"${it.type ? ` aria-checked="${checked}"` : ''}>
          <span class="m-mark">${mark}</span><span class="m-label">${esc(it.label)}</span>${it.hint || it.keys ? `<span class="m-keys">${esc(it.hint || it.keys)}</span>` : ''}</div>`;
      }).join('');
      const r = this.tops[i].getBoundingClientRect();
      this.pop.hidden = false;
      const w = this.pop.offsetWidth;
      this.pop.style.left = `${Math.min(r.left, window.innerWidth - w - 8)}px`;
      this.pop.style.top = `${r.bottom + 4}px`;
      if (focusFirst) this.move(0, 1);
    }

    close() {
      if (this.openIx === -1) return;
      this.openIx = -1;
      this.pop.hidden = true;
      this.tops.forEach(t => t.setAttribute('aria-expanded', 'false'));
    }

    enabledItems() { return [...this.pop.querySelectorAll('[data-item]')].filter(x => x.getAttribute('aria-disabled') !== 'true'); }

    move(from, dir) {
      const list = this.enabledItems();
      if (!list.length) return;
      const cur = list.indexOf(document.activeElement);
      const next = cur === -1 ? (dir > 0 ? from : list.length - 1) : (cur + dir + list.length) % list.length;
      list[next].focus();
    }

    menuKeys(e) {
      const top = this.openIx;
      if (e.key === 'ArrowDown') { e.preventDefault(); this.move(0, 1); }
      else if (e.key === 'ArrowUp') { e.preventDefault(); this.move(0, -1); }
      else if (e.key === 'Home') { e.preventDefault(); this.enabledItems()[0]?.focus(); }
      else if (e.key === 'End') { e.preventDefault(); this.enabledItems().pop()?.focus(); }
      else if (e.key === 'ArrowRight' || e.key === 'ArrowLeft') {
        e.preventDefault();
        this.open((top + (e.key === 'ArrowRight' ? 1 : -1) + this.tops.length) % this.tops.length, true);
      } else if (e.key === 'Enter' || e.key === ' ') {
        e.preventDefault();
        const it = e.target.closest('[data-item]');
        if (it && it.getAttribute('aria-disabled') !== 'true') this.run(+it.dataset.item);
      } else if (e.key === 'Escape') { e.preventDefault(); this.close(); this.focusTop(top); }
      else if (e.key === 'Tab') this.close();
    }

    run(j) {
      const it = this.menus[this.openIx].items[j];
      const top = this.openIx;
      this.close();
      this.tops[top].blur();
      if (it && it.run) it.run();
    }

    /** Every item with a shortcut, for the global key handler. */
    shortcuts() {
      const out = [];
      for (const m of this.menus) for (const it of m.items) if (it && it.keys && it.run) out.push(it);
      return out;
    }
  }

  /**
   * "Ctrl+Shift+E" → matcher for a KeyboardEvent.
   * Shift must match exactly for combinations (Ctrl+E is not Ctrl+Shift+E) and named keys (F1, Escape).
   * For a lone printed character the character itself decides, because "?" or "]" need Shift on some layouts.
   */
  function parseKeys(spec) {
    const parts = spec.split('+').map(s => s.trim());
    const key = (parts.pop() || '+').toLowerCase();
    const mods = new Set(parts.filter(Boolean).map(p => p.toLowerCase()));
    return e => {
      if (!!(e.ctrlKey || e.metaKey) !== mods.has('ctrl') || !!e.altKey !== mods.has('alt')) return false;
      if (mods.has('shift') ? !e.shiftKey : (key.length > 1 || mods.size > 0) && e.shiftKey) return false;
      const k = e.key.toLowerCase();
      return k === key || (key === '=' && k === '+');
    };
  }

  global.WimapMenus = { MenuBar, parseKeys };
})(window);
