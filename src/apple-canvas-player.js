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

  // Same shape as https://github.com/bharadwajpro/m3u8-player's player.js —
  // confirmed working against this exact Apple CDN with zero special
  // handling, so deliberately not adding any here.
  if (window.Hls && window.Hls.isSupported()) {
    var hls = new window.Hls();
    hls.on(window.Hls.Events.MANIFEST_PARSED, function () {
      video.play().catch(function () {});
    });
    hls.on(window.Hls.Events.ERROR, function (_evt, data) {
      if (data && data.fatal) post('error', data.type + ':' + data.details);
    });
    hls.loadSource(url);
    hls.attachMedia(video);
  } else if (video.canPlayType('application/vnd.apple.mpegurl')) {
    video.src = url;
    video.addEventListener('canplay', function () { video.play().catch(function () {}); }, { once: true });
  } else {
    post('error', 'hls-unsupported');
    return;
  }

  video.addEventListener('error', function () { post('error', 'video-element-error'); });
  video.addEventListener('playing', function () { post('playing'); }, { once: true });
})();
