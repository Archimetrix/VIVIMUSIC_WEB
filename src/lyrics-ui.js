/**
 * VIVIMUSIC WEB — lyrics-ui.js
 */

(() => {
  'use strict';

  const PANEL_ID   = 'vivi-lyrics-panel';
  const INFO_BTN_ID    = 'vivi-lyrics-info-btn';
  const OFFSET_PANEL_ID = 'vivi-lyrics-offset-panel';
  const DEBUG      = false;
  const log        = (...a) => DEBUG && console.log('[Vivi:LyricsUI]', ...a);
  const OFFSET_DB_PFX  = 'vivi_lyrics_offset_';
  const OFFSET_STEP_MS = 100;
  const EXCLUDED_DB_PFX = 'vivi_lyrics_excluded_';
  let isRefetchingLyrics = false;

  let settings = { lyricsEnabled: true, autoSwitchLyrics: true, lyricsShowForVideos: true, dancerOnNotFound: true };
  let currentTrackKey = null;
  let currentResult = null;  
  let isLoadingLyrics = false;
  let rafId = null;
  let activeLineEl = null;
  let tabObserver = null;
  let syncRaf = null;
  let contentDirty = false; 

  // Cumulative duration (ms) of SponsorBlock "non-music" segments the player
  // has already auto-skipped through for the current track. Lyrics providers
  // time their lines from the actual start of the song, but when a video
  // opens with a skipped intro/talking segment the video's own currentTime
  // runs ahead of that by exactly this much — so we subtract it back out.
  let sponsorOffsetMs = 0;

  // Manual, user-tuned correction (ms) for cases where a specific provider's
  // timing is itself a little early/late for a given track. Positive values
  // make lyrics advance sooner (subtracted the same way sponsorOffsetMs is).
  let manualOffsetMs = 0;
  // Last value actually persisted to chrome.storage for the current
  // track/provider — compared against manualOffsetMs to know whether the
  // offset panel's Save button has anything unsaved to write.
  let savedOffsetMs = 0;
  // Whether the inline offset editor (opened via the "i" button) is expanded.
  let offsetPanelOpen = false;
  let currentTrack = null; // {song, artist, duration} — for the offset "database" key
  let currentIsVideo = false;
  const VIDEO_BLOCKED = Object.freeze({ videoBlocked: true });

  chrome.storage.local.get(
    { lyricsEnabled: true, autoSwitchLyrics: true, lyricsShowForVideos: true, dancerOnNotFound: true, lyricsAlign: 'left', lyricsAnimationStyle: 'fill' },
    (s) => { settings = s; }
  );

  chrome.runtime.onMessage.addListener((msg) => {
    if (msg.type !== 'VIVI_SETTINGS') return;
    if ('lyricsEnabled' in msg) {
      settings.lyricsEnabled = msg.lyricsEnabled;
      if (!settings.lyricsEnabled) teardownPanel();
      else scheduleSync();
    }
    if ('autoSwitchLyrics' in msg) settings.autoSwitchLyrics = msg.autoSwitchLyrics;
    if ('lyricsAlign' in msg) {
      settings.lyricsAlign = msg.lyricsAlign;
      applyLyricsStyleClasses();
    }
    if ('lyricsAnimationStyle' in msg) {
      settings.lyricsAnimationStyle = msg.lyricsAnimationStyle;
      applyLyricsStyleClasses();
      // Force the active word's fill/glow state to be re-applied under the
      // new animation style rather than waiting for its state to change.
      const active = document.querySelector('.vivi-lyrics-line.vivi-lyrics-active');
      active?.querySelectorAll('.vivi-lyrics-word').forEach((w) => {
        delete w.dataset.fillState;
        w.classList.remove('vivi-lyrics-word-glowing', 'vivi-lyrics-word-bouncing');
      });
    }
    if ('dancerOnNotFound' in msg) {
      settings.dancerOnNotFound = msg.dancerOnNotFound;
      // If the panel is currently showing the "no lyrics found" state,
      // re-render it immediately so the toggle takes effect without
      // waiting for the next track.
      if (currentTrack && !isLoadingLyrics && !currentResult) {
        contentDirty = true;
        syncPanelVisibility();
      }
    }
    if ('lyricsShowForVideos' in msg) {
      settings.lyricsShowForVideos = msg.lyricsShowForVideos;
      // Re-evaluate the currently loaded track against the new setting right
      // away, rather than waiting for the next track change.
      if (currentTrack) reevaluateForVideoSetting();
    }
  });

  
  function findTabByLabel(label) {
    const tabs = document.querySelectorAll('ytmusic-player-page tp-yt-paper-tab, ytmusic-player-page yt-tab-shape');
    for (const tab of tabs) {
      const text = (tab.textContent || '').trim().toLowerCase();
      if (text === label) return tab;
    }
    return null;
  }

  function isLyricsTabActive() {
    const tab = findTabByLabel('lyrics');
    return !!tab && (tab.getAttribute('aria-selected') === 'true' || tab.hasAttribute('selected'));
  }

  // YT Music renders the Lyrics tab for video tracks too, but ships it
  // disabled (disabled + aria-disabled="true" + pointer-events:none), so
  // it's visible but unclickable and never reachable once the user has
  // navigated to another tab. Since the tab node itself is real, we don't
  // need to build a fake one — just strip the disabling. YTM re-disables
  // it on every tab-strip rebuild (track/route change), so this has to be
  // reasserted continuously rather than run once.
  function enableLyricsTabIfDisabled() {
    const tab = findTabByLabel('lyrics');
    if (!tab) return false;
    if (tab.hasAttribute('disabled') || tab.getAttribute('aria-disabled') === 'true' || tab.style.pointerEvents === 'none') {
      tab.removeAttribute('disabled');
      tab.removeAttribute('aria-disabled');
      tab.style.removeProperty('pointer-events');
      log('re-enabled disabled Lyrics tab');
      return true;
    }
    return false;
  }

  // Retrying variant: polls for the tab briefly. When lyrics don't need a
  // network fetch (video-blocked path), handleTrack() now finishes almost
  // instantly — much faster than YT Music's own tab bar
  // can finish mounting after a track/route change. A single click attempt
  // at that moment can silently miss the "Lyrics" tab element entirely and,
  // unlike the render path, nothing else ever retries the click on its own.
  let lyricsTabRetryId = null;
  function clickLyricsTabWithRetry(attemptsLeft) {
    if (lyricsTabRetryId) { clearTimeout(lyricsTabRetryId); lyricsTabRetryId = null; }
    if (attemptsLeft == null) attemptsLeft = 20; // ~3s at 150ms apart
    const tab = findTabByLabel('lyrics');
    if (tab) {
      enableLyricsTabIfDisabled();
      if (tab.getAttribute('aria-selected') !== 'true' && !tab.hasAttribute('selected')) {
        tab.click();
        log('auto-switched to Lyrics tab (attempt', 21 - attemptsLeft, ')');
      }
      return;
    }
    if (attemptsLeft > 1) {
      lyricsTabRetryId = setTimeout(() => clickLyricsTabWithRetry(attemptsLeft - 1), 150);
    }
  }

  function findTabContentHost() {
    return document.querySelector('ytmusic-player-page #tab-renderer');
  }

  // ── Per-track/per-provider offset "database" (chrome.storage.local) ──
  // Keyed by artist+song+provider so a re-fetch from a different, better-
  // timed provider doesn't inherit a correction that no longer applies.
  function offsetDbKey(track, provider) {
    const raw = `${track.artist}—${track.song}—${provider || 'unknown'}`;
    return OFFSET_DB_PFX + raw.replace(/[^a-z0-9]/gi, '_').slice(0, 110);
  }

  function loadOffset(track, provider) {
    return new Promise((resolve) => {
      const key = offsetDbKey(track, provider);
      chrome.storage.local.get(key, (r) => resolve(r[key]?.offsetMs || 0));
    });
  }

  function saveOffset(track, provider, offsetMs) {
    const key = offsetDbKey(track, provider);
    const entry = {
      song: track.song,
      artist: track.artist,
      duration: track.duration ?? null,
      provider: provider || 'unknown',
      offsetMs,
      updatedAt: Date.now(),
    };
    chrome.storage.local.set({ [key]: entry });
  }

  // ── Per-song "refetched away from this provider" list ──
  // Keyed by artist+song only (no provider in the key, unlike the offset
  // db above) — this is "for this song, don't show provider X again",
  // independent of whichever provider happens to be showing right now.
  // Grows as the user hits "refetch from other providers" repeatedly.
  function excludedDbKey(track) {
    const raw = `${track.artist}—${track.song}`;
    return EXCLUDED_DB_PFX + raw.replace(/[^a-z0-9]/gi, '_').slice(0, 110);
  }

  function loadExcludedProviders(track) {
    return new Promise((resolve) => {
      const key = excludedDbKey(track);
      chrome.storage.local.get(key, (r) => resolve(Array.isArray(r[key]?.keys) ? r[key].keys : []));
    });
  }

  function addExcludedProvider(track, providerKey) {
    if (!providerKey) return;
    const key = excludedDbKey(track);
    chrome.storage.local.get(key, (r) => {
      const keys = new Set(Array.isArray(r[key]?.keys) ? r[key].keys : []);
      keys.add(providerKey);
      chrome.storage.local.set({
        [key]: { song: track.song, artist: track.artist, keys: [...keys], updatedAt: Date.now() },
      });
    });
  }

  function setSponsorOffset(ms) {
    sponsorOffsetMs = Number(ms) || 0;
  }

  function offsetIsDirty() {
    return manualOffsetMs !== savedOffsetMs;
  }

  function updateSaveButtonState() {
    const saveBtn = document.querySelector('#' + OFFSET_PANEL_ID + ' .vivi-offset-save-btn');
    if (!saveBtn) return;
    const dirty = offsetIsDirty();
    saveBtn.textContent = dirty ? 'Save' : 'Saved';
    saveBtn.disabled = !dirty;
    saveBtn.classList.toggle('vivi-offset-save-btn-dirty', dirty);
  }

  function updateOffsetPanelValue() {
    const input = document.querySelector('#' + OFFSET_PANEL_ID + ' .vivi-offset-input');
    if (input && document.activeElement !== input) input.value = manualOffsetMs;
    updateSaveButtonState();
  }

  // Live edits (± buttons / typing) only update in-memory state so the user
  // can preview the new timing against the current playback position; they
  // are NOT written to chrome.storage until the explicit Save button is
  // pressed (see persistManualOffset below).
  function setManualOffsetLive(ms) {
    manualOffsetMs = Number.isFinite(ms) ? ms : 0;
    updateOffsetPanelValue();
  }

  function adjustManualOffset(deltaMs) {
    setManualOffsetLive(manualOffsetMs + deltaMs);
  }

  function persistManualOffset() {
    if (!currentTrack || !currentResult?.provider) return;
    saveOffset(currentTrack, currentResult.provider, manualOffsetMs);
    savedOffsetMs = manualOffsetMs;
    updateSaveButtonState();
  }

  // ── "i" info button beside the Lyrics tab + its inline offset editor ──
  // Pressing "i" no longer opens a floating popup (which could end up
  // anchored to a stale/detached button after navigating to a new song from
  // the homepage). Instead it toggles an editor panel rendered inline at
  // the top of the lyrics list itself, so it's always part of the same
  // panel that gets rebuilt on every track change.
  function toggleOffsetPanel() {
    offsetPanelOpen = !offsetPanelOpen;
    contentDirty = true;
    syncPanelVisibility();
    if (offsetPanelOpen) {
      requestAnimationFrame(() => {
        document.getElementById(OFFSET_PANEL_ID)?.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
      });
    }
  }

  function removeInfoButton() {
    document.getElementById(INFO_BTN_ID)?.remove();
  }

  function ensureInfoButton() {
    const tab = findTabByLabel('lyrics');
    const canShowOffset = settings.lyricsEnabled && !!(currentResult && currentResult.mode !== 'plain');

    if (!tab || !canShowOffset) {
      removeInfoButton();
      return;
    }

    let wrap = document.getElementById(INFO_BTN_ID);
    if (!wrap || wrap.previousElementSibling !== tab) {
      if (wrap) wrap.remove();

      wrap = document.createElement('span');
      wrap.id = INFO_BTN_ID;
      wrap.className = 'vivi-lyrics-info-wrap';

      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'vivi-lyrics-info-btn';
      btn.textContent = 'i';
      btn.setAttribute('aria-label', 'Adjust lyrics sync offset');
      btn.setAttribute('aria-expanded', 'false');
      btn.title = 'Adjust lyrics sync';
      btn.addEventListener('click', (e) => {
        e.stopPropagation();
        e.preventDefault();
        toggleOffsetPanel();
      });

      wrap.appendChild(btn);
      tab.insertAdjacentElement('afterend', wrap);
    }

    const btnEl = wrap.querySelector('.vivi-lyrics-info-btn');
    if (btnEl) {
      btnEl.classList.toggle('vivi-lyrics-info-btn-active', offsetPanelOpen);
      btnEl.setAttribute('aria-expanded', offsetPanelOpen ? 'true' : 'false');
    }
  }

  function seekTo(ms) {
    const video = getVideoEl();
    if (!video || Number.isNaN(ms)) return;
    video.currentTime = ms / 1000;
    if (video.paused) video.play().catch(() => {});
  }

  // Only fade an edge when there's actually more content hidden past it —
  // otherwise the very first/last line sits right at the mask's transparent
  // end and looks permanently dimmed even though nothing is scrolled away.
  function updateEdgeFade(host) {
    if (!host || !host.classList.contains('vivi-lyrics-edge-fade')) return;
    const eps = 4;
    const maxScroll = host.scrollHeight - host.clientHeight;
    host.classList.toggle('vivi-fade-top', host.scrollTop > eps);
    host.classList.toggle('vivi-fade-bottom', host.scrollTop < maxScroll - eps);
  }

  function ensurePanel() {
    const host = findTabContentHost();
    if (!host) return null;
    host.classList.add('vivi-lyrics-edge-fade');
    if (!host.dataset.viviFadeBound) {
      host.dataset.viviFadeBound = '1';
      host.addEventListener('scroll', () => updateEdgeFade(host), { passive: true });
      window.addEventListener('resize', () => updateEdgeFade(host));
    }
    updateEdgeFade(host);
    let panel = document.getElementById(PANEL_ID);
    if (panel && panel.parentElement === host) return panel;
    if (panel) panel.remove();

    panel = document.createElement('div');
    panel.id = PANEL_ID;
    host.insertBefore(panel, host.firstChild);
    return panel;
  }

  function hideNativeLyricsContent(host) {
    Array.from(host.children).forEach((child) => {
      if (child.id !== PANEL_ID) child.style.display = 'none';
    });
  }

  function restoreNativeLyricsContent(host) {
    if (!host) return;
    Array.from(host.children).forEach((child) => {
      if (child.id !== PANEL_ID) child.style.display = '';
    });
    nudgeRelayout();
  }

  
  function nudgeRelayout() {
    requestAnimationFrame(() => {
      window.dispatchEvent(new Event('resize'));
      requestAnimationFrame(() => window.dispatchEvent(new Event('resize')));
    });
  }

  function teardownPanel() {
    const panel = document.getElementById(PANEL_ID);
    const host = findTabContentHost();
    if (panel) panel.remove();
    host?.classList.remove('vivi-lyrics-edge-fade', 'vivi-fade-top', 'vivi-fade-bottom');
    restoreNativeLyricsContent(host);
    removeInfoButton();
    offsetPanelOpen = false;
  }


  let dancerUrl = null;
  function getDancerUrl() {
    if (!dancerUrl) {
      try { dancerUrl = chrome.runtime.getURL('icons/lyrics-dancer.webm'); } catch { dancerUrl = null; }
    }
    return dancerUrl;
  }

  function renderDancerState(panel, caption, sub) {
    panel.innerHTML = '';
    const wrap = document.createElement('div');
    wrap.className = 'vivi-lyrics-video-blocked';

    const url = getDancerUrl();
    if (url) {
      const video = document.createElement('video');
      video.className = 'vivi-lyrics-dancer';
      video.src = url;
      video.autoplay = true;
      video.loop = true;
      video.muted = true;
      video.playsInline = true;
      video.disablePictureInPicture = true;
      wrap.appendChild(video);
    }

    const captionEl = document.createElement('div');
    captionEl.className = 'vivi-lyrics-video-blocked-caption';
    captionEl.textContent = caption;
    wrap.appendChild(captionEl);

    if (sub) {
      const subEl = document.createElement('div');
      subEl.className = 'vivi-lyrics-video-blocked-sub';
      subEl.textContent = sub;
      wrap.appendChild(subEl);
    }

    panel.appendChild(wrap);
    activeLineEl = null;
  }

  function renderVideoBlockedState(panel) {
    renderDancerState(
      panel,
      "Lyrics are off for video songs",
      'Turn this back on under Lyrics → "Show lyrics for video songs".'
    );
  }

  function renderNotFoundState(panel) {
    if (settings.dancerOnNotFound) {
      renderDancerState(panel, "No lyrics found for this track.", null);
    } else {
      panel.innerHTML = `<div class="vivi-lyrics-empty">No lyrics found for this track.</div>`;
    }
  }

  function reevaluateForVideoSetting() {
    // Called right after the "Show lyrics for video songs" toggle flips,
    // so the currently open Lyrics tab reacts immediately instead of
    // waiting for the next track change.
    if (!currentTrack) return;
    if (!settings.lyricsShowForVideos && currentIsVideo) {
      isLoadingLyrics = false;
      currentResult = VIDEO_BLOCKED;
      contentDirty = true;
      syncPanelVisibility();
    } else if (settings.lyricsShowForVideos && currentResult && currentResult.videoBlocked) {
      // Setting was turned back on — go fetch lyrics for the track that's
      // still playing, same as a fresh track change would. handleTrack()
      // re-derives the same track key internally, so just force it to treat
      // this as a new lookup instead of a no-op.
      currentTrackKey = null;
      handleTrack(currentTrack);
    }
  }

  function renderLoadingOrResult() {
    const panel = ensurePanel();
    if (!panel) return;
    const host = findTabContentHost();
    if (host) hideNativeLyricsContent(host);
    if (isLoadingLyrics) {
      panel.innerHTML = `<div class="vivi-lyrics-loading">Loading lyrics…</div>`;
      updateEdgeFade(findTabContentHost());
      return;
    }
    renderPanel(currentResult);
  }

  function syncPanelVisibility() {
    const host = findTabContentHost();
    if (!host) return;
    const shouldShow = settings.lyricsEnabled && !!currentTrackKey && isLyricsTabActive();

    if (shouldShow) {
      const existingPanel = document.getElementById(PANEL_ID);
      const panelInHost = existingPanel && existingPanel.parentElement === host;
      if (!panelInHost || contentDirty) {
       
        renderLoadingOrResult();
        contentDirty = false;
      } else {
        
        hideNativeLyricsContent(host);
      }
    } else if (document.getElementById(PANEL_ID)) {
      teardownPanel();
    }

    ensureInfoButton();
  }

  function scheduleSync() {
    
    if (syncRaf) cancelAnimationFrame(syncRaf);
    syncRaf = requestAnimationFrame(() => {
      syncRaf = null;
      syncPanelVisibility();
    });
  }

  // Inline offset editor, rendered at the top of the panel when the "i"
  // button is toggled on. ± buttons and the number input adjust the value
  // live for preview; nothing is written to chrome.storage until Save is
  // pressed.
  function buildOffsetPanel(result) {
    const wrap = document.createElement('div');
    wrap.id = OFFSET_PANEL_ID;
    wrap.className = 'vivi-offset-panel';

    const title = document.createElement('div');
    title.className = 'vivi-offset-panel-title';
    title.textContent = `Lyrics via ${result.provider}`;
    wrap.appendChild(title);

    const controls = document.createElement('div');
    controls.className = 'vivi-offset-panel-controls';

    const minus = document.createElement('button');
    minus.type = 'button';
    minus.className = 'vivi-offset-btn';
    minus.textContent = '−';
    minus.setAttribute('aria-label', 'Delay lyrics');
    minus.addEventListener('click', (e) => { e.stopPropagation(); adjustManualOffset(-OFFSET_STEP_MS); });

    const input = document.createElement('input');
    input.type = 'number';
    input.step = String(OFFSET_STEP_MS);
    input.className = 'vivi-offset-input';
    input.value = String(manualOffsetMs);
    input.setAttribute('aria-label', 'Lyrics offset in milliseconds');
    input.addEventListener('click', (e) => e.stopPropagation());
    input.addEventListener('keydown', (e) => {
      e.stopPropagation();
      if (e.key === 'Enter') input.blur();
    });
    input.addEventListener('change', () => {
      setManualOffsetLive(parseInt(input.value, 10) || 0);
    });

    const unit = document.createElement('span');
    unit.className = 'vivi-offset-unit';
    unit.textContent = 'ms';

    const plus = document.createElement('button');
    plus.type = 'button';
    plus.className = 'vivi-offset-btn';
    plus.textContent = '+';
    plus.setAttribute('aria-label', 'Advance lyrics');
    plus.addEventListener('click', (e) => { e.stopPropagation(); adjustManualOffset(OFFSET_STEP_MS); });

    const saveBtn = document.createElement('button');
    saveBtn.type = 'button';
    saveBtn.className = 'vivi-offset-save-btn';
    saveBtn.textContent = offsetIsDirty() ? 'Save' : 'Saved';
    saveBtn.disabled = !offsetIsDirty();
    saveBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      persistManualOffset();
    });

    const refetchBtn = document.createElement('button');
    refetchBtn.type = 'button';
    refetchBtn.className = 'vivi-offset-refetch-btn';
    refetchBtn.textContent = 'Refetch from other providers';
    refetchBtn.disabled = isRefetchingLyrics;
    refetchBtn.classList.toggle('vivi-offset-refetch-btn-loading', isRefetchingLyrics);
    refetchBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      refetchFromOtherProviders();
    });

    controls.append(minus, input, unit, plus, saveBtn, refetchBtn);
    wrap.appendChild(controls);
    return wrap;
  }

  // "Refetch from other providers" — re-runs discovery while skipping the
  // provider currently on screen (and any providers the user has already
  // refetched away from for this exact song in the past). All the enabled
  // providers were already queried once when this track loaded, but the
  // losing results aren't kept around anywhere (no lyrics cache), so this
  // is a fresh, real fetch rather than a re-scan of old responses — same
  // network shape as the initial lookup, just with one or more providers
  // excluded. If something new turns up, it's shown immediately and that
  // provider's own saved offset (if any) is restored. The current provider
  // is only marked "don't show again for this song" once a replacement has
  // actually been found and displayed — if nothing else is out there, the
  // existing lyrics are left alone rather than being replaced with nothing.
  async function refetchFromOtherProviders() {
    if (isRefetchingLyrics || !currentTrack || !currentResult || currentResult.videoBlocked) return;
    const currentKey = window.__viviLyrics.providerKeyForName(currentResult.provider);
    if (!currentKey) return;

    isRefetchingLyrics = true;
    contentDirty = true;
    syncPanelVisibility();

    try {
      const alreadyExcluded = await loadExcludedProviders(currentTrack);
      const excludeKeys = [...new Set([...alreadyExcluded, currentKey])];
      const result = await window.__viviLyrics.fetchBestLyrics(currentTrack, { excludeKeys });

      if (!result) {
        // Nothing else out there — leave the current lyrics as-is and
        // don't persist the exclusion, so a future refetch (or a later
        // relisten once a provider catches up) can try again.
        return;
      }

      addExcludedProvider(currentTrack, currentKey);
      currentResult = result;
      contentDirty = true;
      manualOffsetMs = await loadOffset(currentTrack, result.provider);
      savedOffsetMs = manualOffsetMs;
      offsetPanelOpen = true;
      syncPanelVisibility();
    } finally {
      isRefetchingLyrics = false;
      contentDirty = true;
      syncPanelVisibility();
    }
  }

  // Re-applies the alignment/animation-style classes to an already-rendered
  // list without rebuilding it, so flipping a setting mid-song updates the
  // panel immediately.
  function applyLyricsStyleClasses(listEl) {
    const list = listEl || document.querySelector('.vivi-lyrics-list');
    if (!list) return;
    list.classList.remove('vivi-lyrics-align-left', 'vivi-lyrics-align-center', 'vivi-lyrics-align-right');
    list.classList.add('vivi-lyrics-align-' + (settings.lyricsAlign || 'left'));
    list.classList.toggle('vivi-lyrics-anim-glow', settings.lyricsAnimationStyle === 'glow');
    list.classList.toggle('vivi-lyrics-anim-bounce', settings.lyricsAnimationStyle === 'bounce');
  }

  function renderPanel(result) {
    const panel = ensurePanel();
    if (!panel) return;
    const host = findTabContentHost();
    if (host) hideNativeLyricsContent(host);

    if (result && result.videoBlocked) {
      renderVideoBlockedState(panel);
      updateEdgeFade(findTabContentHost());
      return;
    }

    if (!result) {
      renderNotFoundState(panel);
      updateEdgeFade(findTabContentHost());
      return;
    }

    const frag = document.createDocumentFragment();

    if (offsetPanelOpen && result.mode !== 'plain' && result.provider) {
      frag.appendChild(buildOffsetPanel(result));
    }

    const list = document.createElement('div');
    list.className = 'vivi-lyrics-list';
    applyLyricsStyleClasses(list);

    result.lines.forEach((line, i) => {
      const lineEl = document.createElement('div');
      lineEl.className = 'vivi-lyrics-line';
      lineEl.dataset.index = String(i);

      if (result.mode === 'word') {
        line.words.forEach((w, wi) => {
          const span = document.createElement('span');
          span.className = 'vivi-lyrics-word';
          span.dataset.start = String(w.start);
          span.dataset.end = String(w.end);
          span.textContent = w.text;
          if (result.mode !== 'plain') {
            span.addEventListener('click', (e) => {
              e.stopPropagation();
              seekTo(w.start);
            });
          }
          lineEl.appendChild(span);
        });
      } else {
        lineEl.textContent = line.text;
      }
      if (result.mode !== 'plain') {
        lineEl.dataset.start = String(line.start);
        lineEl.dataset.end = String(line.end);
        lineEl.classList.add('vivi-lyrics-clickable');
        lineEl.addEventListener('click', () => seekTo(line.start));
      }
      list.appendChild(lineEl);
    });

    frag.appendChild(list);

    if (result.provider) {
      const creditRow = document.createElement('div');
      creditRow.className = 'vivi-lyrics-credit-row';

      const credit = document.createElement('span');
      credit.className = 'vivi-lyrics-credit';
      credit.textContent = `Lyrics via ${result.provider}`;
      creditRow.appendChild(credit);

      frag.appendChild(creditRow);
    }

    panel.innerHTML = '';
    panel.appendChild(frag);
    activeLineEl = null;
    updateEdgeFade(findTabContentHost());
  }

  let cachedVideo = null;

  function getVideoEl() {
    if (cachedVideo && cachedVideo.isConnected && cachedVideo.classList.contains('html5-main-video')) {
      return cachedVideo;
    }

    const main = document.querySelector('#movie_player video.html5-main-video, video.html5-main-video');
    if (main) { cachedVideo = main; return main; }
    const scoped = document.querySelector('#movie_player video');
    if (scoped) { cachedVideo = scoped; return scoped; }

    cachedVideo = null;
    return null;
  }

  function tick() {
    rafId = requestAnimationFrame(tick);
    if (!currentResult || currentResult.videoBlocked || currentResult.mode === 'plain') return;
    const video = getVideoEl();
    if (!video) return;
    // Shift the raw video position back by whatever SponsorBlock already
    // skipped past (so lyrics stay aligned to the real song, not the video
    // file's timeline), then apply the user's manual fine-tune correction.
    const nowMs = (video.currentTime * 1000) - sponsorOffsetMs + manualOffsetMs;

    const panel = document.getElementById(PANEL_ID);
    if (!panel) return;
    const lineEls = panel.querySelectorAll('.vivi-lyrics-line');
    let active = null;
    for (const el of lineEls) {
      const start = Number(el.dataset.start);
      const end = Number(el.dataset.end);
      if (nowMs >= start && nowMs < end) { active = el; break; }
    }

    if (active !== activeLineEl) {
      activeLineEl?.classList.remove('vivi-lyrics-active');
      // Settle every word in the outgoing line to its final "sung" resting
      // state and strip any in-progress animation class/inline style. Left
      // untouched, a word whose line changed mid-glow (or mid-bounce, or
      // mid-fill) would keep its transient class forever — that's the stuck
      // glow on the last word of a finished line.
      activeLineEl?.querySelectorAll('.vivi-lyrics-word').forEach((w) => {
        w.dataset.fillState = 'sung';
        w.classList.add('vivi-lyrics-word-sung');
        w.classList.remove('vivi-lyrics-word-glowing', 'vivi-lyrics-word-bouncing');
        w.style.transitionDuration = '0s';
        w.style.backgroundPosition = '0% 0';
      });
      active?.classList.add('vivi-lyrics-active');
      activeLineEl = active;
      active?.scrollIntoView({ block: 'center', behavior: 'smooth' });
    }

    if (currentResult.mode === 'word' && active) {
      const words = active.querySelectorAll('.vivi-lyrics-word');
      words.forEach((w) => {
        const ws = Number(w.dataset.start);
        const we = Number(w.dataset.end);

        let state;
        if (nowMs >= we) state = 'sung';
        else if (nowMs >= ws) state = 'active';
        else state = 'upcoming';

        // Only touch the DOM when a word's state actually changes, so the
        // fill transition isn't restarted every animation frame.
        if (w.dataset.fillState === state) return;
        w.dataset.fillState = state;
        w.classList.toggle('vivi-lyrics-word-sung', state === 'sung');

        if (settings.lyricsAnimationStyle === 'glow') {
          // Glow-up: instead of a sweeping gradient fill, the word snaps to
          // "sung" color and gets a brief glow pulse exactly as it starts,
          // fading back out over the rest of its spoken duration.
          w.classList.toggle('vivi-lyrics-word-glowing', state === 'active');
          if (state === 'active') {
            w.style.transitionDuration = '0s';
            void w.offsetWidth;
            const dur = Math.max(150, we - ws);
            w.style.transitionDuration = dur + 'ms';
          } else {
            w.style.transitionDuration = '150ms';
          }
        } else if (settings.lyricsAnimationStyle === 'bounce') {
          // Word bounce: the whole active line is already lit up (see CSS),
          // and each word pops with a quick spring scale exactly as it's
          // sung, landing back at rest before the next word starts.
          if (state === 'active') {
            w.classList.remove('vivi-lyrics-word-bouncing');
            void w.offsetWidth;
            w.classList.add('vivi-lyrics-word-bouncing');
          } else {
            w.classList.remove('vivi-lyrics-word-bouncing');
          }
        } else if (state === 'sung') {
          // Snap straight to fully filled (covers seeks/skips landing past
          // the word's end without ever passing through 'active').
          w.style.transitionDuration = '0s';
          w.style.backgroundPosition = '0% 0';
        } else if (state === 'active') {
          // Reset to unfilled, force a reflow, then animate the fill sweep
          // across exactly this word's spoken duration so it lands right
          // as the word finishes — a smooth "karaoke" fill instead of a glow.
          w.style.transitionDuration = '0s';
          w.style.backgroundPosition = '100% 0';
          void w.offsetWidth;
          const dur = Math.max(0, we - ws);
          w.style.transitionDuration = dur + 'ms';
          w.style.transitionTimingFunction = 'linear';
          w.style.backgroundPosition = '0% 0';
        } else {
          w.style.transitionDuration = '0s';
          w.style.backgroundPosition = '100% 0';
        }
      });
    }
  }

  function getCurrentVideoId() {
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

  async function handleTrack(track) {
    if (!settings.lyricsEnabled) return;
    if (!track) return;
    const key = `${track.artist}—${track.song}`;
    if (key === currentTrackKey) return;
    currentTrackKey = key;
    currentResult = null;
    isLoadingLyrics = true;
    contentDirty = true;
    sponsorOffsetMs = 0;
    manualOffsetMs = 0;
    savedOffsetMs = 0;
    offsetPanelOpen = false;

    enableLyricsTabIfDisabled();
    if (settings.autoSwitchLyrics) clickLyricsTabWithRetry();

    const durationEl = getVideoEl();
    const trackWithDuration = {
      ...track,
      duration: durationEl?.duration ? Math.round(durationEl.duration) : null,
      videoId: getCurrentVideoId(),
    };
    currentTrack = trackWithDuration;
    currentIsVideo = !!window.__viviTrackInfo?.isRealMusicVideo?.();

    // Real music videos can be opted out of lyrics entirely — skip the
    // network round-trip altogether and show the dancer placeholder.
    if (!settings.lyricsShowForVideos && currentIsVideo) {
      isLoadingLyrics = false;
      currentResult = VIDEO_BLOCKED;
      syncPanelVisibility();
      // No network fetch means no natural delay for the tab bar to finish
      // mounting/switching — nudge the sync again shortly after so the
      // panel still appears once clickLyricsTabWithRetry() actually lands.
      setTimeout(scheduleSync, 200);
      setTimeout(scheduleSync, 600);
      return;
    }

    syncPanelVisibility();

    await runLyricsFetch(trackWithDuration, key, { keepOffsetPanelOpen: false });
  }

  // Shared fetch-and-render path, called on every track change. There is
  // no lyrics cache — this always hits the lyrics providers fresh.
  async function runLyricsFetch(trackWithDuration, key, { keepOffsetPanelOpen }) {
    const excludeKeys = await loadExcludedProviders(trackWithDuration);
    if (key !== currentTrackKey) return; // track changed again while awaiting the exclusion lookup
    const result = await window.__viviLyrics.fetchBestLyrics(trackWithDuration, { excludeKeys });
    if (key !== currentTrackKey) return; // track changed again while fetching

    // YT Music's video-vs-song signals (views/likes byline, native pixel
    // ratio) are frequently not settled yet at the moment the track first
    // changes — re-check now that time has passed so a video that only
    // "revealed itself" mid-fetch still gets the placeholder instead of
    // lyrics flashing briefly before being replaced.
    currentIsVideo = !!window.__viviTrackInfo?.isRealMusicVideo?.();
    if (!settings.lyricsShowForVideos && currentIsVideo) {
      isLoadingLyrics = false;
      currentResult = VIDEO_BLOCKED;
      contentDirty = true;
      syncPanelVisibility();
      return;
    }

    isLoadingLyrics = false;
    currentResult = result;
    contentDirty = true;
    offsetPanelOpen = keepOffsetPanelOpen && !!result && result.mode !== 'plain';
    // Render immediately — don't gate the panel/offset button on the
    // chrome.storage round-trip below. fetchBestLyrics() can resolve
    // before YT Music has finished (re)mounting its own tab strip.
    // Previously we awaited loadOffset() first and only synced afterwards,
    // which just shifted the race later without fixing it — the offset
    // "i" button would silently stay missing until *something else*
    // happened to trigger the MutationObserver again (hence "works after
    // a refresh", where the extra page-load delay hides the race).
    syncPanelVisibility();
    // Belt-and-suspenders: nudge the sync a couple more times shortly
    // after, same as the video-blocked path below, in case the tab strip
    // was still mounting at the moment above and findTabByLabel('lyrics')
    // came back empty.
    setTimeout(scheduleSync, 200);
    setTimeout(scheduleSync, 600);

    // Restore any previously saved manual correction for this exact
    // song + artist + provider combination.
    manualOffsetMs = result ? await loadOffset(trackWithDuration, result.provider) : 0;
    savedOffsetMs = manualOffsetMs;
    if (key !== currentTrackKey) return; // track changed again while awaiting the offset lookup

    updateOffsetPanelValue();
  }

  function watchTabHost() {
    tabObserver?.disconnect();
    
    tabObserver = new MutationObserver(() => {
      enableLyricsTabIfDisabled();
      scheduleSync();
    });
    tabObserver.observe(document.documentElement, {
      childList: true,
      subtree: true,
      attributes: true,
      attributeFilter: ['aria-selected', 'selected', 'disabled', 'aria-disabled'],
    });
  }


  document.addEventListener('click', (e) => {
    const tab = e.target.closest('ytmusic-player-page tp-yt-paper-tab, ytmusic-player-page yt-tab-shape');
    if (!tab) return;

    enableLyricsTabIfDisabled();
    const host = findTabContentHost();
    if (host) {
      Array.from(host.children).forEach((child) => {
        if (child.id !== PANEL_ID) child.style.display = '';
      });
    }
    scheduleSync();
    nudgeRelayout();
  }, true);

  watchTabHost();
  tick();

  window.__viviLyricsUI = { handleTrack, setSponsorOffset };
})();
