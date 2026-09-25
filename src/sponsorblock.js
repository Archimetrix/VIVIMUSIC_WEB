/**
 * VIVIMUSIC WEB — sponsorblock.js
 *
 * Fetches SponsorBlock "Non-Music Section" segments for the current video
 * (talking/intro/outro/skit parts of a music video that aren't the song
 * itself) using SponsorBlock's privacy-preserving hash-prefix API, and
 * exposes them so content.js can auto-skip through them.
 */

(() => {
  'use strict';

  const API_BASE       = 'https://sponsor.ajay.app/api';
  const CACHE_KEY_PFX   = 'vivi_sb_';
  const CACHE_TTL_MS    = 6 * 60 * 60 * 1000; // 6h — segments rarely change
  const FETCH_TIMEOUT   = 8000;
  const DEBUG           = true; // temporarily on — surfaces fetch/lookup failures in devtools console while we track down the skip issue
  const log = (...a) => DEBUG && console.log('[Vivi:SponsorBlock]', ...a);

  // "music_offtopic" is SponsorBlock's actual category for the non-music
  // parts of a music video (intros, outros, talking, skits, etc).
  const CATEGORIES = ['music_offtopic'];

  let enabled = true;
  chrome.storage.local.get({ sponsorBlockEnabled: true }, (s) => {
    enabled = s.sponsorBlockEnabled !== false;
  });
  chrome.runtime.onMessage.addListener((msg) => {
    if (msg.type === 'VIVI_SETTINGS' && 'sponsorBlockEnabled' in msg) {
      enabled = msg.sponsorBlockEnabled !== false;
    }
  });

  function withTimeout(promise, ms) {
    return Promise.race([
      promise,
      new Promise((_, rej) => setTimeout(() => rej(new Error('timeout')), ms)),
    ]);
  }

  async function sha256Hex(str) {
    const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(str));
    return Array.from(new Uint8Array(buf)).map((b) => b.toString(16).padStart(2, '0')).join('');
  }

  function readCache(videoId) {
    return new Promise((resolve) => {
      const key = CACHE_KEY_PFX + videoId;
      chrome.storage.local.get(key, (r) => {
        const entry = r[key];
        if (entry && Date.now() - entry.cachedAt < CACHE_TTL_MS) resolve(entry.segments);
        else resolve(null);
      });
    });
  }

  function writeCache(videoId, segments) {
    const key = CACHE_KEY_PFX + videoId;
    chrome.storage.local.set({ [key]: { segments, cachedAt: Date.now() } }, () => {
      if (chrome.runtime.lastError) return;
      evictOldCache();
    });
  }

  function evictOldCache() {
    chrome.storage.local.get(null, (all) => {
      const entries = Object.entries(all).filter(([k]) => k.startsWith(CACHE_KEY_PFX));
      const MAX = 500;
      if (entries.length <= MAX) return;
      entries.sort((a, b) => (a[1]?.cachedAt || 0) - (b[1]?.cachedAt || 0));
      const toRemove = entries.slice(0, entries.length - MAX).map(([k]) => k);
      if (toRemove.length) chrome.storage.local.remove(toRemove);
    });
  }

  // Returns an array of {start, end} in ms, sorted, for the given YouTube
  // video ID — or [] if none / disabled / lookup failed.
  async function getSegments(videoId) {
    if (!enabled) { log('disabled, skipping lookup'); return []; }
    if (!videoId) { log('no videoId, skipping lookup'); return []; }

    const cached = await readCache(videoId);
    if (cached) { log('cache hit for', videoId, cached); return cached; }

    try {
      const hash = await sha256Hex(videoId);
      const prefix = hash.slice(0, 4);
      const qs = new URLSearchParams({
        categories: JSON.stringify(CATEGORIES),
        actionTypes: JSON.stringify(['skip']),
      });
      const url = `${API_BASE}/skipSegments/${prefix}?${qs}`;
      log('fetching', url);
      const res = await withTimeout(fetch(url), FETCH_TIMEOUT);
      log('response status', res.status);
      // 404 just means nobody has submitted segments for anything in this
      // hash bucket — not an error.
      if (res.status === 404) { writeCache(videoId, []); return []; }
      if (!res.ok) { log('non-OK response, giving up'); return []; }

      const data = await res.json();
      if (!Array.isArray(data)) { log('unexpected response shape', data); return []; }

      const match = data.find((v) => v.videoID === videoId);
      if (!match || !Array.isArray(match.segments)) {
        log('no segments for this exact videoId among', data.length, 'hash-prefix matches');
        writeCache(videoId, []);
        return [];
      }

      const segments = match.segments
        .filter((s) => Array.isArray(s.segment) && s.segment.length === 2)
        .map((s) => ({ start: Math.round(s.segment[0] * 1000), end: Math.round(s.segment[1] * 1000) }))
        .filter((s) => {
          // Sanity guard: a genuine "non-music" segment is a talking/intro/
          // outro bit, not the song itself. Reject anything absurdly long
          // (bad/mislabeled submission) so a bad segment can't cause the
          // player to jump straight to the end of the track.
          const durationMs = s.end - s.start;
          if (durationMs <= 0) return false;
          if (durationMs > 120000) { log('rejecting oversized segment (>2min)', s); return false; }
          return true;
        })
        .sort((a, b) => a.start - b.start);

      writeCache(videoId, segments);
      log('segments for', videoId, segments);
      return segments;
    } catch (e) {
      log('lookup failed', videoId, e?.message);
      return [];
    }
  }

  window.__viviSponsorBlock = { getSegments, isEnabled: () => enabled };
})();
