(() => {
  'use strict';
  if (window.__VIVI_YTM_TRANSFER_BRIDGE__) return;
  window.__VIVI_YTM_TRANSFER_BRIDGE__ = true;

  function cfg(key, fallback = null) {
    try { return window.ytcfg?.get?.(key) ?? fallback; } catch { return fallback; }
  }
  function context() {
    const c = cfg('INNERTUBE_CONTEXT');
    if (c && typeof c === 'object') return structuredClone(c);
    return { client: { clientName: cfg('INNERTUBE_CLIENT_NAME', 'WEB_REMIX'), clientVersion: cfg('INNERTUBE_CLIENT_VERSION', '1.20260901.01.00'), hl: navigator.language || 'en-US', gl: 'US' } };
  }
  async function sha1(text) {
    const b = await crypto.subtle.digest('SHA-1', new TextEncoder().encode(text));
    return Array.from(new Uint8Array(b), x => x.toString(16).padStart(2,'0')).join('');
  }
  function cookie(name) {
    const prefix = name + '=';
    for (const part of document.cookie.split(';')) {
      const v = part.trim();
      if (v.startsWith(prefix)) return decodeURIComponent(v.slice(prefix.length));
    }
    return null;
  }
  async function authHeader() {
    const sapisid = cookie('SAPISID') || cookie('__Secure-3PAPISID') || cookie('__Secure-1PAPISID');
    if (!sapisid) return null;
    const ts = Math.floor(Date.now()/1000);
    return `SAPISIDHASH ${ts}_${await sha1(`${ts} ${sapisid} ${location.origin}`)}`;
  }
  async function ytmFetch(endpoint, body, attempt = 0) {
    const key = cfg('INNERTUBE_API_KEY');
    if (!key) throw new Error('YouTube Music is still loading. Reload the YouTube Music tab and retry.');
    const headers = {'Content-Type':'application/json','Accept':'application/json'};
    const auth = await authHeader();
    if (auth) headers.Authorization = auth;
    const r = await fetch(`${location.origin}/youtubei/v1/${endpoint}?key=${encodeURIComponent(key)}`, {method:'POST',credentials:'include',headers,body:JSON.stringify(body),cache:'no-store'});
    // One retry only on a transient failure (429/5xx) — enough to ride out a
    // brief hiccup without meaningfully slowing down the normal case, where
    // this branch never triggers at all.
    if ((r.status === 429 || r.status >= 500) && attempt < 1) {
      await new Promise(res => setTimeout(res, 500));
      return ytmFetch(endpoint, body, attempt + 1);
    }
    const text = await r.text();
    if (!r.ok) throw new Error(`YouTube Music request failed (${r.status}): ${text.slice(0,220)}`);
    return text ? JSON.parse(text) : {};
  }
  function runText(r) { return r?.text?.runs?.map(x=>x?.text||'').join('') || r?.text?.simpleText || ''; }
  function candidateText(r) {
    return (r?.flexColumns||[]).flatMap(c => c?.musicResponsiveListItemFlexColumnRenderer?.text?.runs || []).map(runText).filter(Boolean).join(' ');
  }
  function searchItems(data) {
    const root = data?.contents?.tabbedSearchResultsRenderer?.tabs?.[0]?.tabRenderer?.content || data?.contents?.twoColumnSearchResultsRenderer?.primaryContents;
    const out=[];
    const walk=n=>{
      if (!n || typeof n!=='object') return;
      if (Array.isArray(n)) return n.forEach(walk);
      const r=n.musicResponsiveListItemRenderer;
      if (r) {
        const videoId=r?.playNavigationEndpoint?.watchEndpoint?.videoId || r?.navigationEndpoint?.watchEndpoint?.videoId || r?.overlay?.musicItemThumbnailOverlayRenderer?.content?.musicPlayButtonRenderer?.playNavigationEndpoint?.watchEndpoint?.videoId || r?.playlistItemData?.videoId;
        if(videoId) out.push({videoId,title:candidateText(r)});
      }
      Object.values(n).forEach(walk);
    };
    walk(root?.sectionListRenderer?.contents || root);
    return out;
  }
  const clean=s=>String(s||'').toLowerCase().replace(/[\u2018\u2019]/g,"'").replace(/\([^)]*\)|\[[^\]]*\]/g,' ').replace(/[^\p{L}\p{N}]+/gu,' ').replace(/\s+/g,' ').trim(); 
  function score(c,t){
    const title=clean(t.song),artist=clean(t.artist),hay=clean(c.title); let s=0;
    if(title && hay.includes(title)) s+=80;
    for(const x of title.split(' ')) if(x && hay.includes(x)) s+=2;
    if(artist && hay.includes(artist)) s+=50;
    for(const x of artist.split(' ')) if(x && hay.includes(x)) s+=1;
    return s;
  }
  async function searchTrack(t){
    const data=await ytmFetch('search',{context:context(),query:`${t.artist} ${t.song}`.trim()});
    const c=searchItems(data); if(!c.length)return null; c.sort((a,b)=>score(b,t)-score(a,t));
    return {...c[0],score:score(c[0],t)};
  }
  async function createPlaylist(title,description=''){
    const d=await ytmFetch('playlist/create',{context:context(),title,description,privacyStatus:'PRIVATE'});
    const id=d?.playlistId || d?.playlistId?.value; if(!id) throw new Error('YouTube Music did not return a playlist ID.'); return id;
  }
  async function addVideos(playlistId,videoIds){
    let added=0;
    // Smaller batches are handled reliably by YouTube Music's edit_playlist
    // endpoint; larger ones (e.g. 50 at once) have been observed to fail
    // without an 'actions' field in the response, which must NOT be treated
    // as success — doing so previously caused Vivi to report tracks as
    // "added" when YouTube Music had actually added nothing.
    const CHUNK = 20;
    for(let i=0;i<videoIds.length;i+=CHUNK){
      const chunk=videoIds.slice(i,i+CHUNK).filter(Boolean);
      if(!chunk.length)continue;
      const d=await ytmFetch('browse/edit_playlist',{context:context(),playlistId,actions:chunk.map(id=>({action:'ACTION_ADD_VIDEO',addedVideoId:id}))});
      // Only count a chunk as added when YouTube Music explicitly confirms
      // success. A missing/ambiguous response is treated as 0 added, not as
      // a guessed success — better to under-report than to lie about it.
      if(d?.status==='STATUS_SUCCEEDED') added+=chunk.length;
    }
    return added;
  }
  async function ready(){
    if(!location.hostname.includes('music.youtube.com')) throw new Error('Open YouTube Music first.');
    if(!cfg('INNERTUBE_API_KEY')) throw new Error('YouTube Music is still loading. Reload the tab and retry.');
    if(!await authHeader()) throw new Error('YouTube Music login session not visible. Sign in to YouTube Music and retry.');
    return {ok:true,title:document.title||'YouTube Music'};
  }
  window.addEventListener('message', async ev=>{
    if(ev.source!==window || ev.data?.source!=='VIVI_YTM_TRANSFER_CONTENT') return;
    const {id,op,payload}=ev.data;
    const reply={source:'VIVI_YTM_TRANSFER_PAGE',id};
    try {
      if(op==='READY') reply.result=await ready();
      else if(op==='SEARCH') reply.result={ok:true,result:await searchTrack(payload.track)};
      else if(op==='CREATE') reply.result={ok:true,playlistId:await createPlaylist(payload.title,payload.description||'')};
      else if(op==='ADD') reply.result={ok:true,added:await addVideos(payload.playlistId,payload.videoIds||[])};
      else throw new Error('Unknown YouTube Music transfer operation.');
    } catch(e) { reply.result={ok:false,error:e?.message||String(e)}; }
    window.postMessage(reply,'*');
  });
})();
