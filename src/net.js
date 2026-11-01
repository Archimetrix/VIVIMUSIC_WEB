/* VIVIMUSIC WEB — net.js  (content script, isolated world)
 * Content scripts run "as" music.youtube.com, so the browser treats calls to
 * lyrics / SponsorBlock / iTunes servers as cross-origin and rejects them
 * ("Unsafe attempt to load URL … Domains, protocols and ports must match").
 * The extension's background worker has host permissions and isn't bound by
 * that rule, so cross-origin fetch() calls made from this world are relayed
 * through it. Same-origin and extension URLs keep using the normal fetch.
 * This only changes fetch inside the extension's own isolated world — the
 * page's own scripts are untouched.
 */
(() => {
  'use strict';
  if (window.__viviNetPatched) return;
  window.__viviNetPatched = true;

  const nativeFetch = window.fetch.bind(window);
  const NO_BODY = new Set([101, 204, 205, 304]);

  const isExternal = (url) => {
    try {
      const u = new URL(url, location.href);
      return u.protocol === 'https:' && u.origin !== location.origin;
    } catch { return false; }
  };

  const b64ToBytes = (b64) => {
    const bin = atob(b64);
    const out = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
    return out;
  };

  window.fetch = function (input, init = {}) {
    const url = typeof input === 'string' ? input : (input && input.url) || String(input);
    const req = typeof input === 'object' && input instanceof Request ? input : null;
    const body = init.body ?? null;
    const plainBody = body === null || typeof body === 'string' || body instanceof URLSearchParams;
    if (req || !isExternal(url) || !plainBody) return nativeFetch(input, init);

    const signal = init.signal;
    if (signal?.aborted) return Promise.reject(new DOMException('Aborted', 'AbortError'));

    const headers = {};
    new Headers(init.headers || {}).forEach((v, k) => { headers[k] = v; });

    const relay = new Promise((resolve, reject) => {
      try {
        chrome.runtime.sendMessage({
          type: 'VIVI_NET_FETCH',
          url: new URL(url, location.href).href,
          init: {
            method: init.method || 'GET',
            headers,
            body: body === null ? null : String(body),
            credentials: init.credentials,
            cache: init.cache,
          },
        }, (reply) => {
          if (chrome.runtime.lastError || !reply) return reject(new TypeError('Network request failed'));
          if (!reply.ok) return reject(new TypeError(reply.error || 'Network request failed'));
          const bytes = reply.body ? b64ToBytes(reply.body) : null;
          resolve(new Response(NO_BODY.has(reply.status) ? null : bytes, {
            status: reply.status, statusText: reply.statusText, headers: reply.headers,
          }));
        });
      } catch (e) { reject(e); }
    });

    if (!signal) return relay;
    return Promise.race([
      relay,
      new Promise((_, reject) => signal.addEventListener('abort', () => reject(new DOMException('Aborted', 'AbortError')), { once: true })),
    ]);
  };
})();
