
/* VIVIMUSIC WEB — Spotify Canvas integration.
 * Uses the user's own Spotify web-player session locally.
 * Canvas endpoint is undocumented and can change without notice.
 */
'use strict';

const SPOTIFY_SECRET_URL = 'https://code.thetadev.de/ThetaDev/spotify-secrets/raw/branch/main/secrets/secretDict.json';
const SPOTIFY_HOME = 'https://open.spotify.com/';
const SPOTIFY_SERVER_TIME = 'https://open.spotify.com/api/server-time';
const SPOTIFY_TOKEN_URL = 'https://open.spotify.com/api/token';
const SPOTIFY_CANVAS_PATH = '/canvaz-cache/v0/canvases';
const SPOTIFY_LYRICS_HOST_FALLBACK = 'spclient.wg.spotify.com';
const SPOTIFY_APRESOLVE = 'https://apresolve.spotify.com/?type=spclient';
const SPOTIFY_CLIENT_TOKEN_URL = 'https://clienttoken.spotify.com/v1/clienttoken';
const SPOTIFY_SEARCH_URL = 'https://open.spotify.com/search/';
const SPOTIFY_PARTNER_SEARCH_URL = 'https://api-partner.spotify.com/pathfinder/v1/query';
let spotifyClientTokenCache = null;
const SPOTIFY_UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/151.0.0.0 Safari/537.36';

let spotifyTokenCache = null;
let spotifySecretCache = null;
let spotifyClientInfo = null;

function spotifyJsonError(msg) { return { ok: false, error: msg }; }

async function getSpDc() {
  const { spotifySpDc } = await chrome.storage.local.get('spotifySpDc');
  if (spotifySpDc) return spotifySpDc;
  try {
    const c = await chrome.cookies.get({ url: SPOTIFY_HOME, name: 'sp_dc' });
    return c?.value || null;
  } catch { return null; }
}

async function setSpDc(value) {
  value = String(value || '').trim();
  if (!value) throw new Error('Empty sp_dc');
  // Keep a local copy and also install it as the Spotify web-player cookie so
  // extension fetch() requests can authenticate with credentials: include.
  await chrome.storage.local.set({ spotifySpDc: value });
  await chrome.cookies.set({
    url: SPOTIFY_HOME,
    name: 'sp_dc',
    value,
    domain: '.spotify.com',
    path: '/',
    secure: true,
    httpOnly: true,
    sameSite: 'lax'
  });
}

async function getSecretDict() {
  if (spotifySecretCache) return spotifySecretCache;
  const r = await fetch(SPOTIFY_SECRET_URL, { cache: 'no-store' });
  if (!r.ok) throw new Error(`TOTP secret source returned ${r.status}`);
  spotifySecretCache = await r.json();
  return spotifySecretCache;
}

function base32Encode(bytes) {
  const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
  let bits = 0, value = 0, out = '';
  for (const b of bytes) {
    value = (value << 8) | b; bits += 8;
    while (bits >= 5) {
      out += alphabet[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }
  if (bits) out += alphabet[(value << (5 - bits)) & 31];
  return out;
}

async function hmacSha1(keyBytes, messageBytes) {
  const key = await crypto.subtle.importKey('raw', keyBytes, { name: 'HMAC', hash: 'SHA-1' }, false, ['sign']);
  return new Uint8Array(await crypto.subtle.sign('HMAC', key, messageBytes));
}

async function makeTotp(secretBytes, unixSeconds) {
  const transformed = secretBytes.map((e, i) => e ^ ((i % 33) + 9));
  const decimalJoined = transformed.map(n => String(n)).join('');
  const ascii = new TextEncoder().encode(decimalJoined);
  // base32Decode without external libraries
  const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
  let bits = 0, value = 0, raw = [];
  for (const ch of base32Encode(ascii)) {
    value = (value << 5) | alphabet.indexOf(ch); bits += 5;
    if (bits >= 8) { raw.push((value >>> (bits - 8)) & 255); bits -= 8; }
  }
  const msg = new Uint8Array(8);
  let counter = Math.floor(unixSeconds / 30);
  for (let i = 7; i >= 0; i--) { msg[i] = counter & 255; counter = Math.floor(counter / 256); }
  const mac = await hmacSha1(new Uint8Array(raw), msg);
  const offset = mac[mac.length - 1] & 15;
  const bin = ((mac[offset] & 127) << 24) | (mac[offset + 1] << 16) | (mac[offset + 2] << 8) | mac[offset + 3];
  return String(bin % 1000000).padStart(6, '0');
}

async function getSpotifyToken(spDc) {
  const now = Date.now();
  if (spotifyTokenCache && spotifyTokenCache.spDc === spDc &&
      spotifyTokenCache.expiresAt > now + 30000) return spotifyTokenCache;

  const home = await fetch(SPOTIFY_HOME, {
    credentials: 'include',
    headers: { 'User-Agent': SPOTIFY_UA },
    cache: 'no-store'
  });
  if (!home.ok) throw new Error(`Spotify session check failed (${home.status})`);
  const homeText = await home.text();

  let clientVersion = '';
  let clientId = '';
  try {
    const m = homeText.match(/<script id="appServerConfig" type="text\/plain">([^<]+)<\/script>/);
    if (m) {
      const decoded = atob(m[1]);
      const cfg = JSON.parse(decoded);
      clientVersion = cfg.clientVersion || '';
      clientId = cfg.clientId || '';
    }
  } catch {}

  const serverResp = await fetch(SPOTIFY_SERVER_TIME, {
    credentials: 'include',
    headers: { 'User-Agent': SPOTIFY_UA },
    cache: 'no-store'
  });
  if (!serverResp.ok) throw new Error(`Spotify server-time failed (${serverResp.status})`);
  const serverJson = await serverResp.json();
  const serverTime = Number(serverJson.serverTime || Math.floor(Date.now() / 1000));

  const dict = await getSecretDict();
  const versions = Object.keys(dict).map(Number).sort((a,b) => b-a);
  if (!versions.length) throw new Error('No Spotify TOTP secret available');
  const version = versions[0];
  const totp = await makeTotp(dict[String(version)], serverTime);

  const params = new URLSearchParams({
    reason: 'transport',
    productType: 'web-player',
    totp,
    totpVer: String(version),
    totpServer: totp,
    sTime: String(serverTime),
    cTime: String(serverTime),
    ts: String(Date.now()),
  });
  const tokenResp = await fetch(`${SPOTIFY_TOKEN_URL}?${params}`, {
    credentials: 'include',
    headers: {
      'User-Agent': SPOTIFY_UA,
      'App-Platform': 'WebPlayer',
      'Spotify-App-Version': clientVersion || '1.2.87.27.ga2033a72',
      'Accept': 'application/json',
      'Origin': 'https://open.spotify.com',
      'Referer': 'https://open.spotify.com/'
    },
    cache: 'no-store'
  });
  const tokenText = await tokenResp.text();
  if (!tokenResp.ok) throw new Error(`Spotify token failed (${tokenResp.status}): ${tokenText.slice(0,180)}`);
  let data;
  try { data = JSON.parse(tokenText); } catch { throw new Error('Spotify returned invalid token JSON'); }
  if (!data.accessToken) throw new Error(data?.error?.message || 'Spotify did not return an access token');

  spotifyClientInfo = { clientVersion: clientVersion || '1.2.87.27.ga2033a72', clientId: data.clientId || clientId || '' };
  spotifyTokenCache = {
    spDc,
    token: data.accessToken,
    expiresAt: Number(data.accessTokenExpirationTimestampMs || Date.now() + 3600000)
  };
  return spotifyTokenCache;
}

function encodeVarint(n) {
  const out = [];
  n = BigInt(n);
  while (n > 127n) { out.push(Number((n & 127n) | 128n)); n >>= 7n; }
  out.push(Number(n));
  return out;
}
function fieldString(field, value) {
  const b = Array.from(new TextEncoder().encode(value));
  return [field << 3 | 2, ...encodeVarint(b.length), ...b];
}
function canvasRequest(trackUri) {
  // EntityCanvazRequest { repeated Entity entities = 1 }
  // Entity { string entityUri = 1 }
  const entity = fieldString(1, trackUri);
  return new Uint8Array([1 << 3 | 2, ...encodeVarint(entity.length), ...entity]);
}
function readVarint(bytes, state) {
  let value = 0n, shift = 0n;
  while (state.i < bytes.length) {
    const b = bytes[state.i++];
    value |= BigInt(b & 127) << shift;
    if (!(b & 128)) return Number(value);
    shift += 7n;
  }
  return null;
}
function skipField(bytes, state, wire) {
  if (wire === 0) { readVarint(bytes, state); return; }
  if (wire === 2) { const len = readVarint(bytes, state); state.i += Number(len || 0); return; }
  if (wire === 1) { state.i += 8; return; }
  if (wire === 5) { state.i += 4; return; }
  state.i = bytes.length;
}
function readStringField(bytes) {
  const state = { i: 0 };
  let url = null;
  while (state.i < bytes.length) {
    const tag = readVarint(bytes, state); if (tag == null) break;
    const field = tag >> 3, wire = tag & 7;
    if (wire === 2) {
      const len = readVarint(bytes, state); if (len == null) break;
      const end = state.i + len;
      const data = bytes.slice(state.i, end); state.i = end;
      const text = new TextDecoder().decode(data);
      if (field === 1 || field === 2 || field === 3 || field === 5 || field === 9 || field === 11) {
        if (/^https:\/\/canvaz\.scdn\.co\//.test(text) || /^https?:\/\/.+\.mp4(?:\?.*)?$/i.test(text)) url = text;
        // Nested Canvaz message: recurse.
        if (!url && data.length > 2) {
          const nested = readStringField(data);
          if (nested) url = nested;
        }
      }
    } else skipField(bytes, state, wire);
  }
  return url;
}

async function fetchCanvasBySpotifyId(trackId) {
  const spDc = await getSpDc();
  if (!spDc) throw new Error('Spotify is not connected');
  const auth = await getSpotifyToken(spDc);
  const clientToken = await getSpotifyClientToken();

  const headers = {
    'Authorization': `Bearer ${auth.token}`,
    'Client-Token': clientToken,
    'Content-Type': 'application/protobuf',
    'Accept': 'application/protobuf',
    'App-platform': 'WebPlayer',
    'Spotify-App-Version': spotifyClientInfo?.clientVersion || '1.2.87.27.ga2033a72',
    'User-Agent': 'Spotify/8.5.49 iOS/Version 13.3.1 (Build 17D50)'
  };

  const locationsResp = await fetch(SPOTIFY_APRESOLVE, { cache: 'no-store' });
  if (!locationsResp.ok) throw new Error(`Spotify server resolve failed (${locationsResp.status})`);
  const locations = await locationsResp.json();
  const hosts = Array.isArray(locations?.spclient) ? locations.spclient : [];
  const host = hosts[0] || 'spclient.wg.spotify.com';
  console.info('[Vivi Spotify] Requesting Canvas:', host, trackId);

  const r = await fetch(`https://${host}${SPOTIFY_CANVAS_PATH}`, {
    method: 'POST',
    headers,
    body: canvasRequest(`spotify:track:${trackId}`),
    cache: 'no-store'
  });
  const buf = new Uint8Array(await r.arrayBuffer());
  if (!r.ok) {
    const body = new TextDecoder().decode(buf).slice(0,180);
    throw new Error(`Canvas endpoint returned ${r.status}${body ? `: ${body}` : ''}`);
  }
  const canvasUrl = readStringField(buf);
  if (!canvasUrl) {
    console.info('[Vivi Spotify] Canvas response contained no video for', trackId);
    return null;
  }
  console.info('[Vivi Spotify] Canvas URL received from Spotify CDN');
  return canvasUrl;
}

async function fetchLyricsBySpotifyId(trackId) {
  const spDc = await getSpDc();
  if (!spDc) throw new Error('Spotify is not connected');
  const auth = await getSpotifyToken(spDc);
  const clientToken = await getSpotifyClientToken();

  const headers = {
    'Authorization': `Bearer ${auth.token}`,
    'Client-Token': clientToken,
    'Accept': 'application/json',
    'App-platform': 'WebPlayer',
    'Spotify-App-Version': spotifyClientInfo?.clientVersion || '1.2.87.27.ga2033a72',
    'User-Agent': SPOTIFY_UA
  };

  let host = SPOTIFY_LYRICS_HOST_FALLBACK;
  try {
    const locationsResp = await fetch(SPOTIFY_APRESOLVE, { cache: 'no-store' });
    if (locationsResp.ok) {
      const locations = await locationsResp.json();
      const hosts = Array.isArray(locations?.spclient) ? locations.spclient : [];
      if (hosts[0]) host = hosts[0];
    }
  } catch {}

  console.info('[Vivi Spotify] Requesting lyrics:', host, trackId);
  const r = await fetch(`https://${host}/color-lyrics/v2/track/${trackId}?format=json&market=from_token`, {
    headers,
    cache: 'no-store'
  });
  if (r.status === 404) {
    console.info('[Vivi Spotify] No lyrics available for', trackId);
    return null;
  }
  const text = await r.text();
  if (!r.ok) throw new Error(`Spotify lyrics endpoint returned ${r.status}${text ? `: ${text.slice(0,180)}` : ''}`);
  let data;
  try { data = JSON.parse(text); } catch { throw new Error('Spotify lyrics returned invalid JSON'); }

  const body = data?.lyrics;
  if (!body || !Array.isArray(body.lines) || body.lines.length === 0) return null;

  const syncType = body.syncType || 'UNSYNCED';
  if (syncType === 'LINE_SYNCED') {
    const lines = body.lines
      .map((l) => ({ start: Number(l.startTimeMs) || 0, text: l.words || '' }))
      .filter((l) => l.text !== '');
    if (!lines.length) return null;
    lines.sort((a, b) => a.start - b.start);
    for (let i = 0; i < lines.length; i++) {
      lines[i].end = i < lines.length - 1 ? lines[i + 1].start : lines[i].start + 8000;
    }
    console.info('[Vivi Spotify] Lyrics received (line-synced) for', trackId);
    return { mode: 'line', lines, provider: 'Spotify' };
  }

  // Unsynced: join line text as plain lyrics.
  const plainText = body.lines.map((l) => l.words || '').filter(Boolean).join('\n');
  if (!plainText) return null;
  console.info('[Vivi Spotify] Lyrics received (plain) for', trackId);
  return { mode: 'plain', text: plainText, provider: 'Spotify' };
}

async function spotifyLyricsForTrack(track) {
  const id = await resolveSpotifyTrackId(track);
  if (!id) return null;
  return fetchLyricsBySpotifyId(id);
}

async function getSpotifyClientToken() {
  if (spotifyClientTokenCache?.token && spotifyClientTokenCache.expiresAt > Date.now() + 30000) {
    return spotifyClientTokenCache.token;
  }

  const clientVersion = spotifyClientInfo?.clientVersion || '1.2.87.27.ga2033a72';
  const clientId = spotifyClientInfo?.clientId || '';
  const deviceId = crypto.randomUUID();
  const payload = {
    client_data: {
      client_version: clientVersion,
      client_id: clientId,
      js_sdk_data: {
        device_brand: 'unknown',
        device_model: 'unknown',
        os: 'windows',
        os_version: 'NT 10.0',
        device_id: deviceId,
        device_type: 'computer'
      }
    }
  };

  console.info('[Vivi Spotify] Requesting client token');
  const r = await fetch(SPOTIFY_CLIENT_TOKEN_URL, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Accept': 'application/json',
      'User-Agent': SPOTIFY_UA
    },
    body: JSON.stringify(payload),
    cache: 'no-store'
  });
  const text = await r.text();
  if (!r.ok) throw new Error(`Spotify client-token failed (${r.status}): ${text.slice(0,180)}`);
  let data;
  try { data = JSON.parse(text); } catch { throw new Error('Spotify client-token returned invalid JSON'); }

  const token = data?.granted_token?.token || data?.clientToken || data?.client_token;
  if (!token) throw new Error(`Spotify client-token response contained no token (${data?.response_type || 'unknown response'})`);
  spotifyClientTokenCache = { token, expiresAt: Date.now() + 50 * 60 * 1000 };
  console.info('[Vivi Spotify] Client token acquired');
  return token;
}

function collectSpotifyTrackCandidates(node, out = []) {
  if (!node || typeof node !== 'object') return out;
  if (Array.isArray(node)) {
    for (const item of node) collectSpotifyTrackCandidates(item, out);
    return out;
  }
  const uri = typeof node.uri === 'string' ? node.uri : '';
  if (uri.startsWith('spotify:track:')) {
    out.push({
      id: uri.slice('spotify:track:'.length),
      name: node.name || node.title || node.track?.name || '',
      artists: Array.isArray(node.artists) ? node.artists.map(a => a?.name || a).filter(Boolean) : [],
      raw: node
    });
  }
  for (const value of Object.values(node)) collectSpotifyTrackCandidates(value, out);
  return out;
}

function normalizeText(s) {
  return String(s || '').toLowerCase().replace(/[\u2018\u2019]/g, "'").replace(/\s+/g, ' ').trim();
}

async function resolveSpotifyTrackId(track) {
  const spDc = await getSpDc();
  if (!spDc) throw new Error('Spotify is not connected');
  const auth = await getSpotifyToken(spDc);
  const clientToken = await getSpotifyClientToken();
  const q = `${track.song} ${track.artist}`;
  const variables = JSON.stringify({
    searchTerm: q,
    offset: 0,
    limit: 5,
    numberOfTopResults: 5,
    includeAudiobooks: true,
    includePreReleases: false
  });
  const params = new URLSearchParams({
    operationName: 'searchTracks',
    variables,
    extensions: JSON.stringify({
      persistedQuery: {
        version: 1,
        sha256Hash: 'bc1ca2fcd0ba1013a0fc88e6cc4f190af501851e3dafd3e1ef85840297694428'
      }
    })
  });

  console.info('[Vivi Spotify] Searching Spotify partner API:', q);
  const r = await fetch(`${SPOTIFY_PARTNER_SEARCH_URL}?${params}`, {
    headers: {
      'Authorization': `Bearer ${auth.token}`,
      'Client-Token': clientToken,
      'App-platform': 'WebPlayer',
      'Spotify-App-Version': spotifyClientInfo?.clientVersion || '1.2.87.27.ga2033a72',
      'Accept': 'application/json',
      'User-Agent': SPOTIFY_UA
    },
    cache: 'no-store'
  });
  const text = await r.text();
  if (!r.ok) throw new Error(`Spotify partner search failed (${r.status}): ${text.slice(0,180)}`);
  let data;
  try { data = JSON.parse(text); } catch { throw new Error('Spotify partner search returned invalid JSON'); }

  const candidates = collectSpotifyTrackCandidates(data);
  if (!candidates.length) return null;

  const wantedSong = normalizeText(track.song);
  const wantedArtist = normalizeText(track.artist);
  const exact = candidates.find(c => {
    const title = normalizeText(c.name);
    const artists = c.artists.map(normalizeText);
    return title === wantedSong && artists.some(a => a === wantedArtist || a.includes(wantedArtist) || wantedArtist.includes(a));
  });
  const titleMatch = candidates.find(c => normalizeText(c.name) === wantedSong);
  const selected = exact || titleMatch || candidates[0];
  console.info('[Vivi Spotify] Matched track:', selected.id);
  return selected.id;
}
async function spotifyCanvasForTrack(track) {
  const key = `${track.artist}—${track.song}`;
  const cached = await chrome.storage.local.get(`spotify_canvas_${key}`);
  if (cached[`spotify_canvas_${key}`]?.videoUrl) return cached[`spotify_canvas_${key}`].videoUrl;
  const id = await resolveSpotifyTrackId(track);
  if (!id) return null;
  const url = await fetchCanvasBySpotifyId(id);
  if (url) {
    await chrome.storage.local.set({ [`spotify_canvas_${key}`]: { videoUrl: url, spotifyId: id, cachedAt: Date.now() } });
  }
  return url;
}

async function spotifyStatus() {
  const spDc = await getSpDc();
  const { spotifyCanvasEnabled = true } = await chrome.storage.local.get('spotifyCanvasEnabled');
  if (!spDc) return { enabled: spotifyCanvasEnabled !== false, connected: false, masked: null };
  try {
    await getSpotifyToken(spDc);
    return { enabled: spotifyCanvasEnabled !== false, connected: true, masked: `${spDc.slice(0,4)}…${spDc.slice(-4)}` };
  } catch (e) {
    return { enabled: spotifyCanvasEnabled !== false, connected: false, masked: `${spDc.slice(0,4)}…${spDc.slice(-4)}`, error: e?.message || 'Spotify authentication failed' };
  }
}

async function spotifyConnectFromBrowser() {
  // Open Spotify so the user can authenticate normally. We never collect a password.
  const tab = await chrome.tabs.create({ url: SPOTIFY_HOME, active: true });
  // Poll the cookie store until the user has logged in.
  const deadline = Date.now() + 120000;
  while (Date.now() < deadline) {
    await new Promise(r => setTimeout(r, 1500));
    const c = await chrome.cookies.get({ url: SPOTIFY_HOME, name: 'sp_dc' });
    if (c?.value) {
      await setSpDc(c.value);
      return { ok: true };
    }
  }
  return spotifyJsonError('No sp_dc cookie detected. Finish logging in to Spotify and try again.');
}

async function clearSpotify() {
  spotifyTokenCache = null;
  spotifyClientTokenCache = null;
  await chrome.storage.local.remove(['spotifySpDc']);
  try { await chrome.cookies.remove({ url: SPOTIFY_HOME, name: 'sp_dc' }); } catch {}
  return { ok: true };
}


/* ─── Spotify → YouTube Music transfer helpers ─────────────────────────── */
/*
 * IMPORTANT: Spotify's public Web API now rate-limits web-player bearer tokens
 * used outside a normal developer OAuth app. The transfer feature therefore
 * uses the same internal Pathfinder GraphQL service as Spotify Web itself.
 * This is read-only for Spotify in this feature.
 */
const SPOTIFY_GQL_URL = 'https://api-partner.spotify.com/pathfinder/v2/query';
const SPOTIFY_GQL_HASHES = {
  profileAttributes: {
    hash: '08ffb4730af3746e04a8301396f20875dbbce10c75243803091a9274eacc8ac0',
    previous: 'b197b5adb4b761690f76ad9d9fb278c14c14e7331f357c04a56e7001af7106e0'
  },
  libraryV3: {
    hash: '390c78e5b951029bad359785e69b07b536a509c581cbcd0aded5e5067f187455',
    previous: '973e511ca44261fda7eebac8b653155e7caee3675abb4fb110cc1b8c78b091c3'
  },
  fetchPlaylist: {
    hash: '86dde7b9d9356e2369414647cf6950cfed96e778e129cfdfc99aea6c1613b3b0',
    previous: 'e4b2953f160e58e38ac025d79b5a9b3aceee5c4c716598e9830bfceb69faff5f'
  },
  fetchLibraryTracks: {
    hash: '087278b20b743578a6262c2b0b4bcd20d879c503cc359a2285baf083ef944240'
  }
};

async function spotifyGql(operationName, variables = {}) {
  const spDc = await getSpDc();
  if (!spDc) throw new Error('Spotify is not connected. Open Spotify and sign in first.');
  const auth = await getSpotifyToken(spDc);
  const clientToken = await getSpotifyClientToken();
  const hashes = SPOTIFY_GQL_HASHES[operationName];
  if (!hashes?.hash) throw new Error(`No Spotify GraphQL hash configured for ${operationName}`);

  const candidates = [hashes.hash, hashes.previous].filter(Boolean);
  let lastError = null;

  for (const hash of candidates) {
    const body = {
      operationName,
      variables,
      extensions: { persistedQuery: { version: 1, sha256Hash: hash } }
    };
    for (let attempt = 0; attempt < 3; attempt++) {
      const r = await fetch(SPOTIFY_GQL_URL, {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${auth.token}`,
          'Client-Token': clientToken,
          'Content-Type': 'application/json',
          'Accept': 'application/json',
          'App-Platform': 'WebPlayer',
          'Origin': 'https://open.spotify.com',
          'Referer': 'https://open.spotify.com/',
          'User-Agent': SPOTIFY_UA
        },
        body: JSON.stringify(body),
        cache: 'no-store'
      });
      const text = await r.text();
      if (r.status === 429) {
        const retryAfter = Math.max(2, Number(r.headers.get('Retry-After') || 2 * (attempt + 1)));
        await new Promise(resolve => setTimeout(resolve, Math.min(retryAfter, 10) * 1000));
        continue;
      }
      if (r.status === 401) throw new Error('Spotify session expired. Open Spotify, reload it, then try again.');
      if (r.status === 412 || /PersistedQueryNotFound/i.test(text)) {
        lastError = new Error(`Spotify query hash rejected for ${operationName}`);
        break;
      }
      if (!r.ok) throw new Error(`Spotify internal API ${r.status}: ${text.slice(0, 220)}`);
      let data;
      try { data = JSON.parse(text); } catch { throw new Error('Spotify returned invalid GraphQL JSON.'); }
      const gqlErr = data?.errors?.[0]?.message;
      if (gqlErr) {
        if (/PersistedQueryNotFound/i.test(gqlErr)) { lastError = new Error(gqlErr); break; }
        throw new Error(`Spotify GraphQL: ${gqlErr}`);
      }
      return data;
    }
  }
  throw lastError || new Error(`Spotify GraphQL request failed: ${operationName}`);
}

function gqlTrackFromData(data, uriOverride = null) {
  if (!data || typeof data !== 'object') return null;
  const uri = uriOverride || data.uri || data._uri || data.playableUri || '';
  const spotifyId = String(uri).startsWith('spotify:track:') ? String(uri).split(':').pop() : '';
  const artists = Array.isArray(data.artists?.items) ? data.artists.items
    .map(x => x?.profile?.name || x?.name || '').filter(Boolean) : [];
  const album = data.albumOfTrack || data.album || {};
  const durationMs = Number(
    data.duration?.totalMilliseconds || data.durationMs || data.duration_ms ||
    (Number(data.duration || 0) * 1000) || 0
  );
  if (!spotifyId && !data.name) return null;
  return {
    spotifyId,
    song: data.name || '',
    artist: artists.join(', '),
    album: album.name || '',
    durationMs: Number.isFinite(durationMs) ? durationMs : 0,
    isrc: data.externalIds?.isrc || data.external_ids?.isrc || null
  };
}

function collectGqlPlaylistWrappers(items, out = []) {
  if (!Array.isArray(items)) return out;
  for (const item of items) {
    const wrapper = item?.item;
    const typeName = wrapper?.__typename || '';
    if (/Playlist/i.test(typeName) && wrapper?.data) out.push(wrapper);
  }
  return out;
}

// Synthetic id used to represent the Liked Songs collection wherever the rest
// of the extension expects a normal Spotify playlist id.
const SPOTIFY_LIKED_SONGS_ID = 'liked-songs';

// Spotify's internal API doesn't return cover art for the Liked Songs
// "Collection" object, so fall back to a Spotify-style dark gradient tile
// with a heart, rendered inline (no network fetch needed).
const SPOTIFY_LIKED_SONGS_FALLBACK_IMAGE = 'data:image/svg+xml;base64,' + btoa(`
<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 300 300">
  <defs>
    <linearGradient id="g" x1="0" y1="0" x2="1" y2="1">
      <stop offset="0%" stop-color="#450af5"/>
      <stop offset="100%" stop-color="#c4efd9"/>
    </linearGradient>
  </defs>
  <rect width="300" height="300" fill="url(#g)"/>
  <path d="M150 225 L60 138 C35 113 35 75 65 55 C90 39 118 46 135 70 L150 90 L165 70 C182 46 210 39 235 55 C265 75 265 113 240 138 Z" fill="#ffffff" opacity="0.92"/>
</svg>`);

function trackTotalFromPlaylist(playlistData) {
  return Number(
    playlistData?.content?.totalCount || playlistData?.contents?.totalCount ||
    playlistData?.tracks?.totalCount || playlistData?.tracksV2?.totalCount ||
    playlistData?.totalCount || playlistData?.trackCount ||
    playlistData?.numTracks || playlistData?.numberOfTracks || 0
  );
}

function extractTrackItemsFromContent(content) {
  const out = [];
  for (const elem of (content?.items || [])) {
    const itemV2 = elem?.itemV2;
    const trackData = itemV2?.data;
    const uri = itemV2?._uri || itemV2?.uri || trackData?.uri || '';
    const t = gqlTrackFromData(trackData, uri);
    if (t?.spotifyId) out.push(t);
  }
  return out;
}

function deepCollectTracks(node, out = [], seenObjs = seenObjs_default()) {
  if (!node || typeof node !== 'object') return out;
  if (seenObjs.has(node)) return out;
  seenObjs.add(node);
  if (Array.isArray(node)) { for (const x of node) deepCollectTracks(x, out, seenObjs); return out; }
  // Fast path: the wrapper shapes we already know about (playlist items etc).
  const maybe = node.itemV2?.data || node.item?.data || node.track?.data || node.track;
  const t = gqlTrackFromData(maybe, node.itemV2?._uri || node.itemV2?.uri || node.item?._uri || node.item?.uri || node.track?._uri || node.track?.uri || node.uri || null);
  if (t?.spotifyId) out.push(t);
  // Generic fallback: some queries (e.g. fetchLibraryTracks) wrap the track
  // object under keys we don't know in advance. Recognize a track object by
  // its own shape instead of the key that points to it, so schema drift or
  // an unfamiliar wrapper name doesn't silently produce zero results.
  if (!t?.spotifyId && looksLikeTrackData(node)) {
    const direct = gqlTrackFromData(node, node.uri || node._uri);
    if (direct?.spotifyId) out.push(direct);
  }
  for (const [k, v] of Object.entries(node)) {
    if (k === 'images' || k === 'visuals' || k === 'avatar') continue;
    deepCollectTracks(v, out, seenObjs);
  }
  return out;
}
function seenObjs_default() { return new Set(); }
function looksLikeTrackData(node) {
  if (!node || typeof node !== 'object') return false;
  const uri = String(node.uri || node._uri || node.playableUri || '');
  if (!uri.startsWith('spotify:track:')) return false;
  if (typeof node.name !== 'string' || !node.name) return false;
  const hasArtists = Array.isArray(node.artists?.items) && node.artists.items.length > 0;
  const hasDuration = node.duration?.totalMilliseconds != null || node.durationMs != null || node.duration_ms != null;
  return hasArtists || hasDuration;
}

async function spotifyGetUser() {
  const data = await spotifyGql('profileAttributes');
  const p = data?.data?.me?.profile;
  if (!p) throw new Error('Spotify profile data was not returned.');
  return { id: String(p.uri || '').split(':').pop(), display_name: p.name || '', images: [] };
}

async function spotifyListPlaylists() {
  const out = [];
  let offset = 0;
  const limit = 50;
  for (;;) {
    const data = await spotifyGql('libraryV3', {
      filters: ['Playlists'], order: null, textFilter: '',
      features: ['LIKED_SONGS', 'YOUR_EPISODES_V2', 'PRERELEASES', 'EVENTS'],
      limit, offset, flatten: true, expandedFolders: [], folderUri: null,
      includeFoldersWhenFlattening: false
    });
    const lib = data?.data?.me?.libraryV3;
    if (!lib) throw new Error('Spotify library data was not returned.');
    const items = lib.items || [];
    for (const wrapper of collectGqlPlaylistWrappers(items)) {
      const d = wrapper.data || {};
      const uri = String(wrapper._uri || d.uri || '');
      const id = uri.split(':').pop();
      if (!id) continue;
      // Spotify exposes its internal Liked Songs collection as a pseudo-playlist
      // in libraryV3. That entry only carries metadata (name/count), not the
      // actual tracks — those must come from a dedicated fetchLibraryTracks
      // query (see spotifyListLikedTracks). Surface it as a normal-looking
      // entry with a stable synthetic id so the rest of the UI (which just
      // treats everything as "a playlist with an id") works unmodified.
      if (uri === 'spotify:collection:tracks' || uri === 'spotify:collection:tracks:liked' || d.__typename === 'Collection') {
        const tracks = trackTotalFromPlaylist(d);
        const image = d.images?.items?.[0]?.sources?.[0]?.url || d.coverArt?.sources?.[0]?.url || SPOTIFY_LIKED_SONGS_FALLBACK_IMAGE;
        out.push({
          id: SPOTIFY_LIKED_SONGS_ID,
          name: d.name || 'Liked Songs',
          owner: '',
          tracks,
          image,
          collaborative: false, public: false, isLiked: true
        });
        continue;
      }
      const image = d.images?.items?.[0]?.sources?.[0]?.url || d.coverArt?.sources?.[0]?.url || null;
      const tracks = trackTotalFromPlaylist(d);
      out.push({
        id, name: d.name || 'Untitled playlist', owner: d.ownerV2?.data?.name || '',
        tracks, image, collaborative: false, public: false
      });
    }
    const total = Number(lib.totalCount || out.length);
    offset += items.length;
    if (!items.length || offset >= total) break;
  }
  return out;
}

function deepFindTotalCount(node) {
  if (!node || typeof node !== 'object') return null;
  if (Array.isArray(node)) {
    for (const x of node) { const f = deepFindTotalCount(x); if (f != null) return f; }
    return null;
  }
  for (const key of ['totalCount', 'total_count', 'totalTrackCount', 'total']) {
    if (Number.isFinite(Number(node[key]))) return Number(node[key]);
  }
  for (const [k, v] of Object.entries(node)) {
    if (k === 'images' || k === 'visuals' || k === 'avatar') continue;
    const f = deepFindTotalCount(v);
    if (f != null) return f;
  }
  return null;
}

// Liked Songs is NOT a real playlist entity in Spotify's internal API, so
// fetchPlaylist (which expects a spotify:playlist:… uri) always comes back
// empty for it. It has its own paginated query instead.
async function spotifyListLikedTracks() {
  const out = [];
  const seen = new Set();
  let offset = 0;
  const limit = 100;
  const hardCap = 20000; // sanity cap so a schema-drift bug can't loop forever
  for (;;) {
    // fetchLibraryTracks appears to need an explicit collection uri (mirroring
    // fetchPlaylist's `uri` param) — without it the query still resolves and
    // returns a totalCount, but the items array comes back empty, which is
    // exactly the "13 tracks / 0 found" symptom.
    const data = await spotifyGql('fetchLibraryTracks', { uri: 'spotify:collection:tracks', offset, limit, order: null, textFilter: '' });
    const root = data?.data;
    if (!root) throw new Error('Spotify liked-songs data was not returned.');
    let batch = deepCollectTracks(root);
    if (offset === 0 && !batch.length) {
      console.info('[Vivi Spotify] fetchLibraryTracks raw response (first 4000 chars):', JSON.stringify(root).slice(0, 4000));
    }
    const before = out.length;
    for (const t of batch) { if (t?.spotifyId && !seen.has(t.spotifyId)) { seen.add(t.spotifyId); out.push(t); } }
    const total = deepFindTotalCount(root);
    offset += limit;
    const madeProgress = out.length > before;
    if (!batch.length || !madeProgress) break;
    if (total != null && out.length >= total) break;
    if (offset >= hardCap) break;
  }
  return out;
}

async function spotifyLikedSongsCount() {
  const data = await spotifyGql('fetchLibraryTracks', { uri: 'spotify:collection:tracks', offset: 0, limit: 1, order: null, textFilter: '' });
  const root = data?.data;
  const total = deepFindTotalCount(root);
  if (total != null) return total;
  // Fall back to counting whatever came back on the first page if the
  // response shape doesn't expose a total (better than silently reporting 0).
  return deepCollectTracks(root).length;
}

async function spotifyListPlaylistTracks(playlistId) {
  if (playlistId === SPOTIFY_LIKED_SONGS_ID) return spotifyListLikedTracks();
  const out = [];
  let offset = 0;
  const limit = 100;
  for (;;) {
    const data = await spotifyGql('fetchPlaylist', {
      uri: `spotify:playlist:${playlistId}`,
      offset, limit, enableWatchFeedEntrypoint: false
    });
    const playlist = data?.data?.playlistV2;
    if (!playlist) throw new Error('Spotify playlist data was not returned.');
    let batch = extractTrackItemsFromContent(playlist.content);
    // Schema drift fallback: some Spotify responses nest the same itemV2
    // wrapper one level differently. Reuse the tolerant recursive extractor
    // when the primary parser sees the page but no tracks.
    if (!batch.length && playlist.content) batch = deepCollectTracks(playlist.content);
    const before = out.length;
    const seen = new Set(out.map(t => t.spotifyId));
    for (const t of batch) { if (t?.spotifyId && !seen.has(t.spotifyId)) { seen.add(t.spotifyId); out.push(t); } }
    const itemCount = Number(playlist.content?.items?.length || batch.length || 0);
    const total = Number(playlist.content?.totalCount || out.length);
    offset += itemCount;
    if (!itemCount || offset >= total || out.length === before) break;
  }
  return out;
}

async function spotifyPlaylistTrackCount(playlistId) {
  if (playlistId === SPOTIFY_LIKED_SONGS_ID) return spotifyLikedSongsCount();
  const data = await spotifyGql('fetchPlaylist', {
    uri: `spotify:playlist:${playlistId}`,
    offset: 0,
    limit: 1,
    enableWatchFeedEntrypoint: false
  });
  const playlist = data?.data?.playlistV2;
  if (!playlist) return 0;
  return trackTotalFromPlaylist(playlist);
}

