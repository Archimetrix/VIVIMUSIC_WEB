/**
 * VIVIMUSIC WEB — background.js
 */

'use strict';

importScripts('md5.js', 'lastfm.js', 'spotify.js', 'stargate.js', 'apple-canvas.js');

/* -------------------------------------------------------------------------
 * Apple Music Canvas — header spoofing
 *
 * amp-api.music.apple.com checks the request's Origin/Referer against
 * music.apple.com before it'll honor the scraped token. fetch() refuses to
 * let script code set either header directly (they're both "forbidden"
 * request headers per the Fetch spec), so this has to happen one layer
 * below script control: a declarativeNetRequest session rule that rewrites
 * those two headers on the way out, for exactly the requests apple-canvas.js
 * makes. This only works for requests this extension itself initiates
 * (covered by the existing *.apple.com host_permissions) — it can't spoof
 * headers for the page's own traffic.
 * ------------------------------------------------------------------------- */
const AMP_HEADER_RULE_ID = 9001;

async function ensureAmpHeaderSpoofRule() {
  try {
    await chrome.declarativeNetRequest.updateSessionRules({
      removeRuleIds: [AMP_HEADER_RULE_ID],
      addRules: [{
        id: AMP_HEADER_RULE_ID,
        priority: 1,
        condition: {
          urlFilter: '||amp-api.music.apple.com',
          resourceTypes: ['xmlhttprequest'],
        },
        action: {
          type: 'modifyHeaders',
          requestHeaders: [
            { header: 'Origin', operation: 'set', value: 'https://music.apple.com' },
            { header: 'Referer', operation: 'set', value: 'https://music.apple.com/' },
          ],
        },
      }],
    });
  } catch (e) {
    console.warn('[Vivi] Could not register AMP header-spoof rule:', e.message);
  }
}

const REPO = 'Archimetrix/VIVIMUSIC_WEB';
const RELEASES_API = `https://api.github.com/repos/${REPO}/releases/latest`;
const RELEASES_PAGE = `https://github.com/${REPO}/releases/latest`;
const ALARM_NAME = 'vivi-update-check';
const CHECK_INTERVAL_MIN = 12 * 60; // twice a day

function parseVersion(v) {
  return String(v || '').trim().replace(/^v/i, '').split('.').map((n) => parseInt(n, 10) || 0);
}


function isNewer(a, b) {
  const av = parseVersion(a), bv = parseVersion(b);
  const len = Math.max(av.length, bv.length);
  for (let i = 0; i < len; i++) {
    const x = av[i] || 0, y = bv[i] || 0;
    if (x > y) return true;
    if (x < y) return false;
  }
  return false;
}

async function checkForUpdate() {
  const currentVersion = chrome.runtime.getManifest().version;
  let result;
  try {
    const res = await fetch(RELEASES_API, {
      headers: { Accept: 'application/vnd.github+json' },
    });
    if (!res.ok) throw new Error(`GitHub API ${res.status}`);
    const data = await res.json();
    const latestVersion = data.tag_name || data.name || '';
    const updateAvailable = latestVersion ? isNewer(latestVersion, currentVersion) : false;
    result = {
      ok: true,
      currentVersion,
      latestVersion: latestVersion.replace(/^v/i, ''),
      updateAvailable,
      releaseUrl: data.html_url || RELEASES_PAGE,
      checkedAt: Date.now(),
    };
  } catch (e) {
    result = {
      ok: false,
      currentVersion,
      error: e.message,
      checkedAt: Date.now(),
    };
  }

  await chrome.storage.local.set({ vivi_update_check: result });

  if (result.ok && result.updateAvailable) {
    chrome.action.setBadgeText({ text: '1' });
    chrome.action.setBadgeBackgroundColor({ color: '#5b6cf5' });
  } else {
    chrome.action.setBadgeText({ text: '' });
  }

  return result;
}

chrome.runtime.onInstalled.addListener(() => {
  chrome.alarms.create(ALARM_NAME, { periodInMinutes: CHECK_INTERVAL_MIN });
  checkForUpdate();
  ensureAmpHeaderSpoofRule();
});

chrome.runtime.onStartup.addListener(() => {
  checkForUpdate();
  ensureAmpHeaderSpoofRule();
});

// Service workers get evicted after ~30s idle and restart on the next event —
// belt-and-suspenders so the rule is always there even if onInstalled/
// onStartup didn't fire this particular wake-up (e.g. woken by a message).
ensureAmpHeaderSpoofRule();

chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name === ALARM_NAME) checkForUpdate();
});

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (msg.type === 'VIVI_CHECK_UPDATE') {
    checkForUpdate().then(sendResponse);
    return true; 
  }
});


async function lastfmGetSession() {
  const { lastfmSession } = await chrome.storage.local.get('lastfmSession');
  return lastfmSession || null; // { sessionKey, username } | null
}

async function handleLastfmLogin(username, password) {
  try {
    const { sessionKey, username: confirmedName } = await lastfmLogin(username, password);
    await chrome.storage.local.set({
      lastfmSession: { sessionKey, username: confirmedName },
    });
    return { ok: true, username: confirmedName };
  } catch (e) {
    return { ok: false, error: e.message };
  }
}

async function handleLastfmLogout() {
  await chrome.storage.local.remove('lastfmSession');
  return { ok: true };
}

async function handleLastfmNowPlaying(track) {
  const session = await lastfmGetSession();
  if (!session) return { ok: false, error: 'Not logged in' };
  try {
    await lastfmUpdateNowPlaying(session.sessionKey, track);
    return { ok: true };
  } catch (e) {
    return { ok: false, error: e.message };
  }
}

async function handleLastfmScrobble(track, timestamp) {
  const session = await lastfmGetSession();
  if (!session) return { ok: false, error: 'Not logged in' };
  try {
    await lastfmScrobble(session.sessionKey, track, timestamp);
    return { ok: true };
  } catch (e) {
    return { ok: false, error: e.message };
  }
}

async function handleLastfmLove(track, loved) {
  const session = await lastfmGetSession();
  if (!session) return { ok: false, error: 'Not logged in' };
  try {
    await lastfmLoveTrack(session.sessionKey, track, loved);
    return { ok: true };
  } catch (e) {
    return { ok: false, error: e.message };
  }
}


chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  switch (msg.type) {

    case 'VIVI_SPOTIFY_STATUS':
      spotifyStatus().then(sendResponse);
      return true;
    case 'VIVI_SPOTIFY_SET_COOKIE':
      setSpDc(msg.spDc).then(() => spotifyStatus()).then((s) => sendResponse({ ok: true, ...s })).catch((e) => sendResponse(spotifyJsonError(e.message)));
      return true;
    case 'VIVI_SPOTIFY_CONNECT':
      spotifyConnectFromBrowser().then(sendResponse);
      return true;
    case 'VIVI_SPOTIFY_LOGOUT':
      clearSpotify().then(sendResponse);
      return true;
    case 'VIVI_SPOTIFY_CANVAS':
      spotifyCanvasForTrack(msg.track).then((videoUrl) => sendResponse({ ok: !!videoUrl, videoUrl: videoUrl || null })).catch((e) => sendResponse(spotifyJsonError(e.message)));
      return true;
    case 'VIVI_SPOTIFY_LYRICS':
      spotifyLyricsForTrack(msg.track).then((lyrics) => sendResponse({ ok: !!lyrics, lyrics: lyrics || null })).catch((e) => sendResponse(spotifyJsonError(e.message)));
      return true;
    case 'VIVI_SPOTIFY_TRANSFER_USER':
      spotifyGetUser().then(u => sendResponse({ ok: true, user: { id: u.id, name: u.display_name || u.id, image: u.images?.[0]?.url || null } })).catch(e => sendResponse(spotifyJsonError(e.message)));
      return true;
    case 'VIVI_SPOTIFY_TRANSFER_PLAYLISTS':
      spotifyListPlaylists().then(items => sendResponse({ ok: true, items })).catch(e => sendResponse(spotifyJsonError(e.message)));
      return true;
    case 'VIVI_SPOTIFY_TRANSFER_PLAYLIST_TRACKS':
      spotifyListPlaylistTracks(msg.playlistId).then(items => sendResponse({ ok: true, items })).catch(e => sendResponse(spotifyJsonError(e.message)));
      return true;
    case 'VIVI_SPOTIFY_TRANSFER_PLAYLIST_COUNT':
      spotifyPlaylistTrackCount(msg.playlistId).then(count => sendResponse({ ok: true, count: Number(count) || 0 })).catch(e => sendResponse(spotifyJsonError(e.message)));
      return true;
    case 'VIVI_YTM_TRANSFER':
      (async () => {
        let tabs = await chrome.tabs.query({ url: 'https://music.youtube.com/*' });
        let tab = tabs.find(t => t.active) || tabs[0];
        if (!tab?.id) {
          tab = await chrome.tabs.create({ url: 'https://music.youtube.com/', active: true });
          await new Promise(resolve => {
            const listener = (tabId, changeInfo) => {
              if (tabId === tab.id && changeInfo.status === 'complete') { chrome.tabs.onUpdated.removeListener(listener); resolve(); }
            };
            chrome.tabs.onUpdated.addListener(listener);
            setTimeout(() => { chrome.tabs.onUpdated.removeListener(listener); resolve(); }, 15000);
          });
        }
        await chrome.scripting.executeScript({ target: { tabId: tab.id }, world: 'MAIN', files: ['src/ytm-page.js'] });
        try {
          return await chrome.tabs.sendMessage(tab.id, msg.payload);
        } catch (e) {
          await new Promise(r => setTimeout(r, 800));
          await chrome.scripting.executeScript({ target: { tabId: tab.id }, world: 'MAIN', files: ['src/ytm-page.js'] });
          return await chrome.tabs.sendMessage(tab.id, msg.payload);
        }
      })().then(sendResponse).catch(e => sendResponse({ ok: false, error: e?.message || String(e) }));
      return true;

    case 'VIVI_APPLE_CANVAS_DIRECT':
      resolveAppleCanvasDirect(msg.track)
        .then((result) => sendResponse({ ok: !!result?.videoUrl, videoUrl: result?.videoUrl || null }))
        .catch((e) => sendResponse({ ok: false, videoUrl: null, error: String(e?.message || e) }));
      return true;

    case 'VIVI_LASTFM_LOGIN':
      handleLastfmLogin(msg.username, msg.password).then(sendResponse);
      return true;
    case 'VIVI_LASTFM_LOGOUT':
      handleLastfmLogout().then(sendResponse);
      return true;
    case 'VIVI_LASTFM_STATUS':
      lastfmGetSession().then((s) => sendResponse({ loggedIn: !!s, username: s?.username || null }));
      return true;
    case 'VIVI_LASTFM_NOWPLAYING':
      handleLastfmNowPlaying(msg.track).then(sendResponse);
      return true;
    case 'VIVI_LASTFM_SCROBBLE':
      handleLastfmScrobble(msg.track, msg.timestamp).then(sendResponse);
      return true;
    case 'VIVI_LASTFM_LOVE':
      handleLastfmLove(msg.track, msg.loved).then(sendResponse);
      return true;

    default:
      return undefined;
  }
});

/* -------------------------------------------------------------------------
 * Musixmatch Web Auth / Lyrics bridge
 *
 * The web content script must not perform the Musixmatch auth flow directly.
 * MV3's service worker owns the cross-origin requests and WebCrypto signing.
 * This mirrors the working VIVIMUSIC Android flow:
 *   www.musixmatch.com -> extract current _app JS secret
 *   token.get (mobile-app-v1.0 + HMAC-SHA256)
 *   track.search (mobile-app-v1.0 + HMAC-SHA256)
 *   track.richsync.get -> track.subtitle.get -> track.lyrics.get
 * ------------------------------------------------------------------------- */

const MXM_BASE = 'https://apic.musixmatch.com/ws/1.1/';
const MXM_APP_ID = 'mobile-app-v1.0';
const MXM_SECRET_FALLBACK = 'b3dc8788299f5806a70a6a20a0cb0ffc';
const MXM_SECRET_TTL_MS = 12 * 60 * 60 * 1000;
const MXM_TOKEN_TTL_MS = 10 * 60 * 1000;

let mxmSecretCache = null;
let mxmSecretFetchedAt = 0;
let mxmTokenCache = null;
let mxmTokenFetchedAt = 0;
const mxmGuid = crypto.randomUUID();

function mxmCleanText(text) {
  return String(text || '')
    .replace(/,/g, ' ')
    .replace(/&/g, ' ')
    .replace(/\(.*?\)/g, '')
    .replace(/\[.*?\]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9 ]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

async function mxmFetchText(url, options = {}) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 9000);
  try {
    const res = await fetch(url, {
      ...options,
      signal: controller.signal,
      credentials: 'omit',
      cache: 'no-store',
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return await res.text();
  } finally {
    clearTimeout(timer);
  }
}

async function mxmFetchJson(url, options = {}) {
  const text = await mxmFetchText(url, options);
  try {
    return JSON.parse(text);
  } catch {
    throw new Error('Invalid JSON response from Musixmatch');
  }
}

async function getMxmSecret(forceRefresh = false) {
  if (!forceRefresh && mxmSecretCache && Date.now() - mxmSecretFetchedAt < MXM_SECRET_TTL_MS) {
    return mxmSecretCache;
  }

  try {
    const html = await mxmFetchText('https://www.musixmatch.com/search', {
      headers: {
        Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
        'Accept-Language': 'en-US,en;q=0.9',
      },
    });

    const match = html.match(/src=["']([^"']*\/_next\/static\/chunks\/pages\/_app-[^"']+\.js)["']/i);
    if (!match) throw new Error('Musixmatch _app JS was not found');

    const jsUrl = new URL(match[1], 'https://www.musixmatch.com/').href;
    const js = await mxmFetchText(jsUrl, {
      headers: { Accept: '*/*' },
    });

    const secretMatch = js.match(/from(\s*["'])([^"']+?)(?:["']\s*\.split)/);
    if (!secretMatch) throw new Error('Musixmatch signing secret was not found');

    const encoded = secretMatch[2];
    const binary = atob(encoded.split('').reverse().join(''));
    const bytes = Uint8Array.from(binary, ch => ch.charCodeAt(0));
    const secret = new TextDecoder().decode(bytes);
    if (!secret) throw new Error('Empty Musixmatch signing secret');

    mxmSecretCache = secret;
    mxmSecretFetchedAt = Date.now();
    return secret;
  } catch (e) {
    // Preserve the fallback from the working Android implementation.
    mxmSecretCache = MXM_SECRET_FALLBACK;
    mxmSecretFetchedAt = Date.now();
    return mxmSecretCache;
  }
}

function mxmBase64(bytes) {
  let binary = '';
  const chunk = 0x8000;
  for (let i = 0; i < bytes.length; i += chunk) {
    binary += String.fromCharCode(...bytes.subarray(i, i + chunk));
  }
  return btoa(binary);
}

async function signMxmUrl(url, secret) {
  // URLSearchParams serializes spaces as '+', matching the Android signer.
  const normalizedUrl = String(url).replace(/%20/g, '+').replace(/ /g, '+');
  const yyyyMmDd = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'UTC', year: 'numeric', month: '2-digit', day: '2-digit'
  }).format(new Date()).replace(/-/g, '');

  const key = await crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign']
  );
  const sig = await crypto.subtle.sign(
    'HMAC',
    key,
    new TextEncoder().encode(normalizedUrl + yyyyMmDd)
  );
  const encodedSig = encodeURIComponent(mxmBase64(new Uint8Array(sig)));
  return `${normalizedUrl}&signature=${encodedSig}&signature_protocol=sha256`;
}

function mxmStatus(response) {
  return response?.message?.header?.status_code ?? 0;
}

function mxmNormalizeArtist(text) {
  return mxmCleanText(String(text || '')
    .replace(/\b(feat\.?|ft\.?|featuring)\b/gi, ' ')
    .replace(/\s*[&,+]\s*/g, ' '));
}

function mxmNormalizeAlbum(text) {
  return mxmCleanText(String(text || '')
    .replace(/\b(deluxe|expanded|anniversary|remastered|remaster|edition|version)\b/gi, ' '));
}

// Old logic used raw substring containment in both directions, which is too
// permissive for how Musixmatch's search results actually look: a
// single-word title like "Home" or "Up" would count as "related" to
// "Homesick" or "Grown Up" purely because the characters happen to appear
// inside a longer word. When the true match isn't in the fuzzy search
// results for some reason (extra credited artists, punctuation, Musixmatch
// just not having it), pickMxmTrack would still force-pick whatever
// unrelated candidate happened to contain the substring instead of
// correctly finding nothing — this is the main way completely wrong
// lyrics get served, independent of any version/edit mismatch.
//
// Word-boundary comparison instead: every word of the shorter string must
// appear as a whole word in the longer string. "Home" still matches
// "Home (Reprise)" (extra word tacked on, same word to match) but no
// longer matches "Homesick" (different word entirely).
function mxmWordsRelated(a, b) {
  if (!a || !b) return false;
  if (a === b) return true;
  const wordsA = a.split(' ').filter(Boolean);
  const wordsB = b.split(' ').filter(Boolean);
  if (!wordsA.length || !wordsB.length) return false;
  const [shorter, longer] = wordsA.length <= wordsB.length ? [wordsA, wordsB] : [wordsB, wordsA];
  return shorter.every((w) => longer.includes(w));
}

function mxmYearFromTrack(track) {
  // Musixmatch track objects expose the release date under a couple of
  // different field names depending on endpoint/catalog entry vintage.
  const raw = track?.first_release_date || track?.album_release_date || track?.release_date || null;
  if (!raw) return null;
  const m = String(raw).match(/(\d{4})/);
  return m ? Number(m[1]) : null;
}

// YT Music often credits a featured artist only inside the *title*
// ("No Lie (feat. Dua Lipa)"), not in the byline the extension reads
// track.artist from — so track.artist can be missing a co-artist that
// Musixmatch's own catalog credits the track under, and the raw
// parenthetical is noise in the search query itself. Pull it out so we can
// (a) search with a cleaner title and (b) fold the featured name(s) into
// the artist string used for matching, so a candidate Musixmatch credits
// as "Sean Paul feat. Dua Lipa" (or just "Dua Lipa") still scores as a
// proper artist match instead of a wrong-artist mismatch.
function mxmExtractFeatured(title) {
  const re = /[\(\[]?\s*(?:feat\.?|featuring|ft\.?|with)\s+([^)\]]+)[\)\]]?\s*$/i;
  const match = String(title || '').match(re);
  if (!match) return { cleanTitle: title, featured: [] };
  const cleanTitle = title.slice(0, match.index).trim();
  const featured = match[1]
    .split(/,|&|\band\b/i)
    .map((s) => s.trim())
    .filter(Boolean);
  return { cleanTitle: cleanTitle || title, featured };
}

function pickMxmTrack(list, requestedTitle, requestedArtist, requestedAlbum, duration, requestedYear) {
  const normalizedTitle = mxmCleanText(requestedTitle);
  const normalizedArtist = mxmNormalizeArtist(requestedArtist);
  const normalizedAlbum = mxmNormalizeAlbum(requestedAlbum);
  const yearWanted = Number(requestedYear) || null;

  const candidates = list
    .map(x => x?.track)
    .filter(Boolean)
    .map(track => {
      const title = mxmCleanText(track.track_name);
      const artist = mxmNormalizeArtist(track.artist_name);
      const album = mxmNormalizeAlbum(
        track.album_name || track.album || track.album_name_with_artist || ''
      );
      const trackDur = Number(track.track_length) || 0;
      const durDelta = duration > 0 && trackDur > 0 ? Math.abs(trackDur - duration) : null;
      const trackYear = mxmYearFromTrack(track);
      const yearDelta = yearWanted && trackYear ? Math.abs(trackYear - yearWanted) : null;

      const titleExact = title === normalizedTitle;
      const titleRelated = mxmWordsRelated(title, normalizedTitle);
      const artistExact = normalizedArtist && artist === normalizedArtist;
      const artistRelated = normalizedArtist && mxmWordsRelated(artist, normalizedArtist);
      const albumExact = normalizedAlbum && album === normalizedAlbum;
      const albumRelated = normalizedAlbum && mxmWordsRelated(album, normalizedAlbum);

      // Hard reject obvious wrong-title results. A substring match is allowed
      // because Musixmatch often appends edit/version text to the title.
      if (!titleRelated) return null;

      // Artist is much more important than duration. The old selector could
      // choose a different artist/version when the title and duration were close.
      if (normalizedArtist && !artistExact && !artistRelated) return null;

      // Album and year are NOT used as hard filters: the same recording is
      // routinely catalogued under different album names/years on different
      // platforms — a song's YT Music album can be a later compilation or
      // reissue ("Mad Love The Prequel", 2018) while Musixmatch's canonical
      // entry for the identical track is filed under the original single's
      // release ("Weekend Party Hits", 2016). Hard-rejecting on a mismatch
      // here would throw out the correct, verified entry. They're used only
      // as scoring tie-breakers below, alongside duration.

      let score = 0;
      score += titleExact ? 0 : 100;
      score += artistExact ? 0 : 30;
      if (normalizedAlbum) score += albumExact ? 0 : (albumRelated ? 15 : 25);
      if (yearWanted) {
        if (yearDelta == null) score += 10; // unknown year — mild penalty, not disqualifying
        else score += Math.min(yearDelta, 10) * 4; // each year of gap costs more
      }

      // Duration is only a secondary discriminator inside an already-matching
      // title/artist/release candidate. Keep a generous tolerance for uploads
      // whose reported duration differs slightly from the source recording.
      if (durDelta != null) {
        if (durDelta <= 2) score += 0;
        else if (durDelta <= 5) score += 5;
        else if (durDelta <= 10) score += 15;
        else if (durDelta <= 20) score += 35;
        else score += 70;
      } else {
        score += 25;
      }

      // Prefer an actual track with lyrics and a normal track rating when the
      // API supplies those fields, but never let them overrule identity.
      if (track.has_lyrics === false) score += 1000;
      if (Number(track.track_rating) > 0) score -= Math.min(Number(track.track_rating), 20) / 20;

      return { track, score, title, artist, album, durDelta, albumExact, albumRelated };
    })
    .filter(Boolean)
    .sort((a, b) => a.score - b.score);

  if (!candidates.length) return null;

  const best = candidates[0];

  // Final guard: if the best candidate is suspiciously far from the requested
  // duration and we cannot confirm the album, don't silently serve another edit.
  // Exact title+artist can still pass when duration metadata is unavailable.
  if (duration > 0 && best.durDelta != null && best.durDelta > 45 && !normalizedAlbum) {
    return null;
  }

  // A different edit of the same title+artist (radio edit, extended mix,
  // remaster, live cut) can still pass the checks above when the album
  // isn't confirmed, and Musixmatch's own duration metadata for user
  // uploads is often a little off — but a candidate that's more than 20s
  // away from the real track, with no album match to back it up, is much
  // more likely a wrong version than a metadata rounding error. Rejecting
  // it here means we fall through to no-match rather than serving richsync
  // timing for the wrong recording, which looks synced at first and then
  // drifts as the two versions' structures diverge.
  if (duration > 0 && best.durDelta != null && best.durDelta > 20 && !best.albumExact && !best.albumRelated) {
    return null;
  }

  return best.track;
}
function parseMxmRichsync(body) {
  let entries;
  try { entries = JSON.parse(body); } catch { return null; }
  if (!Array.isArray(entries) || !entries.length) return null;

  const lines = [];
  for (const entry of entries) {
    const text = String(entry?.x || '').trim();
    if (!text) continue;
    const lineStart = Math.round((Number(entry.ts) || 0) * 1000);
    const lineEnd = Math.round((Number(entry.te) || 0) * 1000);
    const rawWords = Array.isArray(entry.l) ? entry.l : [];
    // Musixmatch richsync tokens already embed their own trailing space
    // (e.g. "I ", "wish "). Trim it so spacing comes only from the
    // .vivi-lyrics-word CSS margin, same as every other provider — otherwise
    // the literal space and the CSS margin stack, doubling the visual gap.
    const words = rawWords.map(w => ({
      text: String(w?.c ?? '').trim(),
      start: lineStart + Math.round((Number(w?.o) || 0) * 1000),
    })).filter(w => w.text !== '');
    for (let i = 0; i < words.length; i++) {
      words[i].end = i < words.length - 1 ? words[i + 1].start : lineEnd;
    }
    lines.push({ start: lineStart, end: lineEnd || lineStart + 8000, words, text });
  }
  return lines.length ? { mode: 'word', lines } : null;
}

function parseMxmSubtitle(body) {
  if (!body || typeof body !== 'string') return null;
  const lines = [];
  const re = /\[(\d{1,2}:\d{2}(?:\.\d{1,3})?)\]([^\n\r]*)/g;
  for (const match of body.matchAll(re)) {
    const parts = match[1].split(':');
    const seconds = Number(parts[0]) * 60 + Number(parts[1]);
    lines.push({ start: Math.round(seconds * 1000), text: match[2].trim() });
  }
  if (!lines.length) return null;
  lines.sort((a, b) => a.start - b.start);
  for (let i = 0; i < lines.length; i++) {
    lines[i].end = i < lines.length - 1 ? lines[i + 1].start : lines[i].start + 8000;
  }
  return { mode: 'line', lines };
}

function parseMxmPlain(body) {
  if (!body || !String(body).trim()) return null;
  const lines = String(body).split(/\r?\n/).filter(Boolean).map(text => ({ text: text.trim() }));
  return lines.length ? { mode: 'plain', lines } : null;
}

async function mxmSignedGet(path, params, secret) {
  const url = new URL(path, MXM_BASE);
  for (const [key, value] of Object.entries(params)) {
    if (value !== undefined && value !== null && value !== '') url.searchParams.set(key, String(value));
  }
  const signed = await signMxmUrl(url.toString(), secret);
  return mxmFetchJson(signed, { headers: { Accept: 'application/json, text/plain, */*' } });
}

async function getMxmToken(forceRefresh = false) {
  if (!forceRefresh && mxmTokenCache && Date.now() - mxmTokenFetchedAt < MXM_TOKEN_TTL_MS) {
    return mxmTokenCache;
  }
  const secret = await getMxmSecret(forceRefresh);
  const response = await mxmSignedGet('token.get', {
    app_id: MXM_APP_ID,
    guid: mxmGuid,
    format: 'json',
  }, secret);
  if (mxmStatus(response) !== 200) throw new Error(`Musixmatch token status ${mxmStatus(response)}`);
  const token = response?.message?.body?.user_token;
  if (!token) throw new Error('Musixmatch returned no user_token');
  mxmTokenCache = token;
  mxmTokenFetchedAt = Date.now();
  return token;
}

async function getMusixmatchLyrics(track, allowRetry = true) {
  try {
    const secret = await getMxmSecret(false);
    const token = await getMxmToken(false);

    const { cleanTitle, featured } = mxmExtractFeatured(track.song);
    // Combine the byline artist with any title-only featured credit(s) so
    // neither the search query nor pickMxmTrack's artist check is blind to
    // a co-artist YT Music only surfaces via "(feat. X)" in the title.
    const combinedArtist = featured.length
      ? `${track.artist}, ${featured.join(', ')}`
      : track.artist;

    const search = await mxmSignedGet('track.search', {
      app_id: MXM_APP_ID,
      format: 'json',
      q_track: cleanTitle,
      q_artist: combinedArtist,
      q_album: track.album || undefined,
      f_has_lyrics: 'true',
      page_size: 10,
      s_track_rating: 'desc',
      usertoken: token,
    }, secret);

    if (mxmStatus(search) === 401 || mxmStatus(search) === 402) throw new Error(`AUTH:${mxmStatus(search)}`);
    if (mxmStatus(search) !== 200) throw new Error(`Musixmatch search status ${mxmStatus(search)}`);

    const list = search?.message?.body?.track_list;
    let best = pickMxmTrack(
      Array.isArray(list) ? list : [],
      cleanTitle,
      combinedArtist,
      track.album || null,
      Number(track.duration) || 0,
      Number(track.year) || null
    );

    // If sending q_album narrowed the results down to nothing usable (a
    // stricter server-side filter can occasionally exclude the right track
    // when Musixmatch's own album name for it doesn't line up with YT
    // Music's), retry once without it rather than giving up — better to
    // fall back to the artist+title-only search than serve no lyrics.
    if (!best?.track_id && track.album) {
      const retrySearch = await mxmSignedGet('track.search', {
        app_id: MXM_APP_ID,
        format: 'json',
        q_track: cleanTitle,
        q_artist: combinedArtist,
        f_has_lyrics: 'true',
        page_size: 10,
        s_track_rating: 'desc',
        usertoken: token,
      }, secret);
      if (mxmStatus(retrySearch) === 200) {
        const retryList = retrySearch?.message?.body?.track_list;
        best = pickMxmTrack(
          Array.isArray(retryList) ? retryList : [],
          cleanTitle,
          combinedArtist,
          track.album || null,
          Number(track.duration) || 0,
          Number(track.year) || null
        );
      }
    }
    if (!best?.track_id) throw new Error('Musixmatch track not found');

    const trackId = best.track_id;
    const commonTrackId = best.commontrack_id || null;
    const baseParams = { app_id: MXM_APP_ID, format: 'json', track_id: trackId, usertoken: token };

    const trackDurationMs = (Number(track.duration) || 0) * 1000;
    // Same rationale as the version-mismatch guard in pickMxmTrack: if the
    // richsync timeline's last word lands far past (or well short of) the
    // actual audio length, this richsync almost certainly belongs to a
    // different edit of the recording. Prefer falling through to the
    // line-level subtitle (still correctly synced, just not word-level)
    // over serving word timing that will visibly drift.
    const richsyncMatchesDuration = (parsed) => {
      if (!trackDurationMs || !parsed?.lines?.length) return true;
      const last = parsed.lines[parsed.lines.length - 1];
      const lastMs = Number(last.end ?? last.start) || 0;
      const tolerance = Math.max(20000, trackDurationMs * 0.25);
      return lastMs <= trackDurationMs + tolerance;
    };

    const rich = await mxmSignedGet('track.richsync.get', baseParams, secret);
    if (mxmStatus(rich) === 401 || mxmStatus(rich) === 402) throw new Error(`AUTH:${mxmStatus(rich)}`);
    const richBody = rich?.message?.body?.richsync?.richsync_body;
    if (mxmStatus(rich) === 200 && richBody) {
      const parsed = parseMxmRichsync(richBody);
      if (parsed && richsyncMatchesDuration(parsed)) return parsed;
    }

    const subtitleParams = { ...baseParams };
    if (commonTrackId) subtitleParams.commontrack_id = commonTrackId;
    const subtitle = await mxmSignedGet('track.subtitle.get', subtitleParams, secret);
    if (mxmStatus(subtitle) === 401 || mxmStatus(subtitle) === 402) throw new Error(`AUTH:${mxmStatus(subtitle)}`);
    const subtitleBody = subtitle?.message?.body?.subtitle?.subtitle_body;
    if (mxmStatus(subtitle) === 200 && subtitleBody) {
      const parsed = parseMxmSubtitle(subtitleBody);
      if (parsed) return parsed;
    }

    const plain = await mxmSignedGet('track.lyrics.get', baseParams, secret);
    if (mxmStatus(plain) === 401 || mxmStatus(plain) === 402) throw new Error(`AUTH:${mxmStatus(plain)}`);
    const lyrics = plain?.message?.body?.lyrics;
    if (mxmStatus(plain) === 200 && lyrics?.lyrics_body && !lyrics.restricted) {
      const parsed = parseMxmPlain(lyrics.lyrics_body);
      if (parsed) return parsed;
    }

    return null;
  } catch (e) {
    if (allowRetry && String(e?.message || '').startsWith('AUTH:')) {
      mxmTokenCache = null;
      mxmTokenFetchedAt = 0;
      mxmSecretCache = null;
      mxmSecretFetchedAt = 0;
      return getMusixmatchLyrics(track, false);
    }
    throw e;
  }
}

// Add the Musixmatch bridge to the existing listener above without changing
// the popup/Spotify/Last.fm message contracts.
chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (msg?.type !== 'VIVI_MUSIXMATCH_LYRICS') return undefined;
  getMusixmatchLyrics(msg.track || {})
    .then(lyrics => sendResponse({ ok: !!lyrics, lyrics: lyrics || null }))
    .catch(e => sendResponse({ ok: false, error: String(e?.message || e) }));
  return true;
});
