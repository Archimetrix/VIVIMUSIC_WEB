/**
 * VIVIMUSIC WEB — gate.js
 *
 * Runs at document_start, before every other content script. Shows a
 * full-page overlay requiring the user to verify (via GitHub OAuth device
 * flow, handled in the background service worker / stargate.js) that they
 * have starred the repo. Nothing else in the extension is usable until the
 * check passes; the overlay is re-shown if a periodic recheck later finds
 * the star has been removed.
 */

(() => {
  'use strict';

  const REPO_URL = 'https://github.com/Archimetrix/VIVIMUSIC_WEB';
  const OVERLAY_ID = 'vivi-star-gate';

  const baseStyle = `
    position: fixed;
    inset: 0;
    z-index: 2147483647;
    background: #030303;
    color: #fff;
    display: flex;
    flex-direction: column;
    align-items: center;
    justify-content: center;
    gap: 16px;
    font-family: 'Roboto', Arial, sans-serif;
    text-align: center;
    padding: 32px;
  `;

  function render(html) {
    let el = document.getElementById(OVERLAY_ID);
    if (!el) {
      el = document.createElement('div');
      el.id = OVERLAY_ID;
      el.style.cssText = baseStyle;
      (document.documentElement || document.body).appendChild(el);
    }
    el.innerHTML = html;
    return el;
  }

  function removeGate() {
    document.getElementById(OVERLAY_ID)?.remove();
    window.__viviStarVerified = true;
  }

  function btnHtml(id, label) {
    return `<button id="${id}" style="padding:10px 22px;border-radius:8px;border:none;background:#fff;color:#000;font-weight:600;font-size:14px;cursor:pointer;">${label}</button>`;
  }

  function renderLocked() {
    const el = render(`
      <div style="font-size:32px;">⭐</div>
      <h2 style="margin:0;font-size:20px;">Support Vivimusic Web</h2>
      <p style="max-width:420px;opacity:.75;font-size:14px;line-height:1.5;">
        This extension is free to use. In exchange, please star the
        <a href="${REPO_URL}" target="_blank" style="color:#7fd1ff;">GitHub repo</a>
        to unlock it. You'll sign in with GitHub to verify — this extension never
        sees your password, only a confirmation of whether your account has starred the repo.
      </p>
      ${btnHtml('vivi-gate-start', 'Verify with GitHub')}
      <div id="vivi-gate-status" style="font-size:12px;opacity:.6;min-height:16px;"></div>
    `);
    el.querySelector('#vivi-gate-start').addEventListener('click', beginAuth);
  }

  function renderCode(user_code, verification_uri) {
    const el = render(`
      <h2 style="margin:0;font-size:20px;">One more step</h2>
      <p style="opacity:.75;font-size:14px;">
        Open <a href="${verification_uri}" target="_blank" style="color:#7fd1ff;">${verification_uri}</a>
        and enter this code:
      </p>
      <div style="display:flex;align-items:center;gap:10px;">
        <div style="font-size:28px;letter-spacing:5px;font-weight:700;background:#111;padding:12px 24px;border-radius:8px;">${user_code}</div>
        <button id="vivi-gate-copy" title="Copy code" style="display:flex;align-items:center;justify-content:center;width:40px;height:40px;border-radius:8px;border:1px solid rgba(255,255,255,.2);background:#111;color:#fff;cursor:pointer;">
          <svg xmlns="http://www.w3.org/2000/svg" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="9" y="9" width="13" height="13" rx="2" ry="2"></rect><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"></path></svg>
        </button>
      </div>
      <p style="opacity:.55;font-size:13px;">Waiting for you to confirm on GitHub…</p>
    `);

    const copyBtn = el.querySelector('#vivi-gate-copy');
    copyBtn?.addEventListener('click', async () => {
      try {
        await navigator.clipboard.writeText(user_code);
      } catch {
        // Fallback for contexts where the Clipboard API is unavailable
        const ta = document.createElement('textarea');
        ta.value = user_code;
        ta.style.position = 'fixed';
        ta.style.opacity = '0';
        document.body.appendChild(ta);
        ta.select();
        document.execCommand('copy');
        ta.remove();
      }
      const original = copyBtn.innerHTML;
      copyBtn.innerHTML = `<svg xmlns="http://www.w3.org/2000/svg" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="#4ade80" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="20 6 9 17 4 12"></polyline></svg>`;
      setTimeout(() => { copyBtn.innerHTML = original; }, 1200);
    });
  }

  function renderNotStarred() {
    const el = render(`
      <div style="font-size:32px;">👀</div>
      <h2 style="margin:0;font-size:20px;">Almost there</h2>
      <p style="opacity:.75;font-size:14px;max-width:420px;">
        You're verified, but this GitHub account hasn't starred the repo yet.
        Star it, then click retry.
      </p>
      <a href="${REPO_URL}" target="_blank" style="color:#7fd1ff;font-size:14px;">Open the repo →</a>
      ${btnHtml('vivi-gate-retry', "I've starred it — retry")}
    `);
    el.querySelector('#vivi-gate-retry').addEventListener('click', recheck);
  }

  function renderError(message) {
    const el = render(`
      <h2 style="margin:0;font-size:20px;">Something went wrong</h2>
      <p style="opacity:.75;font-size:14px;max-width:420px;">${message}</p>
      ${btnHtml('vivi-gate-start', 'Try again')}
    `);
    el.querySelector('#vivi-gate-start').addEventListener('click', beginAuth);
  }

  let pollTimer = null;
  let pollDeadline = 0;

  function stopPolling() {
    if (pollTimer) { clearTimeout(pollTimer); pollTimer = null; }
  }

  // Polling lives here (content script), not in the background service
  // worker: each tick is one short message round-trip, so it survives the
  // minutes a real GitHub login can take without hitting MV3's service
  // worker idle-timeout.
  function pollTick(device_code, intervalSec) {
    if (Date.now() > pollDeadline) {
      stopPolling();
      return renderError('Timed out waiting for GitHub authorization. Please try again.');
    }
    chrome.runtime.sendMessage({ type: 'VIVI_STAR_GATE_POLL_ONCE', device_code }, (res) => {
      if (chrome.runtime.lastError) {
        // Background woke up fine for this single short call; a transient
        // messaging error just means retry the next tick.
        pollTimer = setTimeout(() => pollTick(device_code, intervalSec), intervalSec * 1000);
        return;
      }
      switch (res?.status) {
        case 'success':
          stopPolling();
          if (res.starred) removeGate();
          else renderNotStarred();
          return;
        case 'slow_down':
          intervalSec += 5;
          // fall through to schedule next tick
        case 'pending':
          pollTimer = setTimeout(() => pollTick(device_code, intervalSec), intervalSec * 1000);
          return;
        default:
          stopPolling();
          renderError(res?.error || 'Verification failed.');
      }
    });
  }

  function beginAuth() {
    stopPolling();
    render(`<p style="opacity:.7;font-size:14px;">Contacting GitHub…</p>`);
    chrome.runtime.sendMessage({ type: 'VIVI_STAR_GATE_START_AUTH' }, (res) => {
      if (chrome.runtime.lastError || !res?.ok) {
        return renderError(res?.error || chrome.runtime.lastError?.message || 'Could not start GitHub verification.');
      }
      const { device_code, user_code, verification_uri, interval, expires_in } = res.device;
      renderCode(user_code, verification_uri);
      pollDeadline = Date.now() + Math.min(expires_in || 900, 900) * 1000;
      pollTimer = setTimeout(() => pollTick(device_code, interval || 5), (interval || 5) * 1000);
    });
  }

  function recheck() {
    chrome.runtime.sendMessage({ type: 'VIVI_STAR_GATE_RECHECK' }, (res) => {
      if (!chrome.runtime.lastError && res?.ok && res.starred) removeGate();
      else renderNotStarred();
    });
  }

  chrome.runtime.sendMessage({ type: 'VIVI_STAR_GATE_STATUS' }, (res) => {
    if (!chrome.runtime.lastError && res?.verified) {
      window.__viviStarVerified = true;
      return;
    }
    renderLocked();
  });
})();
