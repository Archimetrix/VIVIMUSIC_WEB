/**
 * VIVIMUSIC WEB — background.js
 */

'use strict';

importScripts('md5.js', 'lastfm.js', 'spotify.js', 'stargate.js', 'apple-canvas.js', 'lrcred.js');

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
    console.debug('[Vivi] Could not register AMP header-spoof rule:', e.message);
  }
}

const REPO = 'Archimetrix/VIVIMUSIC_WEB';
const RELEASES_API = `https://api.github.com/repos/${REPO}/releases/latest`;
const RELEASES_PAGE = `https://github.com/${REPO}/releases/latest`;
const ALARM_NAME = 'vivi-update-check';
const CHECK_INTERVAL_MIN = 12 * 60; // twice a day
const ANNOUNCEMENTS_URL = 'https://raw.githubusercontent.com/Archimetrix/storage-project-files/main/vivimusicwebannoucement.json';
let announcementsCheckPromise = null;

function announcementId(item, index) {
  return String(item.id || `${item.timestamp || ''}:${item.title || ''}:${index}`);
}

function sortAnnouncements(items) {
  return [...items].sort((a, b) => {
    const ta = Date.parse(a.timestamp || '') || 0;
    const tb = Date.parse(b.timestamp || '') || 0;
    return tb - ta;
  });
}

async function checkAnnouncements() {
  if (announcementsCheckPromise) return announcementsCheckPromise;
  announcementsCheckPromise = (async () => {
    const saved = await chrome.storage.local.get([
      'vivi_announcements', 'vivi_announcements_seen_ids'
    ]);
    const cached = Array.isArray(saved.vivi_announcements) ? saved.vivi_announcements : [];
    const seenIds = Array.isArray(saved.vivi_announcements_seen_ids) ? saved.vivi_announcements_seen_ids : [];
    try {
      const response = await fetch(ANNOUNCEMENTS_URL, { cache: 'no-store', headers: { Accept: 'application/json' } });
      if (!response.ok) throw new Error(`Announcements request failed (${response.status})`);
      const payload = await response.json();
      if (!Array.isArray(payload)) throw new Error('Announcements feed is not a JSON array');
      const announcements = sortAnnouncements(payload.filter(item => item && typeof item === 'object').map((item, index) => ({
        id: announcementId(item, index),
        title: String(item.title || ''),
        message: String(item.message || ''),
        timestamp: String(item.timestamp || '')
      })));
      await chrome.storage.local.set({
        vivi_announcements: announcements,
        vivi_announcements_checked_at: Date.now()
      });
      const unreadCount = announcements.filter(item => !seenIds.includes(item.id)).length;
      return { ok: true, announcements, seenIds, unreadCount };
    } catch (error) {
      const announcements = sortAnnouncements(cached);
      return {
        ok: false,
        error: String(error?.message || error),
        announcements,
        seenIds,
        unreadCount: announcements.filter(item => !seenIds.includes(item.id)).length
      };
    }
  })().finally(() => { announcementsCheckPromise = null; });
  return announcementsCheckPromise;
}

async function getYtMusicAnnouncements() {
  const result = await checkAnnouncements();
  if (!result.ok) return { ok: false, announcements: [] };
  const { vivi_announcements_toasted_ids: toasted = [] } = await chrome.storage.local.get('vivi_announcements_toasted_ids');
  const announcements = result.announcements.filter(item =>
    !result.seenIds.includes(item.id) && !toasted.includes(item.id)
  );
  return { ok: true, announcements };
}

async function markAnnouncementsToasted(ids) {
  const safeIds = Array.isArray(ids) ? ids.map(String).filter(Boolean) : [];
  const { vivi_announcements_toasted_ids: existing = [] } = await chrome.storage.local.get('vivi_announcements_toasted_ids');
  const toasted = [...new Set([...existing, ...safeIds])];
  await chrome.storage.local.set({ vivi_announcements_toasted_ids: toasted });
  return { ok: true };
}

async function markAnnouncementsSeen() {
  const { vivi_announcements: items = [], vivi_announcements_seen_ids: seen = [] } = await chrome.storage.local.get([
    'vivi_announcements', 'vivi_announcements_seen_ids'
  ]);
  const announcements = sortAnnouncements(Array.isArray(items) ? items : []);
  const seenIds = [...new Set([...seen, ...announcements.map((item, index) => announcementId(item, index))])];
  await chrome.storage.local.set({ vivi_announcements_seen_ids: seenIds });
  return { ok: true, announcements, seenIds, unreadCount: 0 };
}

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (msg.type === 'VIVI_ANNOUNCEMENTS_CHECK') {
    checkAnnouncements().then(sendResponse);
    return true;
  }
  if (msg.type === 'VIVI_ANNOUNCEMENTS_MARK_SEEN') {
    markAnnouncementsSeen().then(sendResponse);
    return true;
  }
  if (msg.type === 'VIVI_ANNOUNCEMENTS_FOR_YTMUSIC') {
    if (sender.url && !sender.url.startsWith('https://music.youtube.com/')) {
      sendResponse({ ok: false, announcements: [] });
      return false;
    }
    getYtMusicAnnouncements().then(sendResponse).catch(error => {
      console.debug('[Vivi] YouTube Music announcement fetch failed:', error);
      sendResponse({ ok: false, announcements: [] });
    });
    return true;
  }
  if (msg.type === 'VIVI_ANNOUNCEMENTS_TOASTED') {
    if (sender.url && !sender.url.startsWith('https://music.youtube.com/')) {
      sendResponse({ ok: false });
      return false;
    }
    markAnnouncementsToasted(msg.ids).then(sendResponse).catch(() => sendResponse({ ok: false }));
    return true;
  }
});

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

// One-time lyrics defaults: lrc.red becomes the 1st priority provider
// (then BiniLyrics, then BetterLyrics word-sync) and every provider is on.
// Respects existing choices: a user's own order is kept, with lrc.red just
// slotted in at the top; priority is only switched on for users who never
// configured an order.
const DEFAULT_PRIORITY_ORDER = ['lrcred', 'binilyrics', 'musixmatch'];
async function migrateLyricsDefaults() {
  // "Show lyrics for video songs" now defaults to off — applied once.
  const v = await chrome.storage.local.get({ vivi_video_lyrics_default_off: false });
  if (!v.vivi_video_lyrics_default_off) {
    await chrome.storage.local.set({ lyricsShowForVideos: false, vivi_video_lyrics_default_off: true });
  }
  // "Wait 2s for best quality" now defaults to ON — applied once.
  const w = await chrome.storage.local.get({ vivi_wait_default_on_v2: false });
  if (!w.vivi_wait_default_on_v2) {
    await chrome.storage.local.set({ lyricsPriorityWaitEnabled: true, vivi_wait_default_on_v2: true });
  }
  // Top-3 priority is syllable/word providers only — strip any line-only
  // provider (Legato/Kugou, Legacy, LRCLIB) a user had
  // previously picked. Applied once.
  const sy = await chrome.storage.local.get({ vivi_priority_syllable_word_only: false, lyricsPriorityOrder: [] });
  if (!sy.vivi_priority_syllable_word_only) {
    const ok = ['lrcred', 'betterlyricsTTML', 'betterlyricsPortato', 'unison', 'binilyrics', 'musixmatch'];
    const cleaned = (Array.isArray(sy.lyricsPriorityOrder) ? sy.lyricsPriorityOrder : [])
      .filter((k, i, a) => ok.includes(k) && a.indexOf(k) === i).slice(0, 3);
    await chrome.storage.local.set({ lyricsPriorityOrder: cleaned, vivi_priority_syllable_word_only: true });
  }
  const s = await chrome.storage.local.get({
    vivi_lyrics_defaults_lrcred: false,
    lyricsProviders: {},
    lyricsPriorityEnabled: false,
    lyricsPriorityOrder: [],
  });
  if (s.vivi_lyrics_defaults_lrcred) return;
  const existing = (Array.isArray(s.lyricsPriorityOrder) ? s.lyricsPriorityOrder : []).filter(Boolean);
  const patch = {
    vivi_lyrics_defaults_lrcred: true,
    lyricsProviders: { ...s.lyricsProviders, lrcred: true },
  };
  if (!existing.length) {
    patch.lyricsPriorityOrder = DEFAULT_PRIORITY_ORDER.slice();
    patch.lyricsPriorityEnabled = true;
  } else if (!existing.includes('lrcred')) {
    patch.lyricsPriorityOrder = ['lrcred', ...existing].slice(0, 3);
  }
  await chrome.storage.local.set(patch);
}

chrome.runtime.onInstalled.addListener(() => {
  chrome.alarms.create(ALARM_NAME, { periodInMinutes: CHECK_INTERVAL_MIN });
  checkForUpdate();
  ensureAmpHeaderSpoofRule();
  migrateLyricsDefaults().catch(() => {});
});

chrome.runtime.onStartup.addListener(() => {
  checkForUpdate();
  ensureAmpHeaderSpoofRule();
  migrateLyricsDefaults().catch(() => {});
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

/* ---- Last.fm web sign-in (opens last.fm in a normal tab) ---- */
const LASTFM_WEB_PENDING_KEY = 'vivi_lastfm_pending';
const LASTFM_WEB_ALARM = 'vivi-lastfm-web-auth';
const LASTFM_WEB_TIMEOUT_MS = 10 * 60 * 1000;
let lastfmWebPolling = false;

async function lastfmWebClear() {
  await chrome.storage.local.remove(LASTFM_WEB_PENDING_KEY);
  try { await chrome.alarms.clear(LASTFM_WEB_ALARM); } catch { /* ignore */ }
}

async function lastfmWebStart() {
  try {
    const token = await lastfmGetToken();
    if (!token) throw new Error('Last.fm did not return a token.');
    const url = `https://www.last.fm/api/auth/?api_key=${encodeURIComponent(LASTFM_API_KEY)}&token=${encodeURIComponent(token)}`;
    const tab = await chrome.tabs.create({ url });
    await chrome.storage.local.set({
      [LASTFM_WEB_PENDING_KEY]: { token, tabId: tab.id, startedAt: Date.now() },
    });
    chrome.alarms.create(LASTFM_WEB_ALARM, { periodInMinutes: 0.5 });
    lastfmWebPoll();
    return { ok: true };
  } catch (e) {
    return { ok: false, error: e.message };
  }
}

// -> 'none' | 'pending' | 'expired' | 'done'
async function lastfmWebTryFinish() {
  const saved = await chrome.storage.local.get(LASTFM_WEB_PENDING_KEY);
  const pending = saved[LASTFM_WEB_PENDING_KEY];
  if (!pending) return 'none';
  if (Date.now() - pending.startedAt > LASTFM_WEB_TIMEOUT_MS) {
    await lastfmWebClear();
    return 'expired';
  }
  try {
    const { sessionKey, username } = await lastfmGetSessionFromToken(pending.token);
    await chrome.storage.local.set({ lastfmSession: { sessionKey, username } });
    await lastfmWebClear();
    chrome.runtime.sendMessage({ type: 'VIVI_LASTFM_CONNECTED', username }).catch(() => {});
    return 'done';
  } catch (e) {
    if (e.lastfmCode === 15) { await lastfmWebClear(); return 'expired'; }
    return 'pending'; // 14 (not approved yet) or a network hiccup — keep waiting
  }
}

async function lastfmWebPoll() {
  if (lastfmWebPolling) return;
  lastfmWebPolling = true;
  try {
    for (let i = 0; i < 150; i++) { // ~5 minutes at 2s
      if ((await lastfmWebTryFinish()) !== 'pending') break;
      await new Promise((r) => setTimeout(r, 2000));
    }
  } finally {
    lastfmWebPolling = false;
  }
}

// The service worker can be evicted while the user is on last.fm, so also
// resume on the alarm and whenever the sign-in tab changes or closes.
chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name === LASTFM_WEB_ALARM) lastfmWebPoll();
});
async function lastfmWebOnTabEvent(tabId) {
  const saved = await chrome.storage.local.get(LASTFM_WEB_PENDING_KEY);
  if (saved[LASTFM_WEB_PENDING_KEY]?.tabId === tabId) lastfmWebPoll();
}
chrome.tabs.onUpdated.addListener((tabId, info) => { if (info.status === 'complete') lastfmWebOnTabEvent(tabId); });
chrome.tabs.onRemoved.addListener((tabId) => { lastfmWebOnTabEvent(tabId); });

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


// Romanization of Japanese lines that contain kanji (kana / Korean / Chinese /
// Hindi / Punjabi are romanized offline inside the page). Returns null on any
// failure so the UI just keeps the original text.
async function romanizeJapaneseViaGoogle(text, sl) {
  sl = /^[A-Za-z-]{2,8}$/.test(String(sl || '')) ? String(sl) : 'ja';
  const q = String(text || '').slice(0, 500);
  if (!q) return null;
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 7000);
  try {
    const url = 'https://translate.googleapis.com/translate_a/single?client=gtx&sl=' + encodeURIComponent(sl) + '&tl=en&dt=t&dt=rm&q=' + encodeURIComponent(q);
    const res = await fetch(url, { signal: ctrl.signal, credentials: 'omit' });
    if (!res.ok) return null;
    const data = await res.json();
    const segs = Array.isArray(data && data[0]) ? data[0] : [];
    const parts = [];
    for (const s of segs) {
      if (Array.isArray(s) && s[0] == null && typeof s[3] === 'string' && s[3].trim()) parts.push(s[3].trim());
    }
    const out = parts.join(' ').replace(/\s+/g, ' ').trim();
    return out || null;
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}


chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  switch (msg.type) {

    case 'VIVI_ROMANIZE_JA':
      romanizeJapaneseViaGoogle(msg.text, msg.sl).then((text) => sendResponse({ ok: !!text, text })).catch(() => sendResponse({ ok: false }));
      return true;

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
        if (!tab?.id && msg.passive) return { ok: false, error: 'Open YouTube Music in a tab first.' };
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
    case 'VIVI_LASTFM_WEB_START':
      lastfmWebStart().then(sendResponse);
      return true;
    case 'VIVI_LASTFM_WEB_CANCEL':
      lastfmWebClear().then(() => sendResponse({ ok: true }));
      return true;
    case 'VIVI_LASTFM_WEB_STATUS':
      chrome.storage.local.get(LASTFM_WEB_PENDING_KEY).then((v) => sendResponse({ pending: !!v[LASTFM_WEB_PENDING_KEY] }));
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

// Musixmatch retired the desktop API host in Sept 2026 and now gates the
// older hosts. The currently working path (used by Spicetify, ESLyric and
// others) is the iOS-app host + app id, unsigned, with a user token. The
// previous signed Android-style flow is kept as a fallback profile.
const MXM_PROFILES = [
  { name: 'mobile', base: 'https://apic-appmobile.musixmatch.com/ws/1.1/', appId: 'mac-ios-v2.0', sign: false },
  { name: 'legacy', base: 'https://apic.musixmatch.com/ws/1.1/', appId: 'mobile-app-v1.0', sign: true },
];
const MXM_HEADERS = {
  Accept: 'application/json, text/plain, */*',
  'Accept-Language': 'en-US,en;q=0.9',
  'X-User-Agent': 'Musixmatch/2025120901 CFNetwork/3860.300.31 Darwin/25.2.0',
  'X-Cookie': 'x-mxm-token-guid=',
};
// token.get returns this sentinel (with status 200) when it silently refuses
// to issue a real token; using it makes every later call fail with 401.
const MXM_BAD_TOKEN = /^UpgradeOnly/i;
const mxmTokens = new Map(); // profile.name -> { token, at }
let mxmPreferredProfile = 0;
const MXM_SECRET_FALLBACK = 'b3dc8788299f5806a70a6a20a0cb0ffc';
const MXM_SECRET_TTL_MS = 12 * 60 * 60 * 1000;
const MXM_TOKEN_TTL_MS = 10 * 60 * 1000;

let mxmSecretCache = null;
let mxmSecretFetchedAt = 0;
const mxmGuid = crypto.randomUUID();

function mxmCleanText(text) {
  return String(text || '')
    .replace(/,/g, ' ')
    .replace(/&/g, ' ')
    .replace(/\(.*?\)/g, '')
    .replace(/\[.*?\]/g, '')
    .toLowerCase()
    // Strip Latin accents only; keep letters/digits/combining marks of every
    // script so Hindi/Bengali/Japanese/Korean/etc. titles don't collapse to ''.
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^\p{L}\p{N}\p{M} ]/gu, '')
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
    if (!res.ok) throw new Error(`HTTP ${res.status} from ${new URL(url).hostname}`);
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
  // A trailing "(feat. X)" / "[ft. X]" / "(with X)" / bare "feat. X". "with" is
  // only treated as a credit when bracketed, so "Dancing With Myself" keeps
  // its full title instead of being truncated to "Dancing".
  const re = /(?:\s*[\(\[]\s*(?:feat|featuring|ft|with)\b\.?|\s+(?:feat|featuring|ft)\b\.?(?=\s))\s*([^)\]]+)[\)\]]?\s*$/i;
  const match = String(title || '').match(re);
  if (!match) return { cleanTitle: title, featured: [] };
  const cleanTitle = title.slice(0, match.index).trim();
  const featured = match[1]
    .split(/,|&|\band\b/i)
    .map((s) => s.trim())
    .filter(Boolean);
  return { cleanTitle: cleanTitle || title, featured };
}

/* ---- Matching hardening ------------------------------------------------
 * Wrong lyrics come from picking a *different recording* that merely looks
 * similar: live / remix / sped-up cuts, same-word titles ("Love" vs "Love
 * Story"), same-first-name artists ("Drake" vs "Drake Bell"), or another
 * edit with different timing. The helpers below make identity strict while
 * still tolerating harmless noise (remaster tags, feat. credits, accents).
 * ----------------------------------------------------------------------- */

// Markers meaning "a different recording / arrangement" (lowercased text).
const MXM_VERSION_RULES = [
  ['live',         /\b(live|unplugged|in concert|concert|session)\b/],
  ['remix',        /\b(remix|rmx|vip|bootleg|mashup|rework|refix|flip)\b/],
  ['acoustic',     /\b(acoustic|stripped)\b/],
  ['instrumental', /\b(instrumental|karaoke|backing track|minus one)\b/],
  ['cover',        /\b(cover|tribute|originally performed|in the style of)\b/],
  ['speed',        /\b(sped up|speed up|slowed|reverb|nightcore|8d|bass boosted|lofi|lo-fi|chopped)\b/],
  ['demo',         /\b(demo|rough mix|alternate|alt\.? version|early version|outtake)\b/],
  ['arrangement',  /\b(piano version|orchestral|orchestra|symphonic|a cappella|acapella|string version)\b/],
  ['edit',         /\b(radio edit|extended|club mix|dub mix|dance mix|edit)\b/],
  ['rerecord',     /\b(taylor'?s version|re-?recorded|rerecorded)\b/],
];
// Flags where a mismatch is only penalised (lyrics are normally identical;
// the duration / sync-length checks still guard the timing).
const MXM_SOFT_FLAGS = new Set(['edit', 'rerecord']);
// Parenthetical / dash segments that carry no identity ("Remastered 2011",
// "feat. X", "Deluxe Edition", "Official Audio" ...). Anything else, e.g.
// "(Part 2)" or "(Spanish Version)", is kept as part of the title.
const MXM_NOISE = /\b(remaster(?:ed)?|deluxe|edition|mono|stereo|bonus track|explicit|clean|official|audio|video|lyric video|lyrics|soundtrack|motion picture|single version|album version|original version|(?:19|20)\d{2})\b|\bfrom\s+["“”'‘’]/;
const MXM_NOISE_START = /^(?:feat\.?|ft\.?|featuring|with|prod\.?)\b/;

function mxmParseTitle(raw) {
  let rest = String(raw || '').replace(/[‘’]/g, "'");
  const flags = new Set();
  const consume = (seg) => {
    const low = seg.toLowerCase().trim();
    let hit = false;
    for (const [flag, re] of MXM_VERSION_RULES) {
      if (re.test(low)) { flags.add(flag); hit = true; }
    }
    return hit || MXM_NOISE.test(low) || MXM_NOISE_START.test(low);
  };
  rest = rest.replace(/[\(\[]([^\)\]]*)[\)\]]/g, (_m, inner) => (consume(inner) ? ' ' : ` ${inner} `));
  const parts = rest.split(/\s[-–—]\s/);
  if (parts.length > 1) {
    const kept = [parts[0]];
    for (const part of parts.slice(1)) if (!consume(part)) kept.push(part);
    rest = kept.join(' ');
  }
  const plain = rest.replace(/\s+/g, ' ').trim();
  let base = mxmCleanText(plain);
  if (!base) base = plain.toLowerCase().replace(/\s+/g, ' ').trim(); // symbol-only titles
  const digits = (base.match(/\d+/g) || []).sort().join(',');
  return { plain, base, flags, digits };
}

function mxmLevRatio(a, b) {
  if (a === b) return 1;
  const m = a.length, n = b.length;
  if (!m || !n) return 0;
  let prev = Array.from({ length: n + 1 }, (_, j) => j);
  for (let i = 1; i <= m; i++) {
    const cur = [i];
    for (let j = 1; j <= n; j++) {
      cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
    }
    prev = cur;
  }
  return 1 - prev[n] / Math.max(m, n);
}

function mxmTitleMatch(req, cand) {
  if (!req.base || !cand.base) return { ok: false };
  // "Part 1" vs "Part 2", "7 Rings" vs "9 Rings" must never match.
  if (req.digits !== cand.digits) return { ok: false };
  if (req.base === cand.base) return { ok: true, exact: true, sim: 1 };
  const sim = mxmLevRatio(req.base, cand.base);
  const longEnough = Math.min(req.base.length, cand.base.length) >= 8;
  return { ok: longEnough && sim >= 0.88, exact: false, sim };
}

// "A, B & C feat. D" -> ['a','b','c','d'] (each normalised).
function mxmArtistNames(text) {
  return String(text || '')
    .replace(/[‘’]/g, "'")
    .split(/\s*(?:,|&|\+|;|×|\bfeat\.?|\bft\.?|\bfeaturing\b|\band\b|\bwith\b|\svs\.?\s|\sx\s)\s*/i)
    .map((n) => mxmCleanText(n))
    .filter(Boolean)
    .filter((n, i, a) => a.indexOf(n) === i);
}

function mxmNameSim(a, b) {
  if (a === b) return 1;
  const ac = a.replace(/ /g, ''), bc = b.replace(/ /g, '');
  if (ac === bc) return 1;
  if (Math.min(ac.length, bc.length) <= 4) return 0; // short names must match exactly
  return mxmLevRatio(ac, bc);
}
const MXM_NAME_OK = 0.86;

const MXM_MAX_CANDIDATES = 3;
const MXM_CANDIDATE_SCORE_WINDOW = 80;

function pickMxmTracks(list, requestedTitle, requestedArtist, requestedAlbum, duration, requestedYear) {
  const req = mxmParseTitle(requestedTitle);
  const reqNames = mxmArtistNames(requestedArtist);
  const normalizedAlbum = mxmNormalizeAlbum(requestedAlbum);
  const yearWanted = Number(requestedYear) || null;
  const scored = [];

  for (const entry of Array.isArray(list) ? list : []) {
    const track = entry?.track;
    if (!track) continue;
    if (Number(track.instrumental) === 1) continue;
    // has_lyrics is numeric (0/1) in the API, not a boolean.
    if (track.has_lyrics != null && Number(track.has_lyrics) === 0) continue;

    // ---- title identity -------------------------------------------------
    const cand = mxmParseTitle(track.track_name);
    const tm = mxmTitleMatch(req, cand);
    if (!tm.ok) continue;

    // ---- version flags (live / remix / sped up / ...) -------------------
    let penalty = 0;
    let rejected = false;
    for (const f of cand.flags) {
      if (req.flags.has(f)) continue;
      if (MXM_SOFT_FLAGS.has(f)) penalty += 60; else { rejected = true; break; }
    }
    if (rejected) continue;
    for (const f of req.flags) if (!cand.flags.has(f)) penalty += 40;

    // ---- album / duration (computed first: the artist-alias rule uses them)
    const album = mxmNormalizeAlbum(track.album_name || track.album || track.album_name_with_artist || '');
    const albumExact = !!normalizedAlbum && album === normalizedAlbum;
    const albumRelated = !!normalizedAlbum && mxmWordsRelated(album, normalizedAlbum);
    const trackDur = Number(track.track_length) || 0;
    const durDelta = duration > 0 && trackDur > 0 ? Math.abs(trackDur - duration) : null;
    if (durDelta != null) {
      if (durDelta > 45) continue;                    // a different edit, always
      if (durDelta > 15 && !albumExact) continue;     // different edit unless same release
    }

    // ---- artist identity ------------------------------------------------
    const candNames = mxmArtistNames(track.artist_name);
    let matched = 0;
    for (const r of reqNames) if (candNames.some((c) => mxmNameSim(r, c) >= MXM_NAME_OK)) matched++;
    const primaryMatched = reqNames.length
      ? candNames.some((c) => mxmNameSim(reqNames[0], c) >= MXM_NAME_OK)
      : true;
    if (reqNames.length && matched === 0) {
      // Transliterated / aliased artist names (e.g. Latin vs native script):
      // only trust it when title is exact, the album matches AND the length
      // is within 2s - three independent confirmations.
      const aliasOk = tm.exact && albumExact && durDelta != null && durDelta <= 2;
      if (!aliasOk) continue;
      penalty += 30;
    }
    const coverage = reqNames.length
      ? matched / Math.max(reqNames.length, candNames.length || 1)
      : 1;

    // ---- score (lower is better) ---------------------------------------
    let score = penalty;
    score += tm.exact ? 0 : Math.round((1 - tm.sim) * 100);
    if (reqNames.length) {
      score += primaryMatched ? 0 : 15;
      score += Math.round((1 - coverage) * 30);
    }
    // Album and year are tie-breakers only: the same recording is often
    // catalogued under a different album/year on different platforms.
    if (normalizedAlbum) score += albumExact ? 0 : (albumRelated ? 15 : 25);
    if (yearWanted) {
      const ty = mxmYearFromTrack(track);
      score += ty ? Math.min(Math.abs(ty - yearWanted), 10) * 4 : 10;
    }
    if (durDelta != null) {
      if (durDelta <= 2) score += 0;
      else if (durDelta <= 4) score += 5;
      else if (durDelta <= 8) score += 15;
      else if (durDelta <= 15) score += 35;
      else score += 60;
    } else {
      score += 25;
    }
    // Prefer entries that actually carry synced data, then popular ones -
    // never enough to overrule identity.
    if (Number(track.has_richsync) === 1) score -= 4;
    if (Number(track.has_subtitles) === 1) score -= 2;
    if (Number(track.track_rating) > 0) score -= Math.min(Number(track.track_rating), 20) / 20;

    scored.push({ track, score });
  }

  if (!scored.length) return [];
  scored.sort((a, b) => a.score - b.score);
  const cutoff = scored[0].score + MXM_CANDIDATE_SCORE_WINDOW;
  return scored.filter((c) => c.score <= cutoff).slice(0, MXM_MAX_CANDIDATES).map((c) => c.track);
}

function pickMxmTrack(list, requestedTitle, requestedArtist, requestedAlbum, duration, requestedYear) {
  return pickMxmTracks(list, requestedTitle, requestedArtist, requestedAlbum, duration, requestedYear)[0] || null;
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
  const lines = String(body)
    .split(/\r?\n/)
    .map((t) => t.trim())
    // Musixmatch appends a licence footer + tracking id to plain lyrics.
    .filter((t) => t && !/^\*{3,}.*\*{3,}$/.test(t) && !/^\(\d{6,}\)$/.test(t))
    .map((text) => ({ text }));
  return lines.length ? { mode: 'plain', lines } : null;
}

async function mxmApiGet(profile, path, params) {
  const url = new URL(path, profile.base);
  url.searchParams.set('app_id', profile.appId);
  url.searchParams.set('format', 'json');
  for (const [key, value] of Object.entries(params || {})) {
    if (value !== undefined && value !== null && value !== '') url.searchParams.set(key, String(value));
  }
  let finalUrl = url.toString();
  if (profile.sign) finalUrl = await signMxmUrl(finalUrl, await getMxmSecret(false));
  return mxmFetchJson(finalUrl, { headers: MXM_HEADERS });
}

async function getMxmToken(profile, forceRefresh = false) {
  const cached = mxmTokens.get(profile.name);
  if (!forceRefresh && cached && Date.now() - cached.at < MXM_TOKEN_TTL_MS) return cached.token;

  const params = profile.sign ? { guid: mxmGuid } : {};
  const response = await mxmApiGet(profile, 'token.get', params);
  if (mxmStatus(response) !== 200) throw new Error(`Musixmatch token status ${mxmStatus(response)} (${profile.name})`);
  const token = response?.message?.body?.user_token;
  if (!token || MXM_BAD_TOKEN.test(token)) throw new Error(`Musixmatch refused to issue a token (${profile.name})`);
  mxmTokens.set(profile.name, { token, at: Date.now() });
  return token;
}

function mxmIsAuthStatus(response) {
  const st = mxmStatus(response);
  return st === 401 || st === 402;
}

// Fetches synced/plain lyrics for ONE candidate track and validates that the
// sync belongs to the same recording (via the sync's own reported length and
// its timeline). Returns parsed lyrics, or null so the caller can try the
// next candidate instead of serving a mismatched version.
async function mxmLyricsForCandidate(call, token, cand, track) {
  const trackId = cand.track_id;
  const commonTrackId = cand.commontrack_id || null;
  const baseParams = { track_id: trackId, usertoken: token };
  const durS = Number(track.duration) || 0;
  const durMs = durS * 1000;

  // Reported length of the sync (seconds) vs the real track length.
  const lengthFits = (len) => {
    const l = Number(len) || 0;
    if (!durS || !l) return true;
    return Math.abs(l - durS) <= Math.max(15, durS * 0.1);
  };
  // Timeline vs track length: last lyric far past the end => other edit;
  // last lyric implausibly early => truncated / other song.
  const timelineFits = (parsed) => {
    if (!durMs || !parsed?.lines?.length) return true;
    const last = parsed.lines[parsed.lines.length - 1];
    const lastMs = Number((parsed.mode === 'word' ? (last.end ?? last.start) : last.start)) || 0;
    if (lastMs > durMs + Math.max(20000, durMs * 0.25)) return false;
    if (durS > 90 && lastMs < durMs * 0.3) return false;
    return true;
  };

  const rich = await call('track.richsync.get', baseParams);
  if (mxmIsAuthStatus(rich)) throw new Error(`AUTH:${mxmStatus(rich)}`);
  const richObj = rich?.message?.body?.richsync;
  if (mxmStatus(rich) === 200 && richObj?.richsync_body && lengthFits(richObj.richsync_length)) {
    const parsed = parseMxmRichsync(richObj.richsync_body);
    if (parsed && timelineFits(parsed)) return parsed;
  }

  const subtitleParams = { ...baseParams };
  if (commonTrackId) subtitleParams.commontrack_id = commonTrackId;
  const subtitle = await call('track.subtitle.get', subtitleParams);
  if (mxmIsAuthStatus(subtitle)) throw new Error(`AUTH:${mxmStatus(subtitle)}`);
  const subObj = subtitle?.message?.body?.subtitle;
  if (mxmStatus(subtitle) === 200 && subObj?.subtitle_body && lengthFits(subObj.subtitle_length)) {
    const parsed = parseMxmSubtitle(subObj.subtitle_body);
    if (parsed && timelineFits(parsed)) return parsed;
  }

  const plain = await call('track.lyrics.get', baseParams);
  if (mxmIsAuthStatus(plain)) throw new Error(`AUTH:${mxmStatus(plain)}`);
  const lyrics = plain?.message?.body?.lyrics;
  if (mxmStatus(plain) === 200 && lyrics?.lyrics_body && !lyrics.restricted) {
    const parsed = parseMxmPlain(lyrics.lyrics_body);
    if (parsed) return parsed;
  }
  return null;
}

async function mxmLyricsWithProfile(profile, track, allowRetry = true) {
  try {
    const token = await getMxmToken(profile, false);
    const call = (path, params) => mxmApiGet(profile, path, params);

    const { cleanTitle, featured } = mxmExtractFeatured(track.song);
    // Fold title-only featured credits into the artist so neither the query
    // nor the artist check is blind to a co-artist.
    const combinedArtist = featured.length
      ? `${track.artist}, ${featured.join(', ')}`
      : track.artist;
    const primaryArtist = String(track.artist || '')
      .split(/\s*(?:,|&|\+|;|×|\bfeat\.?|\bft\.?|\bfeaturing\b)\s*/i)[0].trim();
    const plainTitle = mxmParseTitle(cleanTitle).plain;

    const baseSearch = {
      q_track: cleanTitle,
      q_artist: combinedArtist,
      f_has_lyrics: 'true',
      page_size: 10,
      s_track_rating: 'desc',
    };
    // Widening ladder - stops at the first query that yields a candidate
    // that passes the strict identity checks.
    const attempts = [{ ...baseSearch, q_album: track.album || undefined }];
    if (track.album) attempts.push({ ...baseSearch });
    if (plainTitle && plainTitle !== cleanTitle) attempts.push({ ...baseSearch, q_track: plainTitle });
    if (primaryArtist && primaryArtist !== combinedArtist) attempts.push({ ...baseSearch, q_artist: primaryArtist });

    let candidates = [];
    for (let i = 0; i < attempts.length && !candidates.length; i++) {
      const resp = await call('track.search', { ...attempts[i], usertoken: token });
      if (mxmIsAuthStatus(resp)) throw new Error(`AUTH:${mxmStatus(resp)}`);
      if (mxmStatus(resp) !== 200) {
        if (i === 0) throw new Error(`Musixmatch search status ${mxmStatus(resp)} (${profile.name})`);
        continue;
      }
      candidates = pickMxmTracks(
        resp?.message?.body?.track_list,
        cleanTitle,
        combinedArtist,
        track.album || null,
        Number(track.duration) || 0,
        Number(track.year) || null
      );
    }
    if (!candidates.length) {
      const nf = new Error('Musixmatch track not found');
      nf.mxmNotFound = true;
      throw nf;
    }

    for (const cand of candidates) {
      const parsed = await mxmLyricsForCandidate(call, token, cand, track);
      if (parsed) return parsed;
    }
    return null;
  } catch (e) {
    if (allowRetry && String(e?.message || '').startsWith('AUTH:')) {
      mxmTokens.delete(profile.name);
      if (profile.sign) { mxmSecretCache = null; mxmSecretFetchedAt = 0; }
      return mxmLyricsWithProfile(profile, track, false);
    }
    throw e;
  }
}

// Tries the preferred (last known-good) profile first, then the others, so a
// host/app-id the service has blocked degrades to the next one instead of
// silently returning no lyrics. Failures are logged to the service-worker
// console ("[Vivi] Musixmatch ...") to make future breakage diagnosable.
async function getMusixmatchLyrics(track) {
  const order = [mxmPreferredProfile, ...MXM_PROFILES.map((_, i) => i).filter(i => i !== mxmPreferredProfile)];
  let lastErr = null;
  for (const idx of order) {
    const profile = MXM_PROFILES[idx];
    try {
      const lyrics = await mxmLyricsWithProfile(profile, track, true);
      mxmPreferredProfile = idx;
      return lyrics;
    } catch (e) {
      if (e?.mxmNotFound) { mxmPreferredProfile = idx; throw e; }
      console.warn(`[Vivi] Musixmatch (${profile.name}) failed:`, e?.message || e);
      lastErr = e;
    }
  }
  throw lastErr || new Error('Musixmatch unavailable');
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
