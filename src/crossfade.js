/* VIVIMUSIC WEB — crossfade.js  (content script, isolated world)
 *
 * Overlaps the end of one song with the start of the next.
 *
 * How it works, in plain terms:
 *   • A few seconds before a song ends, crossfade-page.js (MAIN world) hands
 *     us the already-buffered tail of that song as decoded PCM.
 *   • At the hand-over moment we line that PCM up with what is currently
 *     coming out of the <video> (a short cross-correlation), start playing
 *     it from a private buffer source, and silence the live element.
 *   • We then press "next". The moment the new song is audible we fade it in
 *     while the buffered tail of the old song fades out (equal-power curves).
 *
 * Both paths feed the equalizer chain, so EQ / reverb apply to the blend.
 * If anything looks off (no buffer, poor alignment, ads, repeat-one, pause,
 * user skip) we simply do nothing or back out and let YouTube Music behave
 * as usual — crossfade never has to succeed for playback to be correct.
 */
(() => {
  'use strict';
  if (window.__viviCrossfade) return;

  const CHANNEL = 'vivi-xfade';
  const PREP_LEAD = 14;        // seconds before the fade window to ask for the tail
  const SWITCH = 0.03;         // live → buffered tail swap ramp (s)
  const MAX_SECONDS = 12;
  const TICK_MS = 150;

  const curve = (fn) => Float32Array.from({ length: 64 }, (_, i) => fn((i / 63) * Math.PI / 2));
  const FADE_IN = curve(Math.sin);
  const FADE_OUT = curve(Math.cos);

  const log = (...a) => console.log('%c[ViVi crossfade]', 'color:#ff805c', ...a);
  const clamp = (x, lo, hi) => Math.min(hi, Math.max(lo, x));
  // Freeze an AudioParam at its current value from time t. Firefox has no
  // cancelAndHoldAtTime, so there the value is read first and pinned by hand
  // (cancelScheduledValues alone would snap it back to its pre-automation value).
  const hold = (param, t) => {
    if (param.cancelAndHoldAtTime) { param.cancelAndHoldAtTime(t); return; }
    const v = param.value;
    param.cancelScheduledValues(t);
    param.setValueAtTime(v, t);
  };

  // ───────── settings (read straight from storage, no relay needed) ─────────
  let userOn = false, userSecs = 6, saver = false;
  const seconds = () => (userOn && !saver ? clamp(Math.round(userSecs) || 0, 1, MAX_SECONDS) : 0);

  function post(msg) {
    window.postMessage({ ch: CHANNEL, dir: 'in', ...msg }, window.location.origin);
  }

  function applyConfig() {
    log('config: seconds =', seconds(), '| enabled:', userOn, '| resource saver:', saver);
    post({ type: 'config', enabled: seconds() > 0 });
    if (seconds() === 0) { if (live) abortLive(); dropPlan(); }
    else if (navigator.userActivation?.hasBeenActive) wake();
  }

  try {
    chrome.storage.local.get({ crossfadeEnabled: false, crossfadeSeconds: 6, resourceSaverEnabled: false }, (r) => {
      userOn = r.crossfadeEnabled === true;
      userSecs = Number(r.crossfadeSeconds) || 6;
      saver = r.resourceSaverEnabled === true;
      applyConfig();
    });
    chrome.storage.onChanged.addListener((ch, area) => {
      if (area !== 'local') return;
      if ('crossfadeEnabled' in ch) userOn = ch.crossfadeEnabled.newValue === true;
      if ('crossfadeSeconds' in ch) userSecs = Number(ch.crossfadeSeconds.newValue) || 6;
      if ('resourceSaverEnabled' in ch) saver = ch.resourceSaverEnabled.newValue === true;
      applyConfig();
    });
  } catch { /* extension context gone */ }

  // ───────── shared audio graph ─────────
  const graph = () => {
    const g = window.__viviAudioGraph;
    return g && g.ctx && g.gate && g.entry ? g : null;
  };

  // Web Audio may only start from a user gesture, and a *suspended* context
  // would mute the page, so the graph is created (and resumed) only here.
  function wake() {
    if (seconds() === 0) return;
    const g = graph() || window.__viviEqualizer?.ensureAudioGraph?.();
    if (!g) log('could not create audio graph (video not found or already bound)');
    else if (!wake.said) { wake.said = true; log('audio graph ready, context state:', g.ctx.state); }
    if (g?.ctx.state === 'suspended') g.ctx.resume().catch(() => {});
    if (g) watchVideo(g.video);
  }
  for (const t of ['pointerdown', 'keydown']) window.addEventListener(t, wake, true);

  let watched = null;
  function watchVideo(v) {
    if (!v || watched === v) return;
    watched = v;
    v.addEventListener('playing', () => { if (live && graph()) live.playedAt = graph().ctx.currentTime; });
  }

  // ───────── state from the page world ─────────
  let st = null, stAt = 0, seenId = '';
  let plan = null, reqId = '', failedId = '', retryAt = 0, tries = 0;
  const MAX_TRIES = 4;
  let tap = null;
  let live = null;
  let startDelay = 0.5;   // learned: seconds between pressing next and hearing it

  window.addEventListener('message', (e) => {
    const d = e.data;
    if (e.source !== window || !d || d.ch !== CHANNEL || d.dir !== 'out') return;
    if (d.type === 'state') {
      st = d; stAt = performance.now();
      if (d.id !== seenId) {
        seenId = d.id;
        if (!live) { dropPlan(); reqId = ''; failedId = ''; tries = 0; }
      }
    } else if (d.type === 'tail') {
      acceptTail(d);
    }
  });

  // A failed attempt (decode, alignment, ...) is retried with fresh data a few
  // times while there is still time left, instead of giving up on the song.
  function retryOrGiveUp(why) {
    tries++;
    if (tries >= MAX_TRIES) { failedId = st?.id || ''; log('giving up on this song:', why); return; }
    log('retrying (' + tries + '/' + MAX_TRIES + '):', why);
    plan = null; reqId = ''; retryAt = performance.now() + 700;
  }

  function dropPlan() {
    plan = null;
    const g = graph();
    if (tap && g) { try { g.source.disconnect(tap); } catch { /* already detached */ } }
    tap = null;
  }

  function acceptTail(d) {
    log('tail reply:', d.ok ? 'ok, ' + (d.channels[0].length / d.sampleRate).toFixed(1) + 's of audio' : 'failed (' + d.why + ')');
    if (!st || d.id !== st.id) return;
    if (!d.ok) {
      if (d.why === 'not-buffered' || d.why === 'no-data' || d.why === 'no-group' || d.why === 'short') {
        reqId = ''; retryAt = performance.now() + 1500;   // may become available shortly
      } else {
        retryOrGiveUp(d.why);                              // decode hiccup / song changed mid-way
      }
      return;
    }
    const g = graph();
    if (!g || !d.channels.length) return;
    const len = d.channels[0].length;
    const buf = g.ctx.createBuffer(d.channels.length, len, d.sampleRate);
    d.channels.forEach((c, i) => buf.copyToChannel(c, i));
    const L = d.channels[0], R = d.channels[1] || L;
    const mono = new Float32Array(len);
    for (let i = 0; i < len; i++) mono[i] = (L[i] + R[i]) * 0.5;
    plan = { id: d.id, buf, mono, rate: d.sampleRate, start: d.start };
  }

  // ───────── alignment: where in the decoded tail are we right now? ─────────
  const rms = (a) => { let s = 0; for (let i = 0; i < a.length; i++) s += a[i] * a[i]; return Math.sqrt(s / Math.max(1, a.length)); };

  // Normalised cross-correlation of `tmpl` against `buf`, searching start
  // positions in [lo, hi]. Both are box-averaged by `D` first (cheap coarse
  // pass); D = 1 is the exact pass.
  function scan(tmpl, buf, lo, hi, D) {
    const L = tmpl.length;
    const n = Math.floor(L / D);
    if (hi < lo || n < 32) return null;
    const a = new Float32Array(n);
    let ea = 0;
    for (let i = 0; i < n; i++) {
      let s = 0;
      for (let k = 0; k < D; k++) s += tmpl[i * D + k];
      a[i] = s; ea += s * s;
    }
    const m = Math.floor((hi - lo) / D) + 1;
    const b = new Float32Array(m + n);
    for (let i = 0; i < b.length; i++) {
      let s = 0;
      const base = lo + i * D;
      for (let k = 0; k < D; k++) s += buf[base + k] || 0;
      b[i] = s;
    }
    const pre = new Float64Array(b.length + 1);
    for (let i = 0; i < b.length; i++) pre[i + 1] = pre[i] + b[i] * b[i];
    let bestJ = 0, bestC = -2;
    for (let j = 0; j < m; j++) {
      let dot = 0;
      for (let i = 0; i < n; i++) dot += a[i] * b[j + i];
      const c = dot / Math.sqrt(ea * (pre[j + n] - pre[j]) + 1e-12);
      if (c > bestC) { bestC = c; bestJ = j; }
    }
    return { index: lo + bestJ * D, score: bestC };
  }

  // Coarse (÷16) → medium (÷4) → exact, so a wide search stays cheap.
  function locate(tmpl, buf, guess, radius) {
    const L = tmpl.length;
    const lo = Math.max(0, guess - radius);
    const hi = Math.min(buf.length - L, guess + radius);
    if (hi < lo) return null;
    let c = (hi - lo > 4000) ? scan(tmpl, buf, lo, hi, 16) : { index: lo };
    if (!c) return null;
    const mid = scan(tmpl, buf, Math.max(0, c.index - 40), Math.min(buf.length - L, c.index + 40), 4);
    if (mid) c = mid;
    return scan(tmpl, buf, Math.max(0, c.index - 8), Math.min(buf.length - L, c.index + 8), 1);
  }

  // ───────── hand-over: live element → buffered tail ─────────
  function handOver(g, v, N) {
    const ctx = g.ctx, p = plan, sr = p.rate;
    const frame = new Float32Array(tap.fftSize);
    tap.getFloatTimeDomainData(frame);
    const tRead = ctx.currentTime;
    const L = Math.round(0.25 * sr);
    const tmpl = frame.subarray(frame.length - L);
    const loud = rms(tmpl);

    let startIdx = Math.round((v.currentTime - p.start) * sr) - L;
    if (loud > 0.001) {
      let hit = locate(tmpl, p.mono, startIdx, Math.round(3 * sr));
      if (!hit || hit.score < 0.9) {
        // my position estimate was off: look through the whole tail instead
        hit = locate(tmpl, p.mono, Math.round(p.mono.length / 2), p.mono.length);
      }
      log('alignment score:', hit && hit.score.toFixed(3), '| estimate was off by', hit ? Math.round((hit.index - startIdx) / sr * 1000) + ' ms' : 'n/a');
      if (!hit || hit.score < 0.9) { retryOrGiveUp('alignment score too low'); return; }
      startIdx = hit.index;
    }
    const T = ctx.currentTime + 0.1;
    const idxT = startIdx + L + (T - tRead) * sr;
    if (idxT < 0 || p.mono.length - idxT < sr * 0.8) { retryOrGiveUp('tail too short'); return; }

    // The element's own volume/normalisation is already baked into what we
    // measured, so the tail is scaled to match it rather than guessed.
    const ref = rms(p.mono.subarray(startIdx, startIdx + L));
    const base = loud > 0.001 && ref > 1e-4 ? clamp(loud / ref, 0, 4) : (v.muted ? 0 : v.volume);

    const src = ctx.createBufferSource();
    const fade = ctx.createGain();
    const vol = ctx.createGain();
    src.buffer = p.buf;
    src.connect(fade); fade.connect(vol); vol.connect(g.entry);
    vol.gain.setValueAtTime(0, T);
    vol.gain.linearRampToValueAtTime(base, T + SWITCH);
    hold(g.gate.gain, ctx.currentTime);
    g.gate.gain.setValueAtTime(1, T);
    g.gate.gain.linearRampToValueAtTime(0, T + SWITCH);
    src.start(T, idxT / sr);

    const me = {
      phase: 'asked', oldId: st.id, N, src, fade, vol, base, muted: false,
      T, askedAt: 0, playedAt: 0, newId: '', newAt: 0, mixEnd: 0,
      tailEnd: T + (p.buf.duration - idxT / sr),
    };
    live = me;
    plan = null;
    log('handover done, tail gain', base.toFixed(2), ', pressing next');
    src.onended = () => { if (live === me) finishLive(); };
    setTimeout(() => {
      if (live !== me) return;
      me.askedAt = graph()?.ctx.currentTime || 0;
      post({ type: 'next' });
    }, Math.max(0, (T + SWITCH - ctx.currentTime) * 1000) + 10);
  }

  function beginMix(g) {
    const ctx = g.ctx, now = ctx.currentTime;
    const room = live.tailEnd - now;
    if (room < 0.25) { finishLive(); return; }
    const M = clamp(Math.min(live.N, room), 0.3, MAX_SECONDS);
    startDelay = clamp(startDelay * 0.7 + (now - live.askedAt) * 0.3, 0.1, 2.5);
    // Both params are at rest here (gate at 0, fade at 1). Only clear what is
    // scheduled from now on: a value *event* at `now` would collide with the
    // curve below, which Firefox rejects.
    g.gate.gain.cancelScheduledValues(now);
    g.gate.gain.setValueCurveAtTime(FADE_IN, now, M);
    live.fade.gain.cancelScheduledValues(now);
    live.fade.gain.setValueCurveAtTime(FADE_OUT, now, M);
    log('mixing for', M.toFixed(1), 's, startDelay', startDelay.toFixed(2));
    live.phase = 'mixing';
    live.mixId = st.id;
    live.mixEnd = now + M;
  }

  function cleanup(L, g, rampGate) {
    const ctx = g.ctx, now = ctx.currentTime;
    hold(g.gate.gain, now);
    if (rampGate) {
      g.gate.gain.setValueAtTime(g.gate.gain.value, now);
      g.gate.gain.linearRampToValueAtTime(1, now + 0.06);
      hold(L.vol.gain, now);
      L.vol.gain.setValueAtTime(L.vol.gain.value, now);
      L.vol.gain.linearRampToValueAtTime(0, now + 0.12);
      try { L.src.stop(now + 0.15); } catch { /* not started / already stopped */ }
    } else {
      g.gate.gain.setValueAtTime(1, now);
      try { L.src.stop(); } catch { /* already ended */ }
    }
    setTimeout(() => { try { L.vol.disconnect(); } catch { /* gone */ } }, 300);
  }

  function finishLive() {
    const g = graph(), L = live;
    live = null;
    if (!g || !L) return;
    cleanup(L, g, false);
    dropPlan();
    reqId = ''; failedId = ''; tries = 0;
  }

  function abortLive() {
    log('aborted crossfade');
    const g = graph(), L = live;
    live = null;
    if (!g || !L) return;
    cleanup(L, g, true);
    dropPlan();
    failedId = st?.id || '';
  }

  // ───────── per-tick logic while a crossfade is in progress ─────────
  function driveLive(g, v) {
    const now = g.ctx.currentTime;
    if (seconds() === 0 || !v || g.video !== v) { abortLive(); return; }

    // honour a mute that happens while the tail is still audible
    const muted = v.muted || v.volume === 0;
    if (muted !== live.muted && now > live.T + 0.1) {
      live.muted = muted;
      live.vol.gain.cancelScheduledValues(now);
      live.vol.gain.setTargetAtTime(muted ? 0 : live.base, now, 0.03);
    }

    if (live.phase === 'asked') {
      if (!live.askedAt) return;
      const sinceAsk = now - live.askedAt;
      const changed = st && st.id && st.id !== live.oldId;
      if (!changed) {
        if (sinceAsk > 1 && v.paused) abortLive();          // user paused, or next did nothing
        else if (sinceAsk > 8) abortLive();                 // nothing followed (end of queue?)
        return;
      }
      if (!live.newId) { live.newId = st.id; live.newAt = now; }
      else if (st.id !== live.newId) { abortLive(); return; }   // user skipped again
      if (st.ad) { abortLive(); return; }
      const audible = !v.paused && (live.playedAt >= live.askedAt || now - live.newAt > 1.2);
      if (audible) beginMix(g);
      else if (now - live.newAt > 5) abortLive();
    } else if (live.phase === 'mixing') {
      if (v.paused || st.id !== live.mixId) abortLive();
    }
  }

  const remaining0 = (v) => st.dur - (v.currentTime - st.off);
  const tick = {};
  // ───────── main tick ─────────
  setInterval(() => {
    const g = graph();
    const v = g?.video;
    if (live) { if (g) driveLive(g, v); else live = null; return; }

    const N = seconds();
    if (!N || !g || !v || !st || performance.now() - stAt > 1500) return;
    if (g.ctx.state !== 'running' || g.video !== document.querySelector('#movie_player video, ytmusic-player video, video')) return;
    watchVideo(v);

    const eligible = !v.paused && v.playbackRate === 1 && !st.ad && !st.rep
      && st.dur >= Math.max(30, N * 2 + 8) && st.id && st.id !== failedId;
    if (!eligible) { if (remaining0(v) < N + PREP_LEAD && !tick[st.id]) { tick[st.id] = 1; log('not eligible:', { paused: v.paused, rate: v.playbackRate, ad: st.ad, repeatOne: st.rep, dur: st.dur, id: st.id, failed: st.id === failedId }); } return; }

    const remaining = st.dur - (v.currentTime - st.off);
    if (remaining > N + PREP_LEAD + 1 || remaining < 0.8) return;

    if (reqId !== st.id && performance.now() >= retryAt) {
      reqId = st.id;
      if (!tap) {
        tap = g.ctx.createAnalyser();
        tap.fftSize = 16384;
        tap.smoothingTimeConstant = 0;
        g.source.connect(tap);
      }
      log('requesting tail, remaining', remaining.toFixed(1), 's');
      post({
        type: 'prepare', id: st.id, sampleRate: g.ctx.sampleRate,
        needFrom: st.off + st.dur - (N + PREP_LEAD + 3), cover: N + 3,
      });
    }

    if (plan && plan.id === st.id && tap && remaining <= N + startDelay && remaining >= 1) {
      handOver(g, v, N);
    }
  }, TICK_MS);

  window.__viviCrossfade = {
    active: () => !!live,
    status: () => ({
      seconds: seconds(), graph: !!graph(), ctx: graph()?.ctx.state, state: st,
      remaining: st && graph() ? st.dur - (graph().video.currentTime - st.off) : null,
      plan: !!plan, reqId, failedId, live: live && live.phase,
    }),
  };
})();
