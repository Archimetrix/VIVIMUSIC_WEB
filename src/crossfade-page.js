/* VIVIMUSIC WEB — crossfade-page.js  (runs in the page's MAIN world)
 *
 * Crossfading needs the *end* of the current song to keep playing after the
 * <video> element has already moved on to the next one. The only place that
 * audio exists ahead of time is the MediaSource buffer YouTube Music feeds
 * the player, and that can only be observed from the page's own JS world.
 *
 * This file therefore does three small jobs and nothing else:
 *   1. Keeps a bounded copy of the audio segments appended to MSE.
 *   2. On request, decodes the final stretch of the current song into PCM
 *      and posts it to crossfade.js (the isolated-world half).
 *   3. Reports a little player state (video id, ad flag, repeat mode) and
 *      can press "next".
 *
 * Talking to crossfade.js happens over window.postMessage on one channel.
 */
(() => {
  'use strict';
  if (window.__viviXfadePage) return;
  window.__viviXfadePage = true;

  const CHANNEL = 'vivi-xfade';
  const MAX_BYTES_PER_SINK = 24 * 1024 * 1024;
  const MAX_SINKS = 4;

  const sinks = [];        // one per audio SourceBuffer we have seen
  let capturing = false;   // chunk copies are only kept while crossfade is on

  const log = (...a) => console.log('%c[ViVi crossfade/page]', 'color:#7aa2ff', ...a);
  const say = (payload) => window.postMessage({ ch: CHANNEL, dir: 'out', ...payload }, window.location.origin);

  // ───────────────────────── byte helpers ─────────────────────────
  const rd32 = (u, i) => ((u[i] << 24) | (u[i + 1] << 16) | (u[i + 2] << 8) | u[i + 3]) >>> 0;

  function findTag(u, tag, from = 0, to = u.length) {
    const a = tag.charCodeAt(0), b = tag.charCodeAt(1), c = tag.charCodeAt(2), d = tag.charCodeAt(3);
    const stop = Math.min(to, u.length) - 4;
    for (let i = from; i <= stop; i++) {
      if (u[i] === a && u[i + 1] === b && u[i + 2] === c && u[i + 3] === d) return i;
    }
    return -1;
  }

  const isWebm = (u) => u[0] === 0x1a && u[1] === 0x45 && u[2] === 0xdf && u[3] === 0xa3;
  const isMp4Init = (u) => findTag(u, 'ftyp', 4, 8) === 4;

  // Big-endian unsigned read of 1..8 bytes.
  function readUint(u, at, len) {
    let v = 0;
    for (let i = 0; i < len; i++) v = v * 256 + u[at + i];
    return v;
  }

  // Timescale: mp4 → mdhd box; webm → TimecodeScale element (default 1 ms).
  function timescaleOf(init) {
    if (isWebm(init)) {
      for (let i = 0; i < Math.min(init.length - 5, 512); i++) {
        if (init[i] === 0x2a && init[i + 1] === 0xd7 && init[i + 2] === 0xb1) {
          const n = init[i + 3];
          if ((n & 0xf0) === 0x80) return readUint(init, i + 4, n & 0x0f) / 1e9;
        }
      }
      return 1e6 / 1e9;
    }
    const m = findTag(init, 'mdhd');
    if (m < 0) return 0;
    return 1 / (rd32(init, m + (init[m + 4] ? 24 : 16)) || 1);
  }

  // Start time (seconds, container timeline) of the first fragment in a segment.
  function segmentStart(u, webm, secPerTick) {
    if (webm) {
      if (!(u[0] === 0x1f && u[1] === 0x43 && u[2] === 0xb6 && u[3] === 0x75)) return null;
      let len = 1, mask = 0x80;
      while (len < 8 && !(u[4] & mask)) { len++; mask >>= 1; }
      const from = 4 + len;
      for (let p = from; p < Math.min(u.length - 3, from + 32); p++) {
        if (u[p] !== 0xe7) continue;
        const n = u[p + 1];
        if (n >= 0x81 && n <= 0x88) return readUint(u, p + 2, n & 0x7f) * secPerTick;
      }
      return null;
    }
    const t = findTag(u, 'tfdt', 0, 4096);
    if (t < 0 || !secPerTick) return null;
    const ticks = u[t + 4] ? rd32(u, t + 8) * 4294967296 + rd32(u, t + 12) : rd32(u, t + 8);
    return ticks * secPerTick;
  }

  // ───────────────────────── MSE capture ─────────────────────────
  const nativeAdd = MediaSource.prototype.addSourceBuffer;
  MediaSource.prototype.addSourceBuffer = function (mime) {
    const sb = nativeAdd.call(this, mime);
    try {
      if (/^audio\//i.test(String(mime))) {
        sinks.push({ sb, ms: this, init: null, webm: false, tick: 0, parts: [], bytes: 0 });
        while (sinks.length > MAX_SINKS) sinks.shift();
      }
    } catch { /* never break playback */ }
    return sb;
  };

  const nativeAppend = SourceBuffer.prototype.appendBuffer;
  SourceBuffer.prototype.appendBuffer = function (data) {
    try {
      const sink = sinks.find((s) => s.sb === this);
      if (sink) remember(sink, this, data);
    } catch { /* never break playback */ }
    return nativeAppend.call(this, data);
  };

  function remember(sink, sb, data) {
    const u = ArrayBuffer.isView(data)
      ? new Uint8Array(data.buffer, data.byteOffset, data.byteLength)
      : new Uint8Array(data);
    if (isWebm(u) || isMp4Init(u)) {
      sink.init = u.slice();            // init segments are tiny: always keep
      sink.webm = isWebm(u);
      sink.tick = timescaleOf(sink.init);
      return;
    }
    if (!capturing || !sink.init) return;
    const t = segmentStart(u, sink.webm, sink.tick);
    if (t == null || !isFinite(t)) return;
    sink.parts.push({ t, shift: sb.timestampOffset, init: sink.init, bytes: u.slice() });
    sink.bytes += u.byteLength;
    while (sink.bytes > MAX_BYTES_PER_SINK && sink.parts.length > 1) {
      sink.bytes -= sink.parts.shift().bytes.byteLength;
    }
  }

  function dropAll() {
    for (const s of sinks) { s.parts = []; s.bytes = 0; }
  }

  // ───────────────────────── player access ─────────────────────────
  const moviePlayer = () => document.getElementById('movie_player');
  const videoEl = () => document.querySelector('#movie_player video, ytmusic-player video, video');
  const liveSink = () => {
    for (let i = sinks.length - 1; i >= 0; i--) {
      if (sinks[i].ms.readyState !== 'closed') return sinks[i];
    }
    return null;
  };

  function snapshot() {
    const p = moviePlayer(), v = videoEl();
    if (!p || !v || typeof p.getVideoData !== 'function') return null;
    const id = p.getVideoData()?.video_id || '';
    const dur = Number(p.getDuration?.()) || 0;
    const pos = Number(p.getCurrentTime?.()) || 0;
    return {
      id,
      dur,
      off: v.currentTime - pos,           // element timeline minus track timeline
      ad: p.classList.contains('ad-showing'),
      rep: document.querySelector('ytmusic-player-bar')?.repeatMode === 'ONE',
    };
  }

  setInterval(() => {
    if (!capturing) return;
    const s = snapshot();
    if (s) say({ type: 'state', ...s });
  }, 250);

  // ───────────────────────── tail decoding ─────────────────────────
  async function buildTail(req) {
    const snap = snapshot();
    if (!snap || snap.id !== req.id) return { ok: false, why: 'track-changed' };
    const sink = liveSink();
    if (!sink || !sink.parts.length) return { ok: false, why: 'no-data' };

    // Segments belonging to this song share one timestampOffset.
    const mine = sink.parts.filter((p) => Math.abs(p.shift - snap.off) < 0.05);
    if (!mine.length) return { ok: false, why: 'no-group' };

    // Order by time, de-duplicate re-appended segments.
    mine.sort((a, b) => a.t - b.t);
    const uniq = mine.filter((p, i) => i === mine.length - 1 || mine[i + 1].t - p.t > 0.01);

    // After a seek, YouTube Music never loads the skipped part, so the captured
    // segments can have holes. Keep only the unbroken run that reaches the end.
    const gaps = [];
    for (let i = 1; i < uniq.length; i++) gaps.push(uniq[i].t - uniq[i - 1].t);
    gaps.sort((x, y) => x - y);
    const typical = gaps.length ? gaps[Math.floor(gaps.length / 2)] : 8;
    const limit = typical * 1.6 + 0.5;
    let begin = uniq.length - 1;
    while (begin > 0 && uniq[begin].t - uniq[begin - 1].t <= limit) begin--;
    const solid = uniq.slice(begin);

    // The song must be buffered right to the end...
    const trackEnd = snap.off + snap.dur;
    const lastStart = solid[solid.length - 1].t + solid[solid.length - 1].shift;
    if (lastStart < trackEnd - (typical * 1.5 + 1)) return { ok: false, why: 'not-buffered' };
    // ...and the unbroken part must reach back far enough to cover the fade.
    if (solid[0].t + solid[0].shift > trackEnd - (req.cover || 6)) return { ok: false, why: 'short' };

    // Start at the last segment that begins at or before the requested time.
    let first = 0;
    for (let i = 0; i < solid.length; i++) {
      if (solid[i].t + solid[i].shift <= req.needFrom) first = i; else break;
    }
    const run = solid.slice(first);

    const init = run[0].init;
    const total = run.reduce((n, p) => n + p.bytes.byteLength, init.byteLength);
    const blob = new Uint8Array(total);
    blob.set(init, 0);
    let at = init.byteLength;
    for (const p of run) { blob.set(p.bytes, at); at += p.bytes.byteLength; }

    let decoded;
    try {
      const offline = new OfflineAudioContext(2, 1, req.sampleRate);
      decoded = await offline.decodeAudioData(blob.buffer);
    } catch {
      return { ok: false, why: 'decode' };
    }

    // Song might have changed while decoding.
    const again = snapshot();
    if (!again || again.id !== req.id) return { ok: false, why: 'track-changed' };

    const channels = [];
    for (let c = 0; c < Math.min(2, decoded.numberOfChannels); c++) {
      channels.push(decoded.getChannelData(c).slice());
    }
    return { ok: true, sampleRate: decoded.sampleRate, start: run[0].t + run[0].shift, channels };
  }

  function pressNext() {
    const btn = document.querySelector('ytmusic-player-bar .next-button');
    if (btn) btn.click();
    else moviePlayer()?.nextVideo?.();
  }

  // ───────────────────────── messages in ─────────────────────────
  window.addEventListener('message', async (e) => {
    const d = e.data;
    if (e.source !== window || !d || d.ch !== CHANNEL || d.dir !== 'in') return;
    if (d.type === 'config') {
      capturing = !!d.enabled;
      log('capturing =', capturing, '| audio sinks seen so far:', sinks.length);
      if (!capturing) dropAll();
    } else if (d.type === 'prepare') {
      const out = await buildTail(d);
      if (!out.ok) log('buildTail failed:', out.why, '| sinks:', sinks.length, '| parts:', sinks.map((s) => s.parts.length));
      say({ type: 'tail', id: d.id, ...out });
    } else if (d.type === 'next') {
      pressNext();
    }
  });
})();
