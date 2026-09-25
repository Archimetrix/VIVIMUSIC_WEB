/**
 * VIVIMUSIC WEB — apple-canvas.js
 *
 * Fetches Apple Music's animated "motion artwork" (Canvas) directly from
 * Apple's own private catalog API, the same way the official web player
 * (music.apple.com) and the VIVIMUSIC Android app do it — no third-party
 * proxy (artwork.boidu.dev) involved.
 *
 * This only works from an extension's own privileged context (background
 * service worker), never from a content script: it needs to read the
 * response regardless of CORS, and needs `Origin`/`Referer` request headers
 * spoofed to look like music.apple.com's own web player — both of which
 * require host_permissions + declarativeNetRequest, not something a page's
 * own JS (or a content script sharing that page's fetch sandbox) can do.
 *
 * Two-part flow, mirroring AppleMusicCanvasProvider.kt:
 *
 *  1. getOrFetchAmpToken() — scrapes music.apple.com's own bundled JS for
 *     the short-lived JWT its web player uses to call its private API.
 *     This is inherently fragile (Apple owes us nothing here and can change
 *     their bundling at any time); a fallback token is baked in for when
 *     scraping comes up empty, same safety net the Android app keeps.
 *
 *  2. searchAndFetchMotion() / fetchMotionArtwork() — call
 *     amp-api.music.apple.com directly with that token, extract
 *     `editorialVideo`'s motion asset URL, and apply the same
 *     scoring/blacklist heuristics the Android resolver uses to avoid
 *     matching a random playlist/session/DJ-mix "album" instead of the
 *     track's real release.
 */

'use strict';

const AMP_BASE_URL = 'https://amp-api.music.apple.com';

// Public read-only JWT used by the Apple Music web player for unauthenticated
// catalog reads. This will eventually expire; getOrFetchAmpToken() always
// tries to scrape a fresh one first and only falls back to this.
const APPLE_MUSIC_TOKEN_FALLBACK =
  'eyJ0eXAiOiJKV1QiLCJhbGciOiJFUzI1NiIsImtpZCI6IldlYlBsYXlLaWQifQ' +
  '.eyJpc3MiOiJBTVBXZWJQbGF5IiwiaWF0IjoxNzgxMDMyODU1LCJleHAiOjE3ODQw' +
  'NTY4NTUsInJvb3RfaHR0cHNfb3JpZ2luIjpbImFwcGxlLmNvbSJdfQ' +
  '.fiMFcJWkfSlxKP9NVA0UW9CbItD1Rge0SISuepz203XcpU762OqdCpU9M-YkmtKkjRmaIWtjsfGgqZPrlMonpA';

let cachedAmpToken = null;
let ampTokenExpiryMs = 0;

function base64UrlDecode(str) {
  const padded = str.replace(/-/g, '+').replace(/_/g, '/').padEnd(str.length + (4 - (str.length % 4)) % 4, '=');
  const binary = atob(padded);
  // JWT payloads are UTF-8 JSON; atob() gives us a binary string, so decode
  // it byte-by-byte through TextDecoder rather than assuming latin1==utf8.
  const bytes = Uint8Array.from(binary, (c) => c.charCodeAt(0));
  return new TextDecoder('utf-8').decode(bytes);
}

async function getOrFetchAmpToken() {
  const now = Date.now();
  if (cachedAmpToken && now < ampTokenExpiryMs - 60_000) return cachedAmpToken;

  try {
    const htmlRes = await fetch('https://music.apple.com/us/browse');
    const html = await htmlRes.text();

    const scriptRe = /\/assets\/index(?:-legacy)?[~-][a-zA-Z0-9_-]+\.js/g;
    const scripts = [...new Set(html.match(scriptRe) || [])];

    for (const scriptPath of scripts) {
      let scriptText;
      try {
        const scriptRes = await fetch(`https://music.apple.com${scriptPath}`);
        scriptText = await scriptRes.text();
      } catch {
        continue;
      }

      const tokenRe = /ey[a-zA-Z0-9_-]+\.ey[a-zA-Z0-9_-]+\.[a-zA-Z0-9_-]+/g;
      const tokens = scriptText.match(tokenRe) || [];
      for (const token of tokens) {
        try {
          const payload = JSON.parse(base64UrlDecode(token.split('.')[1]));
          if (payload && payload.iss && payload.exp && payload.exp * 1000 > now) {
            cachedAmpToken = token;
            ampTokenExpiryMs = payload.exp * 1000;
            return token;
          }
        } catch {
          // not a real/decodable JWT — keep scanning
        }
      }
    }
  } catch {
    // network hiccup scraping music.apple.com — fall through to fallback token
  }

  return APPLE_MUSIC_TOKEN_FALLBACK;
}

async function ampGet(path, params) {
  const token = await getOrFetchAmpToken();
  const url = new URL(AMP_BASE_URL + path);
  for (const [k, v] of Object.entries(params || {})) {
    if (v !== undefined && v !== null && v !== '') url.searchParams.set(k, String(v));
  }
  // Origin/Referer are spoofed to music.apple.com's own by a
  // declarativeNetRequest session rule registered in background.js — fetch()
  // itself refuses to let script code set those (they're forbidden request
  // headers), which is exactly why this has to run here, not in content.js.
  let res;
  try {
    res = await fetch(url.toString(), {
      headers: { Authorization: `Bearer ${token}` },
    });
  } catch {
    return null;
  }
  if (!res.ok) return null;
  try {
    return await res.json();
  } catch {
    return null;
  }
}

function normalizeForComparison(s) {
  return (s || '')
    .toLowerCase()
    .normalize('NFKD').replace(/[\u0300-\u036f]/g, '') // strip accents
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
}

const ARTIST_DELIMITERS = /(?:\s*,\s*|\s*&\s*|\s+×\s+|\s+x\s+|\bfeat\.?\b|\bft\.?\b|\bfeaturing\b|\bwith\b)/i;

function artistMatches(requested, returned) {
  const req = (requested || '').split(ARTIST_DELIMITERS).map(normalizeForComparison).filter(Boolean);
  const ret = (returned || '').split(ARTIST_DELIMITERS).map(normalizeForComparison).filter(Boolean);
  if (!req.length || !ret.length) return false;
  return req.every((r) => ret.some((x) => x === r));
}

const BLACKLIST_WORDS = [
  'playlist', 'set list', 'essentials', 'dj mix', 'mixed', 'apple music', "today's hits", 'session',
];

function isBlacklistedAlbumName(name) {
  const lower = (name || '').toLowerCase();
  return BLACKLIST_WORDS.some((w) => lower.includes(w));
}

// Apple's motion-artwork payload can carry the actual media URL under any of
// a few different keys depending on the asset's shape (some are a segmented
// HLS manifest, some are a plain progressive file) — try each in turn.
function extractEditorialVideoUrl(ev, preferTall) {
  const order = preferTall
    ? ['motionDetailTall', 'motionDetailRaw', 'motionDetailSquare', 'motionDetailStatic']
    : ['motionDetailSquare', 'motionDetailRaw', 'motionDetailTall', 'motionDetailStatic'];
  for (const key of order) {
    const asset = ev?.[key];
    if (!asset) continue;
    const video = asset.video || asset.videoUrl || asset.hlsUrl || asset.url;
    if (video) return video;
  }
  return null;
}

async function fetchMotionArtwork(albumId, storefront, fallbackArtist, titleOverride, artistOverride) {
  if (!albumId || albumId.startsWith('pl.')) return null; // playlist id, not a real album

  const root = await ampGet(`/v1/catalog/${storefront}/albums/${albumId}`, {
    extend: 'editorialVideo',
    include: 'tracks',
  });
  const albumObj = root?.data?.[0];
  if (!albumObj) return null;

  const attributes = albumObj.attributes || {};
  const albumName = attributes.name || '';
  const artistName = attributes.artistName || fallbackArtist || null;

  if (isBlacklistedAlbumName(albumName)) return null;

  const finalTitle = titleOverride || albumName;
  const finalArtist = artistOverride || artistName;

  const ev = attributes.editorialVideo;
  if (ev) {
    const url = extractEditorialVideoUrl(ev, false);
    const tallUrl = extractEditorialVideoUrl(ev, true);
    if (url) {
      return {
        name: finalTitle,
        artist: finalArtist,
        albumId,
        albumName,
        animated: url,
        animatedTall: tallUrl || null,
      };
    }
  }
  return null;
}

async function searchAndFetchMotion(term, artist, album, storefront, type) {
  let query = term.toLowerCase().includes((artist || '').toLowerCase()) ? term : `${artist} ${term}`;
  if (album && !query.toLowerCase().includes(album.toLowerCase())) query = `${query} ${album}`;

  const root = await ampGet(`/v1/catalog/${storefront}/search`, {
    term: query,
    types: type,
    limit: '10',
    extend: 'editorialVideo',
    include: 'albums',
  });
  const results = root?.results?.[type]?.data;
  if (!Array.isArray(results) || !results.length) return null;

  const normTerm = normalizeForComparison(term);
  const editionWords = ['deluxe', 'expanded', 'remastered', 'remix', 'version', 'edit', 'mix', 'bonus'];

  const scored = results
    .map((item) => {
      const attributes = item.attributes;
      if (!attributes) return null;
      const resultArtistName = attributes.artistName || '';
      const resultName = attributes.name || '';
      const resultCollectionName = attributes.albumName || attributes.collectionName || '';

      const nameLower = resultName.toLowerCase();
      const collectionLower = resultCollectionName.toLowerCase();
      if (isBlacklistedAlbumName(nameLower) || isBlacklistedAlbumName(collectionLower)) return null;

      if (!artistMatches(artist, resultArtistName)) return null;

      let score = 10; // artist match, guaranteed by the check above
      const normResultName = normalizeForComparison(resultName);
      if (normResultName === normTerm) score += 15;
      else if (normResultName.includes(normTerm) || normTerm.includes(normResultName)) score += 7;
      else score -= 10;

      for (const word of editionWords) {
        const inTerm = term.toLowerCase().includes(word);
        const inResult = resultName.toLowerCase().includes(word);
        if (inTerm && inResult) score += 5;
        else if (inTerm !== inResult && inResult) score -= 3;
      }

      if (album && resultCollectionName) {
        const normAlbum = normalizeForComparison(album);
        const normCollection = normalizeForComparison(resultCollectionName);
        if (normCollection === normAlbum) score += 20;
        else if (normCollection.includes(normAlbum) || normAlbum.includes(normCollection)) score += 10;
      }

      return { score, item };
    })
    .filter(Boolean)
    .sort((a, b) => b.score - a.score);

  for (const { score, item } of scored) {
    if (score < 12) continue;
    const attributes = item.attributes;
    const resultArtistName = attributes.artistName || '';
    const itemType = item.type;

    let targetAlbumId = null;
    if (itemType === 'songs') {
      targetAlbumId = item.relationships?.albums?.data?.[0]?.id || attributes.collectionId || null;
      if (!targetAlbumId && attributes.url) {
        const albumPart = attributes.url.split('/album/')[1]?.split('?')[0] || '';
        const id = albumPart.split('/').filter(Boolean).pop() || '';
        if (id && /^\d+$/.test(id)) targetAlbumId = id;
      }
    } else if (itemType === 'albums') {
      targetAlbumId = item.id;
    }
    if (!targetAlbumId || String(targetAlbumId).startsWith('pl.')) continue;

    // Motion asset sometimes rides along directly on the search result itself.
    const ev = attributes.editorialVideo;
    if (ev) {
      const hlsUrl = extractEditorialVideoUrl(ev, false);
      const tallHlsUrl = extractEditorialVideoUrl(ev, true);
      if (hlsUrl) {
        const name = attributes.name || '';
        const collName = attributes.collectionName || null;
        return {
          name,
          artist: resultArtistName,
          albumId: targetAlbumId,
          albumName: itemType === 'songs' ? collName : name,
          animated: hlsUrl,
          animatedTall: tallHlsUrl || null,
        };
      }
    }

    const fetched = await fetchMotionArtwork(
      targetAlbumId,
      storefront,
      resultArtistName,
      itemType === 'songs' ? attributes.name : null,
      itemType === 'songs' ? resultArtistName : null,
    );
    if (fetched) return fetched;
  }
  return null;
}

const canvasCache = new Map(); // key -> {value, expiresAtMs}
const CACHE_TTL_MS = 1000 * 60 * 60 * 24; // 24h, matches the Android app

function cacheKey(prefix, ...parts) {
  return `${prefix}|${parts.map((p) => (p || '').trim().toLowerCase()).join('|')}`;
}

/**
 * Public entry point — resolves a track's Apple Music Canvas video directly
 * against Apple's own catalog, no proxy involved.
 *
 * @param {{song: string, artist: string, album?: string|null}} track
 * @param {string} storefront
 * @returns {Promise<{videoUrl: string|null}|null>}
 */
async function resolveAppleCanvasDirect(track, storefront = 'us') {
  const { song, artist, album } = track || {};
  if (!song || !artist) return null;

  const key = cacheKey('song', song, artist, album || '', storefront);
  const cached = canvasCache.get(key);
  if (cached && cached.expiresAtMs > Date.now()) return cached.value;

  let result = null;
  try {
    const motion = await searchAndFetchMotion(song, artist, album || null, storefront, 'songs');
    if (motion) result = { videoUrl: motion.animated || motion.animatedTall || null };
  } catch {
    result = null;
  }

  canvasCache.set(key, { value: result, expiresAtMs: Date.now() + CACHE_TTL_MS });
  return result;
}
