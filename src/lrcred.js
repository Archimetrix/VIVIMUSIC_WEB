/**
 * VIVIMUSIC WEB — lrcred.js (background / service worker)
 *
 * lrc.red is keyed by ISRC:
 *   https://lrc.red/s/<ISRC>.ttml   word-synced (TTML)
 *   https://lrc.red/s/<ISRC>.lrc    line-synced (LRC)
 *
 * YouTube Music doesn't expose an ISRC, so we resolve one from the song's
 * title/artist/duration first — Apple Music's catalog (already used for
 * artwork, returns `isrc` on every song) with Deezer's public API as a
 * fallback. Runs in the service worker so host_permissions apply (no CORS).
 * Raw text is returned; parsing needs DOMParser so it happens in lyrics.js.
 */

'use strict';

const LRCRED_BASE = 'https://lrc.red/s';
const DEEZER_BASE = 'https://api.deezer.com';
const LRCRED_TIMEOUT_MS = 8000;
const ISRC_RE = /^[A-Z]{2}[A-Z0-9]{3}\d{7}$/;

const isrcCache = new Map(); // key -> { value: string[], expiresAtMs }
const ISRC_CACHE_TTL_MS = 1000 * 60 * 60 * 6;

function lrcredNorm(s) {
  return String(s || '')
    .toLowerCase()
    .normalize('NFKD').replace(/[\u0300-\u036f]/g, '')
    .replace(/\(.*?\)|\[.*?\]/g, ' ')
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
}

function lrcredArtistOk(wanted, got) {
  const w = lrcredNorm(wanted), g = lrcredNorm(got);
  if (!w || !g) return true; // can't verify — don't reject
  if (w.includes(g) || g.includes(w)) return true;
  const wt = new Set(w.split(' '));
  return g.split(' ').some((t) => t.length > 2 && wt.has(t));
}

// Rank candidates: title similarity + closeness to the real duration.
function lrcredScore(track, name, artist, durationSec) {
  if (!lrcredArtistOk(track.artist, artist)) return -Infinity;
  let score = 0;
  const a = lrcredNorm(track.song), b = lrcredNorm(name);
  if (a === b) score += 20;
  else if (a && b && (a.includes(b) || b.includes(a))) score += 8;
  else score -= 15;
  const want = Number(track.duration) || 0;
  if (want && durationSec) {
    const d = Math.abs(want - durationSec);
    if (d <= 2) score += 10;
    else if (d <= 5) score += 4;
    else if (d > 15) score -= 25;
  }
  return score;
}

async function lrcredFetch(url, asJson) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), LRCRED_TIMEOUT_MS);
  try {
    const res = await fetch(url, { signal: ctrl.signal });
    if (!res.ok) return null;
    return asJson ? await res.json() : await res.text();
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

async function isrcsFromApple(track) {
  if (typeof ampGet !== 'function') return [];
  const query = `${track.artist || ''} ${track.song}`.trim();
  const root = await ampGet('/v1/catalog/us/search', { term: query, types: 'songs', limit: '10' });
  const items = root?.results?.songs?.data;
  if (!Array.isArray(items)) return [];
  return items
    .map((it) => {
      const at = it.attributes || {};
      return {
        isrc: String(at.isrc || '').toUpperCase(),
        score: lrcredScore(track, at.name, at.artistName, (at.durationInMillis || 0) / 1000),
      };
    })
    .filter((c) => ISRC_RE.test(c.isrc) && c.score > 0)
    .sort((x, y) => y.score - x.score)
    .map((c) => c.isrc);
}

async function isrcsFromDeezer(track) {
  const q = `artist:"${(track.artist || '').split(',')[0].trim()}" track:"${track.song}"`;
  const search = await lrcredFetch(`${DEEZER_BASE}/search?limit=5&q=${encodeURIComponent(q)}`, true);
  const hits = Array.isArray(search?.data) ? search.data : [];
  const ranked = hits
    .map((h) => ({ id: h.id, score: lrcredScore(track, h.title, h.artist?.name, h.duration) }))
    .filter((h) => h.score > 0)
    .sort((x, y) => y.score - x.score)
    .slice(0, 2);
  const out = [];
  for (const h of ranked) {
    const full = await lrcredFetch(`${DEEZER_BASE}/track/${h.id}`, true);
    const isrc = String(full?.isrc || '').toUpperCase();
    if (ISRC_RE.test(isrc)) out.push(isrc);
  }
  return out;
}

async function resolveIsrcs(track) {
  const key = `${lrcredNorm(track.song)}|${lrcredNorm(track.artist)}|${Math.round(track.duration || 0)}`;
  const hit = isrcCache.get(key);
  if (hit && hit.expiresAtMs > Date.now()) return hit.value;

  let isrcs = [];
  try { isrcs = await isrcsFromApple(track); } catch { isrcs = []; }
  if (!isrcs.length) {
    try { isrcs = await isrcsFromDeezer(track); } catch { isrcs = []; }
  }
  isrcs = [...new Set(isrcs)].slice(0, 3);
  if (isrcs.length) isrcCache.set(key, { value: isrcs, expiresAtMs: Date.now() + ISRC_CACHE_TTL_MS });
  return isrcs;
}

/**
 * @param {{song:string, artist:string, duration?:number}} track
 * @returns {Promise<{format:'ttml'|'lrc', text:string, isrc:string}|null>}
 */
async function getLrcRedLyrics(track) {
  if (!track || !track.song) return null;
  const isrcs = await resolveIsrcs(track);
  for (const isrc of isrcs) {
    const [ttml, lrc] = await Promise.all([
      lrcredFetch(`${LRCRED_BASE}/${isrc}.ttml`, false),
      lrcredFetch(`${LRCRED_BASE}/${isrc}.lrc`, false),
    ]);
    // Prefer word-synced TTML; the content script falls back to the LRC
    // text if the TTML turns out to have no usable word timing.
    if (ttml && ttml.includes('<')) return { format: 'ttml', text: ttml, lrc: lrc || null, isrc };
    if (lrc && lrc.trim()) return { format: 'lrc', text: lrc, lrc, isrc };
  }
  return null;
}

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (msg?.type !== 'VIVI_LRCRED_LYRICS') return undefined;
  getLrcRedLyrics(msg.track || {})
    .then((data) => sendResponse({ ok: !!data, data: data || null }))
    .catch((e) => sendResponse({ ok: false, error: String(e?.message || e) }));
  return true;
});
