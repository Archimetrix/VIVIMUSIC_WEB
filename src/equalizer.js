/* VIVIMUSIC WEB — equalizer.js
 * A lightweight 3-band EQ (Low / Mid / High) + a synthetic "Room" reverb
 * send, wired onto YouTube Music's own <video> element via the Web Audio
 * API. Ships with a few one-click presets (Bass Boost, Clear Vocals,
 * Empty Room) on top of the raw sliders.
 *
 * Signal chain:
 *   <video> → MediaElementAudioSourceNode
 *           → lowShelf(200Hz) → midPeak(1000Hz) → highShelf(3200Hz)
 *           → [dryGain] ─────────────────────────────┐
 *           → [convolver(room IR) → wetGain] ─────────┼→ masterGain → compressor → destination
 *
 * The compressor at the tail is just a safety net so boosted bands don't
 * clip; it's set very permissive so it stays out of the way at flat/near-flat
 * settings.
 */
(() => {
  const STORAGE_KEY = 'viviEqSettings';

  const DEFAULT_SETTINGS = {
    enabled: false,
    preset: 'flat',
    low: 0,   // dB, -12..12
    mid: 0,   // dB, -12..12
    high: 0,  // dB, -12..12
    room: 0,  // 0..100 (% wet mix)
    spatial: false, // 3D Audio auto-pan, see spatialL/spatialR nodes below
  };

  const PRESETS = {
    flat:        { label: 'Flat',         low: 0,  mid: 0,  high: 0,  room: 0,  spatial: false },
    bassBoost:   { label: 'Bass Boost',   low: 8,  mid: -1, high: 1,  room: 0,  spatial: false },
    clearVocals: { label: 'Clear Vocals', low: -3, mid: 5,  high: 3,  room: 0,  spatial: false },
    emptyRoom:   { label: 'Empty Room',   low: -1, mid: -2, high: -3, room: 40, spatial: false },
    spatial3d:   { label: '3D Audio',     low: 1,  mid: 0,  high: 2,  room: 12, spatial: true  },
    nightMode:   { label: 'Night Mode',   low: -5, mid: 2,  high: -2, room: 0,  spatial: false },
  };

  // ── 3D Audio (auto-pan) tuning ──
  // The sound sweeps left → right → left. The *quiet* ear never drops
  // below SPATIAL_MIN (40%) of full gain, and the *loud* ear always sits
  // at 100% — plain linear gain multipliers applied after the master
  // volume, so the 40%/100% ratio holds no matter what the user's volume
  // slider is set to. One full left-to-right-to-left sweep takes
  // SPATIAL_PERIOD_SEC seconds.
  //
  // The sweep is driven by scheduling gain curves directly on the audio
  // timeline (setValueCurveAtTime) rather than by a requestAnimationFrame
  // loop. rAF is paused by the browser whenever the tab isn't the active
  // one, which used to leave the pan frozen wherever it happened to be
  // (often hard toward one ear) the moment you switched tabs. Curves
  // scheduled on the AudioParam run on the audio thread and keep playing
  // correctly in background tabs; a low-frequency timer just needs to
  // keep topping up the schedule a few periods ahead of playback.
  const SPATIAL_MIN = 0.4;
  const SPATIAL_PERIOD_SEC = 7;
  const SPATIAL_CURVE_STEPS = 512;      // resolution of one period's curve — high enough that linear interpolation between samples is imperceptible, so the ease feels like a true continuous blend rather than a stepped one
  const SPATIAL_LOOKAHEAD_SEC = 20;     // keep this many seconds pre-scheduled
  const SPATIAL_TOPUP_INTERVAL_MS = 4000; // how often we check/extend the schedule

  let settings = { ...DEFAULT_SETTINGS };

  // ── Web Audio graph state ──
  let audioCtx = null;
  let sourceNode = null;
  let lowShelf = null;
  let midPeak = null;
  let highShelf = null;
  let dryGain = null;
  let wetGain = null;
  let convolver = null;
  let masterGain = null;
  let compressor = null;
  let boundVideo = null;
  let spatialSplitter = null;
  let spatialMerger = null;
  let spatialGainL = null;
  let spatialGainR = null;
  let spatialCurveL = null;
  let spatialCurveR = null;
  let spatialScheduledUntil = 0; // audioCtx time up to which curves are queued
  let spatialTopupTimer = null;

  function dbToGain(db) {
    return Math.pow(10, db / 20);
  }

  // Builds a synthetic "room" impulse response: exponentially decaying
  // filtered noise. No external assets/network needed.
  function buildRoomImpulse(ctx, durationSec = 1.6, decay = 2.4) {
    const rate = ctx.sampleRate;
    const length = Math.max(1, Math.floor(rate * durationSec));
    const impulse = ctx.createBuffer(2, length, rate);
    for (let ch = 0; ch < 2; ch++) {
      const data = impulse.getChannelData(ch);
      for (let i = 0; i < length; i++) {
        const t = i / length;
        data[i] = (Math.random() * 2 - 1) * Math.pow(1 - t, decay);
      }
    }
    return impulse;
  }

  function ensureGraph(video) {
    if (!video) return false;
    if (boundVideo === video && audioCtx) return true; // already wired

    // A MediaElementSourceNode can only ever be created once per element —
    // if we've already claimed this one (e.g. a prior instance of this
    // function ran), don't try again or it'll throw.
    if (video.dataset.viviEqBound === '1' && boundVideo !== video) {
      return false;
    }

    try {
      audioCtx = new (window.AudioContext || window.webkitAudioContext)();
      sourceNode = audioCtx.createMediaElementSource(video);
      video.dataset.viviEqBound = '1';

      lowShelf = audioCtx.createBiquadFilter();
      lowShelf.type = 'lowshelf';
      lowShelf.frequency.value = 200;

      midPeak = audioCtx.createBiquadFilter();
      midPeak.type = 'peaking';
      midPeak.frequency.value = 1000;
      midPeak.Q.value = 1;

      highShelf = audioCtx.createBiquadFilter();
      highShelf.type = 'highshelf';
      highShelf.frequency.value = 3200;

      dryGain = audioCtx.createGain();
      wetGain = audioCtx.createGain();
      wetGain.gain.value = 0;

      convolver = audioCtx.createConvolver();
      convolver.normalize = true;
      convolver.buffer = buildRoomImpulse(audioCtx);

      masterGain = audioCtx.createGain();
      compressor = audioCtx.createDynamicsCompressor();
      compressor.threshold.value = -6;
      compressor.knee.value = 12;
      compressor.ratio.value = 4;
      compressor.attack.value = 0.003;
      compressor.release.value = 0.25;

      // 3D Audio auto-pan stage: split to L/R, apply independent gains
      // (see startSpatial/scheduleSpatialAhead), remerge. Gains start
      // neutral (1/1 = pass-through) and are only driven away from that
      // when settings.spatial is on.
      spatialSplitter = audioCtx.createChannelSplitter(2);
      spatialMerger = audioCtx.createChannelMerger(2);
      spatialGainL = audioCtx.createGain();
      spatialGainR = audioCtx.createGain();
      spatialGainL.gain.value = 1;
      spatialGainR.gain.value = 1;

      sourceNode.connect(lowShelf);
      lowShelf.connect(midPeak);
      midPeak.connect(highShelf);

      highShelf.connect(dryGain);
      highShelf.connect(convolver);
      convolver.connect(wetGain);

      dryGain.connect(masterGain);
      wetGain.connect(masterGain);

      masterGain.connect(spatialSplitter);
      spatialSplitter.connect(spatialGainL, 0);
      spatialSplitter.connect(spatialGainR, 1);
      spatialGainL.connect(spatialMerger, 0, 0);
      spatialGainR.connect(spatialMerger, 0, 1);

      spatialMerger.connect(compressor);
      compressor.connect(audioCtx.destination);

      boundVideo = video;
      applySettingsToGraph();
      return true;
    } catch (e) {
      console.warn('[ViVi EQ] Failed to set up audio graph:', e?.message);
      return false;
    }
  }

  function applySettingsToGraph() {
    if (!audioCtx) return;
    const now = audioCtx.currentTime;
    const ramp = 0.05; // seconds, avoids audible zipper/clicks on slider drag

    const active = settings.enabled;
    const low = active ? settings.low : 0;
    const mid = active ? settings.mid : 0;
    const high = active ? settings.high : 0;
    const roomPct = active ? settings.room : 0;

    lowShelf.gain.setTargetAtTime(low, now, ramp);
    midPeak.gain.setTargetAtTime(mid, now, ramp);
    highShelf.gain.setTargetAtTime(high, now, ramp);

    const wet = roomPct / 100;
    wetGain.gain.setTargetAtTime(wet, now, ramp);
    dryGain.gain.setTargetAtTime(1 - wet * 0.5, now, ramp);

    // Gentle overall makeup-gain compensation so heavy boosts don't just
    // ride the compressor into pumping — pull master down a touch as the
    // total positive boost across bands grows.
    const totalBoost = Math.max(0, low) + Math.max(0, mid) + Math.max(0, high);
    const makeup = dbToGain(-totalBoost * 0.15);
    masterGain.gain.setTargetAtTime(makeup, now, ramp);

    if (active && settings.spatial) {
      startSpatial();
    } else {
      stopSpatial();
    }
  }

  // One period's worth of gain values, smooth raised-cosine easing so the
  // sweep has no sharp corners. Built once and re-used for every period.
  function buildSpatialCurves() {
    const l = new Float32Array(SPATIAL_CURVE_STEPS + 1);
    const r = new Float32Array(SPATIAL_CURVE_STEPS + 1);
    for (let i = 0; i <= SPATIAL_CURVE_STEPS; i++) {
      const phase = i / SPATIAL_CURVE_STEPS;
      const p = 0.5 - 0.5 * Math.cos(2 * Math.PI * phase); // 0→1→0
      l[i] = 1 - (1 - SPATIAL_MIN) * p;       // 1.0 (left) → SPATIAL_MIN (right)
      r[i] = SPATIAL_MIN + (1 - SPATIAL_MIN) * p; // SPATIAL_MIN (left) → 1.0 (right)
    }
    return { l, r };
  }

  // Queues full periods of the pan curve onto the AudioParam timeline,
  // starting from wherever we last left off, until we're scheduled at
  // least SPATIAL_LOOKAHEAD_SEC into the future. Because this writes
  // directly to the Web Audio automation timeline (not just a JS
  // variable), the sweep keeps playing correctly even while the tab is
  // backgrounded and rAF/timers get throttled — we just need this to run
  // often enough to keep topping up the buffer, which a plain interval
  // handles fine.
  function scheduleSpatialAhead() {
    if (!audioCtx || !spatialGainL || !spatialGainR) return;
    if (!settings.enabled || !settings.spatial) return;
    if (!spatialCurveL || !spatialCurveR) {
      const curves = buildSpatialCurves();
      spatialCurveL = curves.l;
      spatialCurveR = curves.r;
    }

    const targetUntil = audioCtx.currentTime + SPATIAL_LOOKAHEAD_SEC;
    while (spatialScheduledUntil < targetUntil) {
      spatialGainL.gain.setValueCurveAtTime(spatialCurveL, spatialScheduledUntil, SPATIAL_PERIOD_SEC);
      spatialGainR.gain.setValueCurveAtTime(spatialCurveR, spatialScheduledUntil, SPATIAL_PERIOD_SEC);
      spatialScheduledUntil += SPATIAL_PERIOD_SEC;
    }
  }

  function startSpatial() {
    if (spatialTopupTimer || !audioCtx) return;
    spatialScheduledUntil = audioCtx.currentTime;
    scheduleSpatialAhead();
    spatialTopupTimer = setInterval(scheduleSpatialAhead, SPATIAL_TOPUP_INTERVAL_MS);
  }

  function stopSpatial() {
    if (spatialTopupTimer) {
      clearInterval(spatialTopupTimer);
      spatialTopupTimer = null;
    }
    if (audioCtx && spatialGainL && spatialGainR) {
      const now = audioCtx.currentTime;
      spatialGainL.gain.cancelScheduledValues(now);
      spatialGainR.gain.cancelScheduledValues(now);
      spatialGainL.gain.setTargetAtTime(1, now, 0.1);
      spatialGainR.gain.setTargetAtTime(1, now, 0.1);
    }
    spatialScheduledUntil = 0;
  }

  function saveSettings() {
    try {
      chrome.storage.local.set({ [STORAGE_KEY]: settings });
    } catch (e) { /* extension context may be gone mid-navigation; ignore */ }
  }

  function loadSettings(cb) {
    try {
      chrome.storage.local.get({ [STORAGE_KEY]: DEFAULT_SETTINGS }, (res) => {
        settings = { ...DEFAULT_SETTINGS, ...(res[STORAGE_KEY] || {}) };
        cb?.();
      });
    } catch (e) {
      cb?.();
    }
  }

  // ── Keep the graph wired to whichever <video> is currently playing ──
  function findVideo() {
    return document.querySelector('#movie_player video, ytmusic-player video, video');
  }

  function pollForVideo() {
    const video = findVideo();
    if (video && (boundVideo !== video)) {
      ensureGraph(video);
    }
  }
  setInterval(pollForVideo, 2000);

  // ── UI ──
  const CSS = `
    .vivi-eq-toggle {
      position: fixed;
      right: 16px;
      bottom: 80px;
      width: 32px;
      height: 32px;
      border-radius: 50%;
      background: rgba(28,28,30,0.92);
      border: 1px solid rgba(255,255,255,0.12);
      color: #fff;
      display: flex;
      align-items: center;
      justify-content: center;
      cursor: pointer;
      z-index: 2147483000;
      box-shadow: 0 4px 14px rgba(0,0,0,0.4);
      transition: transform 0.15s ease, background 0.15s ease, opacity 0.15s ease;
    }
    .vivi-eq-toggle:hover { transform: scale(1.06); }
    .vivi-eq-toggle.vivi-eq-active { background: var(--accent, #8b5cf6); color: #000; }
    .vivi-eq-toggle svg { width: 16px; height: 16px; fill: currentColor; }
    .vivi-eq-toggle.vivi-eq-hidden {
      display: none;
    }

    .vivi-eq-panel {
      position: fixed;
      right: 16px;
      bottom: 120px;
      width: 280px;
      background: rgba(20,20,22,0.97);
      border: 1px solid rgba(255,255,255,0.1);
      border-radius: 14px;
      padding: 16px;
      z-index: 2147483000;
      color: #fff;
      font-family: "Roboto", Arial, sans-serif;
      box-shadow: 0 8px 28px rgba(0,0,0,0.5);
      display: none;
    }
    .vivi-eq-panel.vivi-eq-open { display: block; }
    .vivi-eq-header {
      display: flex;
      align-items: center;
      justify-content: space-between;
      margin-bottom: 10px;
    }
    .vivi-eq-title { font-size: 14px; font-weight: 600; letter-spacing: 0.2px; }
    .vivi-eq-power {
      width: 30px; height: 18px; border-radius: 999px;
      background: rgba(255,255,255,0.18);
      position: relative; cursor: pointer; flex-shrink: 0;
      transition: background 0.15s ease;
    }
    .vivi-eq-power.on { background: var(--accent, #8b5cf6); }
    .vivi-eq-power::after {
      content: ''; position: absolute; top: 2px; left: 2px;
      width: 14px; height: 14px; border-radius: 50%; background: #fff;
      transition: left 0.15s ease;
    }
    .vivi-eq-power.on::after { left: 14px; }

    .vivi-eq-presets {
      display: grid;
      grid-template-columns: 1fr 1fr;
      gap: 6px;
      margin-bottom: 14px;
    }
    .vivi-eq-preset-btn {
      font-size: 11.5px;
      padding: 7px 6px;
      border-radius: 8px;
      border: 1px solid rgba(255,255,255,0.14);
      background: rgba(255,255,255,0.05);
      color: #eee;
      cursor: pointer;
      text-align: center;
      transition: background 0.15s ease, border-color 0.15s ease;
    }
    .vivi-eq-preset-btn:hover { background: rgba(255,255,255,0.1); }
    .vivi-eq-preset-btn.vivi-eq-preset-active {
      border-color: var(--accent, #8b5cf6);
      background: rgba(139,92,246,0.18);
      color: #fff;
    }

    .vivi-eq-row {
      display: flex;
      align-items: center;
      gap: 10px;
      margin-bottom: 10px;
    }
    .vivi-eq-row:last-child { margin-bottom: 0; }
    .vivi-eq-label {
      width: 34px;
      font-size: 11.5px;
      color: #ccc;
      flex-shrink: 0;
    }
    .vivi-eq-row input[type="range"] {
      flex: 1;
      accent-color: var(--accent, #8b5cf6);
      height: 3px;
    }
    .vivi-eq-value {
      width: 38px;
      text-align: right;
      font-size: 11px;
      color: #999;
      flex-shrink: 0;
      font-variant-numeric: tabular-nums;
    }
  `;

  function injectStyle() {
    if (document.getElementById('vivi-eq-style')) return;
    const style = document.createElement('style');
    style.id = 'vivi-eq-style';
    style.textContent = CSS;
    document.head.appendChild(style);
  }

  const BAND_ICON = `
    <svg viewBox="0 0 24 24" xmlns="http://www.w3.org/2000/svg">
      <path d="M4 20V10M4 7V4M12 20v-4M12 13V4M20 20v-8M20 9V4"
            stroke="currentColor" stroke-width="2" stroke-linecap="round" fill="none"/>
      <circle cx="4" cy="8.5" r="2" fill="currentColor"/>
      <circle cx="12" cy="16" r="2" fill="currentColor"/>
      <circle cx="20" cy="10.5" r="2" fill="currentColor"/>
    </svg>`;

  let els = {};

  function buildUI() {
    if (document.querySelector('.vivi-eq-toggle')) return;
    injectStyle();

    const toggleBtn = document.createElement('div');
    toggleBtn.className = 'vivi-eq-toggle';
    toggleBtn.title = 'ViVi Equalizer';
    toggleBtn.innerHTML = BAND_ICON;

    const panel = document.createElement('div');
    panel.className = 'vivi-eq-panel';
    panel.innerHTML = `
      <div class="vivi-eq-header">
        <span class="vivi-eq-title">ViVi Equalizer</span>
        <div class="vivi-eq-power" title="Enable/disable EQ"></div>
      </div>
      <div class="vivi-eq-presets">
        ${Object.entries(PRESETS).map(([key, p]) => `
          <div class="vivi-eq-preset-btn" data-preset="${key}">${p.label}</div>
        `).join('')}
      </div>
      <div class="vivi-eq-row" data-band="low">
        <span class="vivi-eq-label">Low</span>
        <input type="range" min="-12" max="12" step="1" value="0">
        <span class="vivi-eq-value">0 dB</span>
      </div>
      <div class="vivi-eq-row" data-band="mid">
        <span class="vivi-eq-label">Mid</span>
        <input type="range" min="-12" max="12" step="1" value="0">
        <span class="vivi-eq-value">0 dB</span>
      </div>
      <div class="vivi-eq-row" data-band="high">
        <span class="vivi-eq-label">High</span>
        <input type="range" min="-12" max="12" step="1" value="0">
        <span class="vivi-eq-value">0 dB</span>
      </div>
      <div class="vivi-eq-row" data-band="room">
        <span class="vivi-eq-label">Room</span>
        <input type="range" min="0" max="100" step="5" value="0">
        <span class="vivi-eq-value">0%</span>
      </div>
    `;

    document.body.appendChild(toggleBtn);
    document.body.appendChild(panel);

    els = {
      toggleBtn,
      panel,
      power: panel.querySelector('.vivi-eq-power'),
      presetBtns: [...panel.querySelectorAll('.vivi-eq-preset-btn')],
      low: panel.querySelector('[data-band="low"] input'),
      mid: panel.querySelector('[data-band="mid"] input'),
      high: panel.querySelector('[data-band="high"] input'),
      room: panel.querySelector('[data-band="room"] input'),
      lowVal: panel.querySelector('[data-band="low"] .vivi-eq-value'),
      midVal: panel.querySelector('[data-band="mid"] .vivi-eq-value'),
      highVal: panel.querySelector('[data-band="high"] .vivi-eq-value'),
      roomVal: panel.querySelector('[data-band="room"] .vivi-eq-value'),
    };

    toggleBtn.addEventListener('click', () => {
      // Web Audio contexts start "suspended" until a user gesture — this
      // click is that gesture, so resume it here.
      if (audioCtx && audioCtx.state === 'suspended') audioCtx.resume();
      panel.classList.toggle('vivi-eq-open');
    });

    document.addEventListener('click', (e) => {
      if (!panel.classList.contains('vivi-eq-open')) return;
      if (panel.contains(e.target) || toggleBtn.contains(e.target)) return;
      panel.classList.remove('vivi-eq-open');
    });

    els.power.addEventListener('click', () => {
      settings.enabled = !settings.enabled;
      settings.preset = 'custom';
      syncUIFromSettings();
      applySettingsToGraph();
      saveSettings();
    });

    els.presetBtns.forEach((btn) => {
      btn.addEventListener('click', () => {
        const key = btn.dataset.preset;
        const p = PRESETS[key];
        if (!p) return;
        settings = { ...settings, enabled: true, preset: key, low: p.low, mid: p.mid, high: p.high, room: p.room, spatial: !!p.spatial };
        syncUIFromSettings();
        applySettingsToGraph();
        saveSettings();
      });
    });

    const bandInputs = [
      ['low', els.low, els.lowVal, (v) => `${v > 0 ? '+' : ''}${v} dB`],
      ['mid', els.mid, els.midVal, (v) => `${v > 0 ? '+' : ''}${v} dB`],
      ['high', els.high, els.highVal, (v) => `${v > 0 ? '+' : ''}${v} dB`],
      ['room', els.room, els.roomVal, (v) => `${v}%`],
    ];
    bandInputs.forEach(([key, input, label, fmt]) => {
      input.addEventListener('input', () => {
        const v = Number(input.value);
        settings[key] = v;
        settings.preset = 'custom';
        settings.enabled = true;
        settings.spatial = false; // manual band tweaks drop out of the 3D Audio preset
        label.textContent = fmt(v);
        highlightActivePreset();
        applySettingsToGraph();
      });
      input.addEventListener('change', saveSettings);
    });

    syncUIFromSettings();
  }

  function highlightActivePreset() {
    els.presetBtns?.forEach((btn) => {
      btn.classList.toggle('vivi-eq-preset-active', btn.dataset.preset === settings.preset);
    });
  }

  function syncUIFromSettings() {
    if (!els.toggleBtn) return;
    els.toggleBtn.classList.toggle('vivi-eq-active', settings.enabled);
    els.power.classList.toggle('on', settings.enabled);
    els.low.value = settings.low;
    els.mid.value = settings.mid;
    els.high.value = settings.high;
    els.room.value = settings.room;
    els.lowVal.textContent = `${settings.low > 0 ? '+' : ''}${settings.low} dB`;
    els.midVal.textContent = `${settings.mid > 0 ? '+' : ''}${settings.mid} dB`;
    els.highVal.textContent = `${settings.high > 0 ? '+' : ''}${settings.high} dB`;
    els.roomVal.textContent = `${settings.room}%`;
    highlightActivePreset();
  }

  function waitForPlayerShell(cb) {
    if (document.querySelector('ytmusic-app')) { cb(); return; }
    const obs = new MutationObserver(() => {
      if (document.querySelector('ytmusic-app')) {
        obs.disconnect();
        cb();
      }
    });
    obs.observe(document.documentElement, { childList: true, subtree: true });
  }

  // The EQ toggle is only relevant while the full player/watch page is open —
  // it should disappear (not just its panel, the floating button too) the
  // instant the player is minimized back to Home/Explore/etc, same as the
  // Kawarp fluid background. content.js calls this from the same
  // isMainPlayerPageActive() check it already uses for Kawarp.
  function setVisible(visible) {
    if (!els.toggleBtn) return;
    els.toggleBtn.classList.toggle('vivi-eq-hidden', !visible);
    if (!visible && els.panel) {
      els.panel.classList.remove('vivi-eq-open');
    }
  }

  window.__viviEqualizer = { setVisible };

  function init() {
    loadSettings(() => {
      waitForPlayerShell(() => {
        buildUI();
        pollForVideo();
      });
    });
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})();
