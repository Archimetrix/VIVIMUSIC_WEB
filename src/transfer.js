'use strict';
const $=id=>document.getElementById(id);
const sourceList=$('sourceList'), start=$('start'), spStatus=$('spStatus'), ytStatus=$('ytStatus'), log=$('log'), results=$('results'), resultList=$('resultList');
let sources=[]; let transferring=false;
function msg(type,payload={}){return new Promise((resolve,reject)=>chrome.runtime.sendMessage({type,payload},r=>chrome.runtime.lastError?reject(new Error(chrome.runtime.lastError.message)):resolve(r)))}
function direct(type, data={}){return new Promise((resolve,reject)=>chrome.runtime.sendMessage({type,...data},r=>chrome.runtime.lastError?reject(new Error(chrome.runtime.lastError.message)):resolve(r)))}
function writeLog(t){const d=document.createElement('div');d.textContent=t;log.appendChild(d);log.scrollTop=log.scrollHeight}
async function ytm(payload){const r=await direct('VIVI_YTM_TRANSFER',{payload});if(!r?.ok)throw new Error(r?.error||'YouTube Music request failed');return r}
function renderSources(){
  sourceList.innerHTML='';
  sources=[];
  for(const p of window.__playlists||[]){
    const row=document.createElement('label');
    row.className='source';
    row.dataset.playlistId=p.id;
    const known=Number(p.tracks);
    const count=Number.isFinite(known)&&known>0?`${known} tracks`:'Checking tracks…';
    row.innerHTML=`<input type="checkbox" data-kind="playlist" data-id="${esc(p.id)}"><img class="icon" src="${esc(p.image||'')}" onerror="this.style.display='none'"><div class="name"><b>${esc(p.name)}</b><div class="meta track-count">${count}${p.owner?' · '+esc(p.owner):''}</div></div>`;
    sourceList.appendChild(row);
    sources.push({kind:'playlist',id:p.id,name:p.name});
  }
  start.disabled=false;
  if(!transferring) $('reload').disabled=false;
  refreshPlaylistCounts();
}
async function refreshPlaylistCounts(){
  const rows=[...sourceList.querySelectorAll('.source[data-playlist-id]')];
  const queue=rows.slice();
  const workers=Math.min(3,queue.length);
  async function worker(){
    while(queue.length){
      const row=queue.shift();
      if(!row || transferring) return;
      const meta=row.querySelector('.track-count');
      try{
        const r=await direct('VIVI_SPOTIFY_TRANSFER_PLAYLIST_COUNT',{playlistId:row.dataset.playlistId});
        if(r?.ok && meta){
          const owner=(meta.textContent||'').match(/ · .+$/)?.[0]||'';
          meta.textContent=`${Number(r.count)||0} tracks${owner}`;
        }
      }catch{
        if(meta) meta.textContent='Track count unavailable';
      }
    }
  }
  await Promise.all(Array.from({length:workers},()=>worker()));
}

function esc(s){return String(s).replace(/[&<>"']/g,m=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[m]))}
async function load(){start.disabled=true;spStatus.textContent='Checking Spotify…';ytStatus.textContent='Checking YouTube Music…';try{const su=await direct('VIVI_SPOTIFY_TRANSFER_USER');if(!su?.ok)throw new Error(su?.error||'Connect Spotify first');spStatus.textContent=`Connected${su.user?.name?' · '+su.user.name:''}`;const yr=await ytm({type:'VIVI_YTM_TRANSFER_READY'});ytStatus.textContent='Connected';const pl=await direct('VIVI_SPOTIFY_TRANSFER_PLAYLISTS');if(!pl?.ok)throw new Error(pl?.error||'Could not read Spotify playlists');window.__playlists=pl.items||[];renderSources()}catch(e){sourceList.innerHTML=`<div class="empty">${esc(e.message)}</div>`;start.disabled=true;if(e.message.toLowerCase().includes('spotify'))spStatus.textContent=e.message;if(e.message.toLowerCase().includes('youtube'))ytStatus.textContent=e.message}}
async function fetchTracks(sel){const r=await direct('VIVI_SPOTIFY_TRANSFER_PLAYLIST_TRACKS',{playlistId:sel.id});if(!r?.ok)throw new Error(r?.error||'Could not read playlist');return r.items||[]}
async function run(){
  const chosen=[...sourceList.querySelectorAll('input:checked')]
    .map(i=>sources.find(s=>s.id===(i.dataset.id||i.dataset.kind)))
    .filter(Boolean);
  if(!chosen.length || transferring)return;
  transferring=true;
  start.disabled=true;
  $('reload').disabled=true;
  results.classList.add('hidden');
  $('progress').classList.remove('hidden');
  log.innerHTML='';
  const allResults=[];
  try{
    for(let si=0;si<chosen.length;si++){
      const sel=chosen[si];
      writeLog(`Reading ${sel.name}…`);
      const tracks=await fetchTracks(sel);
      writeLog(`${tracks.length} tracks found.`);
      const found=[];
      let misses=0;
      const retryQueue=[];
      async function searchOne(t){
        try{
          const r=await ytm({type:'VIVI_YTM_TRANSFER_SEARCH',track:t});
          if(r.result?.videoId){
            found.push({...t,videoId:r.result.videoId,match:r.result.score||0});
            return true;
          }
          // Genuinely no match on YouTube Music — not a transient failure,
          // so it's not worth retrying.
          misses++;
          writeLog(`Not found: ${t.artist} — ${t.song}`);
          return true;
        }catch(e){
          return false; // request itself failed — caller decides whether to retry
        }
      }
      for(let i=0;i<tracks.length;i++){
        const t=tracks[i];
        $('progressTitle').textContent=`Matching ${sel.name}`;
        $('progressCount').textContent=`${i+1}/${tracks.length}`;
        $('bar').style.width=`${Math.round((i/Math.max(1,tracks.length))*100)}%`;
        const ok=await searchOne(t);
        if(!ok) retryQueue.push(t); // skip forward immediately, come back after the pass
      }
      if(retryQueue.length){
        writeLog(`Retrying ${retryQueue.length} track(s) that failed to search…`);
        for(const t of retryQueue){
          const ok=await searchOne(t);
          if(!ok){
            misses++;
            writeLog(`Search failed: ${t.artist} — ${t.song}`);
          }
        }
      }
      $('bar').style.width='100%';
      const title=sel.name;
      writeLog(`Creating “${title}”…`);
      const cr=await ytm({type:'VIVI_YTM_TRANSFER_CREATE',title,description:`Transferred from Spotify with VIVIMUSIC on ${new Date().toLocaleDateString()}`});
      const ids=found.map(x=>x.videoId);
      let added=0;
      for(let i=0;i<ids.length;i+=50){
        const ar=await ytm({type:'VIVI_YTM_TRANSFER_ADD',playlistId:cr.playlistId,videoIds:ids.slice(i,i+50)});
        // Trust the real count from YouTube Music, including a genuine 0 —
        // guessing a batch fully succeeded here was masking real failures
        // (e.g. large playlists silently not being added).
        added+=Number(ar.added)||0;
      }
      allResults.push({name:title,total:tracks.length,matched:found.length,misses,added});
      writeLog(`Done: ${added}/${tracks.length} added.`);
    }
    showResults(allResults);
  }catch(e){
    writeLog(`TRANSFER STOPPED: ${e.message}`);
  }finally{
    transferring=false;
    start.disabled=false;
    $('reload').disabled=false;
  }
}
function showResults(a){resultList.innerHTML=a.map(x=>`<div class="resultRow"><b>${esc(x.name)}</b><div class="meta">${x.added} added · ${x.misses} not found · ${x.total} source tracks</div></div>`).join('');results.classList.remove('hidden')}
$('openYtm').onclick=()=>chrome.tabs.create({url:'https://music.youtube.com/',active:true});$('reload').onclick=load;start.onclick=run;$('closeResults').onclick=()=>results.classList.add('hidden');load();
