/**
 * VIVIMUSIC WEB — stargate.js
 *
 * Background-side logic for the "must star the repo" gate.
 * Uses GitHub's OAuth Device Flow so the user proves who they actually are
 * (as opposed to just typing a username), then checks GET /user/starred/{owner}/{repo}
 * with their own token — the authoritative "did *this* account star it" check.
 *
 * IMPORTANT: replace GITHUB_CLIENT_ID below with your own GitHub App's client_id.
 * Create it at https://github.com/settings/apps -> New GitHub App -> enable
 * "Device Flow" under Optional features. No client_secret is needed for this flow.
 */

'use strict';

const GITHUB_CLIENT_ID = 'Iv23liMZvwMUxc2HJIso';
const STAR_REPO_OWNER = 'Archimetrix';
const STAR_REPO_NAME = 'VIVIMUSIC_WEB';
const STAR_RECHECK_TTL_MS = 7 * 24 * 60 * 60 * 1000; // treat verification as fresh for 1 week
const STAR_GATE_ALARM_NAME = 'vivi_star_gate_weekly_recheck';
const STAR_GATE_ALARM_PERIOD_MIN = 7 * 24 * 60; // 1 week, matches the TTL above

async function starGateGetState() {
  const { vivi_star_gate } = await chrome.storage.local.get('vivi_star_gate');
  return vivi_star_gate || null;
}

async function starGateSetState(state) {
  await chrome.storage.local.set({ vivi_star_gate: state });
}

async function starGateStartDeviceFlow() {
  const res = await fetch('https://github.com/login/device/code', {
    method: 'POST',
    headers: { Accept: 'application/json', 'Content-Type': 'application/json' },
    body: JSON.stringify({ client_id: GITHUB_CLIENT_ID }),
  });
  if (!res.ok) throw new Error(`GitHub device_code request failed (${res.status})`);
  const data = await res.json();
  if (!data.device_code) throw new Error(data.error_description || 'Could not start GitHub device flow');
  return data; // { device_code, user_code, verification_uri, expires_in, interval }
}

// A single, short-lived token-exchange attempt. MV3 service workers can be
// terminated by Chrome after ~30s idle, so we deliberately do NOT hold a
// long-running poll loop (with setTimeout waits) in the background — that
// pattern gets killed mid-flight during a real GitHub login. Instead the
// content script calls this once per interval tick; each call is fast.
async function starGatePollOnce(deviceCode) {
  const res = await fetch('https://github.com/login/oauth/access_token', {
    method: 'POST',
    headers: { Accept: 'application/json', 'Content-Type': 'application/json' },
    body: JSON.stringify({
      client_id: GITHUB_CLIENT_ID,
      device_code: deviceCode,
      grant_type: 'urn:ietf:params:oauth:grant-type:device_code',
    }),
  });
  const data = await res.json();

  if (data.access_token) return { status: 'success', token: data.access_token };
  if (data.error === 'authorization_pending') return { status: 'pending' };
  if (data.error === 'slow_down') return { status: 'slow_down' };
  return { status: 'error', error: data.error_description || data.error || 'GitHub authorization failed' };
}

async function starGateCheckStarred(token) {
  const res = await fetch(
    `https://api.github.com/user/starred/${STAR_REPO_OWNER}/${STAR_REPO_NAME}`,
    { headers: { Authorization: `Bearer ${token}`, Accept: 'application/vnd.github+json' } }
  );
  // 204 = starred, 404 = not starred (per GitHub's starring API contract)
  if (res.status === 204) return true;
  if (res.status === 404) return false;
  if (res.status === 401) throw new Error('GitHub session expired, please verify again.');
  throw new Error(`GitHub star check failed (${res.status})`);
}

// Silent, background version of the recheck — no message round-trip to a
// content script, so it runs even if no VIVIMUSIC tab happens to be open.
// It only ever *updates stored state*; it never shows the gate UI itself.
// gate.js re-shows the overlay on its own the next time it runs
// VIVI_STAR_GATE_STATUS and finds verified === false (e.g. the user
// unstarred the repo since we last checked).
async function starGateBackgroundRecheck() {
  const state = await starGateGetState();
  if (!state?.token) return; // never verified yet, nothing to recheck
  try {
    const starred = await starGateCheckStarred(state.token);
    await starGateSetState({ ...state, verified: starred, verifiedAt: Date.now() });
  } catch (e) {
    // Network hiccup / expired token: leave the stored state as-is. If it's
    // a real expiry, the TTL will lapse on its own and the user re-verifies
    // next time the gate check runs in a tab.
    console.warn('[ViVi Star Gate] background recheck failed:', e?.message);
  }
}

function starGateEnsureAlarm() {
  chrome.alarms.get(STAR_GATE_ALARM_NAME, (existing) => {
    if (!existing) {
      chrome.alarms.create(STAR_GATE_ALARM_NAME, { periodInMinutes: STAR_GATE_ALARM_PERIOD_MIN });
    }
  });
}

// Belt-and-suspenders, same reasoning as the update-check alarm in
// background.js: register on install/startup, and also right away in case
// this particular service-worker wake-up wasn't triggered by either event.
chrome.runtime.onInstalled.addListener(starGateEnsureAlarm);
chrome.runtime.onStartup.addListener(starGateEnsureAlarm);
starGateEnsureAlarm();

chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name === STAR_GATE_ALARM_NAME) starGateBackgroundRecheck();
});

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  switch (msg?.type) {
    case 'VIVI_STAR_GATE_STATUS':
      starGateGetState().then((state) => {
        const fresh = !!state?.verified && (Date.now() - (state.verifiedAt || 0) < STAR_RECHECK_TTL_MS);
        sendResponse({ verified: fresh });
      });
      return true;

    case 'VIVI_STAR_GATE_START_AUTH':
      starGateStartDeviceFlow()
        .then((device) => sendResponse({ ok: true, device }))
        .catch((e) => sendResponse({ ok: false, error: e.message }));
      return true;

    case 'VIVI_STAR_GATE_POLL_ONCE':
      starGatePollOnce(msg.device_code)
        .then(async (result) => {
          if (result.status === 'success') {
            try {
              const starred = await starGateCheckStarred(result.token);
              await starGateSetState({ verified: starred, verifiedAt: Date.now(), token: result.token });
              sendResponse({ status: 'success', starred });
            } catch (e) {
              sendResponse({ status: 'error', error: e.message });
            }
          } else {
            sendResponse(result);
          }
        })
        .catch((e) => sendResponse({ status: 'error', error: e.message }));
      return true;

    case 'VIVI_STAR_GATE_RECHECK':
      (async () => {
        const state = await starGateGetState();
        if (!state?.token) { sendResponse({ ok: false, error: 'not_authenticated' }); return; }
        try {
          const starred = await starGateCheckStarred(state.token);
          await starGateSetState({ ...state, verified: starred, verifiedAt: Date.now() });
          sendResponse({ ok: true, starred });
        } catch (e) {
          sendResponse({ ok: false, error: e.message });
        }
      })();
      return true;

    default:
      return undefined;
  }
});
