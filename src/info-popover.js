// Shows the Brave login-fix guide as a full-size overlay inside the popup
// (instead of a cramped tooltip or a separate browser tab), with a close (✕)
// button to dismiss it.
(function () {
  function init() {
    var btn = document.getElementById('braveFixBtn');
    var overlay = document.getElementById('braveOverlay');
    var closeBtn = document.getElementById('braveOverlayClose');
    var doneBtn = document.getElementById('braveOverlayDone');
    if (!btn || !overlay) return;

    function open() {
      overlay.classList.add('open');
      overlay.scrollTop = 0;
    }
    function close() {
      overlay.classList.remove('open');
    }

    btn.addEventListener('click', function (e) {
      e.stopPropagation();
      open();
    });
    btn.addEventListener('keydown', function (e) {
      if (e.key === 'Enter' || e.key === ' ') {
        e.preventDefault();
        open();
      }
    });

    if (closeBtn) closeBtn.addEventListener('click', function (e) {
      e.stopPropagation();
      close();
    });
    if (doneBtn) doneBtn.addEventListener('click', function (e) {
      e.stopPropagation();
      close();
    });

    document.addEventListener('keydown', function (e) {
      if (e.key === 'Escape' && overlay.classList.contains('open')) close();
    });
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})();
