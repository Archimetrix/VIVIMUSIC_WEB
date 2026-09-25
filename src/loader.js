/**
 * VIVIMUSIC WEB — loader.js
 *
 * Runs at document_start, before YT Music has painted anything, so we can
 * cover the page with our own splash before the stock UI has a chance to
 * flash in unstyled/partially-themed.
 */

(() => {
  'use strict';

  const OVERLAY_ID   = 'vivi-loading-overlay';
  const MIN_VISIBLE  = 350;   // avoid a jarring one-frame flash on fast loads
  const HARD_TIMEOUT = 8000;  // never block the app forever if something goes wrong

  let logoUrl = '';
  try {
    logoUrl = chrome.runtime.getURL('icons/custom-logo-icon.png');
  } catch { /* no-op */ }

  // ── Favicon override, as early as possible ──
  // This runs at document_start, before the parser has even produced <head>
  // in most cases, so there's no favicon to remove yet — we just need to make
  // sure OUR icon link wins the moment <head> (and YT Music's own icon link
  // inside it) shows up. We watch for both events and strip anything that
  // isn't ours the instant it appears, which is as close to zero-flicker as
  // a content script can get (a native browser feature, not something we
  // can hook synchronously the way a MutationObserver requires a tick).
  function installFaviconOverride() {
    if (!logoUrl) return;

    function ourLink() {
      const link = document.createElement('link');
      link.rel = 'icon';
      link.type = 'image/png';
      link.href = logoUrl;
      return link;
    }

    function stripForeignIcons(root) {
      root.querySelectorAll('link[rel~="icon"]').forEach((el) => {
        if (el.href !== logoUrl && !el.href.endsWith(logoUrl)) el.remove();
      });
    }

    if (document.head) {
      stripForeignIcons(document.head);
      document.head.insertBefore(ourLink(), document.head.firstChild);
    }

    // Catch <head> arriving later, and catch YT Music inserting its own
    // icon link(s) at any point afterward (it does this again on some
    // client-side navigations), removing them the instant they land.
    const observer = new MutationObserver((mutations) => {
      if (!document.head) return;
      let sawForeignIcon = false;
      for (const m of mutations) {
        for (const node of m.addedNodes) {
          if (node.nodeType !== 1) continue;
          if (node.matches?.('link[rel~="icon"]') && node.href !== logoUrl && !node.href?.endsWith?.(logoUrl)) {
            sawForeignIcon = true;
          } else if (node.querySelector?.('link[rel~="icon"]')) {
            sawForeignIcon = true;
          }
        }
      }
      if (sawForeignIcon) {
        stripForeignIcons(document.head);
        if (!document.head.querySelector(`link[rel~="icon"][href="${logoUrl}"]`)) {
          document.head.insertBefore(ourLink(), document.head.firstChild);
        }
      }
    });
    observer.observe(document.documentElement, { childList: true, subtree: true });
  }
  installFaviconOverride();

  // ── Title override, as early as possible ──
  // YT Music may replace the entire <title> node (not merely its text), so
  // watching only the current title element is not sufficient. Keep watching
  // <head> until content.js takes over the real track title.
  (function installTitleOverride() {
    const PLACEHOLDER = 'VIVIMUSIC';

    function enforce() {
      if (window.__viviTitleTakeover) return;
      if (document.title !== PLACEHOLDER) document.title = PLACEHOLDER;
    }

    enforce();

    const headObserver = new MutationObserver(() => enforce());
    const watch = () => {
      if (document.head) {
        headObserver.observe(document.head, {
          childList: true,
          subtree: true,
          characterData: true,
        });
        enforce();
      }
    };

    if (document.head) watch();
    else {
      const rootObserver = new MutationObserver(() => {
        if (document.head) {
          rootObserver.disconnect();
          watch();
        }
      });
      rootObserver.observe(document.documentElement, { childList: true, subtree: true });
    }
  })();

  const shownAt = Date.now();

  function injectOverlay() {
    const style = document.createElement('style');
    style.id = OVERLAY_ID + '-style';
    style.textContent = `
      #${OVERLAY_ID} {
        position: fixed;
        inset: 0;
        z-index: 2147483647;
        background: #030303;
        display: flex;
        flex-direction: column;
        align-items: center;
        justify-content: center;
        gap: 18px;
        opacity: 1;
        transition: opacity 0.4s ease;
      }
      #${OVERLAY_ID}.vivi-loading-hide {
        opacity: 0;
        pointer-events: none;
      }
      #${OVERLAY_ID} img {
        width: 72px;
        height: 72px;
        animation: vivi-loading-pulse 1.3s ease-in-out infinite;
      }
      #${OVERLAY_ID} .vivi-loading-text {
        font-family: 'Roboto', Arial, sans-serif;
        font-size: 15px;
        letter-spacing: 0.3px;
        color: rgba(255, 255, 255, 0.72);
      }
      @keyframes vivi-loading-pulse {
        0%, 100% { transform: scale(1); opacity: 1; }
        50%      { transform: scale(0.88); opacity: 0.6; }
      }
    `;

    const overlay = document.createElement('div');
    overlay.id = OVERLAY_ID;

    const img = document.createElement('img');
    img.src = logoUrl;
    img.alt = 'Vivimusic';

    const text = document.createElement('div');
    text.className = 'vivi-loading-text';
    text.textContent = 'Loading Vivimusic…';

    overlay.appendChild(img);
    overlay.appendChild(text);

    const root = document.documentElement;
    root.appendChild(style);
    root.appendChild(overlay);
  }

  // documentElement always exists by the time a content script runs, even
  // at document_start, so we don't need to wait for it.
  injectOverlay();

  function removeOverlay() {
    const overlay = document.getElementById(OVERLAY_ID);
    const style   = document.getElementById(OVERLAY_ID + '-style');
    if (!overlay) return;

    const elapsed = Date.now() - shownAt;
    const wait = Math.max(0, MIN_VISIBLE - elapsed);

    setTimeout(() => {
      overlay.classList.add('vivi-loading-hide');
      overlay.addEventListener('transitionend', () => {
        overlay.remove();
        style?.remove();
      }, { once: true });
      // Fallback in case transitionend doesn't fire for some reason
      setTimeout(() => { overlay.remove(); style?.remove(); }, 600);
    }, wait);
  }

  function whenReady() {
    // YT Music is a SPA shell — "ready" means its nav bar / player bar has
    // actually mounted, not just that the HTML document finished loading.
    if (document.querySelector('ytmusic-nav-bar, ytmusic-player-bar')) {
      removeOverlay();
      return;
    }
    const observer = new MutationObserver(() => {
      if (document.querySelector('ytmusic-nav-bar, ytmusic-player-bar')) {
        observer.disconnect();
        removeOverlay();
      }
    });
    observer.observe(document.documentElement, { childList: true, subtree: true });

    // Absolute fallback so a slow/odd load never leaves the cover stuck up.
    setTimeout(() => {
      observer.disconnect();
      removeOverlay();
    }, HARD_TIMEOUT);
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', whenReady);
  } else {
    whenReady();
  }
})();
