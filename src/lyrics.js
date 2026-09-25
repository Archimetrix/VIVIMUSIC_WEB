/**
 * VIVIMUSIC WEB — lyrics.js
 */

(() => {
  'use strict';

  const BETTERLYRICS_BASE = 'https://lyrics-api.boidu.dev';
  const UNISON_BASE       = 'https://unison.boidu.dev';
  const LRCLIB_BASE       = 'https://lrclib.net/api';
  // BiniLyrics — separate word-synced (TTML) catalog, same one used by
  // Better Lyrics upstream and by other YTM lyrics clients. Two-step:
  // search returns candidate results with a lyricsUrl, then that URL is
  // fetched separately to get the actual TTML document.
  const BINILYRICS_BASE   = 'https://lyrics-api.binimum.org';
  const FETCH_TIMEOUT     = 9000;
  const GRACE_PERIOD_MS   = 500; 
  const PRIORITY_WAIT_MS  = 2000;
  const DEBUG             = false;

  const log = (...a) => DEBUG && console.log('[Vivi:Lyrics]', ...a);

  
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
  let providerSettings = { ...DEFAULT_PROVIDERS };

  // Provider priority: when enabled, all race-eligible providers below are
  // still requested in parallel (nothing is skipped or delayed), but once
  // they've all settled the result is chosen by walking this ordered list
  // instead of "first/best to reply". Spotify is never part of this — it
  // stays a sequential fallback tried only when nothing else has anything,
  // same as before. Capped at 3 entries to keep the UI (and the user's
  // mental model of "pick my top 3") simple.
  const PRIORITY_ELIGIBLE_KEYS = ['betterlyricsTTML', 'betterlyricsKugou', 'betterlyricsLegacy', 'lrclib', 'musixmatch', 'unison', 'binilyrics'];
  let priorityEnabled = false;
  let priorityOrder = [];
  // When true, a lower-priority reply waits up to PRIORITY_WAIT_MS to see if
  // a higher-priority provider is about to answer too, before committing.
  // When false, whichever of the (up to 3) priority providers answers first
  // wins outright, with no wait.
  let priorityWaitEnabled = true;

  chrome.storage.local.get(
    { lyricsProviders: DEFAULT_PROVIDERS, lyricsPriorityEnabled: false, lyricsPriorityOrder: [], lyricsPriorityWaitEnabled: true },
    (s) => {
      providerSettings = { ...DEFAULT_PROVIDERS, ...s.lyricsProviders };
      priorityEnabled = !!s.lyricsPriorityEnabled;
      priorityOrder = Array.isArray(s.lyricsPriorityOrder) ? s.lyricsPriorityOrder.slice(0, 3) : [];
      priorityWaitEnabled = s.lyricsPriorityWaitEnabled !== false;
    }
  );

  chrome.runtime.onMessage.addListener((msg) => {
    if (msg.type !== 'VIVI_SETTINGS') return;
    if (msg.lyricsProviders) providerSettings = { ...providerSettings, ...msg.lyricsProviders };
    if ('lyricsPriorityEnabled' in msg) priorityEnabled = !!msg.lyricsPriorityEnabled;
    if ('lyricsPriorityOrder' in msg) priorityOrder = Array.isArray(msg.lyricsPriorityOrder) ? msg.lyricsPriorityOrder.slice(0, 3) : [];
    if ('lyricsPriorityWaitEnabled' in msg) priorityWaitEnabled = msg.lyricsPriorityWaitEnabled !== false;
  });

  
  function withTimeout(promise, ms) {
    return Promise.race([
      promise,
      new Promise((_, rej) => setTimeout(() => rej(new Error('timeout')), ms)),
    ]);
  }

  async function safeFetchJson(url, opts) {
    try {
      const res = await withTimeout(fetch(url, opts), FETCH_TIMEOUT);
      if (!res.ok) return null;
      return await res.json();
    } catch (e) {
      log('fetch failed', url, e.message);
      return null;
    }
  }

  async function safeFetchText(url, opts) {
    try {
      const res = await withTimeout(fetch(url, opts), FETCH_TIMEOUT);
      if (!res.ok) return null;
      return await res.text();
    } catch (e) {
      log('fetch failed', url, e.message);
      return null;
    }
  }

  
  function parseTimeToMs(timeStr) {
    if (timeStr == null) return null;
    const parts = String(timeStr).split(':');
    let seconds = 0;
    if (parts.length === 3) {
      seconds = parseInt(parts[0], 10) * 3600 + parseInt(parts[1], 10) * 60 + parseFloat(parts[2]);
    } else if (parts.length === 2) {
      seconds = parseInt(parts[0], 10) * 60 + parseFloat(parts[1]);
    } else {
      seconds = parseFloat(parts[0]);
    }
    if (Number.isNaN(seconds)) return null;
    return Math.round(seconds * 1000);
  }

  
  function parseLRC(text) {
    if (!text) return null;
    const lineRe = /\[(\d{1,2}:\d{2}(?:\.\d{1,3})?)\]/g;
    const rawLines = text.split('\n');
    const lines = [];
    for (const raw of rawLines) {
      const matches = [...raw.matchAll(lineRe)];
      if (matches.length === 0) continue;
      const content = raw.replace(lineRe, '').trim();
      for (const m of matches) {
        const ms = parseTimeToMs(m[1]);
        if (ms == null) continue;
        lines.push({ start: ms, text: content });
      }
    }
    if (lines.length === 0) return null;
    lines.sort((a, b) => a.start - b.start);
    for (let i = 0; i < lines.length; i++) {
      lines[i].end = i < lines.length - 1 ? lines[i + 1].start : lines[i].start + 8000;
    }
    return { mode: 'line', lines };
  }

  
  function parseTTML(ttmlString) {
    if (!ttmlString) return null;
    let doc;
    try {
      doc = new DOMParser().parseFromString(ttmlString, 'text/xml');
      if (doc.querySelector('parsererror')) return null;
    } catch {
      return null;
    }
    const lines = [];
    doc.querySelectorAll('p').forEach((p) => {
      const words = [];
      // `pendingBreak` tracks whether we've seen a real whitespace text node
      // (or the very start of the line) since the last timed span. Some
      // word-synced TTML tags syllables individually, e.g.
      //   <span begin=..>explain</span><span begin=..>ing</span> <span begin=..>myself</span>
      // "explain"+"ing" have no text node between their tags, so they're
      // syllables of one word; the space before "myself" marks a real word
      // boundary. Without this, every timed span becomes its own "word" and
      // syllables render as visually separate words with a gap between them.
      let pendingBreak = true;
      (function collect(el) {
        el.childNodes.forEach((node) => {
          if (node.nodeType === 3) {
            if (/\s/.test(node.textContent)) pendingBreak = true;
            return;
          }
          if (node.nodeType === 1 && node.tagName.toLowerCase() === 'span') {
            const begin = node.getAttribute('begin');
            if (begin) {
              const start = parseTimeToMs(begin);
              const end = parseTimeToMs(node.getAttribute('end'));
              const text = node.textContent;
              if (!pendingBreak && words.length > 0) {
                // Syllable continuation of the previous word: merge instead
                // of pushing a new "word" entry.
                const prev = words[words.length - 1];
                prev.text += text;
                prev.end = end;
              } else {
                words.push({ text, start, end });
              }
              // A trailing space embedded in the span's own text also counts
              // as a break for whatever comes next.
              pendingBreak = /\s$/.test(text);
            } else {
              collect(node);
            }
          }
        });
      })(p);
      if (words.length === 0) return;
      const begin = p.getAttribute('begin');
      const end = p.getAttribute('end');
      lines.push({
        start: begin ? parseTimeToMs(begin) : words[0].start,
        end: end ? parseTimeToMs(end) : words[words.length - 1].end,
        words,
        text: words.map((w) => w.text).join('').trim(),
      });
    });
    if (lines.length === 0) return null;
    return { mode: 'word', lines };
  }

  function parsePlain(text) {
    if (!text || !text.trim()) return null;
    const lines = text.split('\n').filter((l) => l.trim() !== '').map((t) => ({ text: t.trim() }));
    if (lines.length === 0) return null;
    return { mode: 'plain', lines };
  }

  const MODE_RANK = { word: 3, line: 2, plain: 1 };
  function better(a, b) {
    if (!a) return b;
    if (!b) return a;
    return (MODE_RANK[b.mode] || 0) > (MODE_RANK[a.mode] || 0) ? b : a;
  }

  // Timed-sync sanity check — guards against a provider (search-based
  // matching can pick the wrong edit/version of a track: a remaster,
  // radio edit, extended mix, or live cut that shares the same title and
  // artist but has a different structure). Those mismatches often look
  // perfectly synced for the first line or two (shared intro) and then
  // drift — which is exactly what shows up as "word timing goes out of
  // sync partway through the song". We can't verify timing quality
  // directly, but we *can* check that the timed lyrics actually cover
  // roughly the same span as the audio; if the last timestamp is way off
  // from the track's real duration, the sync data almost certainly came
  // from a different recording and shouldn't be trusted for animation.
  //
  // Only applies to timed modes ('word'/'line') — 'plain' has no
  // timestamps to check. Skips the check entirely if we don't know the
  // track duration (nothing to compare against).
  function isTimingPlausible(parsed, track) {
    if (!parsed || parsed.mode === 'plain') return true;
    const durationMs = Number(track?.duration) > 0 ? Number(track.duration) * 1000 : null;
    if (!durationMs) return true;
    const lines = parsed.lines;
    if (!Array.isArray(lines) || lines.length === 0) return true;

    const lastLine = lines[lines.length - 1];
    const lastTimestamp = Number(lastLine.end ?? lastLine.start);
    if (!Number.isFinite(lastTimestamp)) return true;

    // Generous tolerance: synced lyrics legitimately end a bit before the
    // audio does (trailing instrumental/outro), and durations reported by
    // different sources can be off by a few seconds. But a mismatch of
    // more than ~25% of the track (with a 20s floor) means the lyrics
    // timeline and the audio timeline almost certainly belong to two
    // different recordings.
    const tolerance = Math.max(20000, durationMs * 0.25);
    return lastTimestamp <= durationMs + tolerance;
  }

  
  async function fromBetterLyricsTTML(track) {
    const qs = new URLSearchParams({ s: track.song, a: track.artist });
    if (track.duration) qs.set('d', String(track.duration));
    const data = await safeFetchJson(`${BETTERLYRICS_BASE}/getLyrics?${qs}`);
    if (!data || !data.ttml) return null;
    const parsed = parseTTML(data.ttml);
    if (!parsed) return null;
    if (!isTimingPlausible(parsed, track)) {
      log('BetterLyrics (TTML) result rejected: timing does not match track duration');
      return null;
    }
    parsed.provider = 'BetterLyrics (TTML)';
    return parsed;
  }

  async function fromBetterLyricsKugou(track) {
    const qs = new URLSearchParams({ s: track.song, a: track.artist });
    if (track.duration) qs.set('d', String(track.duration));
    const data = await safeFetchJson(`${BETTERLYRICS_BASE}/kugou/getLyrics?${qs}`);
    if (!data || !data.lyrics) return null;
    const parsed = parseLRC(data.lyrics);
    if (!parsed) return null;
    if (!isTimingPlausible(parsed, track)) {
      log('BetterLyrics (Kugou) result rejected: timing does not match track duration');
      return null;
    }
    parsed.provider = 'BetterLyrics (Kugou)';
    return parsed;
  }

  async function fromBetterLyricsLegacy(track) {
    const qs = new URLSearchParams({ s: track.song, a: track.artist });
    const data = await safeFetchJson(`${BETTERLYRICS_BASE}/legacy/getLyrics?${qs}`);
    if (!data) return null;
    if (data.lyrics) {
      const parsed = parseLRC(data.lyrics);
      if (parsed && isTimingPlausible(parsed, track)) { parsed.provider = 'BetterLyrics (Legacy)'; return parsed; }
      if (parsed) log('BetterLyrics (Legacy) result rejected: timing does not match track duration');
    }
    if (Array.isArray(data.lines)) {
      const lines = data.lines
        .map((l) => ({ start: l.startTimeMs ?? parseTimeToMs(l.time), text: l.words || l.text || '' }))
        .filter((l) => l.start != null);
      if (lines.length) {
        lines.sort((a, b) => a.start - b.start);
        for (let i = 0; i < lines.length; i++) {
          lines[i].end = i < lines.length - 1 ? lines[i + 1].start : lines[i].start + 8000;
        }
        const parsed = { mode: 'line', lines, provider: 'BetterLyrics (Legacy)' };
        if (!isTimingPlausible(parsed, track)) {
          log('BetterLyrics (Legacy) result rejected: timing does not match track duration');
          return null;
        }
        return parsed;
      }
    }
    return null;
  }

  async function fromLrclib(track) {
    const qs = new URLSearchParams({ artist_name: track.artist, track_name: track.song });
    if (track.duration) qs.set('duration', String(track.duration));
    let data = await safeFetchJson(`${LRCLIB_BASE}/get?${qs}`);
    if (!data || (!data.syncedLyrics && !data.plainLyrics)) {
      // Fall back to /search which is more forgiving about exact matches
      const searchQs = new URLSearchParams({ artist_name: track.artist, track_name: track.song });
      const results = await safeFetchJson(`${LRCLIB_BASE}/search?${searchQs}`);
      if (Array.isArray(results) && results.length) data = results[0];
    }
    if (!data) return null;
    if (data.syncedLyrics) {
      const parsed = parseLRC(data.syncedLyrics);
      if (parsed && isTimingPlausible(parsed, track)) { parsed.provider = 'LRCLIB'; return parsed; }
      if (parsed) log('LRCLIB result rejected: timing does not match track duration');
    }
    if (data.plainLyrics) {
      const parsed = parsePlain(data.plainLyrics);
      if (parsed) { parsed.provider = 'LRCLIB'; return parsed; }
    }
    return null;
  }

  // Unison — crowdsourced lyrics DB behind Better Lyrics (unison.boidu.dev).
  // GET /lyrics?song=&artist=&album=&duration= returns the single
  // highest-scored match; format is one of ttml/lrc/plain, same shapes our
  // existing parsers already handle for the other providers.
  async function fromUnison(track) {
    const qs = new URLSearchParams({ song: track.song, artist: track.artist });
    if (track.duration) qs.set('duration', String(track.duration));
    const res = await safeFetchJson(`${UNISON_BASE}/lyrics?${qs}`);
    const data = res && res.success ? res.data : null;
    if (!data || !data.lyrics) return null;

    let parsed = null;
    if (data.format === 'ttml') parsed = parseTTML(data.lyrics);
    else if (data.format === 'lrc') parsed = parseLRC(data.lyrics);
    else parsed = parsePlain(data.lyrics);

    if (!parsed) return null;
    // Unison returns a single "best match" from a crowdsourced DB with no
    // candidate list to disambiguate against — if it picked the wrong
    // version/edit of this song, the only signal we have is that its
    // timeline won't line up with the real track length.
    if (!isTimingPlausible(parsed, track)) {
      log('Unison result rejected: timing does not match track duration');
      return null;
    }
    parsed.provider = 'Unison';
    return parsed;
  }

  // BiniLyrics — /getLyrics?q= is a *search*, returning a list of candidate
  // matches, each with its own lyricsUrl pointing at a standalone TTML
  // document. We prefer a word-synced ("word") result if one is offered,
  // otherwise take the top hit, then fetch that URL separately and parse it
  // with the same TTML parser BetterLyrics (TTML) uses.
  async function fromBiniLyrics(track) {
    const query = `${track.song} ${track.artist || ''}`.trim();
    if (!query) return null;
    const qs = new URLSearchParams({ q: query });
    if (track.duration) qs.set('d', String(Math.round(track.duration)));
    const data = await safeFetchJson(`${BINILYRICS_BASE}/getLyrics?${qs}`);
    const results = data?.results;
    if (!Array.isArray(results) || results.length === 0) return null;

    // Search results can include duration metadata under a few different
    // key names depending on the entry's source catalog; use whichever is
    // present to prefer the candidate closest to the real track length,
    // instead of blindly trusting the API's own ranking or "is it word
    // synced" flag — a word-synced result for the wrong edit of the song
    // is worse than no word sync at all, since it desyncs partway through.
    const durationSec = Number(track.duration) || null;
    const candidateDuration = (r) => {
      const v = Number(r?.duration ?? r?.length ?? r?.duration_ms ? Number(r.duration_ms) / 1000 : r?.track_length);
      return Number.isFinite(v) && v > 0 ? v : null;
    };

    let ranked = results.slice();
    if (durationSec) {
      ranked = ranked
        .map((r) => ({ r, delta: (() => { const d = candidateDuration(r); return d == null ? null : Math.abs(d - durationSec); })() }))
        .sort((a, b) => {
          // Unknown-duration entries sort after known ones, but a
          // word-synced entry still gets priority among equally-plausible
          // (or equally-unknown) candidates.
          const aWord = a.r.timing_type === 'word' ? 0 : 1;
          const bWord = b.r.timing_type === 'word' ? 0 : 1;
          if ((a.delta == null) !== (b.delta == null)) return a.delta == null ? 1 : -1;
          if (a.delta != null && b.delta != null && Math.abs(a.delta - b.delta) > 3) return a.delta - b.delta;
          return aWord - bWord;
        })
        .map((x) => x.r);
    } else {
      // No known duration to disambiguate with — fall back to the old
      // "prefer word-synced" behavior.
      ranked = ranked.find((r) => r.timing_type === 'word') ? [ranked.find((r) => r.timing_type === 'word'), ...ranked] : ranked;
    }

    const best = ranked[0];
    if (!best || !best.lyricsUrl) return null;

    const ttmlText = await safeFetchText(best.lyricsUrl);
    if (!ttmlText) return null;

    const parsed = parseTTML(ttmlText);
    if (!parsed) return null;
    if (!isTimingPlausible(parsed, track)) {
      log('BiniLyrics result rejected: timing does not match track duration');
      return null;
    }
    parsed.provider = 'BiniLyrics';
    return parsed;
  }

  
  async function fromMusixmatch(track) {
    try {
      const response = await chrome.runtime.sendMessage({
        type: 'VIVI_MUSIXMATCH_LYRICS',
        track: {
          song: track.song,
          artist: track.artist,
          album: track.album || null,
          year: track.year || null,
          duration: track.duration || 0,
        },
      });
      if (!response?.ok || !response.lyrics) return null;
      const parsed = response.lyrics;
      if ((parsed.mode === 'word' || parsed.mode === 'line') && Array.isArray(parsed.lines)) {
        // Musixmatch's search can match a different edit/version of the
        // track (background.js narrows this further, but double-check
        // here too since this is the actual point where the fill-up
        // animation gets switched on for 'word' results).
        if (!isTimingPlausible(parsed, track)) {
          log('Musixmatch result rejected: timing does not match track duration');
          return null;
        }
        parsed.provider = 'Musixmatch';
        return parsed;
      }
      if (parsed.mode === 'plain' && Array.isArray(parsed.lines)) {
        parsed.provider = 'Musixmatch';
        return parsed;
      }
      return null;
    } catch (e) {
      log('musixmatch request failed', e?.message || e);
      return null;
    }
  }

  async function fromSpotify(track) {
    try {
      const response = await chrome.runtime.sendMessage({
        type: 'VIVI_SPOTIFY_LYRICS',
        track: { song: track.song, artist: track.artist }
      });
      if (!response?.ok || !response.lyrics) return null;
      const l = response.lyrics;
      if (l.mode === 'line' && Array.isArray(l.lines)) return { mode: 'line', lines: l.lines, provider: 'Spotify' };
      if (l.mode === 'plain' && l.text) {
        const parsed = parsePlain(l.text);
        if (parsed) parsed.provider = 'Spotify';
        return parsed;
      }
      return null;
    } catch (e) {
      log('Spotify lyrics failed', e?.message);
      return null;
    }
  }

  
  // Priority-aware provider resolution. Only the up-to-3 prioritized
  // providers are considered here — everything else in jobDefs is left
  // alone and only gets tried afterward, as a fallback, if none of these
  // three come through (see fetchBestLyrics).
  //
  // waitForBetter=true ("wait Ns for better provider"): a lower-priority
  // reply doesn't win immediately — it starts a PRIORITY_WAIT_MS grace
  // window so a higher-priority provider that's still in flight gets a
  // chance to preempt it. If the #1 priority provider itself replies with
  // a result, nothing can outrank it, so that resolves immediately with
  // no wait. If all three settle (success or failure) before the window
  // closes, resolution happens right away rather than sitting out the
  // full window for nothing.
  //
  // waitForBetter=false: strict "whoever answers first, among these
  // three, wins" — no grace window at all.
  async function racePriorityProviders(priorityJobs, waitForBetter) {
    return new Promise((resolve) => {
      let done = false;
      let settledCount = 0;
      let bestSoFar = null; // { value, rank } — lower rank = higher priority
      let graceTimer = null;
      const total = priorityJobs.length;

      const finish = (value) => {
        if (done) return;
        done = true;
        clearTimeout(graceTimer);
        resolve(value || null);
      };

      priorityJobs.forEach((job, rank) => {
        job.promise
          .then((value) => {
            settledCount++;
            if (value) {
              log('priority provider replied', job.key, 'rank', rank);
              if (!waitForBetter) {
                finish(value);
                return;
              }
              if (!bestSoFar || rank < bestSoFar.rank) bestSoFar = { value, rank };
              if (rank === 0) {
                // Top priority itself just answered — nothing left to wait for.
                finish(bestSoFar.value);
                return;
              }
              if (!graceTimer) {
                graceTimer = setTimeout(() => finish(bestSoFar.value), PRIORITY_WAIT_MS);
              }
            }
            if (settledCount === total) finish(bestSoFar ? bestSoFar.value : null);
          })
          .catch(() => {
            settledCount++;
            if (settledCount === total) finish(bestSoFar ? bestSoFar.value : null);
          });
      });
    });
  }

  function raceProviders(jobs) {
    return new Promise((resolve) => {
      let best = null;
      let remaining = jobs.length;
      let graceTimer = null;
      let done = false;

      const finish = () => {
        if (done) return;
        done = true;
        clearTimeout(graceTimer);
        resolve(best);
      };

      jobs.forEach((jobPromise) => {
        jobPromise
          .then((value) => {
            remaining--;
            if (value) {
              best = better(best, value);
              log('provider replied', value.provider, value.mode);
              // Start (or let run) the grace window on the first real hit.
              if (!graceTimer) graceTimer = setTimeout(finish, GRACE_PERIOD_MS);
            }
            if (remaining === 0) finish();
          })
          .catch(() => {
            remaining--;
            if (remaining === 0) finish();
          });
      });
    });
  }

  // Maps a provider's job key (used in providerSettings / priorityOrder) to
  // the human-readable `provider` string that ends up on the resolved
  // lyrics object (result.provider), and back again. Needed so the UI can
  // take "the provider currently on screen" and turn it into something
  // fetchBestLyrics() can exclude, without the UI having to duplicate this
  // list itself.
  const PROVIDER_NAME_BY_KEY = {
    betterlyricsTTML: 'BetterLyrics (TTML)',
    betterlyricsKugou: 'BetterLyrics (Kugou)',
    betterlyricsLegacy: 'BetterLyrics (Legacy)',
    lrclib: 'LRCLIB',
    musixmatch: 'Musixmatch',
    unison: 'Unison',
    binilyrics: 'BiniLyrics',
    spotify: 'Spotify',
  };
  const PROVIDER_KEY_BY_NAME = Object.fromEntries(
    Object.entries(PROVIDER_NAME_BY_KEY).map(([k, v]) => [v, k])
  );
  function providerKeyForName(name) {
    return PROVIDER_KEY_BY_NAME[name] || null;
  }

  // `excludeKeys` lets a caller ask for "everything except these providers"
  // — used by the "refetch from other providers" UI action to re-run
  // discovery while skipping whichever provider is currently on screen
  // (plus any providers the user has previously refetched away from for
  // this exact song). Purely an in-memory filter over which network
  // requests get made this call; nothing about it is cached or persisted
  // here — that bookkeeping lives in the UI layer.
  async function fetchBestLyrics(track, opts) {
    const excludeKeys = new Set((opts && opts.excludeKeys) || []);
    const jobDefs = [];
    if (providerSettings.betterlyricsTTML && !excludeKeys.has('betterlyricsTTML'))   jobDefs.push({ key: 'betterlyricsTTML', promise: fromBetterLyricsTTML(track) });
    if (providerSettings.betterlyricsKugou && !excludeKeys.has('betterlyricsKugou'))  jobDefs.push({ key: 'betterlyricsKugou', promise: fromBetterLyricsKugou(track) });
    if (providerSettings.lrclib && !excludeKeys.has('lrclib'))             jobDefs.push({ key: 'lrclib', promise: fromLrclib(track) });
    if (providerSettings.betterlyricsLegacy && !excludeKeys.has('betterlyricsLegacy')) jobDefs.push({ key: 'betterlyricsLegacy', promise: fromBetterLyricsLegacy(track) });
    if (providerSettings.musixmatch && !excludeKeys.has('musixmatch'))         jobDefs.push({ key: 'musixmatch', promise: fromMusixmatch(track) });
    if (providerSettings.unison && !excludeKeys.has('unison'))             jobDefs.push({ key: 'unison', promise: fromUnison(track) });
    if (providerSettings.binilyrics && !excludeKeys.has('binilyrics'))         jobDefs.push({ key: 'binilyrics', promise: fromBiniLyrics(track) });

    let best = null;
    if (jobDefs.length) {
      const orderedKeys = priorityEnabled
        ? priorityOrder.filter((k) => PRIORITY_ELIGIBLE_KEYS.includes(k) && jobDefs.some((j) => j.key === k))
        : [];
      if (orderedKeys.length) {
        const priorityJobs = orderedKeys.map((k) => jobDefs.find((j) => j.key === k));
        best = await racePriorityProviders(priorityJobs, priorityWaitEnabled);
        if (!best) {
          // None of the prioritized providers had anything — fall back to
          // whatever the rest of the enabled providers turn up, same
          // best-of race as the no-priority path.
          const remainingJobs = jobDefs.filter((j) => !orderedKeys.includes(j.key));
          if (remainingJobs.length) {
            log('priority list empty-handed, falling back to other enabled providers');
            best = await raceProviders(remainingJobs.map((j) => j.promise));
          }
        }
      } else {
        best = await raceProviders(jobDefs.map((j) => j.promise));
      }
    }

    // Spotify is tried last, only as a fallback when every other enabled
    // provider came back empty — never raced in parallel with them.
    if (!best && providerSettings.spotify && !excludeKeys.has('spotify')) {
      log('no result from other providers, trying Spotify as fallback');
      best = await fromSpotify(track);
    }

    if (!best) { log('all providers failed or disabled'); return null; }
    log('resolved', track, best?.provider, best?.mode);
    return best;
  }

  window.__viviLyrics = { fetchBestLyrics, parseTTML, parseLRC, parsePlain, providerKeyForName };
})();
