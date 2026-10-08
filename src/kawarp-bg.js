/* VIVIMUSIC WEB — kawarp-bg.js
 *
 * Wires @kawarp/core (src/kawarp.js, loaded as a global `Kawarp` before this
 * script) into the ambient full-page background layer that content.js
 * creates via ensureBgEl()/setBackgroundVar(). Instead of (or on top of) the
 * static blurred <div>, this renders a live fluid/domain-warp animation of
 * the current track's artwork, similar to Apple Music's now-playing screen.
 *
 * Design notes:
 * - Kawarp needs no audio graph — it only reacts to the album art image —
 *   so it's a much lighter, lower-risk addition than a Milkdrop/Butterchurn
 *   style audio-reactive visualizer would be.
 * - This module never assumes the wrapper exists yet; it lazily attaches to
 *   #vivi-bg-layer whenever content.js creates/recreates it, and exposes a
 *   tiny public API on window.__viviKawarp that content.js calls into:
 *     __viviKawarp.setArtwork(url)   — swap the animated background image
 *     __viviKawarp.setEnabled(bool)  — turn the effect on/off (falls back
 *                                      to the existing static blurred div)
 * - If WebGL isn't available, or an image load fails (e.g. a thumbnail host
 *   without permissive CORS), it silently falls back to the pre-existing
 *   blurred <div> background so nothing regresses.
 */
(() => {
  const BG_ID = 'vivi-bg-layer';
  const CANVAS_ID = 'vivi-bg-kawarp';

  let kawarp = null;
  let canvas = null;
  let enabled = false;         // user setting, off until storage confirms on
  let webglOk = true;          // flips false permanently on first hard failure
  let lastUrl = null;
  let pendingUrl = null;
  let resizeObserver = null;
  let pendingOptions = null;   // options set before Kawarp instance exists
  let pauseWhenInactive = true; // "Pause when inactive" setting
  let pausedForVisibility = false;
  let brightness = 0.5;       // CSS brightness on the canvas (1 = unchanged)

  function log(...a) { console.log('[Vivi Kawarp]', ...a); }
  function warn(...a) { console.debug('[Vivi Kawarp]', ...a); }

  function getWrapper() {
    return document.getElementById(BG_ID);
  }

  function ensureCanvas() {
    const wrapper = getWrapper();
    if (!wrapper) return null;

    let el = document.getElementById(CANVAS_ID);
    if (el && el.parentElement === wrapper) return el;

    el = document.createElement('canvas');
    el.id = CANVAS_ID;
    el.style.cssText = [
      'position:absolute',
      'inset:0',
      'width:100%',
      'height:100%',
      'display:block',
      'opacity:0',
      'transition:opacity 0.6s ease-in-out',
      `filter:brightness(${brightness})`,
    ].join(';');
    wrapper.appendChild(el);
    return el;
  }

  function sizeCanvas(el) {
    if (!el) return;
    const dpr = Math.min(window.devicePixelRatio || 1, 2); // cap DPR — this is a blurred backdrop, not detail work
    const w = Math.max(1, Math.round(window.innerWidth * dpr));
    const h = Math.max(1, Math.round(window.innerHeight * dpr));
    if (el.width !== w || el.height !== h) {
      el.width = w;
      el.height = h;
      kawarp?.resize();
    }
  }

  function initKawarp() {
    if (kawarp || !webglOk) return kawarp;
    canvas = ensureCanvas();
    if (!canvas) return null;
    if (typeof window.Kawarp !== 'function') {
      warn('kawarp.js did not load — skipping fluid background');
      webglOk = false;
      return null;
    }
    try {
      kawarp = new window.Kawarp(canvas, Object.assign({
        warpIntensity: 1.0,
        blurPasses: 5,
        animationSpeed: 4.15,
        transitionDuration: 0,
        saturation: 2.6,
        dithering: 0.034,
        tintIntensity: 0.12,
        scale: 1.15,
        opacity: 1.0,
      }, pendingOptions || {}));
      sizeCanvas(canvas);
      if (!resizeObserver) {
        resizeObserver = new ResizeObserver(() => sizeCanvas(canvas));
        resizeObserver.observe(document.documentElement);
      }
    } catch (e) {
      warn('WebGL init failed, disabling fluid background:', e?.message || e);
      webglOk = false;
      kawarp = null;
    }
    return kawarp;
  }

  function showCanvas() {
    if (!canvas) return;
    // Restore the smooth fade-in for the normal "artwork just loaded" case.
    canvas.style.transition = 'opacity 0.6s ease-in-out';
    canvas.style.opacity = '1';
  }
  function hideCanvas() {
    if (!canvas) return;
    // Hiding (e.g. the player was minimized / navigated away from) must be
    // instant — this layer sits behind the whole app (Home/Explore/etc),
    // so a lingering fade-out here reads as the animation "leaking" onto
    // whatever page the person just navigated back to.
    canvas.style.transition = 'none';
    canvas.style.opacity = '0';
  }

  // Strip YouTube Music's size suffix (=w60-h60-l90-rj etc.) so the same cover
  // at different sizes counts as ONE image, and upsize it for a sharper source.
  const SIZE_SUFFIX_RE = /=w\d+-h\d+[^?#]*$/;
  function artKey(url) { return String(url).replace(SIZE_SUFFIX_RE, ''); }
  function upsize(url) { return SIZE_SUFFIX_RE.test(url) ? url.replace(SIZE_SUFFIX_RE, '=w544-h544-l90-rj') : url; }

  function loadImg(src) {
    return new Promise((resolve, reject) => {
      const img = new Image();
      img.crossOrigin = 'anonymous';
      img.onload = () => resolve(img);
      img.onerror = () => reject(new Error('load failed: ' + src));
      img.src = src;
    });
  }

  // Kawarp is driven ONLY by the player-bar thumbnail (see watchBarThumb).
  // Apple/Spotify artwork never reaches here, so nothing can fight over it.
  async function applyArtwork(url) {
    if (!url || !webglOk) return;
    const key = artKey(url);
    if (key === lastUrl) return;
    try {
      const u = new URL(url, location.href);
      if (!/^https?:$/.test(u.protocol) || u.href === location.href || u.pathname === '/') return;
    } catch { return; }
    pendingUrl = key;

    const inst = initKawarp();
    if (!inst) return;

    let img;
    try {
      try { img = await loadImg(upsize(url)); }
      catch { img = await loadImg(url); } // upsized variant unavailable -> original
    } catch (e) {
      warn('Failed to load artwork into Kawarp:', e?.message || e);
      return;
    }
    // A newer track arrived while loading: drop this one BEFORE touching the
    // GL texture (the old code uploaded first, so a slow stale load could win).
    if (pendingUrl !== key) return;
    try {
      inst.loadImageElement(img);
    } catch (e) {
      warn('Kawarp texture upload failed:', e?.message || e);
      return;
    }
    lastUrl = key;
    if (enabled) {
      if (!(pauseWhenInactive && document.hidden)) inst.start();
      showCanvas();
    }
  }

  // Live-tunable render settings: warpIntensity, blurPasses, animationSpeed,
  // transitionDuration, saturation, dithering, opacity, scale, tintIntensity.
  // Called from content.js when the user changes a slider in the popup.
  function setOptions(opts) {
    if (!opts) return;
    // Brightness isn't a Kawarp shader option — it's applied as a CSS filter
    // on the canvas, so handle it here and keep it out of the Kawarp options.
    const { brightness: nextBrightness, ...kawarpOpts } = opts;
    if (nextBrightness !== undefined && Number.isFinite(Number(nextBrightness))) {
      brightness = Math.max(0.1, Math.min(2, Number(nextBrightness)));
      const el = document.getElementById(CANVAS_ID);
      if (el) el.style.filter = `brightness(${brightness})`;
    }
    pendingOptions = Object.assign({}, pendingOptions, kawarpOpts);
    kawarp?.setOptions(kawarpOpts);
  }

  function setPauseWhenInactive(next) {
    pauseWhenInactive = next !== false;
    // Re-evaluate immediately in case the tab is already hidden/visible.
    handleVisibilityChange();
  }

  function handleVisibilityChange() {
    if (!kawarp) return;
    if (pauseWhenInactive && document.hidden) {
      if (kawarp.isPlaying) {
        pausedForVisibility = true;
        kawarp.stop();
      }
    } else if (pausedForVisibility) {
      pausedForVisibility = false;
      if (enabled) kawarp.start();
    }
  }
  document.addEventListener('visibilitychange', handleVisibilityChange);


  // ── Follow the player-bar thumbnail directly ─────────────────────────────
  // content.js hands Kawarp an artwork URL by reading the player bar's <img>
  // at the instant the track changes. YouTube Music swaps that <img>'s src a
  // moment *after* the track change, so the read returned the PREVIOUS song's
  // thumbnail, and nothing re-read it until the Spotify/Apple lookups finished
  // (several seconds) — Kawarp kept animating the old art until then. Watching
  // the thumbnail's src ourselves means the new cover is picked up the moment
  // YouTube Music updates it. Apple/Spotify artwork passed in through
  // setArtwork() still overrides it afterwards, exactly as before.
  const BAR_IMG_SELECTOR = '.image-wrapper img, ytmusic-thumbnail img, #thumbnail img, .thumbnail-image-wrapper img';
  let barObserver = null;
  let barImgEl = null;
  let barSyncScheduled = false;

  function readBarThumbUrl() {
    const bar = document.querySelector('ytmusic-player-bar');
    const img = bar?.querySelector(BAR_IMG_SELECTOR);
    const src = img?.currentSrc || img?.src || '';
    // Ignore empty / inline placeholders YouTube Music shows while loading.
    if (!src || src.startsWith('data:') || src.startsWith('blob:') || src === location.href || src === location.origin + '/') return null;
    return src;
  }

  function syncFromBar() {
    barSyncScheduled = false;
    const url = readBarThumbUrl();
    if (url && artKey(url) !== lastUrl) applyArtwork(url);
  }

  function scheduleBarSync() {
    if (barSyncScheduled) return;
    barSyncScheduled = true;
    queueMicrotask(syncFromBar);
  }

  function watchBarThumb() {
    const bar = document.querySelector('ytmusic-player-bar');
    if (!bar) { setTimeout(watchBarThumb, 500); return; }
    if (barObserver) return;
    barObserver = new MutationObserver(scheduleBarSync);
    barObserver.observe(bar, { attributes: true, attributeFilter: ['src', 'srcset'], childList: true, subtree: true });
    // The <img> can finish loading a new src without the attribute changing
    // again (cached images), so also listen for load events on the bar.
    bar.addEventListener('load', scheduleBarSync, true);
    scheduleBarSync();
  }
  watchBarThumb();

  function setEnabled(next) {
    enabled = !!next;
    if (!enabled) {
      hideCanvas();
      kawarp?.stop();
      return;
    }
    // Catch up with whatever is playing now — lastUrl can be a stale cover
    // from before Kawarp was switched on / the full player was reopened.
    scheduleBarSync();
    if (lastUrl) {
      initKawarp();
      if (!(pauseWhenInactive && document.hidden)) {
        kawarp?.start();
      }
      showCanvas();
    }
  }

  function dispose() {
    kawarp?.dispose();
    kawarp = null;
    lastUrl = null;
    resizeObserver?.disconnect();
    resizeObserver = null;
  }

  window.__viviKawarp = {
    setArtwork: () => {}, // intentionally ignored: bar thumbnail is the only source
    setEnabled,
    setOptions,
    setPauseWhenInactive,
    dispose,
  };

  log('ready');
})();
