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
    position: fixed; inset: 0; z-index: 2147483647;
    display: flex; align-items: center; justify-content: center;
    overflow: auto; padding: 28px 18px; box-sizing: border-box;
    color: #f7f7fc; text-align: left; font-family: Inter, ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
    background: radial-gradient(ellipse at 50% 0%, rgba(113,92,230,.24), transparent 52%), radial-gradient(ellipse at 100% 100%, rgba(33,188,143,.1), transparent 44%), #0b0b12;
  `;



  function render(html) {
    let el = document.getElementById(OVERLAY_ID);
    if (!el) {
      el = document.createElement('div');
      el.id = OVERLAY_ID;
      el.style.cssText = baseStyle;
      (document.documentElement || document.body).appendChild(el);
    }
    el.replaceChildren();
    const stage = document.createElement('div');
    stage.className = 'gate-stage';
    stage.innerHTML = html;
    el.append(stage);
    return el;
  }

  function removeGate() {
    document.getElementById(OVERLAY_ID)?.remove();
    window.__viviStarVerified = true;
  }

  function brandHtml() {
    return `<div class="gate-brand"><img src="${chrome.runtime.getURL('icons/icon128.png')}" alt=""><div><div class="gate-brand-name">Vivimusic Web</div><div class="gate-brand-tagline">A more personal way to enjoy your music</div></div></div>`;
  }

  function pageHtml(content, footer = 'Your music stays yours. GitHub securely handles account verification.') {
    return `<div class="gate-shell">${brandHtml()}<div class="gate-body">${content}</div><div class="gate-footer">${footer}</div></div>`;
  }

  function btnHtml(id, label, secondary = false) {
    return `<button id="${id}" class="gate-button${secondary ? ' secondary' : ''}" type="button">${label}</button>`;
  }

  function renderLocked() {
    const el = render(pageHtml(`
      <div class="gate-kicker">One-time community check</div>
      <h1 class="gate-title">Unlock your music setup</h1>
      <p class="gate-description">Vivimusic Web is free to use. Star the project on GitHub, then verify your account to unlock the extension.</p>
      <div class="gate-steps">
        <div class="gate-step"><span class="gate-step-number">01</span><span class="gate-step-label">Visit the project</span></div>
        <div class="gate-step"><span class="gate-step-number">02</span><span class="gate-step-label">Star it on GitHub</span></div>
        <div class="gate-step"><span class="gate-step-number">03</span><span class="gate-step-label">Verify and listen</span></div>
      </div>
      <div class="gate-trust"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M12 22s8-4 8-11V5l-8-3-8 3v6c0 7 8 11 8 11Z"/><path d="m9 12 2 2 4-4"/></svg><span>Sign-in happens on GitHub. Vivimusic never sees or stores your password; we only receive confirmation of your star.</span></div>
      <div class="gate-actions">${btnHtml('vivi-gate-start', 'Continue with GitHub')}<a class="gate-button secondary" href="${REPO_URL}" target="_blank" rel="noopener noreferrer">View the project ↗</a></div>
      <div id="vivi-gate-status" class="gate-status" aria-live="polite"></div>
    `));
    el.querySelector('#vivi-gate-start').addEventListener('click', beginAuth);
  }

  function renderCode(user_code, verification_uri) {
    const el = render(pageHtml(`
      <div class="gate-kicker">Secure GitHub verification</div>
      <h1 class="gate-title">Confirm it’s you</h1>
      <p class="gate-description">Open <a class="gate-link" href="${verification_uri}" target="_blank" rel="noopener noreferrer">${verification_uri}</a> and enter this one-time code. Keep this page open while GitHub confirms.</p>
      <div class="gate-code"><div class="gate-code-value">${user_code}</div><button id="vivi-gate-copy" class="gate-copy" type="button" title="Copy code" aria-label="Copy code"><svg xmlns="http://www.w3.org/2000/svg" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="9" y="9" width="13" height="13" rx="2"/><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/></svg></button></div>
      <div class="gate-wait"><span class="gate-spinner"></span><span>Waiting for GitHub to confirm…</span></div>
    `));

    const copyBtn = el.querySelector('#vivi-gate-copy');
    copyBtn?.addEventListener('click', async () => {
      try {
        await navigator.clipboard.writeText(user_code);
      } catch {
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
      copyBtn.innerHTML = `<svg xmlns="http://www.w3.org/2000/svg" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="#68e1ae" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="20 6 9 17 4 12"/></svg>`;
      setTimeout(() => { copyBtn.innerHTML = original; }, 1200);
    });
  }

  function renderNotStarred() {
    const el = render(pageHtml(`
      <div class="gate-kicker">Verification complete</div>
      <h1 class="gate-title">One small step left</h1>
      <p class="gate-description">This GitHub account is verified, but it hasn’t starred the Vivimusic Web project yet. Star the repo, then come back and retry.</p>
      <div class="gate-actions" style="margin-top:18px;">${btnHtml('vivi-gate-retry', 'I’ve starred it — check again')}<a class="gate-button secondary" href="${REPO_URL}" target="_blank" rel="noopener noreferrer">Open GitHub repo ↗</a></div>
    `));
    el.querySelector('#vivi-gate-retry').addEventListener('click', recheck);
  }

  function renderError(message) {
    const el = render(pageHtml(`
      <div class="gate-kicker">Connection issue</div>
      <h1 class="gate-title">Let’s try that again</h1>
      <p class="gate-description">${message}</p>
      <div class="gate-actions" style="margin-top:18px;">${btnHtml('vivi-gate-start', 'Try again')}</div>
    `, 'Your GitHub account and star are never changed by retrying verification.'));
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
