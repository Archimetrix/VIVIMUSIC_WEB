/**
 * VIVIMUSIC WEB — lastfm.js
 */
'use strict';

const LASTFM_API_ROOT = 'https://ws.audioscrobbler.com/2.0/';

const LASTFM_API_KEY = '42a7556fa355c95fd8a308088f988057';
const LASTFM_API_SECRET = '7a3e21a44589a9106f869507e6f6d0e2';

function signParams(params) {
  const keys = Object.keys(params).sort();
  let sigBase = '';
  for (const k of keys) {
    if (k === 'format') continue; // format is excluded from the signature
    sigBase += k + params[k];
  }
  sigBase += LASTFM_API_SECRET;
  return md5(sigBase);
}

async function callLastfm(method, params, httpMethod = 'GET') {
  const full = { method, api_key: LASTFM_API_KEY, ...params };
  Object.keys(full).forEach((k) => { if (full[k] === undefined || full[k] === null) delete full[k]; });
  full.api_sig = signParams(full);
  full.format = 'json';

  let res;
  if (httpMethod === 'POST') {
    const body = new URLSearchParams(full);
    res = await fetch(LASTFM_API_ROOT, { method: 'POST', body });
  } else {
    const url = LASTFM_API_ROOT + '?' + new URLSearchParams(full).toString();
    res = await fetch(url);
  }
  const data = await res.json().catch(() => ({}));
  if (data.error) {
    const err = new Error(data.message || `Last.fm error ${data.error}`);
    err.lastfmCode = data.error;
    throw err;
  }
  return data;
}

async function lastfmLogin(username, password) {
  const data = await callLastfm(
    'auth.getMobileSession',
    { username, password },
    'POST'
  );
  if (!data.session || !data.session.key) {
    throw new Error('Last.fm did not return a session key.');
  }
  return { sessionKey: data.session.key, username: data.session.name };
}

async function lastfmUpdateNowPlaying(sessionKey, track) {
  return callLastfm(
    'track.updateNowPlaying',
    {
      artist: track.artist,
      track: track.song,
      duration: track.duration ? Math.round(track.duration) : undefined,
      sk: sessionKey,
    },
    'POST'
  );
}

async function lastfmScrobble(sessionKey, track, timestamp) {
  return callLastfm(
    'track.scrobble',
    {
      'artist[0]': track.artist,
      'track[0]': track.song,
      'timestamp[0]': timestamp,
      sk: sessionKey,
    },
    'POST'
  );
}

async function lastfmLoveTrack(sessionKey, track, loved) {
  return callLastfm(
    loved ? 'track.love' : 'track.unlove',
    { artist: track.artist, track: track.song, sk: sessionKey },
    'POST'
  );
}
