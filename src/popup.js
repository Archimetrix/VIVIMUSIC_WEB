/* VIVIMUSIC WEB — popup.js */
(() => {

  const enableToggle = document.getElementById('enableToggle');
  const imageOnlyToggle = document.getElementById('imageOnlyToggle');
  const kawarpToggle = document.getElementById('kawarpToggle');
  const eqToggle = document.getElementById('eqToggle');
  const kwOpacity = document.getElementById('kwOpacity');
  const kwWarpIntensity = document.getElementById('kwWarpIntensity');
  const kwBlurPasses = document.getElementById('kwBlurPasses');
  const kwSaturation = document.getElementById('kwSaturation');
  const kwDithering = document.getElementById('kwDithering');
  const kwAnimationSpeed = document.getElementById('kwAnimationSpeed');
  const kwTransitionDuration = document.getElementById('kwTransitionDuration');
  const kwPauseWhenInactive = document.getElementById('kwPauseWhenInactive');
  const themeToggle  = document.getElementById('themeToggle');
  const lyricsToggle = document.getElementById('lyricsToggle');
  const autoSwitchToggle = document.getElementById('autoSwitchToggle');
  const videoLyricsToggle = document.getElementById('videoLyricsToggle');
  const dancerNotFoundToggle = document.getElementById('dancerNotFoundToggle');
  const lyricsAlignSelect = document.getElementById('lyricsAlignSelect');
  const lyricsAnimSelect = document.getElementById('lyricsAnimSelect');
  const sponsorBlockToggle = document.getElementById('sponsorBlockToggle');
  const statusDot    = document.getElementById('statusDot');
  const statusText   = document.getElementById('statusText');
  const nowPlaying   = document.getElementById('nowPlaying');
  const npTitle      = document.getElementById('npTitle');
  const npArtist     = document.getElementById('npArtist');
  const npBadge      = document.getElementById('npBadge');
  const cacheList    = document.getElementById('cacheList');
  const cacheCount   = document.getElementById('cacheCount');
  const clearBtn     = document.getElementById('clearBtn');
  const providersToggle = document.getElementById('providersToggle');
  const providerList = document.getElementById('providerList');
  const priorityEnabledToggle = document.getElementById('priorityEnabledToggle');
  const priorityList = document.getElementById('priorityList');
  const priorityWaitToggle = document.getElementById('priorityWaitToggle');
  const PRIORITY_SLOT_COUNT = 3;
  const prioritySelects = [];
  for (let i = 0; i < PRIORITY_SLOT_COUNT; i++) {
    prioritySelects.push(document.getElementById('priority-' + i));
  }

  const DEFAULT_PROVIDERS = {
    betterlyricsTTML: true,
    betterlyricsKugou: true,
    betterlyricsLegacy: true,
    lrclib: true,
    musixmatch: true,
    unison: true,
    binilyrics: true,
    spotify: true,
  };
  const PROVIDER_KEYS = Object.keys(DEFAULT_PROVIDERS);

  // Provider display names for the priority dropdowns — deliberately
  // excludes Spotify, which is never raced (it's a sequential fallback
  // tried only when nothing else has anything, same with priority on or off).
  const PRIORITY_PROVIDER_LABELS = {
    betterlyricsTTML: 'BetterLyrics (word-sync)',
    betterlyricsKugou: 'BetterLyrics (Kugou)',
    betterlyricsLegacy: 'BetterLyrics (Legacy)',
    lrclib: 'LRCLIB',
    musixmatch: 'Musixmatch',
    unison: 'Unison',
    binilyrics: 'BiniLyrics',
  };
  const PRIORITY_KEYS = Object.keys(PRIORITY_PROVIDER_LABELS);

  
  const KAWARP_DEFAULTS = {
    kawarpPauseWhenInactive: true,
    kawarpOpacity: 1.0,
    kawarpWarpIntensity: 1.0,
    kawarpBlurPasses: 5,
    kawarpSaturation: 2.6,
    kawarpDithering: 0.034,
    kawarpAnimationSpeed: 4.15,
    kawarpTransitionDuration: 0,
  };

  chrome.storage.local.get(
    { enabled: true, themeEnabled: true, imageOnlyMode: false, kawarpEnabled: true, eqEnabled: true, lyricsEnabled: true, autoSwitchLyrics: true, sponsorBlockEnabled: true, lyricsShowForVideos: true, dancerOnNotFound: true, lyricsAlign: 'left', lyricsAnimationStyle: 'fill', lyricsProviders: DEFAULT_PROVIDERS, ...KAWARP_DEFAULTS },
    ({ enabled, themeEnabled, imageOnlyMode, kawarpEnabled, eqEnabled, lyricsEnabled, autoSwitchLyrics, sponsorBlockEnabled, lyricsShowForVideos, dancerOnNotFound, lyricsAlign, lyricsAnimationStyle, lyricsProviders,
       kawarpPauseWhenInactive, kawarpOpacity, kawarpWarpIntensity, kawarpBlurPasses, kawarpSaturation, kawarpDithering, kawarpAnimationSpeed, kawarpTransitionDuration }) => {
      enableToggle.checked = enabled;
      imageOnlyToggle.checked = imageOnlyMode;
      kawarpToggle.checked = kawarpEnabled;
      eqToggle.checked = eqEnabled;
      themeToggle.checked  = themeEnabled;
      lyricsToggle.checked = lyricsEnabled;
      autoSwitchToggle.checked = autoSwitchLyrics;
      sponsorBlockToggle.checked = sponsorBlockEnabled;
      videoLyricsToggle.checked = lyricsShowForVideos;
      dancerNotFoundToggle.checked = dancerOnNotFound;
      lyricsAlignSelect.value = lyricsAlign;
      lyricsAnimSelect.value = lyricsAnimationStyle;
      const merged = { ...DEFAULT_PROVIDERS, ...lyricsProviders };
      PROVIDER_KEYS.forEach((k) => {
        const el = document.getElementById('prov-' + k);
        if (el) el.checked = merged[k];
      });

      kwPauseWhenInactive.checked = kawarpPauseWhenInactive !== false;
      kwOpacity.value = kawarpOpacity;
      kwWarpIntensity.value = kawarpWarpIntensity;
      kwBlurPasses.value = kawarpBlurPasses;
      kwSaturation.value = kawarpSaturation;
      kwDithering.value = kawarpDithering;
      kwAnimationSpeed.value = kawarpAnimationSpeed;
      kwTransitionDuration.value = kawarpTransitionDuration;
      updateKawarpLabels();
    }
  );

  
  providersToggle.addEventListener('click', () => {
    providersToggle.classList.toggle('open');
    providerList.classList.toggle('open');
  });

  
  PROVIDER_KEYS.forEach((k) => {
    const el = document.getElementById('prov-' + k);
    if (!el) return;
    el.addEventListener('change', () => {
      chrome.storage.local.get({ lyricsProviders: DEFAULT_PROVIDERS }, ({ lyricsProviders }) => {
        const merged = { ...DEFAULT_PROVIDERS, ...lyricsProviders, [k]: el.checked };
        chrome.storage.local.set({ lyricsProviders: merged });
        relay({ lyricsProviders: merged });
      });
    });
  });

  function populatePrioritySelects(order) {
    prioritySelects.forEach((sel, i) => {
      const current = order[i] || '';
      const usedElsewhere = order.filter((v, j) => j !== i && v);
      sel.innerHTML = '';
      const noneOpt = document.createElement('option');
      noneOpt.value = '';
      noneOpt.textContent = '— None —';
      sel.appendChild(noneOpt);
      PRIORITY_KEYS.forEach((k) => {
        if (usedElsewhere.includes(k) && k !== current) return;
        const opt = document.createElement('option');
        opt.value = k;
        opt.textContent = PRIORITY_PROVIDER_LABELS[k];
        sel.appendChild(opt);
      });
      sel.value = current;
    });
  }

  function currentPriorityOrder() {
    return prioritySelects.map((sel) => sel.value).filter(Boolean);
  }

  prioritySelects.forEach((sel) => {
    sel.addEventListener('change', () => {
      const order = currentPriorityOrder();
      populatePrioritySelects(prioritySelects.map((s) => s.value));
      chrome.storage.local.set({ lyricsPriorityOrder: order });
      relay({ lyricsPriorityOrder: order });
    });
  });

  priorityEnabledToggle.addEventListener('change', () => {
    const lyricsPriorityEnabled = priorityEnabledToggle.checked;
    priorityList.classList.toggle('open', lyricsPriorityEnabled);
    chrome.storage.local.set({ lyricsPriorityEnabled });
    relay({ lyricsPriorityEnabled });
  });

  priorityWaitToggle.addEventListener('change', () => {
    const lyricsPriorityWaitEnabled = priorityWaitToggle.checked;
    chrome.storage.local.set({ lyricsPriorityWaitEnabled });
    relay({ lyricsPriorityWaitEnabled });
  });

  chrome.storage.local.get(
    { lyricsPriorityEnabled: false, lyricsPriorityOrder: [], lyricsPriorityWaitEnabled: true },
    ({ lyricsPriorityEnabled, lyricsPriorityOrder, lyricsPriorityWaitEnabled }) => {
      priorityEnabledToggle.checked = lyricsPriorityEnabled;
      priorityList.classList.toggle('open', lyricsPriorityEnabled);
      priorityWaitToggle.checked = lyricsPriorityWaitEnabled !== false;
      populatePrioritySelects((lyricsPriorityOrder || []).slice(0, PRIORITY_SLOT_COUNT));
    }
  );

  
  function relay(patch) {
    chrome.tabs.query({ active: true, currentWindow: true }, ([tab]) => {
      if (tab?.url?.includes('music.youtube.com')) {
        chrome.tabs.sendMessage(tab.id, { type: 'VIVI_SETTINGS', ...patch }).catch(() => {});
      }
    });
  }

  enableToggle.addEventListener('change', () => {
    const enabled = enableToggle.checked;
    chrome.storage.local.set({ enabled });
    relay({ enabled });
  });

  imageOnlyToggle.addEventListener('change', () => {
    const imageOnlyMode = imageOnlyToggle.checked;
    chrome.storage.local.set({ imageOnlyMode });
    relay({ imageOnlyMode });
  });

  kawarpToggle.addEventListener('change', () => {
    const kawarpEnabled = kawarpToggle.checked;
    chrome.storage.local.set({ kawarpEnabled });
    relay({ kawarpEnabled });
  });

  eqToggle.addEventListener('change', () => {
    const eqEnabled = eqToggle.checked;
    chrome.storage.local.set({ eqEnabled });
    relay({ eqEnabled });
  });

  function updateKawarpLabels() {
    document.getElementById('kwOpacityVal').textContent = parseFloat(kwOpacity.value).toFixed(2);
    document.getElementById('kwWarpIntensityVal').textContent = parseFloat(kwWarpIntensity.value).toFixed(2);
    document.getElementById('kwBlurPassesVal').textContent = kwBlurPasses.value;
    document.getElementById('kwSaturationVal').textContent = parseFloat(kwSaturation.value).toFixed(2);
    document.getElementById('kwDitheringVal').textContent = parseFloat(kwDithering.value).toFixed(3);
    document.getElementById('kwAnimationSpeedVal').textContent = parseFloat(kwAnimationSpeed.value).toFixed(2);
    document.getElementById('kwTransitionDurationVal').textContent = `${kwTransitionDuration.value}ms`;
  }

  // Live-updating sliders: patch storage + relay to the page as the user drags,
  // so the effect on YouTube Music updates in real time.
  const kawarpSliderMap = [
    [kwOpacity, 'kawarpOpacity', parseFloat],
    [kwWarpIntensity, 'kawarpWarpIntensity', parseFloat],
    [kwBlurPasses, 'kawarpBlurPasses', (v) => parseInt(v, 10)],
    [kwSaturation, 'kawarpSaturation', parseFloat],
    [kwDithering, 'kawarpDithering', parseFloat],
    [kwAnimationSpeed, 'kawarpAnimationSpeed', parseFloat],
    [kwTransitionDuration, 'kawarpTransitionDuration', (v) => parseInt(v, 10)],
  ];
  kawarpSliderMap.forEach(([el, key, parse]) => {
    el.addEventListener('input', () => {
      updateKawarpLabels();
      const value = parse(el.value);
      chrome.storage.local.set({ [key]: value });
      relay({ [key]: value });
    });
  });

  kwPauseWhenInactive.addEventListener('change', () => {
    const kawarpPauseWhenInactive = kwPauseWhenInactive.checked;
    chrome.storage.local.set({ kawarpPauseWhenInactive });
    relay({ kawarpPauseWhenInactive });
  });

  const kwResetDefaults = document.getElementById('kwResetDefaults');
  kwResetDefaults?.addEventListener('click', () => {
    kwPauseWhenInactive.checked = KAWARP_DEFAULTS.kawarpPauseWhenInactive;
    kwOpacity.value = KAWARP_DEFAULTS.kawarpOpacity;
    kwWarpIntensity.value = KAWARP_DEFAULTS.kawarpWarpIntensity;
    kwBlurPasses.value = KAWARP_DEFAULTS.kawarpBlurPasses;
    kwSaturation.value = KAWARP_DEFAULTS.kawarpSaturation;
    kwDithering.value = KAWARP_DEFAULTS.kawarpDithering;
    kwAnimationSpeed.value = KAWARP_DEFAULTS.kawarpAnimationSpeed;
    kwTransitionDuration.value = KAWARP_DEFAULTS.kawarpTransitionDuration;
    updateKawarpLabels();
    chrome.storage.local.set(KAWARP_DEFAULTS);
    relay(KAWARP_DEFAULTS);
  });

  themeToggle.addEventListener('change', () => {
    const themeEnabled = themeToggle.checked;
    chrome.storage.local.set({ themeEnabled });
    relay({ themeEnabled });
  });

  lyricsToggle.addEventListener('change', () => {
    const lyricsEnabled = lyricsToggle.checked;
    chrome.storage.local.set({ lyricsEnabled });
    relay({ lyricsEnabled });
  });

  autoSwitchToggle.addEventListener('change', () => {
    const autoSwitchLyrics = autoSwitchToggle.checked;
    chrome.storage.local.set({ autoSwitchLyrics });
    relay({ autoSwitchLyrics });
  });

  sponsorBlockToggle.addEventListener('change', () => {
    const sponsorBlockEnabled = sponsorBlockToggle.checked;
    chrome.storage.local.set({ sponsorBlockEnabled });
    relay({ sponsorBlockEnabled });
  });

  videoLyricsToggle.addEventListener('change', () => {
    const lyricsShowForVideos = videoLyricsToggle.checked;
    chrome.storage.local.set({ lyricsShowForVideos });
    relay({ lyricsShowForVideos });
  });

  lyricsAlignSelect.addEventListener('change', () => {
    const lyricsAlign = lyricsAlignSelect.value;
    chrome.storage.local.set({ lyricsAlign });
    relay({ lyricsAlign });
  });

  lyricsAnimSelect.addEventListener('change', () => {
    const lyricsAnimationStyle = lyricsAnimSelect.value;
    chrome.storage.local.set({ lyricsAnimationStyle });
    relay({ lyricsAnimationStyle });
  });

  dancerNotFoundToggle.addEventListener('change', () => {
    const dancerOnNotFound = dancerNotFoundToggle.checked;
    chrome.storage.local.set({ dancerOnNotFound });
    relay({ dancerOnNotFound });
  });

  
  chrome.tabs.query({ active: true, currentWindow: true }, ([tab]) => {
    if (!tab?.url?.includes('music.youtube.com')) {
      statusText.textContent = 'Navigate to music.youtube.com';
      return;
    }
    statusDot.classList.add('active');

    chrome.tabs.sendMessage(tab.id, { type: 'VIVI_PING' }, (resp) => {
      if (chrome.runtime.lastError || !resp) {
        statusText.textContent = 'Active — waiting for track';
        return;
      }
      if (resp.track) {
        statusText.textContent = 'Canvas active';
        npTitle.textContent    = resp.track.song;
        npArtist.textContent   = resp.track.artist;
        nowPlaying.classList.add('visible');
        if (resp.cached) npBadge.classList.add('visible');
      } else {
        statusText.textContent = 'Active — play a song to start';
      }
    });
  });

  
  const PALETTE = ['#5b6cf5','#8b5cf6','#ec4899','#f59e0b','#10b981','#3b82f6','#ef4444','#a78bfa'];
  function colorFor(str) {
    let h = 0;
    for (let i = 0; i < str.length; i++) h = (h * 31 + str.charCodeAt(i)) >>> 0;
    return PALETTE[h % PALETTE.length];
  }

  
  function withActiveMusicTab(cb) {
    chrome.tabs.query({ active: true, currentWindow: true }, ([tab]) => {
      if (!tab?.url?.includes('music.youtube.com')) { cb(null); return; }
      cb(tab);
    });
  }

  let allCacheEntries = [];
  let cacheSearchTerm = '';

  function renderCache() {
    withActiveMusicTab((tab) => {
      if (!tab) {
        cacheCount.textContent = '0';
        allCacheEntries = [];
        cacheList.innerHTML = '<div class="empty-cache">Open music.youtube.com to view cache</div>';
        return;
      }
      chrome.tabs.sendMessage(tab.id, { type: 'VIVI_GET_CACHE_LIST' }, (resp) => {
        if (chrome.runtime.lastError || !resp) {
          cacheCount.textContent = '0';
          allCacheEntries = [];
          cacheList.innerHTML = '<div class="empty-cache">No artwork cached yet</div>';
          return;
        }
        allCacheEntries = (resp.entries || [])
          // "notFound" entries remember that a track has no canvas/art so we
          // don't re-fetch it every play, but they're not actual cached
          // artwork — keep them out of this list and its count.
          .filter((e) => e && (e.videoUrl || e.imageUrl))
          .sort((a, b) => (b.cachedAt || 0) - (a.cachedAt || 0));

        cacheCount.textContent = allCacheEntries.length;
        renderCacheList();
      });
    });
  }

  function renderCacheList() {
    const term = cacheSearchTerm.trim().toLowerCase();
    const entries = term
      ? allCacheEntries.filter((e) =>
          (e.song || '').toLowerCase().includes(term) ||
          (e.artist || '').toLowerCase().includes(term))
      : allCacheEntries;

    if (allCacheEntries.length === 0) {
      cacheList.innerHTML = '<div class="empty-cache">No artwork cached yet</div>';
      return;
    }
    if (entries.length === 0) {
      cacheList.innerHTML = `<div class="empty-cache">No matches for "${esc(cacheSearchTerm.trim())}"</div>`;
      return;
    }

    
    const RENDER_CAP = 150;
    const shown = entries.slice(0, RENDER_CAP);

    cacheList.innerHTML = '';
    shown.forEach(entry => {
      const item = document.createElement('div');
      item.className = 'cache-item';

      
      const thumb = document.createElement('div');
      thumb.className = 'cache-thumb';
      const initial = (entry.song || '?').charAt(0).toUpperCase();
      thumb.textContent = initial;
      thumb.style.background = colorFor(entry.song || '');
      thumb.style.color = 'rgba(255,255,255,0.9)';

      const info = document.createElement('div');
      info.className = 'cache-info';
      info.innerHTML = `
        <div class="cache-song">${esc(entry.song || '—')}</div>
        <div class="cache-artist">${esc(entry.artist || '—')}</div>
      `;

      // Once a track's entry exists at all, its artwork URL has already
      // been resolved and cached — there's no separate "downloading the
      // bytes" step anymore, so a track is either CANVAS (video) or ART
      // (image-only) with nothing in between.
      const badge = document.createElement('span');
      const state = entry.videoUrl ? 'canvas' : 'art';
      badge.className = 'cache-badge ' + state;
      badge.textContent = entry.videoUrl ? 'CANVAS' : 'ART';

      const viewBtn = document.createElement('button');
      viewBtn.className = 'cache-view-btn';
      viewBtn.title = 'View cached artwork';
      viewBtn.setAttribute('aria-label', 'View cached artwork');
      viewBtn.innerHTML = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z"/><circle cx="12" cy="12" r="3"/></svg>';
      viewBtn.addEventListener('click', (ev) => {
        ev.stopPropagation();
        openCachePreview(entry);
      });

      item.appendChild(thumb);
      item.appendChild(info);
      item.appendChild(badge);
      item.appendChild(viewBtn);
      item.dataset.trackkey = entry.trackKey || '';
      item.title = 'Open in YouTube Music';
      item.addEventListener('click', () => openTrackInYTMusic(entry));

      cacheList.appendChild(item);
    });

    if (entries.length > RENDER_CAP) {
      const more = document.createElement('div');
      more.className = 'empty-cache';
      more.style.padding = '8px';
      more.textContent = `+ ${entries.length - RENDER_CAP} more matching`;
      cacheList.appendChild(more);
    }
  }

  // ── Open the actual track in YouTube Music (whole cache-item click) ────
  // Entries cached from now on carry the real YouTube videoId, so this can
  // jump straight to watch?v=..., playing the actual song immediately.
  // Older entries cached before videoId was tracked don't have one yet —
  // for those we resolve it once via a YT Music search fetch, open the
  // real watch URL (not a search results page), and backfill the cache
  // entry so the same track opens instantly next time.
  function openTrackInYTMusic(entry) {
    if (entry.videoId) {
      chrome.tabs.create({ url: `https://music.youtube.com/watch?v=${encodeURIComponent(entry.videoId)}` });
      return;
    }
    resolveVideoIdForEntry(entry).then((videoId) => {
      if (videoId) {
        chrome.tabs.create({ url: `https://music.youtube.com/watch?v=${encodeURIComponent(videoId)}` });
        backfillVideoId(entry, videoId);
      } else {
        // Couldn't resolve a video id — fall back to search rather than a dead end.
        const q = `${entry.song || ''} ${entry.artist || ''}`.trim();
        chrome.tabs.create({ url: `https://music.youtube.com/search?q=${encodeURIComponent(q)}` });
      }
    });
  }

  // Scraping music.youtube.com/search itself doesn't work here: that page's
  // results are filled in client-side after load (via an internal API call),
  // so the raw HTML we get back from a plain fetch() has no real videoIds in
  // it — which is why this used to fail silently and fall back to opening a
  // search results tab every time. Regular www.youtube.com/results, by
  // contrast, server-renders its results (each as a "videoRenderer" block
  // with a real videoId), so we resolve against that instead and then hand
  // the id to music.youtube.com/watch — same video, same audio, just found
  // via the page that actually renders results into its HTML.
  async function resolveVideoIdForEntry(entry) {
    const q = `${entry.song || ''} ${entry.artist || ''}`.trim();
    if (!q) return null;
    try {
      const res = await fetch(`https://music.youtube.com/search?q=${encodeURIComponent(q)}`, { credentials: 'include' });
      const html = await res.text();
      const match = html.match(/"videoId":"([a-zA-Z0-9_-]{11})"/);
      return match ? match[1] : null;
    } catch {
      return null;
    }
  }

  function backfillVideoId(entry, videoId) {
    if (!entry.trackKey) return;
    const storageKey = 'vivi_cache_' + entry.trackKey;
    chrome.storage.local.get(storageKey, (stored) => {
      const existing = stored[storageKey];
      if (!existing) return;
      chrome.storage.local.set({ [storageKey]: { ...existing, videoId } });
    });
  }

  // ── Cached-artwork preview (quick shortcut to view a canvas full-size) ──
  const cachePreviewOverlay   = document.getElementById('cachePreviewOverlay');
  const cachePreviewMediaWrap = document.getElementById('cachePreviewMediaWrap');
  const cachePreviewSong      = document.getElementById('cachePreviewSong');
  const cachePreviewArtist    = document.getElementById('cachePreviewArtist');
  const cachePreviewClose     = document.getElementById('cachePreviewClose');
  const cachePreviewOpenTab   = document.getElementById('cachePreviewOpenTab');
  let cachePreviewCurrentUrl  = null;

  function openCachePreview(entry) {
    const url = entry.videoUrl || entry.imageUrl;
    if (!url) return;
    cachePreviewCurrentUrl = url;
    cachePreviewMediaWrap.innerHTML = '';
    if (entry.videoUrl) {
      // entry.videoUrl is an Apple CDN HLS (.m3u8) stream — a plain <video>
      // element can't play that natively (no source, so it just renders
      // black). apple-canvas-player.html already knows how to play these
      // (it loads hls.js), so reuse that exact player here in an iframe
      // instead of duplicating HLS-playback logic in the popup.
      const frame = document.createElement('iframe');
      frame.className = 'cache-preview-frame';
      frame.style.width = '100%';
      frame.style.height = '100%';
      frame.style.border = '0';
      frame.style.borderRadius = 'inherit';
      const frameId = 'preview-' + Date.now();
      frame.src = chrome.runtime.getURL(
        `src/apple-canvas-player.html?fit=contain&id=${encodeURIComponent(frameId)}#${encodeURIComponent(entry.videoUrl)}`
      );
      cachePreviewMediaWrap.appendChild(frame);
    } else {
      const img = document.createElement('img');
      img.src = entry.imageUrl;
      cachePreviewMediaWrap.appendChild(img);
    }
    cachePreviewSong.textContent = entry.song || '—';
    cachePreviewArtist.textContent = entry.artist || '—';
    cachePreviewOverlay.classList.add('show');
  }

  function closeCachePreview() {
    cachePreviewOverlay.classList.remove('show');
    cachePreviewMediaWrap.innerHTML = '';
    cachePreviewCurrentUrl = null;
  }

  cachePreviewClose.addEventListener('click', closeCachePreview);
  cachePreviewOverlay.addEventListener('click', (ev) => {
    if (ev.target === cachePreviewOverlay) closeCachePreview();
  });
  cachePreviewOpenTab.addEventListener('click', () => {
    if (cachePreviewCurrentUrl) chrome.tabs.create({ url: cachePreviewCurrentUrl });
  });

  // ── Search box ──
  const cacheSearchInput = document.getElementById('cacheSearch');
  const cacheSearchClearBtn = document.getElementById('cacheSearchClear');
  let cacheSearchDebounce = null;
  cacheSearchInput.addEventListener('input', () => {
    cacheSearchTerm = cacheSearchInput.value;
    cacheSearchClearBtn.classList.toggle('show', cacheSearchTerm.length > 0);
    clearTimeout(cacheSearchDebounce);
    cacheSearchDebounce = setTimeout(renderCacheList, 120);
  });
  cacheSearchClearBtn.addEventListener('click', () => {
    cacheSearchInput.value = '';
    cacheSearchTerm = '';
    cacheSearchClearBtn.classList.remove('show');
    renderCacheList();
    cacheSearchInput.focus();
  });

  function esc(str) {
    return str.replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
  }

  
  clearBtn.addEventListener('click', () => {
    withActiveMusicTab((tab) => {
      if (!tab) return;
      chrome.tabs.sendMessage(tab.id, { type: 'VIVI_CLEAR_CACHE' }, () => {
        if (chrome.runtime.lastError) return;
        renderCache();
      });
    });
  });

  // ── Export / import (mirrors Better Lyrics Shaders' cache export shape) ──
  const exportBtn = document.getElementById('exportBtn');
  const importBtn = document.getElementById('importBtn');
  const importCacheFile = document.getElementById('importCacheFile');
  const cacheIoError = document.getElementById('cacheIoError');
  const cacheIoSuccess = document.getElementById('cacheIoSuccess');
  const cacheIoSuccessText = document.getElementById('cacheIoSuccessText');

  function showCacheIoError(msg) {
    if (!msg) { cacheIoError.style.display = 'none'; return; }
    cacheIoError.textContent = msg;
    cacheIoError.style.display = 'block';
    cacheIoSuccess.classList.remove('show');
  }

  let cacheIoSuccessTimer = null;
  function showCacheIoSuccess(msg) {
    clearTimeout(cacheIoSuccessTimer);
    cacheIoSuccessText.textContent = msg;
    // restart the show transition even if already visible
    cacheIoSuccess.classList.remove('show');
    // eslint-disable-next-line no-unused-expressions
    void cacheIoSuccess.offsetWidth;
    cacheIoSuccess.classList.add('show');
    cacheIoSuccessTimer = setTimeout(() => {
      cacheIoSuccess.classList.remove('show');
    }, 2600);
  }

  function pad2(n) { return String(n).padStart(2, '0'); }

  exportBtn.addEventListener('click', () => {
    showCacheIoError(null);
    withActiveMusicTab((tab) => {
      if (!tab) { showCacheIoError('Open music.youtube.com to export'); return; }
      chrome.tabs.sendMessage(tab.id, { type: 'VIVI_EXPORT_CACHE' }, (resp) => {
        if (chrome.runtime.lastError || !resp) { showCacheIoError('Could not read cache'); return; }
        const entries = resp.entries || {};
        const payload = {
          version: '1.0',
          exportedAt: new Date().toISOString(),
          count: Object.keys(entries).length,
          entries,
        };
        const now = new Date();
        const stamp = `${now.getFullYear()}-${pad2(now.getMonth() + 1)}-${pad2(now.getDate())}`;
        const blob = new Blob([JSON.stringify(payload, null, 2)], { type: 'application/json' });
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url;
        a.download = `vivimusic-artwork-cache-${stamp}.json`;
        document.body.appendChild(a);
        a.click();
        document.body.removeChild(a);
        URL.revokeObjectURL(url);
        showCacheIoSuccess(`Backup saved — ${payload.count} track${payload.count === 1 ? '' : 's'}`);
      });
    });
  });

  importBtn.addEventListener('click', () => {
    showCacheIoError(null);
    importCacheFile.value = '';
    importCacheFile.click();
  });

  importCacheFile.addEventListener('change', () => {
    const file = importCacheFile.files?.[0];
    if (!file) return;
    withActiveMusicTab(async (tab) => {
      if (!tab) { showCacheIoError('Open music.youtube.com to import'); return; }
      try {
        const text = await file.text();
        const parsed = JSON.parse(text);
        if (!parsed.entries || typeof parsed.entries !== 'object') {
          showCacheIoError('Invalid cache file format');
          return;
        }
        chrome.tabs.sendMessage(tab.id, { type: 'VIVI_IMPORT_CACHE', entries: parsed.entries }, (resp) => {
          if (chrome.runtime.lastError) { showCacheIoError('Import failed'); return; }
          if (resp?.error) { showCacheIoError(resp.error); return; }
          const count = Object.keys(parsed.entries || {}).length;
          showCacheIoSuccess(`Imported ${count} track${count === 1 ? '' : 's'}`);
          renderCache();
        });
      } catch (err) {
        showCacheIoError('Error reading cache file');
      }
    });
  });

  
  chrome.runtime.onMessage.addListener((msg) => {
    if (msg.type === 'VIVI_CACHE_UPDATED') renderCache();
  });

  renderCache();

  
  const currentVersionEl = document.getElementById('currentVersion');
  const checkUpdateBtn   = document.getElementById('checkUpdateBtn');
  const updateStatus     = document.getElementById('updateStatus');

  currentVersionEl.textContent = chrome.runtime.getManifest().version;

  function renderUpdateResult(result) {
    if (!result) return;
    updateStatus.className = 'update-status show';
    if (!result.ok) {
      updateStatus.classList.add('error');
      updateStatus.innerHTML = `Couldn't check for updates (${esc(result.error || 'network error')}).`;
      return;
    }
    if (result.updateAvailable) {
      updateStatus.classList.add('available');
      updateStatus.innerHTML =
        `v${esc(result.latestVersion)} is available — ` +
        `<a href="${esc(result.releaseUrl)}" target="_blank" rel="noopener">Download</a>`;
    } else {
      updateStatus.classList.add('uptodate');
      updateStatus.textContent = "You're on the latest version.";
    }
  }

  chrome.storage.local.get('vivi_update_check', ({ vivi_update_check }) => {
    if (vivi_update_check) renderUpdateResult(vivi_update_check);
  });


  /* ─── SPOTIFY CANVAS ─────────────────────────────────────────── */
  const spotifyCanvasEnabled = document.getElementById('spotifyCanvasEnabled');
  const spotifyDisconnected = document.getElementById('spotifyDisconnected');
  const spotifyConnected = document.getElementById('spotifyConnected');
  const spotifyConnectBtn = document.getElementById('spotifyConnectBtn');
  const spotifySpDc = document.getElementById('spotifySpDc');
  const spotifySaveCookieBtn = document.getElementById('spotifySaveCookieBtn');
  const spotifyDisconnectBtn = document.getElementById('spotifyDisconnectBtn');
  const spotifyStatus = document.getElementById('spotifyStatus');
  const canvasPrioritySelect = document.getElementById('canvasPrioritySelect');
  const SPOTIFY_DEFAULTS = { spotifyCanvasEnabled: true, canvasPriority: 'apple' };

  function refreshSpotifyStatus() {
    chrome.runtime.sendMessage({ type: 'VIVI_SPOTIFY_STATUS' }, (resp) => {
      if (chrome.runtime.lastError) return;
      spotifyCanvasEnabled.checked = resp?.enabled !== false;
      const connected = !!resp?.connected;
      spotifyDisconnected.style.display = connected ? 'none' : 'flex';
      spotifyConnected.style.display = connected ? 'block' : 'none';
      if (resp?.error) spotifyStatus.textContent = resp.error;
      else if (!connected) spotifyStatus.textContent = resp?.error || 'Connect opens Spotify; no Spotify password is collected.';
      if (resp?.masked) spotifyConnectedAs.textContent = `Spotify connected (${resp.masked})`;
    });
  }

  chrome.storage.local.get(SPOTIFY_DEFAULTS, (s) => {
    spotifyCanvasEnabled.checked = s.spotifyCanvasEnabled;
    canvasPrioritySelect.value = s.canvasPriority === 'apple' ? 'apple' : 'spotify';
  });
  refreshSpotifyStatus();

  spotifyCanvasEnabled.addEventListener('change', () => {
    const enabled = spotifyCanvasEnabled.checked;
    chrome.storage.local.set({ spotifyCanvasEnabled: enabled });
    relay({ spotifyCanvasEnabled: enabled });
  });

  canvasPrioritySelect.addEventListener('change', () => {
    const canvasPriority = canvasPrioritySelect.value === 'apple' ? 'apple' : 'spotify';
    chrome.storage.local.set({ canvasPriority });
    relay({ canvasPriority });
  });

  spotifyConnectBtn.addEventListener('click', () => {
    spotifyConnectBtn.disabled = true;
    spotifyConnectBtn.textContent = 'Opening Spotify…';
    spotifyStatus.textContent = 'Log in to Spotify in the opened tab, then return here.';
    chrome.runtime.sendMessage({ type: 'VIVI_SPOTIFY_CONNECT' }, (resp) => {
      spotifyConnectBtn.disabled = false;
      spotifyConnectBtn.textContent = 'Connect Spotify';
      if (chrome.runtime.lastError || !resp?.ok) {
        spotifyStatus.textContent = resp?.error || 'Could not read the Spotify session.';
      }
      refreshSpotifyStatus();
    });
  });

  spotifySaveCookieBtn.addEventListener('click', () => {
    const value = spotifySpDc.value.trim();
    if (!value) return;
    spotifySaveCookieBtn.disabled = true;
    spotifySaveCookieBtn.textContent = 'Checking…';
    chrome.runtime.sendMessage({ type: 'VIVI_SPOTIFY_SET_COOKIE', spDc: value }, (resp) => {
      spotifySaveCookieBtn.disabled = false;
      spotifySaveCookieBtn.textContent = 'Save sp_dc locally';
      spotifySpDc.value = '';
      spotifyStatus.textContent = resp?.ok ? 'Spotify session saved locally.' : (resp?.error || 'Invalid Spotify cookie.');
      refreshSpotifyStatus();
    });
  });

  spotifyDisconnectBtn.addEventListener('click', () => {
    chrome.runtime.sendMessage({ type: 'VIVI_SPOTIFY_LOGOUT' }, () => {
      relay({ spotifyCanvasEnabled: false });
      refreshSpotifyStatus();
    });
  });

  const spotifyTransferBtn = document.getElementById('spotifyTransferBtn');
  if (spotifyTransferBtn) {
    spotifyTransferBtn.addEventListener('click', () => {
      chrome.tabs.create({ url: chrome.runtime.getURL('src/transfer.html'), active: true });
    });
  }

  /* ─── LAST.FM ────────────────────────────────────────────────── */
  const LASTFM_DEFAULTS = {
    lastfmEnabled: false,
    lastfmSendNowPlaying: true,
    lastfmSendLikes: true,
    lastfmMinDurationSec: 30,
    lastfmDelayPercent: 50,
    lastfmDelayMinutes: 3,
  };

  const lfEnabledToggle    = document.getElementById('lastfmEnabledToggle');
  const lfLoginBlock       = document.getElementById('lastfmLoginBlock');
  const lfConnectedBlock   = document.getElementById('lastfmConnectedBlock');
  const lfConnectedAs      = document.getElementById('lastfmConnectedAs');
  const lfUsername         = document.getElementById('lastfmUsername');
  const lfPassword         = document.getElementById('lastfmPassword');
  const lfLoginBtn         = document.getElementById('lastfmLoginBtn');
  const lfLoginError       = document.getElementById('lastfmLoginError');
  const lfLogoutBtn        = document.getElementById('lastfmLogoutBtn');
  const lfNowPlayingToggle = document.getElementById('lastfmNowPlayingToggle');
  const lfLikesToggle      = document.getElementById('lastfmLikesToggle');
  const lfMinDuration      = document.getElementById('lastfmMinDuration');
  const lfDelayPercent     = document.getElementById('lastfmDelayPercent');
  const lfDelayMinutes     = document.getElementById('lastfmDelayMinutes');

  function lastfmRelay(patch) { relay(patch); }

  function refreshLastfmStatus() {
    chrome.runtime.sendMessage({ type: 'VIVI_LASTFM_STATUS' }, (resp) => {
      if (chrome.runtime.lastError) return;
      if (resp?.loggedIn) {
        lfLoginBlock.style.display = 'none';
        lfConnectedBlock.style.display = 'block';
        lfConnectedAs.textContent = `Connected as ${resp.username}`;
      } else {
        lfLoginBlock.style.display = 'flex';
        lfConnectedBlock.style.display = 'none';
      }
    });
  }

  chrome.storage.local.get(LASTFM_DEFAULTS, (s) => {
    lfEnabledToggle.checked    = s.lastfmEnabled;
    lfNowPlayingToggle.checked = s.lastfmSendNowPlaying;
    lfLikesToggle.checked      = s.lastfmSendLikes;
    lfMinDuration.value        = s.lastfmMinDurationSec;
    lfDelayPercent.value       = s.lastfmDelayPercent;
    lfDelayMinutes.value       = s.lastfmDelayMinutes;
  });
  refreshLastfmStatus();

  lfEnabledToggle.addEventListener('change', () => {
    const lastfmEnabled = lfEnabledToggle.checked;
    chrome.storage.local.set({ lastfmEnabled });
    lastfmRelay({ lastfmEnabled });
  });
  lfNowPlayingToggle.addEventListener('change', () => {
    const lastfmSendNowPlaying = lfNowPlayingToggle.checked;
    chrome.storage.local.set({ lastfmSendNowPlaying });
    lastfmRelay({ lastfmSendNowPlaying });
  });
  lfLikesToggle.addEventListener('change', () => {
    const lastfmSendLikes = lfLikesToggle.checked;
    chrome.storage.local.set({ lastfmSendLikes });
    lastfmRelay({ lastfmSendLikes });
  });
  lfMinDuration.addEventListener('change', () => {
    const lastfmMinDurationSec = parseInt(lfMinDuration.value, 10) || 0;
    chrome.storage.local.set({ lastfmMinDurationSec });
    lastfmRelay({ lastfmMinDurationSec });
  });
  lfDelayPercent.addEventListener('change', () => {
    const lastfmDelayPercent = Math.min(100, Math.max(0, parseInt(lfDelayPercent.value, 10) || 0));
    chrome.storage.local.set({ lastfmDelayPercent });
    lastfmRelay({ lastfmDelayPercent });
  });
  lfDelayMinutes.addEventListener('change', () => {
    const lastfmDelayMinutes = parseInt(lfDelayMinutes.value, 10) || 0;
    chrome.storage.local.set({ lastfmDelayMinutes });
    lastfmRelay({ lastfmDelayMinutes });
  });

  lfLoginBtn.addEventListener('click', () => {
    const username = lfUsername.value.trim();
    const password = lfPassword.value;
    if (!username || !password) return;
    lfLoginBtn.disabled = true;
    lfLoginBtn.textContent = 'Connecting…';
    lfLoginError.style.display = 'none';
    chrome.runtime.sendMessage({ type: 'VIVI_LASTFM_LOGIN', username, password }, (resp) => {
      lfLoginBtn.disabled = false;
      lfLoginBtn.textContent = 'Connect Last.fm account';
      if (chrome.runtime.lastError || !resp?.ok) {
        lfLoginError.style.display = 'block';
        lfLoginError.textContent = resp?.error || "Couldn't connect — check your credentials.";
        return;
      }
      lfPassword.value = '';
      refreshLastfmStatus();
    });
  });

  lfLogoutBtn.addEventListener('click', () => {
    chrome.runtime.sendMessage({ type: 'VIVI_LASTFM_LOGOUT' }, () => {
      refreshLastfmStatus();
    });
  });

  checkUpdateBtn.addEventListener('click', () => {
    checkUpdateBtn.disabled = true;
    checkUpdateBtn.textContent = 'Checking…';
    chrome.runtime.sendMessage({ type: 'VIVI_CHECK_UPDATE' }, (result) => {
      checkUpdateBtn.disabled = false;
      checkUpdateBtn.textContent = 'Check for updates';
      if (chrome.runtime.lastError) {
        updateStatus.className = 'update-status show error';
        updateStatus.textContent = "Couldn't reach the background service — try again.";
        return;
      }
      renderUpdateResult(result);
    });
  });
})();
