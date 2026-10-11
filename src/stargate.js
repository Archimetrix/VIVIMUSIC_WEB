/**
 * VIVIMUSIC WEB — stargate.js
 *
 * Background-side logic for the "must star the repo" gate.
 * Uses GitHub's OAuth Device Flow so the user proves who they actually are
 * (as opposed to just typing a username), then checks GET /user/starred/{owner}/{repo}
 * with their own token — the authoritative "did *this* account star it" check.
 *
 * Policy: fresh installs get a 10-minute grace period; after that the user
 * verifies once and the extension is unlocked permanently. No rechecks, and
 * extension updates never trigger verification.
 *
 * IMPORTANT: replace GITHUB_CLIENT_ID below with your own GitHub App's client_id.
 * Create it at https://github.com/settings/apps -> New GitHub App -> enable
 * "Device Flow" under Optional features. No client_secret is needed for this flow.
 */

'use strict';

const GITHUB_CLIENT_ID = 'Iv23liMZvwMUxc2HJIso';
const STAR_REPO_OWNER = 'Archimetrix';
const STAR_REPO_NAME = 'VIVIMUSIC_WEB';
// Fresh installs get this long to use the extension before the star screen
// appears. Updates (manual or automatic from the add-on store) never see it.
const STAR_GRACE_MS = 10 * 60 * 1000;
const STAR_INSTALL_KEY = 'vivi_install_time';
const STAR_OLD_ALARM_NAME = 'vivi_star_gate_weekly_recheck'; // removed; cleaned up on update

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

// Verification is permanent: once a user has verified, the extension stays
// unlocked forever. There is no periodic recheck and no alarm.

// Install bookkeeping. 'install' starts the 10-minute grace clock; 'update'
// (including automatic add-on-store updates) unlocks permanently so existing
// users are never asked to verify.
async function starGateOnInstalled(details) {
  try {
    if (details?.reason === 'install') {
      await chrome.storage.local.set({ [STAR_INSTALL_KEY]: Date.now() });
    } else if (details?.reason === 'update') {
      const state = await starGateGetState();
      if (!state?.verified) {
        await starGateSetState({ verified: true, verifiedAt: Date.now(), grandfathered: true });
      } else if (state.token) {
        const { token, ...rest } = state; // token is no longer needed once verified
        await starGateSetState(rest);
      }
    }
    // Clean up the weekly recheck alarm left behind by older versions.
    await chrome.alarms.clear(STAR_OLD_ALARM_NAME);
  } catch (e) {
    console.debug('[ViVi Star Gate] onInstalled failed:', e?.message);
  }
}
chrome.runtime.onInstalled.addListener(starGateOnInstalled);
try { chrome.alarms.clear(STAR_OLD_ALARM_NAME); } catch { /* ignore */ }

// Returns { verified, graceMs }. graceMs > 0 means "not verified yet, but
// still inside the grace window — don't show the gate for this many ms".
async function starGateStatus() {
  const state = await starGateGetState();
  if (state?.verified) return { verified: true, graceMs: 0 };
  let { [STAR_INSTALL_KEY]: installedAt } = await chrome.storage.local.get(STAR_INSTALL_KEY);
  if (!installedAt) {
    // No install time recorded (e.g. the status query beat onInstalled).
    // Start the clock now rather than risk locking someone out immediately.
    installedAt = Date.now();
    await chrome.storage.local.set({ [STAR_INSTALL_KEY]: installedAt });
  }
  const graceMs = Math.max(0, installedAt + STAR_GRACE_MS - Date.now());
  return { verified: false, graceMs };
}

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  switch (msg?.type) {
    case 'VIVI_STAR_GATE_STATUS':
      starGateStatus()
        .then((st) => sendResponse(st))
        .catch(() => sendResponse({ verified: true, graceMs: 0 })); // never lock on an internal error
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
              await starGateSetState(starred
                ? { verified: true, verifiedAt: Date.now() }
                : { verified: false, token: result.token });
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

    // Only used by the "I've starred it — check again" button; never automatic.
    case 'VIVI_STAR_GATE_RECHECK':
      (async () => {
        const state = await starGateGetState();
        if (!state?.token) { sendResponse({ ok: false, error: 'not_authenticated' }); return; }
        try {
          const starred = await starGateCheckStarred(state.token);
          if (starred) await starGateSetState({ verified: true, verifiedAt: Date.now() });
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
