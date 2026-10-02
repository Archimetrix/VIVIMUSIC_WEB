// Fetch unseen developer announcements on YouTube Music load and show them
// inside the page, without using the browser's system notification service.
(() => {
  const request = { type: 'VIVI_ANNOUNCEMENTS_FOR_YTMUSIC' };

  try {
    chrome.runtime.sendMessage(request, response => {
      if (chrome.runtime.lastError || !response?.ok || !response.announcements?.length) return;
      showAnnouncements(response.announcements);
    });
  } catch (error) {
    console.debug('[Vivi] Could not request announcements:', error);
  }

  function showAnnouncements(items) {
    const host = document.createElement('div');
    host.id = 'vivimusic-announcement-toast';
    const shadow = host.attachShadow({ mode: 'open' });
    const latest = items[0];
    const box = document.createElement('section');
    box.className = 'toast';
    box.setAttribute('role', 'status');
    box.setAttribute('aria-live', 'polite');

    const style = document.createElement('style');
    style.textContent = `
      :host { all: initial; position: fixed; z-index: 2147483647; top: 78px; right: 22px; width: min(370px, calc(100vw - 28px)); color: #f4f2ff; font: 13px/1.45 Inter, "Segoe UI", system-ui, sans-serif; pointer-events: none; }
      *, *::before, *::after { box-sizing: border-box; }
      .toast { pointer-events: auto; overflow: hidden; border: 1px solid rgba(177,157,255,.38); border-radius: 15px; background: radial-gradient(ellipse at 0 0, rgba(133,105,255,.2), transparent 68%), linear-gradient(145deg, rgba(28,27,40,.98), rgba(15,16,23,.985)); box-shadow: 0 14px 48px rgba(0,0,0,.48), inset 0 1px rgba(255,255,255,.09); backdrop-filter: blur(18px); -webkit-backdrop-filter: blur(18px); animation: vivi-toast-in .24s cubic-bezier(.2,.8,.2,1) both; }
      .top { display: flex; align-items: center; gap: 8px; padding: 12px 12px 0 14px; }
      .dot { width: 7px; height: 7px; flex: none; border-radius: 50%; background: #a894ff; box-shadow: 0 0 10px #a894ff; }
      .eyebrow { flex: 1; color: #bdb1ff; font-size: 9px; font-weight: 800; letter-spacing: .13em; text-transform: uppercase; }
      .close { width: 27px; height: 27px; flex: none; display: grid; place-items: center; border: 1px solid rgba(255,255,255,.12); border-radius: 8px; background: rgba(255,255,255,.055); color: #c8c5d4; font: 19px/1 system-ui, sans-serif; cursor: pointer; }
      .close:hover, .close:focus-visible { color: white; background: rgba(255,255,255,.13); outline: 2px solid #a894ff; outline-offset: 2px; }
      h2 { margin: 8px 42px 0 14px; color: #f0eaff; font-size: 15px; font-weight: 750; line-height: 1.35; overflow-wrap: anywhere; }
      p { max-height: 150px; overflow: auto; margin: 6px 14px 14px; color: #c1becd; font-size: 12px; line-height: 1.55; white-space: pre-wrap; overflow-wrap: anywhere; }
      .count { display: inline-block; margin: 9px 0 0 14px; padding: 3px 7px; border: 1px solid rgba(177,157,255,.24); border-radius: 99px; color: #c8bcff; background: rgba(149,133,255,.09); font-size: 9px; font-weight: 700; }
      @keyframes vivi-toast-in { from { opacity: 0; transform: translateY(-8px) scale(.985); } to { opacity: 1; transform: translateY(0) scale(1); } }
      @media (max-width: 480px) { :host { top: 66px; right: 12px; width: calc(100vw - 24px); } }
      @media (prefers-reduced-motion: reduce) { .toast { animation: none; } }
    `;

    const top = document.createElement('div'); top.className = 'top';
    const dot = document.createElement('span'); dot.className = 'dot';
    const eyebrow = document.createElement('span'); eyebrow.className = 'eyebrow';
    eyebrow.textContent = items.length === 1 ? 'Vivimusic · Announcement' : `${items.length} new announcements`;
    const close = document.createElement('button'); close.className = 'close'; close.type = 'button'; close.setAttribute('aria-label', 'Dismiss announcement'); close.textContent = '×';
    close.addEventListener('click', () => host.remove());
    top.append(dot, eyebrow, close);

    const title = document.createElement('h2'); title.textContent = latest.title || 'Announcement';
    const message = document.createElement('p'); message.textContent = latest.message || '';
    box.append(top, title, message);
    if (items.length > 1) {
      const count = document.createElement('span'); count.className = 'count'; count.textContent = `${items.length} unread in your announcements panel`;
      box.appendChild(count);
    }
    shadow.append(style, box);

    const mount = () => {
      if (!document.documentElement) { setTimeout(mount, 20); return; }
      if (document.getElementById(host.id)) return;
      document.documentElement.appendChild(host);
      chrome.runtime.sendMessage({ type: 'VIVI_ANNOUNCEMENTS_TOASTED', ids: items.map(item => item.id) }, () => {
        void chrome.runtime.lastError;
      });
    };
    mount();
  }
})();
