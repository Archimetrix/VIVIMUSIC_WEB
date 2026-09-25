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

  function log(...a) { console.log('[Vivi Kawarp]', ...a); }
  function warn(...a) { console.warn('[Vivi Kawarp]', ...a); }

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

  async function applyArtwork(url) {
    if (!url || !webglOk) return;
    if (url === lastUrl) return;
    pendingUrl = url;

    const inst = initKawarp();
    if (!inst) return;

    try {
      await inst.loadImage(url);
      // Another track may have changed while the image was loading — only
      // commit/show if this is still the most recently requested artwork.
      if (pendingUrl !== url) return;
      lastUrl = url;
      if (!(pauseWhenInactive && document.hidden)) {
        inst.start();
      }
      if (enabled) showCanvas();
    } catch (e) {
      // Most likely a CORS-restricted thumbnail host. Fail quietly and keep
      // showing the existing static blurred-image background instead.
      warn('Failed to load artwork into Kawarp, falling back to static blur:', e?.message || e);
      hideCanvas();
    }
  }

  // Live-tunable render settings: warpIntensity, blurPasses, animationSpeed,
  // transitionDuration, saturation, dithering, opacity, scale, tintIntensity.
  // Called from content.js when the user changes a slider in the popup.
  function setOptions(opts) {
    if (!opts) return;
    pendingOptions = Object.assign({}, pendingOptions, opts);
    kawarp?.setOptions(opts);
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

  function setEnabled(next) {
    enabled = !!next;
    if (!enabled) {
      hideCanvas();
      kawarp?.stop();
      return;
    }
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
    setArtwork: applyArtwork,
    setEnabled,
    setOptions,
    setPauseWhenInactive,
    dispose,
  };

  log('ready');
})();
