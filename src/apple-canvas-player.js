'use strict';

(function () {
  var video = document.getElementById('v');
  var params = new URLSearchParams(location.search);
  var fit = params.get('fit') === 'cover' ? 'cover' : 'contain';
  var frameId = params.get('id') || '';
  video.style.objectFit = fit;

  function post(type, detail) {
    try {
      window.parent.postMessage({ __viviAppleCanvas: true, id: frameId, type: type, detail: detail || null }, '*');
    } catch (_) { /* no-op */ }
  }

  var url = decodeURIComponent(location.hash.slice(1) || '');
  if (!url) {
    post('error', 'no-url');
    return;
  }

  var hls = null;
  var hlsStarted = false;
  var playbackRequested = false;
  var nativeHls = !(window.Hls && window.Hls.isSupported()) && video.canPlayType('application/vnd.apple.mpegurl');

  function startPlayback() {
    if (document.hidden || playbackRequested) return;
    playbackRequested = true;
    if (window.Hls && window.Hls.isSupported()) {
      if (!hls) {
        hls = new window.Hls({ enableWorker: true, maxBufferLength: 15 });
        hls.on(window.Hls.Events.ERROR, function (_evt, data) {
          if (data && data.fatal) post('error', data.type + ':' + data.details);
        });
        hls.attachMedia(video);
      }
      if (!hlsStarted) {
        hlsStarted = true;
        hls.loadSource(url);
      } else {
        hls.startLoad();
      }
    } else if (nativeHls) {
      if (!video.src) video.src = url;
    } else {
      playbackRequested = false;
      post('error', 'hls-unsupported');
      return;
    }
    video.play().catch(function () { playbackRequested = false; });
  }

  function pausePlayback() {
    playbackRequested = false;
    video.pause();
    if (hls) hls.stopLoad();
  }

  window.addEventListener('message', function (event) {
    if (event.source !== window.parent) return;
    if (event.data && event.data.__viviAppleCanvasControl === 'pause') pausePlayback();
    else if (event.data && event.data.__viviAppleCanvasControl === 'resume') startPlayback();
  });
  document.addEventListener('visibilitychange', function () {
    if (document.hidden) pausePlayback();
    else startPlayback();
  });

  if (!(window.Hls && window.Hls.isSupported()) && !nativeHls) {
    post('error', 'hls-unsupported');
    return;
  }

  video.addEventListener('error', function () { post('error', 'video-element-error'); });
  video.addEventListener('playing', function () { post('playing'); }, { once: true });
  startPlayback();
})();
