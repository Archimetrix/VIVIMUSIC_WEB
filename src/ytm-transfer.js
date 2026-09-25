'use strict';
(() => {
  const pending = new Map();
  let seq = 0;
  window.addEventListener('message', ev => {
    if (ev.source !== window || ev.data?.source !== 'VIVI_YTM_TRANSFER_PAGE') return;
    const item = pending.get(ev.data.id);
    if (!item) return;
    pending.delete(ev.data.id);
    item.resolve(ev.data.result);
  });
  function call(op, payload={}) {
    return new Promise((resolve, reject) => {
      const id = `vivi-ytm-${Date.now()}-${++seq}`;
      pending.set(id, {resolve, reject});
      window.postMessage({source:'VIVI_YTM_TRANSFER_CONTENT',id,op,payload},'*');
      setTimeout(() => { if(pending.delete(id)) reject(new Error('YouTube Music bridge timed out. Reload music.youtube.com and retry.')); }, 30000);
    });
  }
  chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
    if (!msg || !String(msg.type || '').startsWith('VIVI_YTM_TRANSFER')) return;
    const op = msg.type === 'VIVI_YTM_TRANSFER_READY' ? 'READY' : msg.type === 'VIVI_YTM_TRANSFER_SEARCH' ? 'SEARCH' : msg.type === 'VIVI_YTM_TRANSFER_CREATE' ? 'CREATE' : msg.type === 'VIVI_YTM_TRANSFER_ADD' ? 'ADD' : null;
    if (!op) return;
    call(op, msg.track ? {track:msg.track} : {title:msg.title,description:msg.description,playlistId:msg.playlistId,videoIds:msg.videoIds})
      .then(sendResponse).catch(e=>sendResponse({ok:false,error:e.message}));
    return true;
  });
})();
