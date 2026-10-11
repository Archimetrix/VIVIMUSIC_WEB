/**
 * VIVIMUSIC WEB — popup-info.js
 *
 * Keeps the settings pages compact: every long description (".theme-sub") is
 * folded away behind a small "i" button next to the setting it explains.
 * Tap the button to open / close the description in place.
 *
 * Optional markup hooks:
 *   data-info-for="<css selector>"  attach the button to that element instead of
 *                                   the row directly above the description
 *   data-info-keep                  never collapse this description
 */
(() => {
  'use strict';

  const MIN_LEN = 20;          // one-line credits such as "By Chengggit" stay visible
  let uid = 0;

  function labelFor(row) {
    return row.querySelector('.row-label') || row.querySelector('span');
  }

  // Where does the button go?  -> { host, mode: 'append' | 'after' } | null
  function findAnchor(note) {
    const sel = note.getAttribute('data-info-for');
    if (sel) {
      const el = document.querySelector(sel);
      if (!el) return null;
      const row = el.closest('.row, .provider-row');
      if (row && (el.matches('input, label, .switch') || el === row)) {
        const label = labelFor(row);
        return label ? { host: label, mode: 'append' } : null;
      }
      return { host: el, mode: 'after' };
    }
    // nearest row above the note (skipping small helper blocks such as a font preview)
    let prev = note.previousElementSibling;
    for (let hops = 0; prev && hops < 3; hops++, prev = prev.previousElementSibling) {
      if (prev.classList.contains('theme-sub')) return null;
      if (prev.matches('.row, .provider-row')) {
        const label = labelFor(prev);
        return label ? { host: label, mode: 'append' } : null;
      }
    }
    return null;
  }

  function makeButton(note, anchorText) {
    const id = note.id || 'info-note-' + (++uid);
    note.id = id;
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'info-btn';
    btn.textContent = 'i';
    btn.setAttribute('aria-expanded', 'false');
    btn.setAttribute('aria-controls', id);
    btn.setAttribute('aria-label', 'More info' + (anchorText ? ': ' + anchorText : ''));
    btn.title = 'More info';
    btn.addEventListener('click', (e) => {
      e.preventDefault();
      e.stopPropagation();
      const open = !note.classList.contains('info-open');
      note.classList.toggle('info-open', open);
      btn.setAttribute('aria-expanded', String(open));
    });
    return btn;
  }

  function init() {
    document.querySelectorAll('.theme-sub').forEach((note) => {
      if (note.hasAttribute('data-info-keep') || note.dataset.info === '1') return;
      if (note.textContent.trim().length < MIN_LEN) return;
      const anchor = findAnchor(note);
      if (!anchor) return;
      const text = (anchor.host.textContent || '').trim().slice(0, 60);
      const btn = makeButton(note, anchor.mode === 'append' ? text : '');
      if (anchor.mode === 'append') anchor.host.appendChild(btn);
      else anchor.host.insertAdjacentElement('afterend', btn);
      note.dataset.info = '1';     // CSS hides it until the button opens it
      note.setAttribute('role', 'note');
    });
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init);
  else init();
})();
