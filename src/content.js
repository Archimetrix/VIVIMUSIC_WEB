/**
 * VIVIMUSIC WEB — content.js
 */

(() => {
  'use strict';

  // Apple Music's animated Canvas is now resolved directly against Apple's
  // own catalog API from background.js (see apple-canvas.js) rather than a
  // third-party proxy — nothing to preconnect to here, since that request
  // never leaves this content script's process.
  const ITUNES_SEARCH_BASE = 'https://itunes.apple.com/search';
  const POLL_INTERVAL  = 2500;           // slow safety-net poll (scrobble progress etc.) — real track-change detection is event-driven now
  const FETCH_TIMEOUT  = 6000;           // give up on a hung request instead of waiting forever
  const RETRY_DELAYS   = [2000, 5000, 12000]; // progressive backoff instead of one fixed 8s wait
  const THEME_LINK_ID  = 'vivi-theme-link';
  const DEBUG          = false;
  const SPOTIFY_CANVAS_DEFAULT = true;

  // Warm up the DNS/TLS connection to Apple's iTunes search endpoint (the
  // one request this content script still makes directly) as early as
  // possible, since it's on the critical path for perceived load time.
  (function preconnect() {
    try {
      const link = document.createElement('link');
      link.rel = 'preconnect';
      link.href = ITUNES_SEARCH_BASE;
      link.crossOrigin = 'anonymous';
      document.head.appendChild(link);
    } catch { /* no-op */ }
  })();

  // ── Safe DOM observer ─────────────────────────────────────────────────
  // Both the logo swap and the Support-button swap watch the document and
  // rewrite DOM nodes from inside their own MutationObserver callback. That is
  // a feedback loop by construction: every write we make re-triggers the
  // observer, which writes again. Normally it converges because the second pass
  // finds nothing left to change — but if YouTube Music re-adds a node on every
  // pass (its guide/premium-badge slot does exactly this in some states), the
  // loop never settles and pins the main thread at 100%, which presents as the
  // whole page freezing while a track loads. Nothing about that depends on any
  // feature toggle, which is why turning everything off didn't help.
  //
  // observeDom() makes that structurally impossible:
  //   1. the observer is disconnected while our own callback runs, so our
  //      writes can never feed back into it;
  //   2. callbacks are coalesced into one rAF tick instead of firing per
  //      mutation record;
  //   3. a circuit breaker trips if the callback keeps firing far more often
  //      than any real re-render would, permanently downgrading to a slow
  //      interval so a pathological page can degrade instead of hanging.
  function observeDom(target, options, callback, label = 'observer') {
    if (!target) return null;

    const BURST_WINDOW_MS = 1000;
    const BURST_LIMIT = 60;      // far above any legitimate re-render rate
    const FALLBACK_INTERVAL_MS = 2000;

    let scheduled = false;
    let windowStart = Date.now();
    let runsInWindow = 0;
    let tripped = false;

    const observer = new MutationObserver(() => schedule());

    const connect = () => { try { observer.observe(target, options); } catch { /* no-op */ } };

    const run = () => {
      scheduled = false;
      // Suppress self-feedback: our own writes below must not re-enter here.
      observer.disconnect();
      // console.warn directly, not warn(): observeDom runs before `warn` is
      // initialized further down this file (temporal dead zone).
      try { callback(); } catch (e) { console.warn('[Vivi]', `${label} failed`, e?.message); }
      if (!tripped) connect();
    };

    function schedule() {
      if (scheduled || tripped) return;

      const now = Date.now();
      if (now - windowStart > BURST_WINDOW_MS) {
        windowStart = now;
        runsInWindow = 0;
      }
      if (++runsInWindow > BURST_LIMIT) {
        tripped = true;
        observer.disconnect();
        console.warn('[Vivi]', `${label}: mutation storm detected — falling back to polling`);
        setInterval(() => { try { callback(); } catch { /* no-op */ } }, FALLBACK_INTERVAL_MS);
        return;
      }

      scheduled = true;
      requestAnimationFrame(run);
    }

    connect();
    return observer;
  }

  // ── Custom logo (replaces the stock YouTube Music wordmark/icon) ──
  function applyCustomLogo() {
    try {
      const fullLogoUrl = chrome.runtime.getURL('icons/custom-logo-full.png');
      const iconLogoUrl = chrome.runtime.getURL('icons/custom-logo-icon.png');

      const swap = () => {
        // Main nav-bar logo — <ytmusic-logo logo-src="..." white-logo-src="..."><picture><img class="logo">
        document.querySelectorAll('ytmusic-logo').forEach((el) => {
          if (el.getAttribute('logo-src') !== fullLogoUrl) el.setAttribute('logo-src', fullLogoUrl);
          if (el.getAttribute('white-logo-src') !== fullLogoUrl) el.setAttribute('white-logo-src', fullLogoUrl);
          const img = el.querySelector('img');
          if (img && img.src !== fullLogoUrl) img.src = fullLogoUrl;
        });
        // Collapsed / mini-guide icon-only logo (if YT Music renders one)
        document.querySelectorAll('.mini-guide-item img[src*="logo"], #mini-guide img[src*="logo"]').forEach((img) => {
          if (img.src !== iconLogoUrl) img.src = iconLogoUrl;
        });
      };

      swap();

      // The header re-renders on SPA navigation and theme switches, which can
      // reset these attributes back to YT's stock logo — keep reapplying.
      observeDom(document.documentElement, {
        childList: true,
        subtree: true,
        attributes: true,
        attributeFilter: ['logo-src', 'white-logo-src', 'src'],
      }, swap, 'Custom logo swap');
    } catch (e) {
      warn('Custom logo swap failed', e?.message);
    }
  }
  applyCustomLogo();

  // ── "Upgrade" sidebar link → "Support" (Buy Me a Coffee) ──
  function applySupportButton() {
    try {
      const SUPPORT_URL = 'https://buymeacoffee.com/archimetrix';

      const COFFEE_SVG = `<svg data-vivi-coffee-icon="1" viewBox="0 0 24 24" width="100%" height="100%" style="fill:currentColor;">
                <path d="M4 3h13v2H4V3zm14 5H5c-1.1 0-2 .9-2 2v3c0 3.31 2.69 6 6 6h2c2.76 0 5.08-1.86 5.79-4.4.13.03.27.05.41.05 1.76 0 3.2-1.44 3.2-3.2S19.96 8 18.2 8H18zm0 4.4c0 .66-.54 1.2-1.2 1.2H16v-3.2h.8c.66 0 1.2.54 1.2 1.2v.8zM3 19h16v2H3v-2z"/>
              </svg>`;

      const swap = () => {
        document.querySelectorAll('ytmusic-guide-entry-renderer').forEach((entry) => {
          // Once we've identified an entry as the Support entry we keep a
          // permanent marker on it (data-vivi-support-entry) — separate from
          // the label check, because the label itself gets rewritten to
          // "Support" the first time through and would no longer match
          // "Upgrade" on later passes.
          const alreadyMarked = entry.dataset.viviSupportEntry === '1';

          if (!alreadyMarked) {
            const textEl = entry.querySelector('yt-formatted-string, .item-text, #formatted-string');
            const label = (textEl?.textContent || entry.textContent || '').trim();
            if (label !== 'Upgrade') return;

            entry.dataset.viviSupportEntry = '1';
            if (textEl) textEl.textContent = 'Support';

            const clickable = entry.querySelector('tp-yt-paper-item, a') || entry;
            clickable.removeAttribute('href');
            clickable.style.cursor = 'pointer';
            clickable.addEventListener('click', (e) => {
              e.preventDefault();
              e.stopPropagation();
              window.open(SUPPORT_URL, '_blank', 'noopener');
            }, true);
          } else {
            // Entry already marked as Support — but YT Music can still
            // lazily upgrade/re-render its icon slot on a later pass
            // (e.g. after a page refresh), which is what let the real
            // premium badge icon sneak back in next to our coffee cup.
            // If our marked svg is already the only thing there, skip the
            // work; otherwise fall through and re-enforce it below.
            const iconHost = entry.querySelector('yt-icon, tp-yt-iron-icon, .yt-spec-icon-shape, ytmusic-guide-entry-renderer #img yt-icon');
            const alreadyClean = iconHost
              && iconHost.querySelector('svg[data-vivi-coffee-icon]')
              && iconHost.children.length === 1;
            if (alreadyClean) return;
          }

          // Swap the icon for a coffee-cup glyph
          // Clear every icon layer inside the entry first, so no leftover
          // (e.g. the original circular logo) shows behind the cup.
          // NOTE: <img> is a void element — its picture comes from the `src`
          // attribute, not markup content, so `innerHTML = ''` is a no-op on
          // it and the old logo/badge kept bleeding through behind the cup.
          // Images (and any yt-img-shadow host wrapping one) must be hidden
          // and stripped of their src instead.
          const iconHosts = entry.querySelectorAll('yt-icon, tp-yt-iron-icon, .yt-spec-icon-shape, ytmusic-guide-entry-renderer #img yt-icon, ytmusic-guide-entry-renderer #img img, ytmusic-guide-entry-renderer #img *');
          iconHosts.forEach((el) => {
            if (el.tagName === 'IMG') {
              el.removeAttribute('src');
              el.removeAttribute('srcset');
              el.style.display = 'none';
            } else {
              el.innerHTML = '';
              // Some hosts (e.g. yt-img-shadow) render their picture inside
              // an internal <img> that isn't reachable via light-DOM
              // selectors above — belt-and-braces hide it too.
              el.querySelectorAll?.('img').forEach((img) => {
                img.removeAttribute('src');
                img.removeAttribute('srcset');
                img.style.display = 'none';
              });
            }
          });

          const iconHost = entry.querySelector('yt-icon, tp-yt-iron-icon, .yt-spec-icon-shape, ytmusic-guide-entry-renderer #img yt-icon');
          if (iconHost) {
            iconHost.innerHTML = COFFEE_SVG;
          } else {
            // Fallback: no dedicated icon element found — inject one into the #img slot.
            const imgSlot = entry.querySelector('ytmusic-guide-entry-renderer #img, #img');
            if (imgSlot) imgSlot.innerHTML = COFFEE_SVG;
          }
        });
      };

      swap();

      // Scoped to the guide (where the entry actually lives) rather than the
      // whole document: this callback rewrites innerHTML, so the narrower the
      // watched subtree, the fewer unrelated YT Music re-renders can retrigger
      // it. Falls back to documentElement only until the guide exists.
      const guide = document.querySelector('ytmusic-app-layout') || document.documentElement;
      observeDom(guide, { childList: true, subtree: true }, swap, 'Support button swap');
    } catch (e) {
      warn('Support button swap failed', e?.message);
    }
  }
  applySupportButton();

  let currentTrackKey = null;
  let canvasRenderToken = 0;

  // ── SponsorBlock (skip non-music sections of music videos) ──
  let sponsorBlockEnabled = true;
  let sponsorSegments = [];          // [{start, end}] ms, for the current video
  let sponsorSkippedIdx = new Set(); // indices already skipped this track, so we only skip once
  let sponsorSkipOffsetMs = 0;       // cumulative ms skipped so far — fed to the lyrics panel
  let sponsorSegmentsToken = 0;      // guards against a late fetch applying to a track that's since changed
    let retryTimer      = null;
  let pollTimer       = null;
  let currentVideoUrl = null;
  let currentImageUrl = null;
  const memCache      = {};

  let themeUserEnabled  = true;
  let themeCurrentlyOn  = true;
  let imageOnlyMode     = false; // when true, canvas video is skipped entirely (still image only) to save bandwidth/CPU
  // These two toggles are independent artwork *sources*. Either or both can be on at once —
  // Spotify Canvas is always tried first for a track, and Apple Music-style animated artwork
  // (fetched from the boidu.dev API, historically labelled "Enable Canvas" in the popup) is
  // used as the fallback whenever Spotify has no Canvas for that track. Neither toggle stops
  // the shared polling loop, since that loop also drives lyrics/last.fm/track-change detection.
  let appleCanvasEnabled = true;
  let spotifyCanvasEnabled = true;
  // Which artwork source wins when a track has both a Spotify Canvas and
  // Apple Music-style animated artwork available. 'spotify' (default)
  // preserves the original always-try-Spotify-first behavior; 'apple' flips it.
  let canvasPriority = 'apple';
  let currentSpotifyCanvasUrl = null;
  let spotifyCanvasRequestKey = null;

  
  const LASTFM_DEFAULTS = {
    lastfmEnabled: false,
    lastfmSendNowPlaying: true,
    lastfmSendLikes: true,
    lastfmMinDurationSec: 30,   
    lastfmDelayPercent: 50,     
    lastfmDelayMinutes: 3,      
  };
  let lastfmSettings = { ...LASTFM_DEFAULTS };
  let lastfmCurrentKey = null;
  let lastfmStartedAt  = 0;     
  let lastfmScrobbled  = false;
  let lastfmSentNowPlaying = false;
  let lastfmLikeObserver = null;

  const log  = (...a) => DEBUG && console.log('[Vivi]', ...a);
  const warn = (...a) => console.warn('[Vivi]', ...a);

  
  function applyTheme(enabled) {
    themeCurrentlyOn = enabled;
    const existing = document.getElementById(THEME_LINK_ID);
    if (enabled) {
      // canvas.css's header/sidebar glass-tint rules key off this class so
      // that they only ever apply while the theme is actually on — see
      // canvas.css for why they can't just live in theme.css itself.
      document.documentElement.classList.add('vivi-theme-on');
      if (existing) return;
      const link = document.createElement('link');
      link.id   = THEME_LINK_ID;
      link.rel  = 'stylesheet';
      link.href = chrome.runtime.getURL('src/theme.css');
      document.head.appendChild(link);
      // Restore background layer if we have artwork
      if (currentVideoUrl || currentImageUrl) {
        setBackgroundVar(currentImageUrl);
      }
    } else {
      document.documentElement.classList.remove('vivi-theme-on');
      existing?.remove();
      const inner = document.getElementById(BG_IMG_ID);
      if (inner) inner.style.backgroundImage = '';
      document.documentElement.style.removeProperty('--blyrics-background-img');
    }
  }

  const BG_ID    = 'vivi-bg-layer';
  const BG_IMG_ID = 'vivi-bg-img';

  function ensureBgEl() {
    let wrapper = document.getElementById(BG_ID);
    if (!wrapper) {
      wrapper = document.createElement('div');
      wrapper.id = BG_ID;
      wrapper.style.cssText = [
        'position:fixed',
        'inset:0',
        'z-index:-1',
        'pointer-events:none',
        'overflow:hidden',
      ].join(';');

      
      const inner = document.createElement('div');
      inner.id = BG_IMG_ID;
      inner.style.cssText = [
        'position:absolute',
        'inset:-20%',          
        'background-size:cover',
        'background-position:center',
        'background-repeat:no-repeat',
        'transform:scale(1.35)',
        'filter:blur(100px) saturate(1.5) brightness(0.55)',
        'transition:background-image 0.4s ease-in-out',
      ].join(';');

      wrapper.appendChild(inner);

      if (document.documentElement && document.body) {
        document.documentElement.insertBefore(wrapper, document.body);
      } else {
        document.body.insertBefore(wrapper, document.body.firstChild);
      }
    }
    return document.getElementById(BG_IMG_ID);
  }

  function setBackgroundVar(imageUrl) {
    const inner = ensureBgEl();
    if (!inner) return;
    let url = imageUrl;
    if (!url) {
      // Scope this strictly inside the player bar itself. #thumbnail is a
      // generic id YT Music reuses on lots of unrelated list-item tiles
      // (queue, up-next, home shelves) — an unscoped document-wide selector
      // for it just grabs whichever matching tile happens to appear first in
      // the DOM, which is how the background ended up showing a random
      // unrelated thumbnail instead of the currently playing track's.
      const bar = document.querySelector('ytmusic-player-bar');
      const thumb = bar?.querySelector(
        '.image-wrapper img, ytmusic-thumbnail img, #thumbnail img, .thumbnail-image-wrapper img'
      );
      if (thumb?.src) url = thumb.src;
    }
    if (url) {
      inner.style.backgroundImage = `url("${url}")`;
      
      document.documentElement.style.setProperty('--blyrics-background-img', `url("${url}")`);
      // Feed the same artwork to the fluid Kawarp background, when enabled.
      // It layers on top of this static blurred image and cross-fades in,
      // so nothing regresses if Kawarp is off, still loading, or fails
      // (e.g. a thumbnail host that doesn't send permissive CORS headers).
      window.__viviKawarp?.setArtwork(url);
    }
  }

  // ── Artwork URL cache (chrome.storage.local) ─────────────────────────────
  // This mirrors how Better Lyrics Shaders caches Apple Music-style animated
  // artwork: the artwork API (artwork.boidu.dev) is only ever asked to
  // *resolve* a track to a video/image URL. We persist that resolved URL —
  // a few hundred bytes of text — and nothing else. We never download the
  // actual video/image bytes ourselves, never store them as Blobs, and never
  // hand the player an object: URL.
  //
  // Playback always points the <video>/<img> element straight at the
  // upstream CDN URL. The instant-replay behaviour users actually want
  // ("plays immediately the next time") comes from two much simpler things:
  //   1. Looking the URL up is synchronous once primed into memCache, so
  //      there's zero async round trip standing between "track changed" and
  //      "we know what to show".
  //   2. The browser's own HTTP disk cache serves the media bytes for a
  //      previously-played URL without hitting the network again, the same
  //      way it would for any other <video src> the page reuses — we don't
  //      need to (and shouldn't) reimplement that ourselves.
  // This is simpler, avoids IndexedDB/Blob/object-URL lifetime bugs, and
  // uses a tiny fraction of the disk space the old blob cache did.
  const CACHE_PREFIX = 'vivi_cache_';

  function cacheKeyFor(trackKey) {
    return CACHE_PREFIX + trackKey;
  }

  function readCache(trackKey) {
    if (trackKey in memCache) return Promise.resolve(memCache[trackKey]);
    return new Promise((resolve) => {
      chrome.storage.local.get(cacheKeyFor(trackKey), (stored) => {
        const entry = chrome.runtime.lastError ? null : (stored[cacheKeyFor(trackKey)] || null);
        memCache[trackKey] = entry;
        resolve(entry);
      });
    });
  }

  // Read every entry into memory once at startup so per-track cache hits for
  // the rest of the session are plain object lookups instead of an async
  // storage round trip — this is what makes replays of an already-seen track
  // show up with zero perceptible delay.
  function primeMemCacheFromStorage() {
    chrome.storage.local.get(null, (all) => {
      if (chrome.runtime.lastError) return;
      for (const [k, v] of Object.entries(all)) {
        if (k.startsWith(CACHE_PREFIX)) memCache[k.slice(CACHE_PREFIX.length)] = v;
      }
    });
  }

  // No cap: artwork cache is now unlimited, entries are kept forever until
  // the user manually clears them (clearArtworkCache).

  function writeCache(trackKey, data, track) {
    const entry = {
      trackKey,
      videoUrl: data.videoUrl || null,
      imageUrl: data.imageUrl || null,
      notFound: !!data.notFound,
      song: track.song,
      artist: track.artist,
      videoId: track.videoId || null,
      cachedAt: Date.now(),
    };
    memCache[trackKey] = entry;
    return new Promise((resolve) => {
      chrome.storage.local.set({ [cacheKeyFor(trackKey)]: entry }, () => {
        chrome.runtime.lastError && warn('Cache write failed', chrome.runtime.lastError.message);
        chrome.runtime.sendMessage({ type: 'VIVI_CACHE_UPDATED' }).catch(() => {});
        resolve();
      });
    });
  }

  // Single entry point for "make sure this track's Apple-style artwork URL is
  // fetched and cached" — used by the live playback path, the cache-aware
  // priority branch, and next-track prefetch alike, so there's exactly one
  // code path to reason about instead of three slightly-different copies.
  //
  // Deliberately module-level (not nested in handleTrackChange) so the
  // in-flight map survives across track changes: skipping tracks must NOT
  // cancel a lookup that's already underway for a track you skipped away
  // from. Resolves with {videoUrl, imageUrl} — the URLs are what's shown
  // immediately; the first listen still costs one network round trip to
  // *resolve* them, but nothing further is downloaded or stored beyond that.
  const appleFetchInflight = new Map(); // trackKey -> Promise<{videoUrl,imageUrl}|null>
  function ensureAppleCached(track, trackKey) {
    if (appleFetchInflight.has(trackKey)) return appleFetchInflight.get(trackKey);
    const job = (async () => {
      try {
        const existing = await readCache(trackKey);
        if (existing) return existing;
        const data = await fetchCanvasData(track, new AbortController().signal);
        if (!data) return null;
        if (!data.noStore) {
          await writeCache(trackKey, data, track);
        } else {
          // Session-only result (e.g. the resolver streamed raw video bytes
          // with no stable upstream URL to persist — see fetchCanvasData).
          // We deliberately don't write this to chrome.storage.local since
          // the blob: URL won't survive a reload, but it's still genuinely
          // showing right now, so memCache needs to reflect that. Without
          // this, readCache() keeps returning the `null` it cached on the
          // very first miss, so Alt+C reports "Not cached" — and every
          // replay this session re-fetches from scratch — even while the
          // artwork is actively playing.
          memCache[trackKey] = {
            trackKey,
            videoUrl: data.videoUrl || null,
            imageUrl: data.imageUrl || null,
            notFound: false,
            song: track.song,
            artist: track.artist,
            videoId: track.videoId || null,
            cachedAt: Date.now(),
            sessionOnly: true,
          };
        }
        return data;
      } finally {
        appleFetchInflight.delete(trackKey);
      }
    })();
    appleFetchInflight.set(trackKey, job);
    return job;
  }

  // Turns a cache entry into something playable right now — just the plain
  // remote URLs. No object: URLs, no Blobs, nothing to revoke.
  function resolvePlayableSource(entry) {
    if (!entry) return null;
    return { videoUrl: entry.videoUrl || null, imageUrl: entry.imageUrl || null };
  }

  function clearArtworkCache() {
    return new Promise((resolve) => {
      chrome.storage.local.get(null, (all) => {
        if (chrome.runtime.lastError) { resolve(); return; }
        const keys = Object.keys(all).filter((k) => k.startsWith(CACHE_PREFIX));
        Object.keys(memCache).forEach((k) => delete memCache[k]);
        if (!keys.length) { resolve(); return; }
        chrome.storage.local.remove(keys, resolve);
      });
    });
  }

  

  
  // ── Real music video detection ──────────────────────────────────────────
  // YouTube Music serves two very different kinds of "tracks": plain songs
  // (rendered as a static piece of artwork — internally an "Art Track",
  // musicVideoType MUSIC_VIDEO_TYPE_ATV) and genuine music videos (official
  // videos, UGC uploads, live performances, etc. — actual filmed footage).
  // Canvas/animated-artwork overlays only make sense for the former: for a
  // real video, the overlay was covering the actual video content the user
  // is trying to watch. We ask YouTube's own player API what kind of video
  // is currently loaded and only allow Canvas for ATV (art-track/song) items.
  function getMusicVideoType() {
    try {
      const player = document.querySelector('#movie_player') || document.querySelector('ytmusic-player');
      const resp = typeof player?.getPlayerResponse === 'function' ? player.getPlayerResponse() : null;
      return resp?.videoDetails?.musicVideoType || null;
    } catch {
      return null;
    }
  }

  // Fallback/primary DOM signal: YT Music renders a visibly different stat
  // line in the player bar for tracks that are actually plain YouTube videos
  // (official videos, UGC uploads, etc.) rather than catalog songs — it shows
  // "<views> views • <likes> likes" instead of the "<plays> plays" line real
  // songs get. getPlayerResponse() above is frequently unavailable/empty on
  // YT Music (unlike classic YouTube), so this text check is the check that
  // actually fires in practice and must not be treated as a secondary fallback.
  function playerBarLooksLikeRealVideo() {
    const byline = document.querySelector(
      '.ytmusic-player-bar yt-formatted-string.byline, .ytmusic-player-bar .byline'
    );
    const text = (byline?.textContent || '').toLowerCase();
    return /\bviews?\b/.test(text) && /\blikes?\b/.test(text);
  }

  // Second, independent DOM signal, needed because the views/likes byline
  // text above isn't always rendered (many catalog videos show only the
  // artist name with no stat line at all). The underlying <video> element's
  // native pixel dimensions don't lie, though: a real filmed video is ~16:9
  // widescreen, while a plain song's "art track" video is a square (~1:1)
  // loop of the cover art. Checking that ratio directly catches every case
  // the text-based check above misses.
  function nativeVideoIsWidescreen() {
    try {
      const vid = document.querySelector(
        '.html5-main-video, ytmusic-player video, #movie_player video'
      );
      if (!vid || !vid.videoWidth || !vid.videoHeight) return null; // not loaded yet — unknown
      const ratio = vid.videoWidth / vid.videoHeight;
      return ratio > 1.3; // wider than ~4:3 — treat as a real video, not square art
    } catch {
      return null;
    }
  }

  function isRealMusicVideo() {
    if (playerBarLooksLikeRealVideo()) return true;
    const widescreen = nativeVideoIsWidescreen();
    if (widescreen === true) return true;
    if (widescreen === false) return false; // confidently square art — don't fall through to the API guess
    const type = getMusicVideoType();
    // Unknown (API not ready yet, different surface, etc.) — assume it's a
    // normal song rather than risk permanently hiding Canvas for everyone.
    if (!type) return false;
    return type !== 'MUSIC_VIDEO_TYPE_ATV';
  }

  // Shared with lyrics-ui.js (loaded earlier in the content-script bundle,
  // but it only calls this lazily on track changes — by then this IIFE has
  // long since run and set it) so both the Canvas overlay and the lyrics
  // "hide on real videos" setting agree on what counts as a video.
  window.__viviTrackInfo = { isRealMusicVideo };

  // ── Custom branding: tab title + favicon ──
  // YT Music is free to rewrite or replace <title> at any time, including on
  // SPA navigation and background playback changes. Keep a permanent title
  // enforcer alive so the browser tab never falls back to "YouTube Music".
  let viviDesiredTitle = 'VIVIMUSIC';

  function enforceViviTitle() {
    if (document.title !== viviDesiredTitle) document.title = viviDesiredTitle;
  }

  function installViviTitleGuard() {
    try {
      enforceViviTitle();
      const headObserver = new MutationObserver(() => {
        enforceViviTitle();
      });
      const attach = () => {
        if (!document.head) return;
        headObserver.observe(document.head, {
          childList: true,
          subtree: true,
          characterData: true,
        });
        enforceViviTitle();
      };
      attach();

      // YT Music can rebuild <head> on unusual navigations. Re-attach if the
      // current title element gets replaced along with the rest of the head.
      const rootObserver = new MutationObserver(() => attach());
      rootObserver.observe(document.documentElement, { childList: true, subtree: true });
    } catch (e) {
      warn('Title guard failed', e?.message);
    }
  }

  installViviTitleGuard();

  function applyViviTitle(track) {
    if (!track?.song) return;
    window.__viviTitleTakeover = true;
    viviDesiredTitle = `${track.song} | VIVIMUSIC`;
    enforceViviTitle();
  }

  // Shared artist-text extraction so every place that derives a cache key
  // from a "byline" element (player bar, queue panel, ...) agrees on the
  // same string for the same song. Previously getCurrentTrack() read only
  // the first <a> inside the byline (i.e. just the primary artist), while
  // getNextQueuedTrack() read the byline's full text up to the first "•"
  // (i.e. every credited artist, e.g. "Artist A, Artist B"). For any
  // multi-artist track those two disagreed, so the same song produced two
  // different trackKeys depending on whether it was read live off the
  // player bar or prefetched off the queue panel — the prefetch would cache
  // under one key while playback looked the other key up, so Alt+C showed
  // "Not cached" for the track that was, in fact, already cached (just
  // under a sibling key). Both call sites now go through this one function.
  function bylineArtistText(bylineEl) {
    if (!bylineEl) return null;
    const text = bylineEl.textContent?.trim()?.split('•')[0]?.trim();
    return text || null;
  }

  function getCurrentTrack() {
    const titleEl  = document.querySelector('.ytmusic-player-bar yt-formatted-string.title');
    const bylineEl = document.querySelector(
      '.ytmusic-player-bar yt-formatted-string.byline, .ytmusic-player-bar .byline'
    );
    if (!titleEl || !bylineEl) {
      const parts = document.title.replace(' - YouTube Music', '').split(' · ');
      if (parts.length >= 2) return { song: parts[0].trim(), artist: parts[1].trim() };
      return null;
    }
    const song = titleEl.textContent.trim(), artist = bylineArtistText(bylineEl);
    if (!song || !artist) return null;
    const href = document.querySelector('.ytmusic-player-bar a[href*="watch?v="]')?.href || '';
    let videoId = null;
    try { videoId = new URL(href).searchParams.get('v'); } catch {}
    if (!videoId) videoId = getRobustVideoId(); // player-bar link isn't always present — fall back to URL/player API
    return { song, artist, videoId, album: getCurrentAlbum(), year: getCurrentYear(), duration: getCurrentDuration() };
  }

  // The player-bar byline is "Artist • Album • Year" when the track came off
  // an album (rendered as separate <a> links), but can also just be "Artist"
  // for singles/videos with no album link. When there's a second link, it's
  // the album — same DOM shape Better Lyrics Shaders reads this from. This is
  // what lets the artwork resolver disambiguate between multiple releases of
  // the same song title (album cut vs. single edit vs. deluxe reissue), which
  // song+artist alone can't do.
  function getCurrentAlbum() {
    const byline = document.querySelector(
      '.ytmusic-player-bar yt-formatted-string.byline, .ytmusic-player-bar .byline'
    );
    if (!byline) return null;
    const links = byline.querySelectorAll('a');
    if (links.length < 2) return null;
    const album = links[links.length - 1].textContent?.trim();
    return (album && album !== '•' && album !== '&') ? album : null;
  }

  // Release year — unlike the album, YT Music renders this as plain text
  // (not a link), as the last "• "-separated segment of the byline. Used
  // alongside album to disambiguate which release of a song is playing
  // (e.g. an original vs. a remaster/anniversary reissue sharing the same
  // title, artist, and near-identical duration but a different year).
  function getCurrentYear() {
    const byline = document.querySelector(
      '.ytmusic-player-bar yt-formatted-string.byline, .ytmusic-player-bar .byline'
    );
    if (!byline) return null;
    const segments = (byline.textContent || '').split('•').map((s) => s.trim()).filter(Boolean);
    const last = segments[segments.length - 1];
    if (last && /^\d{4}$/.test(last)) return Number(last);
    return null;
  }

  // Track duration in whole seconds, straight off the native <video>, same
  // value Better Lyrics Shaders sends as its `d` param.
  function getCurrentDuration() {
    const video = document.querySelector('video');
    return (video && video.duration && !Number.isNaN(video.duration)) ? video.duration : null;
  }

  // Same fallback chain lyrics-ui.js uses: current URL's ?v=, then the player
  // API directly. The player-bar anchor above is the fussiest of the three
  // (it isn't rendered on every layout), so this is what actually resolves
  // videoId most of the time.
  function getRobustVideoId() {
    const params = new URLSearchParams(window.location.search);
    const fromUrl = params.get('v');
    if (fromUrl) return fromUrl;
    const player = document.querySelector('#movie_player, ytmusic-player');
    try {
      const data = player?.getVideoData?.();
      if (data?.video_id) return data.video_id;
    } catch { /* ignore */ }
    return null;
  }

  // ── SponsorBlock: fetch + auto-skip "non-music" segments ──
  async function loadSponsorSegmentsForTrack(track) {
    sponsorSegments = [];
    sponsorSkippedIdx = new Set();
    sponsorSkipOffsetMs = 0;
    window.__viviLyricsUI?.setSponsorOffset(0);

    if (!sponsorBlockEnabled) return;
    if (!window.__viviSponsorBlock) return;

    const videoId = track.videoId || getRobustVideoId();
    if (!videoId) { warn('SponsorBlock: could not resolve a video ID for', track.song); return; }

    const token = ++sponsorSegmentsToken;
    const segments = await window.__viviSponsorBlock.getSegments(videoId);
    if (token !== sponsorSegmentsToken) return; // track changed while we were fetching
    sponsorSegments = segments;
    console.log('[Vivi:SponsorBlock]', `${segments.length} non-music segment(s) for "${track.song}"`, segments);
  }

  // Runs every animation frame (same technique the lyrics panel uses to
  // track playback position) rather than depending on a 'timeupdate' event —
  // more reliable than an event listener given how deep YouTube Music nests
  // its player DOM.
  function sponsorSkipLoop() {
    requestAnimationFrame(sponsorSkipLoop);
    checkSponsorSkip();
  }

  function checkSponsorSkip() {
    if (!sponsorSegments.length) return;
    const video = getVideoEl();
    if (!video || video.paused) return;
    const nowMs = video.currentTime * 1000;

    for (let i = 0; i < sponsorSegments.length; i++) {
      if (sponsorSkippedIdx.has(i)) continue;
      const seg = sponsorSegments[i];
      if (nowMs >= seg.start && nowMs < seg.end) {
        sponsorSkippedIdx.add(i);
        sponsorSkipOffsetMs += (seg.end - seg.start);
        video.currentTime = seg.end / 1000;
        window.__viviLyricsUI?.setSponsorOffset(sponsorSkipOffsetMs);
        console.log('[Vivi:SponsorBlock] skipped non-music section', seg);
        break;
      }
    }
  }


  // Upsizes iTunes' default thumbnail ("...100x100bb.jpg") to a much larger
  // rendition. iTunes serves the same artwork at whatever pixel size is
  // baked into the filename, up to very large sizes, so we just swap the
  // token instead of settling for the tiny default.
  const ITUNES_ARTWORK_SIZE_RE = /(\d+)x\1(bb)?\.(jpe?g|png)$/i;
  function upsizeItunesArtwork(url) {
    if (!url) return url;
    return url.replace(ITUNES_ARTWORK_SIZE_RE, (_, __, bb, ext) => `1200x1200${bb || ''}.${ext}`);
  }

  // Static album cover — always tried, since (unlike animated Canvas) Apple
  // Music has one for basically every released track, and this is a plain,
  // public, unauthenticated endpoint (no token/CORS games needed, so this
  // can just run directly here in the content script).
  async function fetchItunesArtworkFallback(track, signal) {
    const term = `${track.song} ${track.artist}`;
    const params = { term, media: 'music', entity: 'song', limit: '5' };
    const url = `${ITUNES_SEARCH_BASE}?${new URLSearchParams(params)}`;
    let res;
    try {
      res = await fetch(url, { signal });
    } catch (err) {
      if (err.name !== 'AbortError') warn('iTunes fallback fetch:', err.message);
      return null;
    }
    if (!res.ok) return null;
    let data;
    try { data = await res.json(); } catch { return null; }
    const results = Array.isArray(data.results) ? data.results : [];
    if (!results.length) return null;

    // Prefer a result whose album name matches the track's album (when we
    // know it) — a title can have several catalog entries (single vs. album
    // cut vs. reissue), and iTunes' relevance ranking doesn't always put the
    // one we actually want first.
    const norm = (s) => (s || '').toLowerCase().trim();
    const match = (track.album && results.find((r) => norm(r.collectionName) === norm(track.album)))
      || results.find((r) => norm(r.artistName) === norm(track.artist))
      || results[0];

    const raw = match.artworkUrl100 || match.artworkUrl60 || match.artworkUrl30;
    if (!raw) return null;
    return { imageUrl: upsizeItunesArtwork(raw) };
  }

  // Animated Canvas — resolved directly against Apple's own private catalog
  // API (amp-api.music.apple.com), the same one music.apple.com's own web
  // player calls, instead of a third-party proxy. This has to happen in the
  // background service worker (see apple-canvas.js for why: forbidden
  // Origin/Referer headers, and reading a cross-origin response regardless
  // of CORS both require that privileged context) — this just relays the
  // request over runtime messaging, same pattern already used for Spotify
  // Canvas and Last.fm.
  async function fetchAppleCanvasDirect(track) {
    try {
      const res = await chrome.runtime.sendMessage({
        type: 'VIVI_APPLE_CANVAS_DIRECT',
        track: { song: track.song, artist: track.artist, album: track.album || null },
      });
      return res?.videoUrl || null;
    } catch (err) {
      warn('Apple Canvas (direct) message failed:', err.message);
      return null;
    }
  }

  async function fetchCanvasData(track, signal) {
    // Only the animated Apple Music Canvas video counts as "Canvas" here —
    // the user wants motion artwork only, never a plain static cover. We
    // still fire the iTunes artwork fetch in parallel (so it's warm if a
    // video is found and momentarily fails later, see makeMediaEl's
    // fallbackToImage), but a track with no motion asset must resolve as
    // "no canvas", not silently fall back to a static image.
    const [videoUrl, artworkResult] = await Promise.all([
      fetchAppleCanvasDirect(track),
      fetchItunesArtworkFallback(track, signal),
    ]);
    if (!videoUrl) return { videoUrl: null, imageUrl: null, notFound: true };
    const imageUrl = artworkResult?.imageUrl || null;
    return { videoUrl, imageUrl, notFound: false };
  }

 
  const SLOT_CLASS = 'vivi-canvas-slot';
  const MAIN_PLAYER_CLASS = 'vivi-canvas-player';

  // Apple Music-style artwork is an independent overlay over the native
  // YouTube Music thumbnail. YT Music can replace/rebuild thumbnail nodes at
  // runtime, so the overlay is kept in a small reconciliation loop instead of
  // being permanently tied to one DOM node.
  let activeAppleArtwork = null;
  let appleOverlayObserver = null;
  let appleOverlaySyncTimer = null;
  let appleOverlaySyncing = false;

  const APPLE_MAIN_IMG_SELECTOR =
    'ytmusic-player #song-image img, ' +
    'ytmusic-player .ytmusic-player-thumbnail img, ' +
    '#song-image img, ytmusic-thumbnail.ytmusic-player img';
  const APPLE_BAR_IMG_SELECTOR =
    'ytmusic-player-bar .image-wrapper img, ' +
    'ytmusic-player-bar ytmusic-thumbnail img, ' +
    'ytmusic-player-bar .thumbnail img';

  function getAppleTargetImages() {
    return {
      main: isMainPlayerPageActive() ? document.querySelector(APPLE_MAIN_IMG_SELECTOR) : null,
      bar: document.querySelector(APPLE_BAR_IMG_SELECTOR),
    };
  }

  function removeAppleOverlay(el) {
    if (!el) return;
    try { el.__viviHls?.destroy(); } catch (_) {}
    el.__viviHls = null;
    try { el.pause?.(); } catch (_) {}
    const parent = el.parentElement;
    el.remove();
    if (parent?.dataset.viviApplePositionSet === '1' &&
        !parent.querySelector('.vivi-canvas-media[data-vivi-apple-overlay="1"]')) {
      parent.style.removeProperty('position');
      delete parent.dataset.viviApplePositionSet;
    }
    if (parent?.dataset.viviAppleOverflowSet === '1' &&
        !parent.querySelector('.vivi-canvas-media[data-vivi-apple-overlay="1"]')) {
      parent.style.removeProperty('overflow');
      delete parent.dataset.viviAppleOverflowSet;
    }
  }

  function clearAppleOverlays() {
    document.querySelectorAll('.vivi-canvas-media[data-vivi-apple-overlay="1"]').forEach(removeAppleOverlay);
  }

  function ensureAppleOverlayOnImage(imgEl, source) {
    if (!imgEl?.isConnected || !source?.videoUrl && !source?.imageUrl) return null;
    const parent = imgEl.parentElement;
    if (!parent) return null;

    let overlay = [...parent.children].find(el =>
      el.classList?.contains('vivi-canvas-media') &&
      el.dataset?.viviAppleOverlay === '1'
    );

    const desiredUrl = source.videoUrl || source.imageUrl || '';
    const isValidFallback = overlay?.dataset.viviAppleFallback === '1' &&
      source.videoUrl && overlay.dataset.viviAppleOriginalUrl === source.videoUrl;
    if (overlay && !isValidFallback && overlay.dataset.viviAppleSourceUrl !== desiredUrl) {
      removeAppleOverlay(overlay);
      overlay = null;
    }

    if (!overlay) {
      const computed = getComputedStyle(parent);
      if (computed.position === 'static') {
        parent.style.setProperty('position', 'relative');
        parent.dataset.viviApplePositionSet = '1';
      }
      // The overlay intentionally overshoots its box by 1px on each edge (see
      // canvas.css) to avoid a subpixel seam. That only works if this parent
      // actually clips it — native YT Music thumbnail wrappers are usually
      // already overflow:hidden with a rounded corner, but assert it here
      // too rather than assume, or the overshoot would show as a stray
      // sliver of video poking past the intended thumbnail edge instead of
      // fixing anything.
      if (computed.overflow !== 'hidden') {
        parent.style.setProperty('overflow', 'hidden');
        parent.dataset.viviAppleOverflowSet = '1';
      }

      overlay = makeMediaEl(source, parent, { appleOverlay: true });
      if (!overlay) return null;
      overlay.dataset.viviAppleOverlay = '1';
      overlay.dataset.viviAppleSourceUrl = desiredUrl;
      overlay.dataset.viviAppleOriginalUrl = source.videoUrl || '';
      overlay.dataset.viviAppleSlot = imgEl.closest('ytmusic-player-bar') ? 'bar' : 'main';
      overlay.style.opacity = '0';
      overlay.style.objectFit = 'cover';
      overlay.style.objectPosition = 'center';
      overlay.style.zIndex = '10';
      overlay.style.pointerEvents = 'none';
      // Do not animate the Apple overlay. A live YT thumbnail is underneath and
      // animation/crossfade was causing the thumbnail to flash when YT rebuilt it.
      overlay.classList.remove('vivi-canvas-crossfade', 'vivi-canvas-fadeout');
      parent.appendChild(overlay);

      const reveal = () => {
        if (!overlay?.isConnected) return;
        overlay.style.opacity = '1';
      };
      if (overlay.tagName === 'VIDEO') {
        overlay.addEventListener('canplay', reveal, { once: true });
        overlay.addEventListener('loadeddata', reveal, { once: true });
        overlay.addEventListener('error', () => {
          if (activeAppleArtwork?.videoUrl === source.videoUrl && source.imageUrl) {
            const replacement = makeMediaEl(
              { videoUrl: null, imageUrl: source.imageUrl },
              parent,
              { appleOverlay: true }
            );
            if (replacement) {
              replacement.dataset.viviAppleOverlay = '1';
              replacement.dataset.viviAppleFallback = '1';
              replacement.dataset.viviAppleSourceUrl = source.imageUrl;
              replacement.dataset.viviAppleOriginalUrl = source.videoUrl || '';
              replacement.dataset.viviAppleSlot = overlay.dataset.viviAppleSlot || 'main';
              replacement.style.opacity = '0';
              replacement.style.objectFit = 'cover';
              replacement.style.objectPosition = 'center';
              replacement.style.zIndex = '10';
              replacement.style.pointerEvents = 'none';
              replacement.addEventListener('load', () => replacement.style.opacity = '1', { once: true });
              overlay.replaceWith(replacement);
            } else {
              overlay.remove();
            }
          }
        }, { once: true });
        if (overlay.readyState >= 3) reveal();
      } else if (overlay.dataset.viviAppleAwaitsPlaying === '1') {
        // Apple HLS iframe: same fix as the main dedicated-player path — the
        // iframe document's own 'load' fires almost instantly, long before
        // the video inside has any decoded frames. Revealing on that (the
        // previous behavior here) is exactly why this overlay was showing
        // solid black immediately, with no timeout to recover if something
        // stalled. Wait for the real 'vivi-apple-playing' signal instead,
        // with a timeout as a safety net only.
        overlay.addEventListener('vivi-apple-playing', reveal, { once: true });
        setTimeout(() => { if (overlay.isConnected && overlay.style.opacity === '0') reveal(); }, 2500);
      } else {
        overlay.addEventListener('load', reveal, { once: true });
        if (overlay.complete) reveal();
      }
      // Attempt playback once the element exists; hidden/offscreen overlays still
      // retain the native muted autoplay behavior in Chromium.
      if (overlay.tagName === 'VIDEO') overlay.play().catch(() => {});
    }

    // YT Music may rewrite the native img's parent styles. Reassert only the
    // dimensions/stacking needed for this overlay without touching the img.
    overlay.style.inset = '0';
    overlay.style.width = '100%';
    overlay.style.height = '100%';
    overlay.style.position = 'absolute';
    overlay.style.zIndex = '10';
    return overlay;
  }

  function syncAppleOverlaysNow() {
    if (appleOverlaySyncing || !activeAppleArtwork) return;
    appleOverlaySyncing = true;
    try {
      const { main, bar } = getAppleTargetImages();
      const wantedParents = new Set();
      if (main) wantedParents.add(main.parentElement);
      if (bar) wantedParents.add(bar.parentElement);

      if (main) ensureAppleOverlayOnImage(main, activeAppleArtwork);
      if (bar) ensureAppleOverlayOnImage(bar, activeAppleArtwork);

      document.querySelectorAll('.vivi-canvas-media[data-vivi-apple-overlay="1"]').forEach(el => {
        if (!wantedParents.has(el.parentElement)) removeAppleOverlay(el);
      });
    } finally {
      appleOverlaySyncing = false;
    }
  }

  function scheduleAppleOverlaySync() {
    if (appleOverlaySyncTimer || !activeAppleArtwork) return;
    appleOverlaySyncTimer = setTimeout(() => {
      appleOverlaySyncTimer = null;
      requestAnimationFrame(syncAppleOverlaysNow);
    }, 30);
  }

  function startAppleOverlayObserver() {
    if (appleOverlayObserver) return;
    appleOverlayObserver = new MutationObserver(() => scheduleAppleOverlaySync());
    appleOverlayObserver.observe(document.documentElement, {
      childList: true,
      subtree: true
    });
  }

  function stopAppleOverlayObserver() {
    appleOverlayObserver?.disconnect();
    appleOverlayObserver = null;
    if (appleOverlaySyncTimer) clearTimeout(appleOverlaySyncTimer);
    appleOverlaySyncTimer = null;
  }

  // Kept for the existing cleanup paths. It now clears only Apple overlays and
  // never moves or destroys the native YT Music image.
  function overlayOnImage(imgEl, source) {
    activeAppleArtwork = source ? { ...source } : null;
    if (activeAppleArtwork) {
      startAppleOverlayObserver();
      ensureAppleOverlayOnImage(imgEl, activeAppleArtwork);
      scheduleAppleOverlaySync();
    }
  }

  function cleanupLegacyArtworkSlots() {
    document.querySelectorAll(`.${SLOT_CLASS}`).forEach(wrapper => {
      // v14 wrapped the native img. Restore it before deleting the legacy wrapper.
      const nativeImg = wrapper.querySelector('img:not(.vivi-canvas-media)');
      if (nativeImg && wrapper.parentElement) wrapper.parentElement.insertBefore(nativeImg, wrapper);
      wrapper.remove();
    });
  }

  function restoreAppleOverlayParents() {
    activeAppleArtwork = null;
    stopAppleOverlayObserver();
    clearAppleOverlays();
    document.querySelectorAll('[data-vivi-apple-position-set="1"]').forEach(parent => {
      parent.style.removeProperty('position');
      delete parent.dataset.viviApplePositionSet;
    });
  }

  // Apple's motion-artwork assets are sometimes a segmented HLS manifest
  // (.m3u8) rather than a single progressive file. For those specifically,
  // playback is delegated to apple-canvas-player.html running in an
  // <iframe> at the extension's own chrome-extension:// origin — see the
  // long comment at the top of that file for why: a bare page with plain
  // `new Hls(); loadSource(); attachMedia();` (github.com/bharadwajpro/
  // m3u8-player's exact pattern) was confirmed to play this same CDN's
  // .m3u8 with zero special handling, so this reproduces that bare setup
  // instead of running hls.js inside music.youtube.com's own page context.
  // Non-Apple / non-HLS sources are unaffected and keep using a plain
  // <video> below.
  let appleCanvasFrameSeq = 0;
  const applePendingFrames = new Map(); // frameId -> { onError, onPlaying }

  window.addEventListener('message', (evt) => {
    const msg = evt.data;
    if (!msg || !msg.__viviAppleCanvas || !msg.id) return;
    const pending = applePendingFrames.get(msg.id);
    if (!pending) return;
    if (msg.type === 'error') {
      pending.onError();
      applePendingFrames.delete(msg.id);
    } else if (msg.type === 'playing') {
      // Fire the reveal callback the instant the video inside the iframe is
      // actually decoding frames — NOT when the iframe document merely
      // finishes loading (that happens almost immediately and was causing
      // the black box to be revealed before there was any real video data,
      // i.e. the "black flash then it starts playing" symptom).
      pending.onPlaying?.();
      applePendingFrames.delete(msg.id);
    }
  });

  function isAppleCdnHlsUrl(url) {
    if (!/\.m3u8(\?|$)/i.test(url)) return false;
    try {
      const host = new URL(url).hostname;
      return /(^|\.)apple\.com$|(^|\.)aaplimg\.com$|(^|\.)cdn-apple\.com$|(^|\.)mzstatic\.com$/i.test(host);
    } catch {
      return false;
    }
  }

  function makeAppleHlsIframe(url, className, fit, appleOverlay, onError, onPlaying) {
    const frame = document.createElement('iframe');
    const id = `vivi-apple-${++appleCanvasFrameSeq}`;
    applePendingFrames.set(id, { onError, onPlaying });
    const src = chrome.runtime.getURL(`src/apple-canvas-player.html?fit=${fit}&id=${encodeURIComponent(id)}#${encodeURIComponent(url)}`);
    frame.src = src;
    frame.className = className;
    frame.setAttribute('frameborder', '0');
    frame.setAttribute('allow', 'autoplay');
    frame.style.border = 'none';
    frame.style.background = 'transparent';
    // Marks this element as "an iframe that reveals on a postMessage
    // 'playing' event", so createMainCanvasPlayer's reveal-scheduling knows
    // not to treat it like a plain <img> (which reveals on 'load' — wrong
    // signal for an iframe, since the iframe document loads almost
    // instantly, long before the video inside it has any frames decoded).
    frame.dataset.viviAppleAwaitsPlaying = '1';
    if (appleOverlay) frame.dataset.viviAppleOverlay = '1';
    frame.dataset.viviAppleFrameId = id;
    return frame;
  }

  function attachVideoSource(vid, url) {
    try { vid.__viviHls?.destroy(); } catch { /* no-op */ }
    vid.__viviHls = null;
    if (!url) return;

    const isHls = /\.m3u8(\?|$)/i.test(url);
    if (isHls && vid.canPlayType('application/vnd.apple.mpegurl')) {
      // Safari (and iOS WebKit-based browsers) play HLS natively — no
      // library needed, and in fact hls.js explicitly recommends deferring
      // to native support where it exists.
      vid.src = url;
      return;
    }
    if (isHls && window.Hls && window.Hls.isSupported()) {
      const hls = new window.Hls({ enableWorker: true, maxBufferLength: 15 });
      // Fatal hls.js-level failures (bad manifest, network error mid-stream,
      // etc.) don't necessarily raise the native <video> 'error' event on
      // their own — funnel them into it so the existing "swap to static
      // image" fallback below fires the same way regardless of which layer
      // the failure happened at.
      hls.on(window.Hls.Events.ERROR, (_evt, data) => {
        if (data?.fatal) {
          // Logged so a future CDN-host surprise (Apple adding yet another
          // edge domain) shows up immediately in DevTools instead of just
          // silently falling back — check data.type/details/response.url
          // here first before assuming it's the same aaplimg.com/itunes.apple.com
          // permission gap this was written to fix.
          console.warn('[Vivi] Apple Canvas hls.js fatal error:', data.type, data.details, data.response?.url || url);
          vid.dispatchEvent(new Event('error'));
        }
      });
      hls.loadSource(url);
      hls.attachMedia(vid);
      vid.__viviHls = hls;
      return;
    }
    // Not HLS (a plain .mp4-style file), or hls.js isn't available/supported
    // for some reason — assigning it directly is exactly what already
    // worked for boidu.dev's resolved URLs.
    vid.src = url;
  }

  function makeMediaEl({ videoUrl, imageUrl }, wrapper, options = {}) {
    const appleOverlay = options.appleOverlay === true;
    if (videoUrl && !imageOnlyMode) {
      const isMain = wrapper?.classList?.contains(MAIN_PLAYER_CLASS);
      const className = isMain ? 'vivi-canvas-player-media' : 'vivi-canvas-media';

      if (isAppleCdnHlsUrl(videoUrl)) {
        const fallbackToImage = () => {
          if (imageUrl) {
            const img = makeMediaEl({ videoUrl: null, imageUrl }, wrapper, { appleOverlay });
            if (img) {
              img.style.opacity = frame.style.opacity || '1';
              frame.replaceWith(img);
            } else {
              frame.remove();
            }
          } else {
            frame.remove();
          }
        };
        // Main player uses 'cover' (not 'contain'): Apple's motion-artwork
        // source isn't guaranteed to be *exactly* 9:16, and our fixed-size
        // box's width/height are independently rounded to whole pixels
        // (see updateCanvasPlayerSize) — either alone is enough for
        // object-fit:contain to leave a thin unfilled sliver down one edge,
        // which read as a stray vertical "line" next to the frame border.
        // 'cover' guarantees the video fully fills the box with no gap,
        // at the cost of a negligible crop.
        const frame = makeAppleHlsIframe(videoUrl, className, 'cover', appleOverlay, fallbackToImage, () => {
          frame.dispatchEvent(new Event('vivi-apple-playing'));
        });
        return frame;
      }

      const vid = document.createElement('video');
      attachVideoSource(vid, videoUrl);
      vid.autoplay = true;
      vid.loop = true;
      vid.muted = true;
      vid.playsInline = true;
      vid.preload = 'auto';
      // No `crossorigin` here on purpose: this video is only ever displayed,
      // never sampled into a <canvas>/WebGL texture (Kawarp gets its own,
      // separate static imageUrl — see setBackgroundVar). A
      // crossorigin="anonymous" request is a *different* HTTP cache
      // partition than a plain one — so setting this forced a real network
      // re-fetch (and its slow TLS/range-request round trip) on every single
      // "cached" replay instead of reusing the browser's own disk cache,
      // which is what made Better Lyrics Shaders' identical video-src
      // approach feel instant while this felt like a 2-6s stall.
      vid.className = className;
      if (appleOverlay) vid.dataset.viviAppleOverlay = '1';
      // Only the dedicated Spotify Canvas should ever touch the global Canvas
      // sizing state. Apple Music artwork is a normal-thumbnail overlay and
      // must not toggle portrait/large page classes when its metadata arrives.
      if (isMain) {
        vid.addEventListener('loadedmetadata', () => {
          updateCanvasShapeClass(vid.videoWidth, vid.videoHeight);
        }, { once: true });
      }
      vid.addEventListener('canplay', () => { vid.play().catch(() => {}); }, { once: true });
      vid.addEventListener('error', () => {
        // Some Apple artwork URLs can expire or momentarily fail after playing.
        // Replace the media *in place* and preserve its overlay identity so the
        // fallback cannot leak onto the native thumbnail as an unmanaged image.
        try { vid.__viviHls?.destroy(); } catch (_) {}
        vid.__viviHls = null;
        if (imageUrl) {
          const img = makeMediaEl({ videoUrl: null, imageUrl }, wrapper, { appleOverlay });
          if (img) {
            img.style.opacity = vid.style.opacity || '1';
            vid.replaceWith(img);
          } else {
            vid.remove();
          }
        } else {
          vid.remove();
        }
      }, { once: true });
      return vid;
    }
    if (imageUrl) {
      const img = document.createElement('img');
      img.src = imageUrl;
      img.alt = '';
      img.className = wrapper?.classList?.contains(MAIN_PLAYER_CLASS)
        ? 'vivi-canvas-player-media'
        : 'vivi-canvas-media';
      img.setAttribute('aria-hidden', 'true');
      if (appleOverlay) img.dataset.viviAppleOverlay = '1';
      if (wrapper?.classList?.contains(MAIN_PLAYER_CLASS)) {
        img.addEventListener('load', () => {
          updateCanvasShapeClass(img.naturalWidth, img.naturalHeight);
        }, { once: true });
      }
      return img;
    }
    return null;
  }

  // Spotify Canvas is normally 9:16 portrait. We now use a dedicated player
  // element instead of resizing/wrapping YT Music's #song-image element.
  // That completely removes the host thumbnail's layout math from the Canvas.
  function updateCanvasShapeClass() {
    // Spotify Canvas is a portrait 9:16 asset. Never derive the player ratio
    // from the decoded media because the host page may return a poster/fallback
    // with a different ratio and that would reintroduce cropping.
    const ar = 9 / 16;
    document.documentElement.classList.add('vivi-canvas-portrait');
    document.documentElement.classList.remove('vivi-canvas-square');
    document.documentElement.style.setProperty('--vivi-canvas-ar', ar.toFixed(4));
    requestAnimationFrame(updateCanvasPlayerSize);
  }

  // Keep #song-media-window in the layout so it remains a reliable anchor for
  // the dedicated Canvas player. Only hide its visual artwork content.
  const NATIVE_ARTWORK_HIDE_SELECTORS = [
    'ytmusic-player #song-image',
    'ytmusic-player #song-image img',
    'ytmusic-player .ytmusic-player-thumbnail',
    'ytmusic-player ytmusic-thumbnail.ytmusic-player',
  ];

  function hideNativeArtwork() {
    const seen = new Set();
    const mediaWindow = document.querySelector('ytmusic-player #song-media-window');
    if (mediaWindow) {
      if (!mediaWindow.dataset.viviCanvasWindowStyleSaved) {
        mediaWindow.dataset.viviCanvasWindowStyleSaved = '1';
        mediaWindow.dataset.viviCanvasWindowStyle = mediaWindow.getAttribute('style') || '';
      }
      // Preserve geometry for positioning, but make the native artwork surface invisible.
      mediaWindow.style.setProperty('background', 'transparent', 'important');
      mediaWindow.style.setProperty('background-image', 'none', 'important');
      mediaWindow.style.setProperty('overflow', 'visible', 'important');
    }
    for (const selector of NATIVE_ARTWORK_HIDE_SELECTORS) {
      document.querySelectorAll(selector).forEach(node => {
        if (seen.has(node)) return;
        seen.add(node);
        if (!node.dataset.viviNativeArtworkStyleSaved) {
          node.dataset.viviNativeArtworkStyleSaved = '1';
          node.dataset.viviNativeArtworkStyle = node.getAttribute('style') || '';
        }
        node.style.setProperty('display', 'none', 'important');
        node.style.setProperty('visibility', 'hidden', 'important');
        node.style.setProperty('opacity', '0', 'important');
        node.style.setProperty('pointer-events', 'none', 'important');
      });
    }
  }

  function restoreNativeArtwork() {
    const mediaWindow = document.querySelector('ytmusic-player #song-media-window');
    if (mediaWindow?.dataset.viviCanvasWindowStyleSaved === '1') {
      const style = mediaWindow.dataset.viviCanvasWindowStyle || '';
      if (style) mediaWindow.setAttribute('style', style);
      else mediaWindow.removeAttribute('style');
      delete mediaWindow.dataset.viviCanvasWindowStyleSaved;
      delete mediaWindow.dataset.viviCanvasWindowStyle;
    }
    const seen = new Set();
    for (const selector of NATIVE_ARTWORK_HIDE_SELECTORS) {
      document.querySelectorAll(selector).forEach(node => {
        if (seen.has(node) || node.dataset.viviNativeArtworkStyleSaved !== '1') return;
        seen.add(node);
        const style = node.dataset.viviNativeArtworkStyle || '';
        if (style) node.setAttribute('style', style);
        else node.removeAttribute('style');
        delete node.dataset.viviNativeArtworkStyleSaved;
        delete node.dataset.viviNativeArtworkStyle;
      });
    }
  }

  // Defensive cleanup for track changes and source toggles. YouTube Music can
  // recreate its artwork nodes while a Canvas is active, which means a freshly
  // created node may not carry the data attributes we used to save its old style.
  // Only clear the exact hide signature that this extension applies, so native
  // YT Music layout styles are left untouched.
  function ensureNativeArtworkVisible() {
    restoreNativeArtwork();

    const candidates = new Set();
    for (const selector of NATIVE_ARTWORK_HIDE_SELECTORS) {
      document.querySelectorAll(selector).forEach(node => candidates.add(node));
    }

    for (const node of candidates) {
      const display = node.style.getPropertyValue('display');
      const visibility = node.style.getPropertyValue('visibility');
      const opacity = node.style.getPropertyValue('opacity');
      const pointerEvents = node.style.getPropertyValue('pointer-events');
      const looksExtensionHidden =
        display === 'none' &&
        visibility === 'hidden' &&
        opacity === '0' &&
        pointerEvents === 'none';

      if (looksExtensionHidden) {
        node.style.removeProperty('display');
        node.style.removeProperty('visibility');
        node.style.removeProperty('opacity');
        node.style.removeProperty('pointer-events');
      }
    }

    const mediaWindow = document.querySelector('ytmusic-player #song-media-window');
    mediaWindow?.classList.remove('vivi-canvas-main-active');
    document.documentElement.classList.remove(
      'vivi-canvas-large', 'vivi-canvas-portrait', 'vivi-canvas-square'
    );
    document.documentElement.style.removeProperty('--vivi-canvas-ar');
  }

  function hideMainCanvasPlayer({ restoreArtwork = true } = {}) {
    document.querySelectorAll(`.${MAIN_PLAYER_CLASS}`).forEach(el => {
      el.style.visibility = 'hidden';
      el.style.opacity = '0';
      el.removeAttribute('data-vivi-visible');
      el.dataset.viviCanvasRouteHidden = '1';
    });
    if (restoreArtwork) restoreNativeArtwork();
    const mediaWindow = document.querySelector('ytmusic-player #song-media-window');
    if (mediaWindow) mediaWindow.classList.remove('vivi-canvas-main-active');
    document.documentElement.classList.remove('vivi-canvas-large');
  }

  function showMainCanvasPlayer() {
    const player = document.querySelector(`.${MAIN_PLAYER_CLASS}`);
    // Never tie Canvas visibility to the native thumbnail's layout. The fixed
    // Canvas can be shown as soon as the full-player route is active and its
    // own media is ready.
    if (!player || !isMainPlayerPageActive() || document.hidden) return false;
    const media = player.querySelector('.vivi-canvas-player-media');
    const ready = !!media && (
      media.dataset.viviCanvasReady === '1' ||
      media.readyState >= 3 ||
      media.complete === true
    );
    // Never reveal the dedicated player before the new Canvas is actually ready.
    // A visible, media-less shell is the black rectangle seen during track changes.
    if (!ready) {
      player.style.visibility = 'hidden';
      player.style.opacity = '0';
      player.dataset.viviCanvasRouteHidden = '1';
      return false;
    }
    player.style.visibility = 'visible';
    player.style.opacity = '1';
    player.setAttribute('data-vivi-visible', '1');
    delete player.dataset.viviCanvasRouteHidden;
    const mediaWindow = document.querySelector('ytmusic-player #song-media-window');
    if (mediaWindow) mediaWindow.classList.add('vivi-canvas-main-active');
    document.documentElement.classList.add('vivi-canvas-large', 'vivi-canvas-portrait');
    return true;
  }

  function removeMainCanvasPlayer() {
    document.querySelectorAll(`.${MAIN_PLAYER_CLASS}`).forEach(el => {
      el.querySelectorAll?.('video').forEach((v) => {
        try { v.__viviHls?.destroy(); } catch (_) {}
        v.__viviHls = null;
      });
      el.remove();
    });
    restoreNativeArtwork();
    const mediaWindow = document.querySelector('ytmusic-player #song-media-window');
    if (mediaWindow) {
      mediaWindow.classList.remove('vivi-canvas-main-active');
      delete mediaWindow.dataset.viviCanvasAnchorLeft;
      delete mediaWindow.dataset.viviCanvasAnchorTop;
      delete mediaWindow.dataset.viviCanvasAnchorWidth;
      delete mediaWindow.dataset.viviCanvasAnchorHeight;
    }
    document.documentElement.classList.remove('vivi-canvas-portrait', 'vivi-canvas-square');
    document.documentElement.style.removeProperty('--vivi-canvas-ar');
  }

  function createMainCanvasPlayer({ videoUrl, imageUrl, token = canvasRenderToken, trackKey = currentTrackKey }) {
    const mediaWindow = document.querySelector('ytmusic-player #song-media-window');
    const songImage = document.querySelector('ytmusic-player #song-image');
    // A hidden player may be created while the app is minimized so the Canvas
    // video can preload. It will be positioned and revealed when /watch opens.

    let player = document.querySelector(`.${MAIN_PLAYER_CLASS}`);
    if (!player) {
      player = document.createElement('div');
      player.className = MAIN_PLAYER_CLASS;
      player.setAttribute('aria-label', 'Canvas');
      document.body.appendChild(player);
    }

    // Keep the old native artwork visible until the new Canvas media is actually
    // ready. This removes the black/blank gap seen during track changes.
    player.style.visibility = 'hidden';
    player.style.opacity = '0';
    player.removeAttribute('data-vivi-visible');
    delete player.dataset.viviCanvasRouteHidden;

    if (mediaWindow) mediaWindow.classList.remove('vivi-canvas-main-active');
    restoreNativeArtwork();

    const oldMedia = player.querySelector('.vivi-canvas-player-media');
    const newMedia = makeMediaEl({ videoUrl, imageUrl }, player);
    if (!newMedia) return false;

    newMedia.style.opacity = '0';
    player.appendChild(newMedia);

    const reveal = () => {
      // Never allow a late media event from an older track to resurrect the
      // previous Canvas after the user has already changed songs.
      if (token !== canvasRenderToken || trackKey !== currentTrackKey || !player.isConnected) {
        newMedia.remove();
        return;
      }
      player.dataset.viviCanvasMediaReady = '1';
      newMedia.dataset.viviCanvasReady = '1';

      // While minimized, only preload the Canvas. When reopening, wait until
      // the mini -> full player transition has completely settled before
      // revealing or positioning it. This prevents the Canvas from following
      // the thumbnail as it grows and moves.
      if (!isMainPlayerPageActive()) return;

      const revealWhenStable = () => {
        if (token !== canvasRenderToken || trackKey !== currentTrackKey || !player.isConnected) {
          newMedia.remove();
          return;
        }
        // A background tab may have an unusable/collapsed native artwork window.
        // That must never block the independent Canvas player. Wait only for the
        // actual full-player route and the Canvas media itself.
        if (!isMainPlayerPageActive() || document.hidden) return;
        if (canvasExpandRevealPending) return;

        hideNativeArtwork();
        document.documentElement.classList.add('vivi-canvas-large', 'vivi-canvas-portrait');
        newMedia.style.opacity = '';
        newMedia.classList.add('vivi-canvas-player-crossfade');
        player.style.visibility = 'visible';
        player.style.opacity = '1';
        player.setAttribute('data-vivi-visible', '1');
        delete player.dataset.viviCanvasRouteHidden;

        // Set the fixed viewport position synchronously before the frame paints.
        updateCanvasPlayerSize();

        if (oldMedia && oldMedia !== newMedia) {
          oldMedia.classList.add('vivi-canvas-player-fadeout');
          setTimeout(() => oldMedia.remove(), 350);
        }
      };

      revealWhenStable();
    };

    if (newMedia.tagName === 'VIDEO') {
      newMedia.addEventListener('canplay', reveal, { once: true });
      newMedia.addEventListener('loadeddata', reveal, { once: true });
      if (newMedia.readyState >= 3) reveal();
      else setTimeout(() => { if (player.isConnected && newMedia.style.opacity === '0') reveal(); }, 1200);
    } else if (newMedia.dataset.viviAppleAwaitsPlaying === '1') {
      // Apple HLS iframe: the iframe document's own 'load' event fires
      // almost instantly (long before the video inside has any decoded
      // frames), so it must NOT be used as the reveal signal — that was the
      // cause of the black flash before playback actually started. Wait for
      // the real 'vivi-apple-playing' signal (dispatched once
      // apple-canvas-player.html posts back that the video is genuinely
      // playing), with a generous timeout as a safety net only.
      newMedia.addEventListener('vivi-apple-playing', reveal, { once: true });
      setTimeout(() => { if (player.isConnected && newMedia.style.opacity === '0') reveal(); }, 2500);
    } else {
      newMedia.addEventListener('load', reveal, { once: true });
      if (newMedia.complete) reveal();
      else setTimeout(() => { if (player.isConnected && newMedia.style.opacity === '0') reveal(); }, 900);
    }

    updateCanvasShapeClass();
    bindCanvasViewportUpdates();
    bindCanvasOverlayDimming();
    requestAnimationFrame(updateCanvasPlayerSize);
    return true;
  }

  function isFullPlayerLayoutStable() {
    // isMainPlayerPageActive() already confirms the /watch route AND the
    // player-page-open / player-page-ui-state / player-ui-state attributes
    // all agree the full player is genuinely open (not just minimized on
    // /watch). On top of that, during mini -> full navigation the attributes
    // can flip true before YT Music finishes moving the thumbnail into the
    // full artwork area, so also require the artwork slot to have actually
    // reached full size/position before treating the layout as stable.
    if (!isMainPlayerPageActive()) return false;

    const rect = document.querySelector('ytmusic-player #song-media-window')?.getBoundingClientRect();
    return !!rect && rect.width >= 160 && rect.height >= 160 &&
      rect.left > 80 && rect.left < window.innerWidth - 80 &&
      rect.top > 40 && rect.bottom < window.innerHeight;
  }

  // ── Keep native dialogs/dropdowns/search-suggestions above the Canvas ──
  // The Canvas video is a decorative overlay pinned at z-index:9999 (see
  // canvas.css) so it always sits above the normal page. But YouTube
  // Music's own dialogs ("Save to playlist", "Share", the account menu)
  // and the search-suggestions dropdown are painted at a lower z-index, so
  // without this they render visually *underneath* the Canvas box even
  // though pointer-events are already passed through to them. All of these
  // native panels share the same reflected "opened" boolean attribute, so a
  // single attribute observer is enough to catch every case.
  const BLOCKING_OVERLAY_SELECTOR = [
    'tp-yt-paper-dialog[opened]',
    'tp-yt-iron-dropdown[opened]',
    'ytmusic-search-box[opened]',
    'tp-yt-paper-menu-button[opened]',
  ].join(', ');

  let canvasOverlayObserver = null;
  let canvasOverlayCheckScheduled = false;

  function isBlockingOverlayOpen() {
    return !!document.querySelector(BLOCKING_OVERLAY_SELECTOR);
  }

  function syncCanvasOverlayDimming() {
    canvasOverlayCheckScheduled = false;
    const below = isBlockingOverlayOpen();
    document.querySelectorAll(`.${MAIN_PLAYER_CLASS}`).forEach(player => {
      player.classList.toggle('vivi-canvas-below-overlay', below);
    });
  }

  function scheduleCanvasOverlayCheck() {
    if (canvasOverlayCheckScheduled) return;
    canvasOverlayCheckScheduled = true;
    requestAnimationFrame(syncCanvasOverlayDimming);
  }

  function bindCanvasOverlayDimming() {
    if (canvasOverlayObserver) return;
    canvasOverlayObserver = new MutationObserver(scheduleCanvasOverlayCheck);
    canvasOverlayObserver.observe(document.body, {
      attributes: true,
      attributeFilter: ['opened'],
      subtree: true,
    });
    scheduleCanvasOverlayCheck();
  }

  function updateCanvasPlayerSize() {
    const player = document.querySelector(`.${MAIN_PLAYER_CLASS}`);
    // The Canvas is deliberately independent of YT Music's artwork geometry.
    // Do NOT wait for #song-media-window to be stable here: during background
    // playback YT Music may leave that element collapsed/stale, and blocking
    // this function leaves the fixed player with left/top unset (so it renders
    // partially off-screen until refresh). The only host state we need is that
    // the full player route is actually active.
    if (!player || !isMainPlayerPageActive() || document.hidden) return;

    // IMPORTANT: the dedicated Spotify Canvas player is intentionally NOT
    // positioned from #song-media-window / #song-image. YouTube Music can
    // rebuild or temporarily collapse those nodes while a background-tab
    // track change is happening. Using their rect as our anchor is what caused
    // the Canvas to jump to the side until a page refresh restored the layout.
    //
    // Instead, the Canvas has a stable desktop "artwork column" position that
    // is based only on the viewport. Track thumbnails may move/reflow however
    // they want; the Canvas does not follow them.
    const ar = 9 / 16;

    // Leave room for YT Music's top navigation and bottom player bar. These are
    // viewport-relative bounds, so a background-tab track update cannot poison
    // the Canvas position with stale thumbnail geometry.
    const safeTop = Math.max(96, Math.round(window.innerHeight * 0.105));
    const safeBottom = Math.min(
      window.innerHeight - 18,
      Math.max(safeTop + 260, window.innerHeight - 88)
    );
    const availableH = Math.max(260, safeBottom - safeTop);

    // Keep the Canvas large on desktop while giving narrower browser windows
    // enough room. Height is the primary limiter so the whole 9:16 frame stays
    // inside the player area.
    const maxW = Math.min(420, Math.max(240, window.innerWidth * 0.30));
    let h = Math.min(availableH, maxW / ar);
    // Round height to a whole pixel FIRST, then derive width from that
    // rounded height — not the other way around, and not independently.
    // Rounding w and h separately (the previous behavior) could leave the
    // box a fraction of a pixel off true 9:16, which combined with
    // object-fit:contain on the video inside was leaving a hairline unfilled
    // strip down one edge of the frame.
    h = Math.round(h);
    let w = Math.round(h * ar);

    // Stable horizontal pin: centered in YT Music's left artwork column, not
    // tied to whichever thumbnail node happens to exist for the current track.
    // The clamp prevents the Canvas from drifting too far right on ultrawide
    // monitors while remaining usable on smaller desktop windows.
    const centerX = Math.max(
      220,
      Math.min(window.innerWidth - w / 2 - 24, window.innerWidth * 0.28)
    );

    // Vertically center in the usable full-player region, with a small upward
    // bias matching YT Music's visual balance.
    const LIFT_PX = 24;
    let top = safeTop + Math.max(0, (availableH - h) / 2) - LIFT_PX;
    top = Math.max(safeTop, Math.min(top, safeBottom - h));

    player.style.width = `${Math.round(w)}px`;
    player.style.height = `${Math.round(h)}px`;
    player.style.aspectRatio = '9 / 16';
    player.style.left = `${Math.round(centerX)}px`;
    player.style.top = `${Math.round(top)}px`;
    player.style.setProperty('--vivi-player-width', `${Math.round(w)}px`);
    player.style.setProperty('--vivi-player-height', `${Math.round(h)}px`);
    player.style.setProperty('--vivi-player-ar', ar.toFixed(4));
  }

  let canvasViewportBound = false;
  function bindCanvasViewportUpdates() {
    if (canvasViewportBound) return;
    canvasViewportBound = true;
    const refresh = () => requestAnimationFrame(updateCanvasPlayerSize);
    window.addEventListener('resize', refresh, { passive: true });
    window.addEventListener('scroll', refresh, { passive: true });

    // When the tab/app is backgrounded, the browser throttles rendering and
    // YT Music's own layout can transiently report a collapsed or stale
    // #song-media-window rect. Nothing above ever re-fires in that case, so
    // the Canvas player was left sitting at whatever (possibly wrong)
    // position/size was last computed before backgrounding — only a full
    // page refresh reset it. Force a few staggered recomputes once the tab
    // becomes visible again so the geometry has time to settle back to its
    // real values.
    const refreshBurst = () => {
      [0, 60, 200, 500, 1000].forEach(delay => {
        setTimeout(() => requestAnimationFrame(updateCanvasPlayerSize), delay);
      });
    };
    document.addEventListener('visibilitychange', () => {
      if (document.visibilityState === 'visible') refreshBurst();
    });
    window.addEventListener('focus', refreshBurst, { passive: true });
    window.addEventListener('pageshow', refreshBurst, { passive: true });
  }

  function removeAllOverlays() {
    cleanupLegacyArtworkSlots();
    restoreAppleOverlayParents();
    document.querySelectorAll('.vivi-canvas-media').forEach(el => el.remove());
    removeMainCanvasPlayer();
    setCanvasActiveClass(false);
    document.documentElement.style.removeProperty('--vivi-canvas-ar');
  }

  function setCanvasActiveClass(active) {
    document.documentElement.classList.toggle('vivi-canvas-large', !!active);
    if (active) updateCanvasPlayerSize();
    if (!active) disablePlayerAutoHide();
  }

  // Kept for compatibility with the existing auto-hide behavior on the player bar.
  // The Canvas itself is no longer sized from the player-bar coordinates.
  let playerHideMouseHandler = null;
  function enablePlayerAutoHide() {
    if (playerHideMouseHandler) return;
    playerHideMouseHandler = (e) => {
      const nearBottom = window.innerHeight - e.clientY <= 90;
      document.documentElement.classList.toggle('vivi-player-peek', nearBottom);
    };
    window.addEventListener('mousemove', playerHideMouseHandler);
    document.documentElement.classList.add('vivi-player-autohide');
  }

  function disablePlayerAutoHide() {
    if (playerHideMouseHandler) {
      window.removeEventListener('mousemove', playerHideMouseHandler);
      playerHideMouseHandler = null;
    }
    document.documentElement.classList.remove('vivi-player-autohide', 'vivi-player-peek');
  }

  function swapOverlayMedia({ videoUrl, imageUrl }) {
    // Player-bar thumbnail overlay.
    document.querySelectorAll(`.${SLOT_CLASS}`).forEach(wrapper => {
      const oldMedia = wrapper.querySelector('.vivi-canvas-media');
      const newMedia = makeMediaEl({ videoUrl, imageUrl }, wrapper);
      if (!newMedia) { oldMedia?.remove(); return; }
      newMedia.style.opacity = '0';
      wrapper.appendChild(newMedia);
      const reveal = () => {
        newMedia.style.opacity = '';
        newMedia.classList.add('vivi-canvas-crossfade');
        if (oldMedia) { oldMedia.classList.add('vivi-canvas-fadeout'); setTimeout(() => oldMedia.remove(), 400); }
      };
      if (newMedia.tagName === 'VIDEO') { newMedia.addEventListener('canplay', reveal, { once: true }); setTimeout(reveal, 1000); }
      else if (newMedia.dataset.viviAppleAwaitsPlaying === '1') {
        newMedia.addEventListener('vivi-apple-playing', reveal, { once: true });
        setTimeout(reveal, 2500);
      }
      else { newMedia.addEventListener('load', reveal, { once: true }); setTimeout(reveal, 800); }
    });

  }

  function injectAppleArtwork({ videoUrl, imageUrl }, attempt = 0, token = canvasRenderToken, trackKey = currentTrackKey) {
    if (token !== canvasRenderToken || trackKey !== currentTrackKey) return;
    if (!appleCanvasEnabled || !isMainPlayerPageActive()) return;
    if (isRealMusicVideo()) return;

    setBackgroundVar(imageUrl);

    // No real motion-Canvas video for this track — only a static iTunes cover
    // fallback (or nothing). Don't overlay a static image over the native
    // thumbnail; leave YouTube Music's own artwork exactly as-is instead of
    // substituting a still photo that looks like it should be animated.
    // (setBackgroundVar above still runs — that's the separate ambient
    // background-tint feature, not the artwork overlay.)
    if (!videoUrl) {
      clearAppleOverlays();
      activeAppleArtwork = null;
      return;
    }

    // Apple artwork is never the dedicated Spotify 9:16 player. Keep the native
    // thumbnail intact and maintain a separate overlay above whichever thumbnail
    // node YT Music currently owns.
    cleanupLegacyArtworkSlots();
    removeMainCanvasPlayer();
    setCanvasActiveClass(false);

    const mainImg = document.querySelector(APPLE_MAIN_IMG_SELECTOR);
    const barImg = document.querySelector(APPLE_BAR_IMG_SELECTOR);
    if (!mainImg && !barImg) {
      if (attempt < 20) {
        setTimeout(() => injectAppleArtwork({ videoUrl, imageUrl }, attempt + 1, token, trackKey), 120);
      }
      return;
    }

    activeAppleArtwork = { videoUrl, imageUrl };
    startAppleOverlayObserver();
    if (mainImg) ensureAppleOverlayOnImage(mainImg, activeAppleArtwork);
    if (barImg) ensureAppleOverlayOnImage(barImg, activeAppleArtwork);
    scheduleAppleOverlaySync();
  }

  // Spotify Canvas uses the dedicated true-9:16 player. Apple Music-style
  // artwork must use the normal thumbnail overlay instead.
  function injectIntoPlayerThumbnails({ videoUrl, imageUrl }, attempt = 0, token = canvasRenderToken, trackKey = currentTrackKey) {
    if (token !== canvasRenderToken || trackKey !== currentTrackKey) return;
    if (!isMainPlayerPageActive()) return;
    setBackgroundVar(imageUrl);

    // Spotify Canvas uses a dedicated viewport-pinned player. Do not wait for,
    // measure, or depend on #song-media-window: YT Music can leave that native
    // artwork node collapsed/stale while a background tab changes tracks.
    document.querySelectorAll(`.${SLOT_CLASS}`).forEach(wrapper => wrapper.remove());
    document.querySelectorAll('.vivi-canvas-media').forEach(el => el.remove());

    const mainCreated = createMainCanvasPlayer({ videoUrl, imageUrl, token, trackKey });
    if (mainCreated) {
      document.querySelectorAll(`.${SLOT_CLASS}, .vivi-canvas-media`).forEach(el => el.remove());
      updateCanvasPlayerSize();
    }
    setCanvasActiveClass(false);
  }

  function fadeOutCurrentOverlay() {
    const minimized = !isMainPlayerPageActive();
    document.querySelectorAll('.vivi-canvas-media, .vivi-canvas-player-media').forEach(el => {
      el.classList.add(el.classList.contains('vivi-canvas-player-media')
        ? 'vivi-canvas-player-fadeout'
        : 'vivi-canvas-fadeout');
    });

    if (minimized) {
      // Keep the dedicated Canvas shell alive but hidden so the next track's
      // Canvas can preload during minimized playback. This removes the stale
      // visual immediately without forcing a re-fetch/rebuild on reopen.
      const player = document.querySelector(`.${MAIN_PLAYER_CLASS}`);
      player?.querySelectorAll('.vivi-canvas-player-media').forEach(el => el.remove());
      if (player) {
        player.style.visibility = 'hidden';
        player.style.opacity = '0';
        player.removeAttribute('data-vivi-visible');
        player.dataset.viviCanvasRouteHidden = '1';
        delete player.dataset.viviCanvasMediaReady;
      }
      restoreNativeArtwork();
      const mediaWindow = document.querySelector('ytmusic-player #song-media-window');
      mediaWindow?.classList.remove('vivi-canvas-main-active');
    } else {
      removeMainCanvasPlayer();
    }

    cleanupLegacyArtworkSlots();
    restoreAppleOverlayParents();
    document.querySelectorAll('.vivi-canvas-media').forEach(el => el.remove());

    setBackgroundVar(null);
    setCanvasActiveClass(false);
    ensureNativeArtworkVisible();
  }

  function getVideoEl() {
    return document.querySelector('ytmusic-player video, video');
  }

  function getLikeButtonState() {
    const btn = document.querySelector(
      'ytmusic-like-button-renderer button[aria-label="Like"], ' +
      'ytmusic-like-button-renderer button[aria-pressed]'
    );
    if (!btn) return null;
    return btn.getAttribute('aria-pressed') === 'true';
  }

  function resetLastfmForNewTrack() {
    lastfmStartedAt = Math.floor(Date.now() / 1000);
    lastfmScrobbled = false;
    lastfmSentNowPlaying = false;
  }

  function sendLastfmNowPlaying(track) {
    if (!lastfmSettings.lastfmEnabled || !lastfmSettings.lastfmSendNowPlaying) return;
    if (lastfmSentNowPlaying) return;
    lastfmSentNowPlaying = true;
    const video = getVideoEl();
    chrome.runtime.sendMessage({
      type: 'VIVI_LASTFM_NOWPLAYING',
      track: { artist: track.artist, song: track.song, duration: video?.duration || undefined },
    }).catch(() => {});
  }

  function maybeScrobble(track) {
    if (!lastfmSettings.lastfmEnabled || lastfmScrobbled) return;
    const video = getVideoEl();
    if (!video || !video.duration || Number.isNaN(video.duration)) return;

    const duration = video.duration;
    const elapsed = video.currentTime || 0;
    if (duration < lastfmSettings.lastfmMinDurationSec) return; // too short to count

    const percentThreshold = duration * (lastfmSettings.lastfmDelayPercent / 100);
    const minutesThreshold = lastfmSettings.lastfmDelayMinutes * 60;
    const threshold = Math.min(percentThreshold, minutesThreshold);

    if (elapsed >= threshold) {
      lastfmScrobbled = true;
      chrome.runtime.sendMessage({
        type: 'VIVI_LASTFM_SCROBBLE',
        track: { artist: track.artist, song: track.song },
        timestamp: lastfmStartedAt,
      }).catch(() => {});
    }
  }

  function watchLikeButton(track) {
    lastfmLikeObserver?.disconnect();
    if (!lastfmSettings.lastfmEnabled || !lastfmSettings.lastfmSendLikes) return;

    let lastState = getLikeButtonState();
    const target = document.querySelector('ytmusic-like-button-renderer');
    if (!target) return;

    lastfmLikeObserver = new MutationObserver(() => {
      const state = getLikeButtonState();
      if (state === null || state === lastState) return;
      lastState = state;
      chrome.runtime.sendMessage({
        type: 'VIVI_LASTFM_LOVE',
        track: { artist: track.artist, song: track.song },
        loved: state,
      }).catch(() => {});
    });
    lastfmLikeObserver.observe(target, { attributes: true, subtree: true, attributeFilter: ['aria-pressed'] });
  }


  async function fetchSpotifyCanvas(track) {
    if (!spotifyCanvasEnabled) return null;
    const key = `${track.artist}—${track.song}`;
    if (spotifyCanvasRequestKey === key) return currentSpotifyCanvasUrl;
    spotifyCanvasRequestKey = key;
    try {
      const response = await chrome.runtime.sendMessage({
        type: 'VIVI_SPOTIFY_CANVAS',
        track: { song: track.song, artist: track.artist, videoId: track.videoId }
      });
      if (spotifyCanvasRequestKey !== key) return null;
      if (!response?.ok) {
        warn('Spotify Canvas request failed:', response?.error || 'No Canvas returned');
        return null;
      }
      currentSpotifyCanvasUrl = response.videoUrl || null;
      return currentSpotifyCanvasUrl;
    } catch (e) {
      warn('Spotify Canvas:', e?.message || e);
      return null;
    }
  }

  // The dedicated Canvas player belongs only to the full player/watch page.
  // When YouTube Music is minimized or navigated back to Home, the global player
  // bar remains mounted, but the main player canvas must disappear completely.
  function isMainPlayerPageActive() {
    const path = window.location.pathname || '';
    if (path !== '/watch' && !path.startsWith('/watch/')) return false;

    // The /watch route stays active even after the player is minimized to
    // the mini-player bar (YT Music doesn't navigate away on minimize), so
    // the URL alone can't tell full-player-open apart from minimized.
    const appLayout = document.querySelector('ytmusic-app-layout[player-page-open], #layout[player-page-open]');
    const playerPage = document.querySelector('ytmusic-player-page[player-page-open]');
    if (!appLayout || !playerPage) return false;

    // `player-page-open` alone isn't enough either: YT Music keeps the player
    // page "open" (mounted/expanded) even after you collapse it to the mini
    // bar — it just flips `player-page-ui-state` away from FULL_PLAYER_VIEW
    // and `ytmusic-player`'s `player-ui-state` away from PLAYER_PAGE_OPEN/
    // FULL_PLAYER. Without checking these too, Kawarp/the Canvas kept
    // thinking the full player was showing while you were actually looking
    // at Home with the mini-player bar. Require both to confirm the full
    // player is genuinely the thing on screen.
    const pageState = playerPage.getAttribute('player-page-ui-state');
    if (pageState && pageState !== 'FULL_PLAYER_VIEW') return false;

    const playerState = document.querySelector('ytmusic-player')?.getAttribute('player-ui-state');
    if (playerState && !['PLAYER_PAGE_OPEN', 'FULL_PLAYER'].includes(playerState)) return false;

    return true;
  }

  // The Kawarp fluid background belongs only to the full player/watch page too —
  // it shouldn't bleed into Home/Explore/Library, which have their own shelves
  // and artwork the animated backdrop would otherwise compete with. This tracks
  // the user's actual toggle state separately so route changes can gate the
  // *effective* on/off state without losing what the person picked in settings.
  let kawarpUserEnabled = true;
  let eqUserEnabled = true;
  function updateKawarpVisibility() {
    const active = isMainPlayerPageActive();
    window.__viviKawarp?.setEnabled(kawarpUserEnabled && active);
    // Reuses the same detection this function already does for Kawarp
    // (including the immediate MutationObserver added above) so the EQ
    // toggle button disappears the instant the player is minimized too,
    // instead of staying visible over Home/Explore/etc.
    window.__viviEqualizer?.setVisible(eqUserEnabled && active);
  }

  // Delay Canvas reveal by ~1s specifically when reopening the full player
  // from YouTube Music's mini-player. YT Music flips its FULL_PLAYER_VIEW
  // state before the main player DOM has visually finished expanding; revealing
  // the Canvas immediately can make it appear a frame/beat before the player.
  let canvasExpandRevealTimer = null;
  let canvasWasFullPlayerActive = false;
  let canvasExpandRevealPending = false;
  let canvasFullPlayerStateInitialized = false;

  function scheduleCanvasRevealAfterExpand() {
    canvasExpandRevealPending = true;
    if (canvasExpandRevealTimer) clearTimeout(canvasExpandRevealTimer);

    const player = document.querySelector(`.${MAIN_PLAYER_CLASS}`);
    if (player) {
      player.style.visibility = 'hidden';
      player.style.opacity = '0';
      player.removeAttribute('data-vivi-visible');
      player.dataset.viviCanvasRouteHidden = '1';
    }

    canvasExpandRevealTimer = setTimeout(() => {
      canvasExpandRevealTimer = null;
      canvasExpandRevealPending = false;
      if (!document.hidden && isMainPlayerPageActive()) {
        const current = document.querySelector(`.${MAIN_PLAYER_CLASS}`);
        const media = current?.querySelector('.vivi-canvas-player-media');
        const ready = !!media && (
          media.dataset.viviCanvasReady === '1' ||
          media.readyState >= 3 ||
          media.complete === true
        );
        if (ready && currentSpotifyCanvasUrl) {
          hideNativeArtwork();
          if (media) media.style.opacity = '';
          showMainCanvasPlayer();
          requestAnimationFrame(updateCanvasPlayerSize);
        }
      }
    }, 1000);
  }

  function syncMainCanvasToRoute() {
    const player = document.querySelector(`.${MAIN_PLAYER_CLASS}`);
    const active = isMainPlayerPageActive();

    // Detect the exact mini -> full transition. Only this transition gets the
    // 1-second Canvas reveal delay; normal track changes stay immediate.
    if (canvasFullPlayerStateInitialized && active && !canvasWasFullPlayerActive && player && currentSpotifyCanvasUrl) {
      scheduleCanvasRevealAfterExpand();
    }
    canvasWasFullPlayerActive = active;
    canvasFullPlayerStateInitialized = true;

    updateKawarpVisibility();
    if (!active) {
      if (canvasExpandRevealTimer) {
        clearTimeout(canvasExpandRevealTimer);
        canvasExpandRevealTimer = null;
      }
      canvasExpandRevealPending = false;
      if (player) {
        // Keep the ready Canvas in memory but hide it while the mini-player/Home
        // route is active. This makes reopening the full player seamless and
        // avoids flashing the static thumbnail before the Canvas is restored.
        hideMainCanvasPlayer({ restoreArtwork: true });
        document.querySelectorAll(`.${SLOT_CLASS}`).forEach(wrapper => wrapper.remove());
        document.querySelectorAll('.vivi-canvas-media').forEach(el => el.remove());
      }
      setCanvasActiveClass(false);
      return;
    }

    if (player && currentSpotifyCanvasUrl) {
      if (isRealMusicVideo()) {
        hideMainCanvasPlayer({ restoreArtwork: true });
        removeMainCanvasPlayer();
        setBackgroundVar(null);
        return;
      }
      // The Canvas is a viewport-pinned overlay. Never gate it on the native
      // artwork window's geometry; that window is exactly what becomes stale or
      // collapsed when YT Music advances tracks in a background tab.
      if (document.hidden) {
        hideMainCanvasPlayer({ restoreArtwork: true });
        return;
      }
      const media = player.querySelector('.vivi-canvas-player-media');

      // During a mini -> full reopen, keep the Canvas hidden for the scheduled
      // 1-second settle period even when its media is already cached/ready.
      if (canvasExpandRevealPending) {
        hideMainCanvasPlayer({ restoreArtwork: true });
        return;
      }

      const ready = !!media && (
        media.dataset.viviCanvasReady === '1' ||
        media.readyState >= 3 ||
        media.complete === true
      );

      // While the new Canvas is loading, keep the normal YT Music artwork visible.
      // Do not apply Canvas mode or expose the player shell yet. This prevents both
      // the black rectangle and the previous track's Canvas from flashing.
      if (!ready) {
        hideMainCanvasPlayer({ restoreArtwork: true });
        return;
      }

      if (media) media.style.opacity = '';
      if (!showMainCanvasPlayer()) return;
      hideNativeArtwork();
      requestAnimationFrame(updateCanvasPlayerSize);
    }
  }

  function injectSpotifyCanvas(url, attempt = 0, token = canvasRenderToken, trackKey = currentTrackKey) {
    if (!url || imageOnlyMode) return;
    if (token !== canvasRenderToken || trackKey !== currentTrackKey) return;
    if (isRealMusicVideo()) return;
    if (!isMainPlayerPageActive()) {
      // Preload the Canvas in a hidden player while minimized. It will be reused
      // instantly when the full player page is opened.
      createMainCanvasPlayer({ videoUrl: url, imageUrl: null, token, trackKey });
      return;
    }
    // Do not wait for YT Music's thumbnail DOM. The Spotify Canvas player is
    // an independent fixed overlay and can be created as soon as the full
    // player state says it is open.
    injectIntoPlayerThumbnails({ videoUrl: url, imageUrl: null }, 0, token, trackKey);
  }

  // Hard-stop the currently displayed Canvas before YouTube Music has finished
  // updating its internal track state. Track detection is intentionally asynchronous
  // (the title/DOM can lag behind a click), so relying only on handleTrackChange()
  // allows the old Canvas to flash for a frame or two. This pre-emptive guard runs
  // during the pointer/click capture phase and invalidates every pending Canvas job.
  let canvasPreemptGuardBound = false;

  function hardStopCanvasForTrackTransition() {
    canvasRenderToken++;
    spotifyCanvasRequestKey = null;
    currentSpotifyCanvasUrl = null;

    // Stop playback immediately, remove the old media, and hide the dedicated shell.
    document.querySelectorAll(`.${MAIN_PLAYER_CLASS}`).forEach(player => {
      player.querySelectorAll('.vivi-canvas-player-media').forEach(media => {
        try { media.pause?.(); } catch (_) {}
        try { media.removeAttribute('src'); media.load?.(); } catch (_) {}
        media.remove();
      });
      player.style.visibility = 'hidden';
      player.style.opacity = '0';
      player.removeAttribute('data-vivi-visible');
      player.dataset.viviCanvasRouteHidden = '1';
      delete player.dataset.viviCanvasMediaReady;
    });

    // Remove any Apple-style animated overlay too, but keep the real YT Music
    // artwork node in place so the new track has a clean handoff frame.
    cleanupLegacyArtworkSlots();
    restoreAppleOverlayParents();
    document.querySelectorAll('.vivi-canvas-media').forEach(media => {
      try { media.pause?.(); } catch (_) {}
      media.remove();
    });

    restoreNativeArtwork();
    const mediaWindow = document.querySelector('ytmusic-player #song-media-window');
    mediaWindow?.classList.remove('vivi-canvas-main-active');

    document.documentElement.classList.remove('vivi-canvas-large', 'vivi-canvas-portrait', 'vivi-canvas-square');
    document.documentElement.style.removeProperty('--vivi-canvas-ar');
    setBackgroundVar(null);
  }

  function isLikelyTrackActivation(target) {
    if (!(target instanceof Element)) return false;

    const path = typeof target.closest === 'function' ? target.closest : null;

    // Queue/list rows are reliable track-change targets when the user clicks
    // the row itself. Do NOT treat the row's action/overflow buttons as a
    // track activation: those buttons open the menu used for "Play next",
    // "Add to queue", "Save to playlist", etc. Hard-stopping the Canvas
    // on that pointerdown makes the currently playing Canvas disappear even
    // though playback never changed.
    if (path) {
      const queueRow = target.closest([
        'ytmusic-player-queue-item',
        'ytmusic-responsive-list-item-renderer',
        'ytmusic-two-row-item-renderer',
        'ytmusic-item-section-renderer .ytmusic-two-row-item-renderer',
        'ytmusic-shelf-renderer ytmusic-responsive-list-item-renderer',
        'ytmusic-playlist-shelf-renderer ytmusic-responsive-list-item-renderer'
      ].join(', '));
      if (queueRow) {
        const actionButton = target.closest('button, yt-icon-button, yt-button-shape, [role=\"button\"]');
        if (!actionButton) return true;

        // Navigation controls inside a row can still legitimately switch the
        // track (for example a dedicated play/skip control). Action/menu
        // buttons must be ignored because they do not change the current track.
        const label = `${actionButton.getAttribute('aria-label') || ''} ${actionButton.getAttribute('title') || ''}`.toLowerCase();
        if (/(play|next|previous|prev|skip)/.test(label) &&
            !/(more|menu|overflow|add to|play next|queue|playlist|save)/.test(label)) {
          return true;
        }
        return false;
      }
    }

    // Direct links to a watch page are also definitive track activations.
    const link = target.closest?.('a[href]');
    if (link) {
      const href = link.getAttribute('href') || '';
      if (/\/watch(?:[/?#]|$)/.test(href)) return true;
    }

    // Next/previous and queue-related player controls switch the track without
    // changing the page route first.
    const button = target.closest?.('button, tp-yt-paper-button, yt-icon-button, [role="button"]');
    if (button) {
      const label = `${button.getAttribute('aria-label') || ''} ${button.getAttribute('title') || ''}`.toLowerCase();
      if (/(next|previous|prev|skip|next song|previous song)/.test(label)) return true;
    }

    return false;
  }

  function bindCanvasTrackTransitionGuard() {
    if (canvasPreemptGuardBound) return;
    canvasPreemptGuardBound = true;

    const preempt = (event) => {
      if (!document.querySelector(`.${MAIN_PLAYER_CLASS}`)) return;
      const target = event.composedPath?.().find(node => node instanceof Element) || event.target;
      if (!isLikelyTrackActivation(target)) return;
      hardStopCanvasForTrackTransition();
    };

    // pointerdown fires before the click/default navigation and is early enough
    // to guarantee that the previous Canvas disappears before the new song starts.
    document.addEventListener('pointerdown', preempt, true);
    document.addEventListener('mousedown', preempt, true);

    // YouTube Music also emits route-navigation events before the final track DOM
    // settles. Treat watch navigation as a second hard-stop signal.
    window.addEventListener('yt-navigate-start', () => {
      if (document.querySelector(`.${MAIN_PLAYER_CLASS}`)) hardStopCanvasForTrackTransition();
    }, true);
  }

  async function handleTrackChange(track) {
    const key = `${track.artist}—${track.song}`;
    if (key !== currentTrackKey) {
      window.__viviLyricsUI?.handleTrack(track);
      loadSponsorSegmentsForTrack(track).catch((e) => warn('SponsorBlock: track load failed', e?.message));
      applyViviTitle(track);
    }
    if (key === currentTrackKey) return;
    currentTrackKey = key;
    canvasRenderToken++;
    const trackCanvasToken = canvasRenderToken;
    prefetchedForKey = null;
    spotifyCanvasRequestKey = null;
    currentSpotifyCanvasUrl = null;
    currentVideoUrl = null; currentImageUrl = null;

    // Clear whatever the previous track was showing right away, before either
    // artwork source has had a chance to respond — this is what stops the old
    // Canvas from lingering on screen after a skip. Immediately restore the
    // native YT Music thumbnail as the safe visual fallback for ordinary songs.
    fadeOutCurrentOverlay();
    ensureNativeArtworkVisible();

    if (key !== lastfmCurrentKey) {
      lastfmCurrentKey = key;
      resetLastfmForNewTrack();
      watchLikeButton(track);
    }

    clearTimeout(retryTimer);

    // Never overlay Canvas/animated-artwork on top of an actual music video —
    // only plain songs (art-track playback) should ever get one. Still update
    // the blurred page background from the video's own thumbnail (grabbed
    // straight off the player bar), or it's left showing whatever the
    // previous track looked like.
    if (isRealMusicVideo()) {
      log('Real music video detected — skipping Canvas overlay for', key);
      hideMainCanvasPlayer({ restoreArtwork: true });
      removeMainCanvasPlayer();
      setBackgroundVar(null);
      return;
    }

    // Try Spotify Canvas. Returns 'stop' if the caller should return immediately
    // (either it rendered something, or a real video was detected mid-fetch),
    // or 'miss' if there was nothing to show and the other source should be tried.
    async function attemptSpotify() {
      const spotifyCanvas = await fetchSpotifyCanvas(track);
      if (key !== currentTrackKey) return 'stop'; // track moved on again while we were waiting
      // Re-check here, not just at the top of this function: when the track
      // first changes, YT Music's player-bar stats line (views/likes vs.
      // plays) often hasn't rendered yet, so the earlier check can miss a
      // real video. By the time this fetch resolves the stats line has
      // reliably loaded, so this is the check that actually catches it.
      if (isRealMusicVideo()) {
        log('Real music video detected (post-fetch) — skipping Canvas overlay for', key);
        hideMainCanvasPlayer({ restoreArtwork: true });
        removeMainCanvasPlayer();
        setBackgroundVar(null);
        return 'stop';
      }
      if (spotifyCanvas) {
        injectSpotifyCanvas(spotifyCanvas, 0, trackCanvasToken, key);
        return 'stop';
      }
      return 'miss';
    }

    // Try Apple Music-style animated artwork. Same 'stop'/'miss' contract as
    // attemptSpotify above, except a miss here also means no retry has been
    // scheduled yet — the caller decides whether to schedule one, since that
    // should only happen once we know neither source is going to pan out.
    async function attemptApple() {
      if (isRealMusicVideo()) return 'stop';

      const cached = await readCache(key);
      if (key !== currentTrackKey) return 'stop';
      if (isRealMusicVideo()) return 'stop';
      if (cached) {
        const playable = resolvePlayableSource(cached);
        currentVideoUrl = playable.videoUrl;
        currentImageUrl = playable.imageUrl;
        injectAppleArtwork(playable, 0, trackCanvasToken, key);
        return 'stop';
      }

      // ensureAppleCached runs on its own connection, decoupled from track
      // changes, specifically so that skipping away doesn't
      // kill the download — it keeps running and caching in the background
      // even after we stop waiting on it here. We just decide, once it
      // resolves, whether it's still worth *displaying* (still the current
      // track) or was only ever going to end up cached for next time.
      const data = await ensureAppleCached(track, key);
      if (key !== currentTrackKey) return 'stop';
      if (data) {
        currentVideoUrl = data.videoUrl; currentImageUrl = data.imageUrl;
        injectAppleArtwork(data, 0, trackCanvasToken, key);
        return 'stop';
      }
      return 'miss';
    }

    // Is this track's Apple artwork URL already resolved (i.e. showing it
    // costs zero extra network round-trip beyond what the <video>/<img>
    // element itself needs to fetch)?
    function isAppleCacheReady(entry) {
      return !!(entry && (entry.videoUrl || entry.imageUrl));
    }

    // canvasPriority decides which source gets first refusal when a track has
    // both a Spotify Canvas and Apple Music-style artwork available: whichever
    // source is listed first below wins outright, and the other is only tried
    // if the first one comes up empty (or is turned off).
    //
    // Special case: when the user prefers Apple Music AND Spotify is also
    // enabled, Apple is only shown immediately if its URL is already
    // resolved and cached. If it isn't cached yet, Spotify Canvas plays
    // right away instead while Apple's artwork URL resolves in the
    // background — so this play isn't held up, but the *next* play of this
    // same song shows Apple Music's artwork instantly (cached URL + the
    // browser's own HTTP cache for the actual bytes).
    if (canvasPriority === 'apple' && appleCanvasEnabled && spotifyCanvasEnabled) {
      const cached = await readCache(key);
      if (key !== currentTrackKey) return;
      if (isAppleCacheReady(cached)) {
        const result = await attemptApple(); // cache hit path — instant
        if (result === 'stop') return;
      } else {
        ensureAppleCached(track, key); // fire-and-forget, doesn't block or display
        const spResult = await attemptSpotify();
        if (spResult === 'stop') return;
        // Spotify had nothing for this track either — fall back to Apple's
        // normal live fetch so something still shows for this first play.
        const appleResult = await attemptApple();
        if (appleResult === 'stop') return;
        setBackgroundVar(null);
        if (appleCanvasEnabled) scheduleRetry(track, key, 0);
      }
      return;
    }

    const order = canvasPriority === 'apple'
      ? [['apple', appleCanvasEnabled, attemptApple], ['spotify', spotifyCanvasEnabled, attemptSpotify]]
      : [['spotify', spotifyCanvasEnabled, attemptSpotify], ['apple', appleCanvasEnabled, attemptApple]];

    let appleMissed = false;
    for (const [name, sourceEnabled, attempt] of order) {
      if (!sourceEnabled) continue;
      const result = await attempt();
      if (result === 'stop') return;
      if (name === 'apple') appleMissed = true; // no cached/fetched artwork this round
    }

    // Neither enabled source had anything for this track. Only Apple Music's
    // artwork source has a retry/backoff loop (Spotify Canvas is a one-shot
    // lookup per track), so that's the one worth trying again shortly.
    setBackgroundVar(null);
    if (appleCanvasEnabled && appleMissed) scheduleRetry(track, key, 0);
  }

  function scheduleRetry(track, key, attempt) {
    if (attempt >= RETRY_DELAYS.length) return; // give up after the last backoff step
    retryTimer = setTimeout(async () => {
      if (currentTrackKey !== key) return; // track moved on, this retry is stale
      if (!appleCanvasEnabled || currentSpotifyCanvasUrl) return; // source turned off / Spotify Canvas took over meanwhile
      const retry = await ensureAppleCached(track, key);
      if (currentTrackKey !== key) return;
      if (retry) {
        currentVideoUrl = retry.videoUrl; currentImageUrl = retry.imageUrl;
        injectAppleArtwork(retry, 0, canvasRenderToken, key);
      } else {
        scheduleRetry(track, key, attempt + 1); // back off further instead of hammering the API
      }
    }, RETRY_DELAYS[attempt]);
  }

  // ── Prefetch the next queued track's canvas ─────────────────────────────
  // YouTube Music renders the upcoming queue in a side panel. If it happens to be
  // present in the DOM (panel open, or "up next" mini list), we can read the next
  // item's title/artist and fetch+cache its canvas ahead of time — by the time
  // playback actually reaches that track, the fetch has usually already finished,
  // so the delay users see on skip/auto-advance disappears entirely.
  const NEXT_ITEM_SELECTOR = [
    '#queue-container ytmusic-player-queue-item',       // queue panel
    'ytmusic-player-queue ytmusic-player-queue-item',    // alt queue panel structure
    'ytmusic-tab-renderer ytmusic-player-queue-item',
  ].join(', ');

  let prefetchedForKey = null;

  function getNextQueuedTrack() {
    const items = document.querySelectorAll(NEXT_ITEM_SELECTOR);
    if (!items.length) return null;
    // The currently-playing row is marked selected/playing; the next track is
    // simply the following sibling in the list.
    let currentIdx = -1;
    for (let i = 0; i < items.length; i++) {
      const el = items[i];
      if (el.hasAttribute('selected') || el.getAttribute('aria-selected') === 'true' ||
          el.classList.contains('playing') || el.querySelector('[playing], .playing-indicator')) {
        currentIdx = i;
        break;
      }
    }
    // If we can't confidently tell which row is the one currently playing,
    // don't guess (items[0] is frequently the track that JUST started, not
    // the one coming up — the queue panel's "selected" highlight lags a beat
    // behind the title/player-bar update, so right after a track change this
    // branch used to misidentify the current track as "next" and prefetch it
    // under a differently-parsed key, silently shadowing the real cache
    // entry). Bail out and let the next poll tick try again once the
    // highlight has caught up.
    if (currentIdx < 0) return null;
    const next = items[currentIdx + 1];
    if (!next) return null;
    const titleEl  = next.querySelector('.song-title, yt-formatted-string.song-title, [class*="title"]');
    const artistEl = next.querySelector('.byline, yt-formatted-string.byline, [class*="byline"]');
    const song = titleEl?.textContent?.trim();
    const artist = bylineArtistText(artistEl); // same extraction getCurrentTrack() uses — keeps trackKeys identical
    if (!song || !artist) return null;
    return { song, artist };
  }

  async function prefetchNextTrack() {
    const next = getNextQueuedTrack();
    if (!next) return;
    const key = `${next.artist}—${next.song}`;
    if (key === currentTrackKey || key === prefetchedForKey) return; // already current or already tried this round

    // Belt-and-suspenders against key-format drift between getCurrentTrack()
    // (player bar) and getNextQueuedTrack() (queue panel), which parse the
    // song/artist strings slightly differently and can produce non-identical
    // keys for what is actually the same song (see getNextQueuedTrack for
    // the highlight-lag race this guards against). A loose, normalized
    // compare against the *current* track catches that even if the exact
    // key strings don't match.
    const currentTrack = getCurrentTrack();
    if (currentTrack) {
      const norm = (s) => (s || '').toLowerCase().replace(/\s+/g, ' ').trim();
      if (norm(next.song) === norm(currentTrack.song) && norm(next.artist) === norm(currentTrack.artist)) {
        return;
      }
    }

    prefetchedForKey = key;

    const cached = await readCache(key);
    if (cached) return; // URL already resolved and cached

    ensureAppleCached(next, key); // fire-and-forget — shares dedupe with the live path, survives track changes
  }

  function poll() {
    syncMainCanvasToRoute();
    const track = getCurrentTrack();
    if (track) handleTrackChange(track);
    if (isMainPlayerPageActive() &&
        (currentVideoUrl || currentImageUrl || currentSpotifyCanvasUrl) &&
        !document.querySelector(`.${MAIN_PLAYER_CLASS}`)) {
      if (currentSpotifyCanvasUrl) injectSpotifyCanvas(currentSpotifyCanvasUrl);
      else if (appleCanvasEnabled) injectAppleArtwork({ videoUrl: currentVideoUrl, imageUrl: currentImageUrl });
    }
    if (track && lastfmSettings.lastfmEnabled) {
      sendLastfmNowPlaying(track);
      maybeScrobble(track);
    }
    prefetchNextTrack();
  }

  let titleObserver = null;
  let playerBarTextObserver = null;
  let pollScheduled = false;

  // Coalesces bursts of DOM mutations (document.title firing, then the
  // player-bar's title/byline text catching up moments later, plus anything
  // else — a live playback-time text node, for instance) into at most one
  // poll() per animation frame, so being notified several times in quick
  // succession doesn't mean running poll() several times in quick succession.
  function schedulePoll() {
    if (pollScheduled) return;
    pollScheduled = true;
    requestAnimationFrame(() => {
      pollScheduled = false;
      poll();
    });
  }

  function startPolling() {
    clearInterval(pollTimer);
    // The safety-net poll now only needs to run often enough to catch things a mutation
    // observer might miss and to drive lastfm scrobble-progress checks — the actual
    // track-change reaction is event-driven below, so this can be much slower than before.
    pollTimer = setInterval(poll, POLL_INTERVAL);

    // YouTube Music updates document.title the moment a new track starts, before most
    // of the player-bar DOM has finished updating. Reacting to that immediately (instead
    // of waiting up to POLL_INTERVAL ms for the next tick) is what actually removes the
    // perceived delay before canvas fetching kicks in — but it also means the very first
    // poll() this triggers can still read the *previous* track's text off the player-bar
    // (title/byline haven't re-rendered yet), so handleTrackChange() sees an unchanged key
    // and does nothing. Without anything else watching those specific elements, the old
    // artwork was then left showing until the slow POLL_INTERVAL safety-net tick finally
    // caught the real change — several seconds of stale Canvas after a skip.
    //
    // Fixed by also observing the player-bar's title/byline text directly: that fires the
    // instant the DOM getCurrentTrack() actually reads from has caught up, closing the gap
    // to effectively zero instead of up to POLL_INTERVAL.
    if (!titleObserver) {
      const titleEl = document.querySelector('title');
      if (titleEl) {
        titleObserver = new MutationObserver(schedulePoll);
        titleObserver.observe(titleEl, { childList: true });
      }
    }
    if (!playerBarTextObserver) {
      const bar = document.querySelector('ytmusic-player-bar');
      if (bar) {
        playerBarTextObserver = new MutationObserver(schedulePoll);
        playerBarTextObserver.observe(bar, { characterData: true, childList: true, subtree: true });
      }
    }
    poll();
  }

  function watchBgEl() {
    const obs = new MutationObserver(() => {
      if (!document.getElementById(BG_ID)) {
        const inner = ensureBgEl();
        if (inner && (currentVideoUrl || currentImageUrl)) {
          setBackgroundVar(currentImageUrl);
        }
      }
    });
    obs.observe(document.documentElement, { childList: true, subtree: false });
  }

  function installRouteWatcher() {
    const rerun = () => {
      syncMainCanvasToRoute();
      setTimeout(() => poll(), 0);
    };

    window.addEventListener('popstate', rerun, { passive: true });
    window.addEventListener('hashchange', rerun, { passive: true });

    // YouTube Music is a SPA and commonly changes routes through history.pushState/replaceState.
    const originalPushState = history.pushState;
    const originalReplaceState = history.replaceState;
    if (!history.__viviCanvasRoutePatched) {
      history.__viviCanvasRoutePatched = true;
      history.pushState = function(...args) {
        const result = originalPushState.apply(this, args);
        rerun();
        return result;
      };
      history.replaceState = function(...args) {
        const result = originalReplaceState.apply(this, args);
        rerun();
        return result;
      };
    }

    // Route changes can occur through internal Polymer state without a history event.
    setInterval(() => syncMainCanvasToRoute(), 350);
  }

  // Minimizing the full player (clicking the collapse chevron) doesn't change
  // the route or fire pushState/popstate — YT Music keeps you on /watch and
  // just flips player-page-open / player-page-ui-state / player-ui-state on
  // elements that are already mounted (see isMainPlayerPageActive() above).
  // Without reacting to that directly, syncMainCanvasToRoute() only ran on
  // the next 350ms safety-net tick, so the Kawarp fluid background (which
  // lives in the single global #vivi-bg-layer behind Home/Explore/etc, not
  // scoped to the player DOM) stayed visible/fading-out for a beat while the
  // person was already looking at Home with the mini-player bar. Observing
  // the exact attributes that flip on minimize lets us hide it immediately.
  let playerStateObserver = null;
  let playerStateCheckScheduled = false;

  // YouTube Music sizes the full-player artwork in JS and then only recomputes
  // it when the window resizes. Opening the player page (or the player bar
  // appearing for the first time) changes the available height *after* that
  // measurement has already run, which left the artwork a few pixels too tall —
  // visibly flush against the progress bar — until the page was reloaded.
  // Poking YT Music's own resize handler makes it re-measure right away. This is
  // a no-op when the geometry is already correct, so it's safe to fire often.
  let relayoutTimers = [];
  function nudgeNativePlayerRelayout() {
    relayoutTimers.forEach(clearTimeout);
    relayoutTimers = [0, 120, 400].map((delay) => setTimeout(() => {
      try {
        requestAnimationFrame(() => window.dispatchEvent(new Event('resize')));
      } catch { /* no-op */ }
    }, delay));
  }

  function schedulePlayerStateCheck() {
    if (playerStateCheckScheduled) return;
    playerStateCheckScheduled = true;
    requestAnimationFrame(() => {
      playerStateCheckScheduled = false;
      syncMainCanvasToRoute();
      nudgeNativePlayerRelayout();
    });
  }

  function bindPlayerStateObserver() {
    if (playerStateObserver) return;
    playerStateObserver = new MutationObserver(schedulePlayerStateCheck);
    playerStateObserver.observe(document.body, {
      attributes: true,
      subtree: true,
      attributeFilter: ['player-page-open', 'player-page-ui-state', 'player-ui-state'],
    });
    schedulePlayerStateCheck();
  }

  installRouteWatcher();
  bindPlayerStateObserver();
  primeMemCacheFromStorage();

  chrome.storage.local.get(LASTFM_DEFAULTS, (stored) => {
    lastfmSettings = { ...LASTFM_DEFAULTS, ...stored };
  });

  chrome.storage.local.get({
    enabled: true, themeEnabled: true, imageOnlyMode: false, spotifyCanvasEnabled: true, canvasPriority: 'apple', sponsorBlockEnabled: true,
    kawarpEnabled: true, kawarpPauseWhenInactive: true, eqEnabled: true,
    kawarpWarpIntensity: 1.0, kawarpBlurPasses: 5, kawarpAnimationSpeed: 4.15,
    kawarpTransitionDuration: 0, kawarpSaturation: 2.6, kawarpDithering: 0.034, kawarpOpacity: 1.0,
  }, ({
    enabled, themeEnabled, imageOnlyMode: imgOnly, spotifyCanvasEnabled: spCanvas, canvasPriority: canvasPrio, sponsorBlockEnabled: sbEnabled,
    kawarpEnabled: kwEnabled, kawarpPauseWhenInactive: kwPause, eqEnabled: eqEnabled_,
    kawarpWarpIntensity, kawarpBlurPasses, kawarpAnimationSpeed, kawarpTransitionDuration, kawarpSaturation, kawarpDithering, kawarpOpacity,
  }) => {
    bindCanvasTrackTransitionGuard();
    appleCanvasEnabled = enabled !== false;
    spotifyCanvasEnabled = spCanvas !== false;
    canvasPriority = canvasPrio === 'apple' ? 'apple' : 'spotify';
    sponsorBlockEnabled = sbEnabled !== false;
    themeUserEnabled = themeEnabled;
    imageOnlyMode = imgOnly;
    applyTheme(themeEnabled);
    window.__viviKawarp?.setOptions({
      warpIntensity: kawarpWarpIntensity,
      blurPasses: kawarpBlurPasses,
      animationSpeed: kawarpAnimationSpeed,
      transitionDuration: kawarpTransitionDuration,
      saturation: kawarpSaturation,
      dithering: kawarpDithering,
      opacity: kawarpOpacity,
    });
    window.__viviKawarp?.setPauseWhenInactive(kwPause !== false);
    kawarpUserEnabled = kwEnabled !== false;
    eqUserEnabled = eqEnabled_ !== false;
    updateKawarpVisibility();
    // Pre-create the background element immediately
    if (themeEnabled) ensureBgEl();
    watchBgEl();
    // The polling loop drives lyrics/last.fm/track-change detection as well as both
    // artwork sources, so it always starts — the two canvas toggles only gate which
    // artwork source(s) handleTrackChange is allowed to use, not the loop itself.
    if (document.querySelector('ytmusic-player-bar')) {
      startPolling();
    } else {
      const obs = new MutationObserver(() => {
        if (document.querySelector('ytmusic-player-bar')) { obs.disconnect(); startPolling(); }
      });
      obs.observe(document.documentElement, { childList: true, subtree: true });
    }
  });

  // ── Quick cache-status overlay (Alt+C) ─────────────────────────────────
  // A fast on-page shortcut so you don't have to open the popup just to
  // check "is this song's artwork cached?" — shows the current track's
  // cache state plus every other cached track, all pulled straight from
  // storage/memCache so it's cheap to open repeatedly.
  let cacheStatusOverlayEl = null;

  function injectCacheStatusStyles() {
    if (document.getElementById('vivi-cache-status-style')) return;
    const style = document.createElement('style');
    style.id = 'vivi-cache-status-style';
    style.textContent = `
      #vivi-cache-status-overlay {
        position: fixed; top: 16px; right: 16px; z-index: 2147483647;
        width: 300px; max-height: 70vh;
        background: rgba(10,10,13,0.96);
        backdrop-filter: blur(10px);
        border: 1px solid rgba(255,255,255,0.1);
        border-radius: 12px;
        box-shadow: 0 12px 40px rgba(0,0,0,0.55);
        color: #f2f2f5;
        font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Arial, sans-serif;
        display: flex; flex-direction: column;
        overflow: hidden;
      }
      #vivi-cache-status-overlay .vcs-header {
        padding: 12px 14px; font-size: 12.5px; font-weight: 700;
        border-bottom: 1px solid rgba(255,255,255,0.08);
        display: flex; align-items: center; justify-content: space-between;
      }
      #vivi-cache-status-overlay .vcs-header span.vcs-hint {
        font-weight: 500; font-size: 10.5px; color: rgba(255,255,255,0.45);
      }
      #vivi-cache-status-overlay .vcs-current {
        padding: 10px 14px; border-bottom: 1px solid rgba(255,255,255,0.08);
        display: flex; align-items: center; gap: 8px;
      }
      #vivi-cache-status-overlay .vcs-dot {
        width: 8px; height: 8px; border-radius: 50%; flex: none;
        background: #ef4444;
      }
      #vivi-cache-status-overlay .vcs-dot.cached { background: #10b981; }
      #vivi-cache-status-overlay .vcs-current-text { min-width: 0; }
      #vivi-cache-status-overlay .vcs-current-title {
        font-size: 12px; font-weight: 600; white-space: nowrap;
        overflow: hidden; text-overflow: ellipsis;
      }
      #vivi-cache-status-overlay .vcs-current-sub {
        font-size: 10.5px; color: rgba(255,255,255,0.5); margin-top: 1px;
      }
      #vivi-cache-status-overlay .vcs-list {
        overflow-y: auto; padding: 6px;
      }
      #vivi-cache-status-overlay .vcs-item {
        display: flex; align-items: center; gap: 8px;
        padding: 6px 8px; border-radius: 8px; font-size: 11.5px;
      }
      #vivi-cache-status-overlay .vcs-item:hover { background: rgba(255,255,255,0.06); }
      #vivi-cache-status-overlay .vcs-item-text {
        flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
      }
      #vivi-cache-status-overlay .vcs-item-artist { color: rgba(255,255,255,0.45); }
      #vivi-cache-status-overlay .vcs-badge {
        flex: none; font-size: 9px; font-weight: 700; letter-spacing: 0.03em;
        padding: 2px 6px; border-radius: 5px;
      }
      #vivi-cache-status-overlay .vcs-badge.canvas { background: rgba(91,108,245,0.18); color: #8b93f8; }
      #vivi-cache-status-overlay .vcs-badge.art { background: rgba(255,255,255,0.1); color: rgba(255,255,255,0.6); }
      #vivi-cache-status-overlay .vcs-badge.none { background: rgba(255,255,255,0.06); color: rgba(255,255,255,0.35); }
      #vivi-cache-status-overlay .vcs-dot.no-canvas { background: rgba(255,255,255,0.35); }
      #vivi-cache-status-overlay .vcs-empty {
        padding: 16px; text-align: center; font-size: 11.5px; color: rgba(255,255,255,0.4);
      }
    `;
    document.head.appendChild(style);
  }

  function trackKeyFor(track) {
    return track ? `${track.artist}—${track.song}` : null;
  }

  function getAllCacheEntriesSorted() {
    return new Promise((resolve) => {
      chrome.storage.local.get(null, (all) => {
        const entries = Object.entries(all || {})
          .filter(([k]) => k.startsWith(CACHE_PREFIX))
          .map(([, v]) => v)
          .filter(Boolean)
          .sort((a, b) => (b.cachedAt || 0) - (a.cachedAt || 0));
        resolve(entries);
      });
    });
  }

  function closeCacheStatusOverlay() {
    if (cacheStatusOverlayEl) {
      cacheStatusOverlayEl.remove();
      cacheStatusOverlayEl = null;
    }
    document.removeEventListener('keydown', onCacheStatusOverlayKeydown, true);
  }

  function onCacheStatusOverlayKeydown(e) {
    if (e.key === 'Escape') closeCacheStatusOverlay();
  }

  async function openCacheStatusOverlay() {
    injectCacheStatusStyles();

    const track = getCurrentTrack();
    const key = trackKeyFor(track);
    const currentEntry = key ? memCache[key] : null;
    // Three real states, not two: we may not have looked this track up yet
    // ("Not cached"), we looked it up and it has art/video ("Cached"), or we
    // looked it up and the API confirmed there's nothing for this song
    // ("No canvas") — that last one is a settled answer, not a pending one,
    // so it shouldn't be shown the same way as "not cached yet".
    const isCached = !!(currentEntry && (currentEntry.videoUrl || currentEntry.imageUrl));
    const isNoCanvas = !!(currentEntry && currentEntry.notFound);
    const entries = await getAllCacheEntriesSorted();

    const overlay = document.createElement('div');
    overlay.id = 'vivi-cache-status-overlay';

    const header = document.createElement('div');
    header.className = 'vcs-header';
    header.innerHTML = `<span>Cache status (${entries.length})</span><span class="vcs-hint">Alt+C / Esc to close</span>`;
    overlay.appendChild(header);

    const current = document.createElement('div');
    current.className = 'vcs-current';
    const dot = document.createElement('span');
    dot.className = 'vcs-dot' + (isCached ? ' cached' : '') + (isNoCanvas ? ' no-canvas' : '');
    const currentText = document.createElement('div');
    currentText.className = 'vcs-current-text';
    if (track) {
      const statusLabel = isCached ? 'Cached' : (isNoCanvas ? 'No canvas' : 'Not cached');
      currentText.innerHTML = `
        <div class="vcs-current-title">${escapeHtml(track.song)}</div>
        <div class="vcs-current-sub">${escapeHtml(track.artist)} — ${statusLabel}</div>
      `;
    } else {
      currentText.innerHTML = `<div class="vcs-current-title">No track playing</div>`;
    }
    current.appendChild(dot);
    current.appendChild(currentText);
    overlay.appendChild(current);

    const list = document.createElement('div');
    list.className = 'vcs-list';
    if (entries.length === 0) {
      list.innerHTML = '<div class="vcs-empty">No artwork cached yet</div>';
    } else {
      entries.slice(0, 200).forEach((entry) => {
        const item = document.createElement('div');
        item.className = 'vcs-item';
        const isCurrent = key && trackKeyFor({ song: entry.song, artist: entry.artist }) === key;
        const badgeClass = entry.videoUrl ? 'canvas' : (entry.imageUrl ? 'art' : 'none');
        const badgeLabel = entry.videoUrl ? 'CANVAS' : (entry.imageUrl ? 'ART' : 'NO CANVAS');
        item.innerHTML = `
          <span class="vcs-item-text">${escapeHtml(entry.song || '—')} <span class="vcs-item-artist">— ${escapeHtml(entry.artist || '—')}</span></span>
          <span class="vcs-badge ${badgeClass}">${badgeLabel}</span>
        `;
        if (isCurrent) item.style.background = 'rgba(16,185,129,0.1)';
        list.appendChild(item);
      });
    }
    overlay.appendChild(list);

    document.body.appendChild(overlay);
    cacheStatusOverlayEl = overlay;
    document.addEventListener('keydown', onCacheStatusOverlayKeydown, true);
  }

  function escapeHtml(str) {
    return String(str ?? '').replace(/[&<>"']/g, (c) => ({
      '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
    }[c]));
  }

  document.addEventListener('keydown', (e) => {
    // Alt+C — ignore while typing in an input/textarea/contenteditable so
    // it doesn't fire while the user is, say, editing the search box.
    if (!e.altKey || e.ctrlKey || e.metaKey || e.shiftKey) return;
    if (e.key !== 'c' && e.key !== 'C') return;
    const tag = document.activeElement?.tagName;
    if (tag === 'INPUT' || tag === 'TEXTAREA' || document.activeElement?.isContentEditable) return;

    e.preventDefault();
    if (cacheStatusOverlayEl) {
      closeCacheStatusOverlay();
    } else {
      openCacheStatusOverlay();
    }
  }, true);

  chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
    if (msg.type === 'VIVI_PING') {
      const track = getCurrentTrack();
      const key = track ? `${track.artist}—${track.song}` : null;
      const entry = key ? memCache[key] : null;
      sendResponse({
        track,
        cached: !!(entry && (entry.videoUrl || entry.imageUrl)),
        noCanvas: !!(entry && entry.notFound),
      });
      return true;
    }
    if (msg.type === 'VIVI_GET_CACHE_LIST') {
      // Entries are just a couple of URL strings each now, so the whole
      // list is cheap to send across the message boundary as-is.
      chrome.storage.local.get(null, (all) => {
        const entries = Object.entries(all)
          .filter(([k]) => k.startsWith(CACHE_PREFIX))
          .map(([, v]) => v);
        sendResponse({ entries });
      });
      return true;
    }
    if (msg.type === 'VIVI_CLEAR_CACHE') {
      clearArtworkCache().then(() => sendResponse({ ok: true }));
      return true;
    }
    if (msg.type === 'VIVI_EXPORT_CACHE') {
      // Keyed by trackKey (not an array) so a re-import can write entries
      // straight back under their original storage keys — same shape
      // Better Lyrics Shaders exports (getCacheEntries: { [cacheKey]: entry }).
      chrome.storage.local.get(null, (all) => {
        const entries = {};
        for (const [k, v] of Object.entries(all)) {
          if (k.startsWith(CACHE_PREFIX)) entries[k.slice(CACHE_PREFIX.length)] = v;
        }
        sendResponse({ entries });
      });
      return true;
    }
    if (msg.type === 'VIVI_IMPORT_CACHE') {
      const incoming = msg.entries && typeof msg.entries === 'object' ? msg.entries : {};
      const toStore = {};
      for (const [trackKey, entry] of Object.entries(incoming)) {
        if (!entry || (!entry.videoUrl && !entry.imageUrl)) continue; // skip malformed/empty rows
        toStore[cacheKeyFor(trackKey)] = entry;
      }
      const keys = Object.keys(toStore);
      if (keys.length === 0) { sendResponse({ imported: 0 }); return true; }
      chrome.storage.local.set(toStore, () => {
        if (chrome.runtime.lastError) { sendResponse({ imported: 0, error: chrome.runtime.lastError.message }); return; }
        for (const [k, v] of Object.entries(toStore)) memCache[k.slice(CACHE_PREFIX.length)] = v;
        chrome.runtime.sendMessage({ type: 'VIVI_CACHE_UPDATED' }).catch(() => {});
        sendResponse({ imported: keys.length });
      });
      return true;
    }
    if (msg.type === 'VIVI_SETTINGS') {
      // Both artwork-source toggles funnel through the same re-check: clear
      // whatever's showing, forget the current track so handleTrackChange treats
      // it as new, and immediately re-run it against the fresh flag values —
      // rather than waiting up to POLL_INTERVAL for the next safety-net tick.
      let reCheckCanvas = false;
      if ('enabled' in msg) {
        appleCanvasEnabled = msg.enabled !== false;
        reCheckCanvas = true;
      }
      if ('themeEnabled' in msg) {
        themeUserEnabled = msg.themeEnabled;
        applyTheme(msg.themeEnabled);
      }
      if ('spotifyCanvasEnabled' in msg) {
        spotifyCanvasEnabled = msg.spotifyCanvasEnabled !== false;
        reCheckCanvas = true;
      }
      if ('canvasPriority' in msg) {
        canvasPriority = msg.canvasPriority === 'apple' ? 'apple' : 'spotify';
        reCheckCanvas = true;
      }
      if (reCheckCanvas) {
        const track = getCurrentTrack();
        fadeOutCurrentOverlay();
        ensureNativeArtworkVisible();
        currentTrackKey = null;
        spotifyCanvasRequestKey = null;
        currentSpotifyCanvasUrl = null;
        if (track) handleTrackChange(track);
        if (!pollTimer) startPolling();
      }
      if ('sponsorBlockEnabled' in msg) {
        sponsorBlockEnabled = msg.sponsorBlockEnabled !== false;
        const track = getCurrentTrack();
        if (track) loadSponsorSegmentsForTrack(track).catch((e) => warn('SponsorBlock: track load failed', e?.message));
      }
      if ('imageOnlyMode' in msg) {
        imageOnlyMode = msg.imageOnlyMode;
        // Re-render whatever's currently showing so the change is visible immediately
        // instead of waiting for the next track change.
        if (currentVideoUrl || currentImageUrl) {
          swapOverlayMedia({ videoUrl: currentVideoUrl, imageUrl: currentImageUrl });
        }
      }
      if ('kawarpEnabled' in msg) {
        kawarpUserEnabled = msg.kawarpEnabled !== false;
        updateKawarpVisibility();
      }
      if ('eqEnabled' in msg) {
        eqUserEnabled = msg.eqEnabled !== false;
        updateKawarpVisibility();
      }
      if ('kawarpPauseWhenInactive' in msg) {
        window.__viviKawarp?.setPauseWhenInactive(msg.kawarpPauseWhenInactive !== false);
      }
      {
        const kawarpOptMap = {
          kawarpWarpIntensity: 'warpIntensity',
          kawarpBlurPasses: 'blurPasses',
          kawarpAnimationSpeed: 'animationSpeed',
          kawarpTransitionDuration: 'transitionDuration',
          kawarpSaturation: 'saturation',
          kawarpDithering: 'dithering',
          kawarpOpacity: 'opacity',
        };
        const liveOpts = {};
        let hasLiveOpts = false;
        Object.keys(kawarpOptMap).forEach((k) => {
          if (k in msg) {
            liveOpts[kawarpOptMap[k]] = msg[k];
            hasLiveOpts = true;
          }
        });
        if (hasLiveOpts) window.__viviKawarp?.setOptions(liveOpts);
      }
      Object.keys(LASTFM_DEFAULTS).forEach((k) => {
        if (k in msg) lastfmSettings[k] = msg[k];
      });
      if (Object.keys(LASTFM_DEFAULTS).some((k) => k in msg)) {
        const track = getCurrentTrack();
        if (track) watchLikeButton(track);
      }
    }
  });
})();
