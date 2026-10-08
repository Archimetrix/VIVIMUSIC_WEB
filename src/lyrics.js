/**
 * VIVIMUSIC WEB — lyrics.js
 */

(() => {
  'use strict';

  // Better Lyrics moved to betterlyrics.org; the old boidu.dev hosts are kept
  // as a fallback that is only tried on a network error / 5xx (never on a
  // plain "no lyrics" 404, so misses don't cost a second request).
  const BETTERLYRICS_BASES = ['https://api.betterlyrics.org', 'https://lyrics-api.boidu.dev'];
  const UNISON_BASES       = ['https://unison.betterlyrics.org', 'https://unison.boidu.dev'];
  const LRCLIB_BASE       = 'https://lrclib.net/api';
  // BiniLyrics — separate word-synced (TTML) catalog, same one used by
  // Better Lyrics upstream and by other YTM lyrics clients. Two-step:
  // search returns candidate results with a lyricsUrl, then that URL is
  // fetched separately to get the actual TTML document.
  const BINILYRICS_BASE   = 'https://lyrics-api.binimum.org';
  const FETCH_TIMEOUT     = 9000;
  const PRIORITY_WAIT_MS  = 2000;
  // Priority OFF: the first reply is shown at once; for this long afterwards
  // later replies are compared and the best level (syllable > word > line >
  // plain) replaces it. Never longer than this.
  const UPGRADE_WINDOW_MS = 1000;
  const DEBUG             = false;

  const log = (...a) => DEBUG && console.log('[Vivi:Lyrics]', ...a);

  
  const DEFAULT_PROVIDERS = {
    lrcred: true,
    betterlyricsTTML: true,
    betterlyricsKugou: true,
    betterlyricsLegacy: true,
    betterlyricsPortato: true,
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
  // Only providers that can deliver syllable- or word-level sync may be put
  // in the top-3 priority list (line-only sources — Legato/Kugou, Legacy,
  // LRCLIB — are not offered there). A priority provider's
  // reply is shown whatever level it turns out to be, even line-synced.
  const PRIORITY_ELIGIBLE_KEYS = ['lrcred', 'betterlyricsTTML', 'betterlyricsPortato', 'unison', 'binilyrics', 'musixmatch'];
  const sanitizeOrder = (arr) => (Array.isArray(arr) ? arr : [])
    .filter((k, i, a) => PRIORITY_ELIGIBLE_KEYS.includes(k) && a.indexOf(k) === i)
    .slice(0, 3);
  // Defaults: lrc.red first, then BiniLyrics, then BetterLyrics (word-sync).
  const DEFAULT_PRIORITY_ORDER = ['lrcred', 'binilyrics', 'unison'];
  let priorityEnabled = true;
  let priorityOrder = DEFAULT_PRIORITY_ORDER.slice();
  // When true, a lower-priority reply waits up to PRIORITY_WAIT_MS to see if
  // a higher-priority provider is about to answer too, before committing.
  // When false, whichever of the (up to 3) priority providers answers first
  // wins outright, with no wait.
  let priorityWaitEnabled = false;

  chrome.storage.local.get(
    { lyricsProviders: DEFAULT_PROVIDERS, lyricsPriorityEnabled: true, lyricsPriorityOrder: DEFAULT_PRIORITY_ORDER, lyricsPriorityWaitEnabled: false },
    (s) => {
      providerSettings = { ...DEFAULT_PROVIDERS, ...s.lyricsProviders };
      priorityEnabled = !!s.lyricsPriorityEnabled;
      priorityOrder = sanitizeOrder(s.lyricsPriorityOrder);
      priorityWaitEnabled = s.lyricsPriorityWaitEnabled === true;
    }
  );

  chrome.runtime.onMessage.addListener((msg) => {
    if (msg.type !== 'VIVI_SETTINGS') return;
    if (msg.lyricsProviders) providerSettings = { ...providerSettings, ...msg.lyricsProviders };
    if ('lyricsPriorityEnabled' in msg) priorityEnabled = !!msg.lyricsPriorityEnabled;
    if ('lyricsPriorityOrder' in msg) priorityOrder = sanitizeOrder(msg.lyricsPriorityOrder);
    if ('lyricsPriorityWaitEnabled' in msg) priorityWaitEnabled = msg.lyricsPriorityWaitEnabled === true;
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

  // Tries each base in order; moves on to the next only on a network error,
  // timeout or 5xx — a clean 404/401 ("no lyrics") is a real answer.
  async function fetchJsonFromBases(bases, path, qs) {
    for (const base of bases) {
      try {
        const res = await withTimeout(fetch(`${base}${path}?${qs}`), FETCH_TIMEOUT);
        if (res.ok) return await res.json();
        if (res.status < 500) return null;
      } catch (e) {
        log('fetch failed', base, path, e.message);
      }
    }
    return null;
  }

  function baseQuery(track) {
    const qs = new URLSearchParams({ s: track.song, a: track.artist || '' });
    if (track.album) qs.set('al', track.album);
    if (track.duration) qs.set('d', String(Math.round(track.duration)));
    return qs;
  }

  function checkTiming(parsed, track, label) {
    if (!parsed) return null;
    if (!isTimingPlausible(parsed, track)) {
      log(label + ' result rejected: timing does not match track duration');
      return null;
    }
    return parsed;
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
    const str = String(timeStr).trim();
    // TTML offset-time ("432.25s", "250ms", "5m")
    const off = /^(\d+(?:\.\d+)?)(ms|s|m|h)$/.exec(str);
    if (off) {
      const n = parseFloat(off[1]);
      return Math.round(n * { ms: 1, s: 1000, m: 60000, h: 3600000 }[off[2]]);
    }
    const parts = str.split(':');
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

  // ── Word / syllable model ────────────────────────────────────────────────
  // Every timed lyric line can carry `words`. Each word is
  //   { text, start, end, syllables: [{ text, start, end }], joined?, bg? }
  // `joined` = no space follows this word (CJK text / punctuation glued on),
  // `bg`     = background / backing vocal.
  // A result is mode 'syllable' when at least one word is split into several
  // independently timed syllables, 'word' when the source only times whole
  // words, 'line' when it only times lines.
  const CJK_RE = /[\u3040-\u30ff\u3400-\u9fff\uac00-\ud7af\uff00-\uffef]/;

  // parts: [{ text, start, end, bg? }] — text may carry leading/trailing
  // whitespace, which is what marks the word boundaries.
  function buildWordsFromParts(parts) {
    const words = [];
    let cur = null;
    let pendingBreak = true;
    for (const part of parts) {
      const raw = String(part.text ?? '');
      const t = raw.trim();
      if (/^\s/.test(raw)) pendingBreak = true;
      if (t === '') { pendingBreak = true; continue; }
      const prev = cur && cur.syllables[cur.syllables.length - 1];
      // CJK has no spaces: every character/token is its own word so long
      // lines can still wrap, but no gap is rendered between them.
      const cjkBoundary = !pendingBreak && cur && (CJK_RE.test(t[0]) || CJK_RE.test(prev.text.slice(-1)));
      const bgChange = cur && !!cur.bg !== !!part.bg;
      if (pendingBreak || !cur || cjkBoundary || bgChange) {
        if (cur && !pendingBreak) cur.joined = true;
        cur = { text: '', start: part.start, end: part.end, syllables: [], bg: !!part.bg };
        words.push(cur);
      }
      cur.syllables.push({ text: t, start: part.start, end: part.end });
      cur.text += t;
      cur.end = part.end;
      pendingBreak = /\s$/.test(raw);
    }
    return words;
  }

  // Make sure every syllable has a sane [start, end) (missing / zero-length
  // ends fall back to the next syllable's start or the line end).
  function repairTimings(words, lineEnd) {
    const flat = [];
    words.forEach((w) => w.syllables.forEach((sy) => flat.push(sy)));
    for (let i = 0; i < flat.length; i++) {
      const sy = flat[i];
      const next = flat[i + 1];
      if (sy.end == null || !(sy.end > sy.start)) {
        sy.end = next ? Math.max(next.start, sy.start + 1) : Math.max(lineEnd || 0, sy.start + 300);
      }
    }
    words.forEach((w) => {
      w.start = w.syllables[0].start;
      w.end = w.syllables[w.syllables.length - 1].end;
    });
  }

  function finalizeResult(lines) {
    if (!lines.length) return null;
    let rich = false, split = false;
    for (const l of lines) {
      if (l.words && l.words.length) {
        rich = true;
        if (l.words.some((w) => w.syllables.length > 1)) split = true;
      }
    }
    return { mode: split ? 'syllable' : rich ? 'word' : 'line', lines };
  }

  function parseTTML(ttmlString) {
    if (!ttmlString) return null;
    let doc;
    try {
      doc = new DOMParser().parseFromString(String(ttmlString).replace(/\\"/g, '"'), 'text/xml');
      if (doc.querySelector('parsererror')) return null;
    } catch {
      return null;
    }
    const roleOf = (el) => el.getAttribute('ttm:role') || el.getAttribute('role') || '';
    const lines = [];
    doc.querySelectorAll('p').forEach((p) => {
      const parts = [];
      (function collect(el, inBg) {
        el.childNodes.forEach((node) => {
          if (node.nodeType === 3) {
            // Whitespace-only text between timed spans = a word boundary.
            if (/\s/.test(node.textContent) && parts.length) {
              const last = parts[parts.length - 1];
              if (!/\s$/.test(last.text)) last.text += ' ';
            }
            return;
          }
          if (node.nodeType !== 1 || node.tagName.toLowerCase() !== 'span') return;
          const role = roleOf(node);
          if (role === 'x-translation' || role === 'x-roman') return;
          const bg = inBg || role === 'x-bg';
          const begin = node.getAttribute('begin');
          const hasChildSpans = node.querySelector('span[begin]');
          if (begin && !hasChildSpans) {
            parts.push({
              text: node.textContent,
              start: parseTimeToMs(begin),
              end: parseTimeToMs(node.getAttribute('end')),
              bg,
            });
          } else {
            collect(node, bg);
          }
        });
      })(p, false);

      const pBegin = p.getAttribute('begin');
      const pEnd = p.getAttribute('end');
      const lineStartAttr = pBegin ? parseTimeToMs(pBegin) : null;
      const lineEndAttr = pEnd ? parseTimeToMs(pEnd) : null;
      const usable = parts.filter((x) => x.start != null);

      if (usable.length === 0) {
        // Line-timed TTML: no timed spans, just the <p> text.
        const text = (p.textContent || '').replace(/\s+/g, ' ').trim();
        if (!text || lineStartAttr == null) return;
        lines.push({ start: lineStartAttr, end: lineEndAttr ?? lineStartAttr + 5000, text });
        return;
      }
      const words = buildWordsFromParts(usable);
      if (!words.length) return;
      const start = lineStartAttr ?? words[0].start;
      repairTimings(words, lineEndAttr ?? words[words.length - 1].end);
      const lastEnd = Math.max(...words.map((w) => w.end));
      const end = Math.max(lineEndAttr ?? lastEnd, lastEnd);
      lines.push({
        start: Math.min(start, words[0].start),
        end,
        words,
        text: words.map((w) => w.text + (w.joined ? '' : ' ')).join('').trim(),
      });
    });
    if (lines.length === 0) return null;
    lines.sort((a, b) => a.start - b.start);
    return finalizeResult(lines);
  }

  // Enhanced LRC — "[mm:ss.xx]<mm:ss.xx>word <mm:ss.xx>word <mm:ss.xx>" — the
  // word-level format Unison / lrc.red / Musixmatch-derived sources use.
  function parseEnhancedLRC(text) {
    if (!text || !/<\d{1,2}:\d{2}(?:\.\d{1,3})?>/.test(text)) return null;
    const lineTag = /^\s*\[(\d{1,2}:\d{2}(?:\.\d{1,3})?)\]/;
    const wordTag = /<(\d{1,2}:\d{2}(?:\.\d{1,3})?)>/g;
    const raw = [];
    for (const row of text.split(/\r?\n/)) {
      const m = lineTag.exec(row);
      if (!m) continue;
      const lineStart = parseTimeToMs(m[1]);
      const body = row.slice(m[0].length);
      const segs = [];
      let last = 0, curT = null;
      for (const t of body.matchAll(wordTag)) {
        const chunk = body.slice(last, t.index);
        if (curT !== null && chunk !== '') segs.push({ text: chunk, start: curT, end: parseTimeToMs(t[1]) });
        else if (curT === null && chunk.trim() !== '') segs.push({ text: chunk, start: lineStart, end: parseTimeToMs(t[1]) });
        curT = parseTimeToMs(t[1]);
        last = t.index + t[0].length;
      }
      const tail = body.slice(last);
      if (tail.trim() !== '' && curT !== null) segs.push({ text: tail, start: curT, end: null });
      raw.push({ start: lineStart, segs, plain: body.replace(wordTag, '').trim() });
    }
    raw.sort((a, b) => a.start - b.start);
    const lines = [];
    raw.forEach((r, i) => {
      const nextStart = i < raw.length - 1 ? raw[i + 1].start : r.start + 8000;
      if (!r.segs.length) {
        if (r.plain) lines.push({ start: r.start, end: nextStart, text: r.plain });
        return;
      }
      const words = buildWordsFromParts(r.segs);
      if (!words.length) return;
      repairTimings(words, nextStart);
      lines.push({
        start: r.start,
        end: Math.max(nextStart, words[words.length - 1].end),
        words,
        text: words.map((w) => w.text + (w.joined ? '' : ' ')).join('').trim(),
      });
    });
    return finalizeResult(lines);
  }

  // QRC (QQ Music, "Better Lyrics Portato"): "[lineStart,lineDur]text(start,dur)text(start,dur)".
  // The body lives in a LyricContent="…" XML attribute.
  const QRC_CREDIT_RE = /^(作词|作曲|词|曲|编曲|制作人|混音|录音|母带|监制|和声|吉他|贝斯|鼓|OP|SP|(?:Lyrics?|Written|Composed|Composer|Produced|Producer|Arranged|Arranger|Mixed|Mastered|Recorded|Publisher|Published)(?:\s+by)?)\s*[:：]/i;
  function parseQRC(raw, durationMs, meta) {
    if (!raw) return null;
    let body = String(raw);
    const m = /LyricContent="([\s\S]*?)"\s*(?:\/?>|[a-zA-Z]+=)/.exec(body);
    if (m) {
      body = m[1].replace(/&quot;/g, '"').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&');
    }
    const norm = (x) => String(x || '').toLowerCase().replace(/[^a-z0-9\u3040-\u9fff\uac00-\ud7af]/g, '');
    const nt = norm(meta?.title), na = norm(meta?.artist);
    const rows = [];
    for (const rawRow of body.split(/\r?\n/)) {
      const row = rawRow.trim();
      if (!row || /^\[[a-zA-Z]+:/.test(row)) continue;
      const h = /^\[(\d+),(\d+)\]/.exec(row);
      if (!h) continue;
      const rest = row.slice(h[0].length);
      const parts = [];
      let last = 0;
      for (const t of rest.matchAll(/\((\d+),(\d+)\)/g)) {
        const text = rest.slice(last, t.index);
        last = t.index + t[0].length;
        if (text === '') continue;
        const start = parseInt(t[1], 10), dur = parseInt(t[2], 10);
        parts.push({ text, start, end: dur > 0 ? start + dur : null });
      }
      if (!parts.length) continue;
      const lineText = parts.map((x) => x.text).join('').trim();
      if (!lineText) continue;
      rows.push({ start: parseInt(h[1], 10), dur: parseInt(h[2], 10), parts, lineText });
    }
    // Drop the title/artist echo and credit lines QQ puts at the top.
    const kept = rows.filter((r, i) => {
      if (QRC_CREDIT_RE.test(r.lineText)) return false;
      if (i < 4) {
        const n = norm(r.lineText);
        if (nt && n.includes(nt) && (!na || n.includes(na) || n.length < nt.length + 15)) return false;
        if (na && n === na) return false;
      }
      return true;
    });
    const lines = [];
    kept.forEach((r, i) => {
      const nextStart = i < kept.length - 1 ? kept[i + 1].start : (durationMs || r.start + r.dur || r.start + 8000);
      const words = buildWordsFromParts(r.parts);
      if (!words.length) return;
      repairTimings(words, r.dur > 0 ? r.start + r.dur : nextStart);
      const end = Math.max(r.dur > 0 ? r.start + r.dur : nextStart, words[words.length - 1].end);
      lines.push({
        start: Math.min(r.start, words[0].start),
        end,
        words,
        text: words.map((w) => w.text + (w.joined ? '' : ' ')).join('').trim(),
      });
    });
    const res = finalizeResult(lines);
    // QQ tokens are whole words (or single CJK characters): by definition
    // word-level, so never advertise it as syllable-synced.
    if (res) res.mode = 'word';
    return res;
  }

  function parsePlain(text) {
    if (!text || !text.trim()) return null;
    const lines = text.split('\n').filter((l) => l.trim() !== '').map((t) => ({ text: t.trim() }));
    if (lines.length === 0) return null;
    return { mode: 'plain', lines };
  }

  // syllable > word > line > plain
  const MODE_RANK = { syllable: 4, word: 3, line: 2, plain: 1 };
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

  
  // Better Lyrics — syllable-synced TTML (falls back to line-level if the
  // document only times whole lines).
  async function fromBetterLyricsTTML(track) {
    const data = await fetchJsonFromBases(BETTERLYRICS_BASES, '/getLyrics', baseQuery(track));
    const ttml = data && (data.ttml || data.lyrics);
    if (!ttml) return null;
    const parsed = checkTiming(parseTTML(ttml), track, 'BetterLyrics (TTML)');
    if (!parsed) return null;
    parsed.provider = 'BetterLyrics (TTML)';
    return parsed;
  }

  // Better Lyrics Legato — Kugou, line-synced.
  async function fromBetterLyricsKugou(track) {
    const data = await fetchJsonFromBases(BETTERLYRICS_BASES, '/kugou/getLyrics', baseQuery(track));
    if (!data || !data.lyrics) return null;
    let text = data.lyrics;
    if (typeof text === 'string' && text.trim().startsWith('{')) {
      try { text = JSON.parse(text).lyrics || text; } catch { /* keep as is */ }
    }
    const parsed = checkTiming(parseLRC(text), track, 'BetterLyrics (Legato)');
    if (!parsed) return null;
    parsed.provider = 'BetterLyrics (Legato)';
    return parsed;
  }

  // Better Lyrics Portato — QQ Music QRC, word-synced.
  async function fromBetterLyricsPortato(track) {
    const data = await fetchJsonFromBases(BETTERLYRICS_BASES, '/qq/getLyrics', baseQuery(track));
    if (!data || !data.lyrics) return null;
    let text = data.lyrics;
    if (typeof text === 'string' && text.trim().startsWith('{')) {
      try { text = JSON.parse(text).lyrics || text; } catch { /* keep as is */ }
    }
    const parsed = checkTiming(
      parseQRC(text, Number(track.duration) > 0 ? Number(track.duration) * 1000 : 0, { title: track.song, artist: track.artist }),
      track, 'BetterLyrics (Portato)');
    if (!parsed) return null;
    parsed.provider = 'BetterLyrics (Portato)';
    return parsed;
  }

  async function fromBetterLyricsLegacy(track) {
    const qs = new URLSearchParams({ s: track.song, a: track.artist });
    // The legacy endpoint only exists on the original host.
    const data = await fetchJsonFromBases([...BETTERLYRICS_BASES].reverse(), '/legacy/getLyrics', qs);
    if (!data) return null;
    if (data.lyrics) {
      const parsed = parseLRC(data.lyrics);
      if (parsed && isTimingPlausible(parsed, track)) { parsed.provider = 'BetterLyrics (Legacy)'; return parsed; }
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
        return isTimingPlausible(parsed, track) ? parsed : null;
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
    const qs = new URLSearchParams({ song: track.song, artist: track.artist || '' });
    if (track.videoId) qs.set('v', track.videoId);
    if (track.album) qs.set('album', track.album);
    if (track.duration) qs.set('duration', String(Math.round(track.duration)));
    const res = await fetchJsonFromBases(UNISON_BASES, '/lyrics', qs);
    const data = res ? (res.data || (res.success ? res.data : null)) : null;
    if (!data || !data.lyrics) return null;

    // Unison stores: ttml (syllable or line), lrc (word-level "richsync" or
    // line-level "linesync"), plain.
    let parsed = null;
    if (data.format === 'ttml') parsed = parseTTML(data.lyrics);
    else if (data.format === 'lrc') {
      parsed = (data.syncType === 'richsync' ? parseEnhancedLRC(data.lyrics) : null)
        || parseEnhancedLRC(data.lyrics)
        || parseLRC(String(data.lyrics).replace(/<\d{1,2}:\d{2}(?:\.\d{1,3})?>/g, ''));
    } else parsed = parsePlain(data.lyrics);

    parsed = checkTiming(parsed, track, 'Unison');
    if (!parsed) return null;
    parsed.provider = 'Unison';
    return parsed;
  }

  // BiniLyrics — /getLyrics?q= is a *search*, returning a list of candidate
  // matches, each with its own lyricsUrl pointing at a standalone TTML
  // document. We prefer a word-synced ("word") result if one is offered,
  // otherwise take the top hit, then fetch that URL separately and parse it
  // with the same TTML parser BetterLyrics (TTML) uses.
  const isRichTiming = (t) => t === 'word' || t === 'syllable';
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
          const aWord = isRichTiming(a.r.timing_type) ? 0 : 1;
          const bWord = isRichTiming(b.r.timing_type) ? 0 : 1;
          if ((a.delta == null) !== (b.delta == null)) return a.delta == null ? 1 : -1;
          if (a.delta != null && b.delta != null && Math.abs(a.delta - b.delta) > 3) return a.delta - b.delta;
          return aWord - bWord;
        })
        .map((x) => x.r);
    } else {
      // No known duration to disambiguate with — fall back to the old
      // "prefer word-synced" behavior.
      const richHit = ranked.find((r) => isRichTiming(r.timing_type));
      ranked = richHit ? [richHit, ...ranked] : ranked;
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

  
  // lrc.red — keyed by ISRC. background.js (lrcred.js) resolves the ISRC and
  // downloads the raw TTML/LRC text; parsing happens here because it needs
  // DOMParser. Word-synced TTML is preferred; if it has no usable word
  // timing (or fails the duration sanity check) we fall back to its LRC.
  async function fromLrcRed(track) {
    try {
      const response = await chrome.runtime.sendMessage({
        type: 'VIVI_LRCRED_LYRICS',
        track: { song: track.song, artist: track.artist, duration: track.duration || 0 },
      });
      const d = response?.data;
      if (!response?.ok || !d) return null;

      if (d.format === 'ttml') {
        const parsed = parseTTML(d.text);
        if (parsed && isTimingPlausible(parsed, track)) { parsed.provider = 'lrc.red'; return parsed; }
        if (parsed) log('lrc.red TTML rejected: timing does not match track duration');
      }
      const lrcText = d.format === 'lrc' ? d.text : d.lrc;
      if (lrcText) {
        const enhanced = parseEnhancedLRC(lrcText);
        if (enhanced && isTimingPlausible(enhanced, track)) { enhanced.provider = 'lrc.red'; return enhanced; }
        // Enhanced-LRC word tags (<00:12.34>) would otherwise end up in the text.
        const cleaned = lrcText.replace(/<\d{1,2}:\d{2}(?:\.\d{1,3})?>/g, '');
        const synced = parseLRC(cleaned);
        if (synced) {
          if (!isTimingPlausible(synced, track)) { log('lrc.red LRC rejected: timing mismatch'); return null; }
          synced.provider = 'lrc.red';
          return synced;
        }
        const plain = parsePlain(cleaned.replace(/^\[[a-z]{2}:.*\]$/gim, ''));
        if (plain) { plain.provider = 'lrc.red'; return plain; }
      }
      return null;
    } catch (e) {
      log('lrc.red request failed', e?.message || e);
      return null;
    }
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
        if (parsed.mode === 'word') parsed.lines.forEach((l) => { if (Array.isArray(l.words)) l.words.forEach((w) => { if (!w.syllables) w.syllables = [{ text: w.text, start: w.start, end: w.end }]; }); });
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

  // Priority OFF path. The first reply is handed to onUpdate immediately so
  // lyrics appear as fast as possible; replies arriving within the next
  // UPGRADE_WINDOW_MS are compared by sync level and the best one replaces
  // it (onUpdate fires again). Resolves with the final best result.
  function raceProviders(jobs, onUpdate) {
    return new Promise((resolve) => {
      let best = null;
      let remaining = jobs.length;
      let timer = null;
      let done = false;

      const finish = () => {
        if (done) return;
        done = true;
        clearTimeout(timer);
        resolve(best);
      };

      jobs.forEach((jobPromise) => {
        jobPromise
          .then((value) => {
            remaining--;
            if (value && !done) {
              const prev = best;
              best = better(best, value);
              log('provider replied', value.provider, value.mode);
              if (!prev) {
                timer = setTimeout(finish, UPGRADE_WINDOW_MS);
              }
              if (best !== prev && typeof onUpdate === 'function') onUpdate(best);
              // Nothing outranks syllable sync — no reason to keep waiting.
              if (best.mode === 'syllable') finish();
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
    lrcred: 'lrc.red',
    betterlyricsTTML: 'BetterLyrics (TTML)',
    betterlyricsKugou: 'BetterLyrics (Legato)',
    betterlyricsLegacy: 'BetterLyrics (Legacy)',
    betterlyricsPortato: 'BetterLyrics (Portato)',
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
    if (name === 'BetterLyrics (Kugou)') return 'betterlyricsKugou'; // pre-rename label
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
    const onUpdate = opts && opts.onUpdate;
    const jobDefs = [];
    if (providerSettings.lrcred && !excludeKeys.has('lrcred'))                 jobDefs.push({ key: 'lrcred', promise: fromLrcRed(track) });
    if (providerSettings.betterlyricsTTML && !excludeKeys.has('betterlyricsTTML'))   jobDefs.push({ key: 'betterlyricsTTML', promise: fromBetterLyricsTTML(track) });
    if (providerSettings.betterlyricsKugou && !excludeKeys.has('betterlyricsKugou'))  jobDefs.push({ key: 'betterlyricsKugou', promise: fromBetterLyricsKugou(track) });
    if (providerSettings.betterlyricsPortato && !excludeKeys.has('betterlyricsPortato')) jobDefs.push({ key: 'betterlyricsPortato', promise: fromBetterLyricsPortato(track) });
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
            best = await raceProviders(remainingJobs.map((j) => j.promise), onUpdate);
          }
        }
      } else {
        best = await raceProviders(jobDefs.map((j) => j.promise), onUpdate);
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

  window.__viviLyrics = { fetchBestLyrics, parseTTML, parseLRC, parseEnhancedLRC, parseQRC, parsePlain, providerKeyForName };
})();
