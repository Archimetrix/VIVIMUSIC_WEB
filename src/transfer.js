'use strict';
const $=id=>document.getElementById(id);
const sourceList=$('sourceList'), start=$('start'), spStatus=$('spStatus'), ytStatus=$('ytStatus'), log=$('log'), queue=$('queue'), selInfo=$('selInfo');
let sources=[], transferring=false, cancelRequested=false, ytAccount=null, ytChecking=false, ytLastCheck=0, st={matched:0,missed:0}, timer=null, t0=0;
const counts=new Map();
const baseTitle=document.title;

function direct(type,data={}){return new Promise((resolve,reject)=>chrome.runtime.sendMessage({type,...data},r=>chrome.runtime.lastError?reject(new Error(chrome.runtime.lastError.message)):resolve(r)))}
async function ytm(payload,passive=false){const r=await direct('VIVI_YTM_TRANSFER',{payload,passive});if(!r?.ok)throw new Error(r?.error||'YouTube Music request failed');return r}
function esc(s){return String(s).replace(/[&<>"']/g,m=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[m]))}
function writeLog(t){const d=document.createElement('div');d.textContent=t;log.appendChild(d);log.scrollTop=log.scrollHeight}
function fmtTime(ms){const s=Math.floor(ms/1000);return `${Math.floor(s/60)}:${String(s%60).padStart(2,'0')}`}
function hideBrokenImgs(root){root.querySelectorAll('img').forEach(i=>i.addEventListener('error',()=>{i.style.visibility='hidden'}))}

/* ---------- account cards ---------- */
function setProfile(el,{tag,name,sub,photo,note}){
  const initial=(name||'?').trim().charAt(0).toUpperCase()||'?';
  el.innerHTML=`<div class="acct">${photo?`<img src="${esc(photo)}" referrerpolicy="no-referrer" alt="">`:`<div class="ph">${esc(initial)}</div>`}<div class="who"><div class="tag">${esc(tag)}</div><b>${esc(name)}</b>${sub?`<div class="sub">${esc(sub)}</div>`:''}</div></div>${note?`<div class="acctNote">${esc(note)}</div>`:''}`;
  const img=el.querySelector('img');
  if(img)img.addEventListener('error',()=>{const ph=document.createElement('div');ph.className='ph';ph.textContent=initial;img.replaceWith(ph)});
}
function acctLine(a){return [a.email,a.handle].filter(Boolean).join(' · ')}
function acctName(a){return a?.name||a?.email||a?.handle||'YouTube Music account'}
function renderYt(a,note){setProfile(ytStatus,{tag:'Connected · playlists go to this account',name:acctName(a),sub:acctLine(a)!==acctName(a)?acctLine(a):'',photo:a.photo,note})}
// Re-reads which YouTube Music account is active. `passive` never opens or
// focuses a tab, so it is safe to run in the background while the page is idle.
async function checkYtm(passive=false){
  const r=await ytm({type:'VIVI_YTM_TRANSFER_READY'},passive);
  const a=r.account||{name:'',email:'',handle:'',photo:'',key:''};
  const changed=!!ytAccount&&ytAccount.key!==a.key;
  ytAccount=a;
  renderYt(a,changed?'Account changed — now using this account.':'');
  return {account:a,changed};
}
async function recheckYtm(){
  if(transferring||ytChecking||document.hidden||Date.now()-ytLastCheck<4000)return;
  ytChecking=true;ytLastCheck=Date.now();
  try{await checkYtm(true)}catch(e){ytAccount=null;ytStatus.textContent=e.message}
  finally{ytChecking=false;updateSelection()}
}
window.addEventListener('focus',recheckYtm);
document.addEventListener('visibilitychange',recheckYtm);
setInterval(recheckYtm,15000);
window.addEventListener('beforeunload',e=>{if(transferring){e.preventDefault();e.returnValue=''}});

/* ---------- playlist picker ---------- */
const iconHtml=p=>p.image?`<img class="icon" src="${esc(p.image)}" alt="">`:`<div class="icon"></div>`;
function selectedIds(){return [...sourceList.querySelectorAll('input:checked')].map(i=>i.dataset.id)}
function canStart(n){return !transferring&&!!ytAccount&&!!window.__playlists&&n>0}
function updateSelection(){
  const ids=selectedIds();
  let tracks=0,unknown=0;
  for(const id of ids){const c=counts.get(id);if(Number.isFinite(c))tracks+=c;else unknown++}
  sourceList.querySelectorAll('.source').forEach(r=>r.classList.toggle('selected',r.querySelector('input').checked));
  selInfo.classList.remove('warnText');
  selInfo.textContent=ids.length?`${ids.length} selected · ${tracks}${unknown?'+':''} tracks`:'Select playlists to transfer';
  start.textContent=ids.length?`Transfer ${ids.length} playlist${ids.length>1?'s':''}`:'Transfer selected';
  start.disabled=!canStart(ids.length);
}
function renderSources(){
  sourceList.innerHTML='';sources=[];
  const list=window.__playlists||[];
  if(!list.length){sourceList.innerHTML='<div class="empty">No playlists found in this Spotify account.</div>';updateSelection();return}
  for(const p of list){
    const row=document.createElement('label');
    row.className='source';
    row.dataset.playlistId=p.id;row.dataset.name=(p.name||'').toLowerCase();
    const known=Number(p.tracks);
    if(Number.isFinite(known)&&known>0)counts.set(p.id,known);
    const count=Number.isFinite(known)&&known>0?`${known} tracks`:'Checking tracks…';
    row.innerHTML=`<input type="checkbox" data-kind="playlist" data-id="${esc(p.id)}">${iconHtml(p)}<div class="name"><b>${esc(p.name)}</b><div class="meta track-count">${count}${p.owner?' · '+esc(p.owner):''}</div></div>`;
    sourceList.appendChild(row);
    sources.push({kind:'playlist',id:p.id,name:p.name,image:p.image});
  }
  hideBrokenImgs(sourceList);
  applyFilter();updateSelection();refreshPlaylistCounts();
}
function applyFilter(){const q=$('filter').value.trim().toLowerCase();sourceList.querySelectorAll('.source').forEach(r=>{r.hidden=!!q&&!r.dataset.name.includes(q)})}
async function refreshPlaylistCounts(){
  const queueRows=[...sourceList.querySelectorAll('.source[data-playlist-id]')];
  const workers=Math.min(3,queueRows.length);
  async function worker(){
    while(queueRows.length){
      const row=queueRows.shift();
      if(!row||transferring)return;
      const meta=row.querySelector('.track-count');
      try{
        const r=await direct('VIVI_SPOTIFY_TRANSFER_PLAYLIST_COUNT',{playlistId:row.dataset.playlistId});
        if(r?.ok&&meta){
          const owner=(meta.textContent||'').match(/ · .+$/)?.[0]||'';
          counts.set(row.dataset.playlistId,Number(r.count)||0);
          meta.textContent=`${Number(r.count)||0} tracks${owner}`;
          updateSelection();
        }
      }catch{if(meta)meta.textContent='Track count unavailable'}
    }
  }
  await Promise.all(Array.from({length:workers},()=>worker()));
}
async function load(){
  start.disabled=true;
  spStatus.textContent='Checking Spotify…';ytStatus.textContent='Checking YouTube Music…';
  try{
    const su=await direct('VIVI_SPOTIFY_TRANSFER_USER');
    if(!su?.ok)throw new Error(su?.error||'Connect Spotify first');
    setProfile(spStatus,{tag:'Connected · playlists are read from this account',name:su.user?.name||'Spotify account',photo:su.user?.image});
    ytAccount=null;await checkYtm();
    const pl=await direct('VIVI_SPOTIFY_TRANSFER_PLAYLISTS');
    if(!pl?.ok)throw new Error(pl?.error||'Could not read Spotify playlists');
    window.__playlists=pl.items||[];renderSources();
  }catch(e){
    sourceList.innerHTML=`<div class="empty">${esc(e.message)}</div>`;start.disabled=true;
    if(e.message.toLowerCase().includes('spotify'))spStatus.textContent=e.message;
    if(e.message.toLowerCase().includes('youtube'))ytStatus.textContent=e.message;
  }
}

/* ---------- transfer ---------- */
async function fetchTracks(sel){const r=await direct('VIVI_SPOTIFY_TRANSFER_PLAYLIST_TRACKS',{playlistId:sel.id});if(!r?.ok)throw new Error(r?.error||'Could not read playlist');return r.items||[]}
const qrow=id=>queue.querySelector(`[data-id="${CSS.escape(id)}"]`);
function setRow(id,state,text,pct){const r=qrow(id);if(!r)return;r.dataset.state=state;r.querySelector('.qstatus').textContent=text;if(pct!=null)r.querySelector('.qbar i').style.width=pct+'%'}
function setOverall(si,frac,n){const p=Math.min(100,Math.round(((si+frac)/n)*100));$('bar').style.width=p+'%';document.title=`${p}% · Transferring`}
function updateStats(){$('statMatched').textContent=`${st.matched} matched`;$('statMissed').textContent=`${st.missed} not found`}
function fatal(msg){const e=new Error(msg);e.fatal=true;return e}

async function transferOne(sel,si,n,lockedKey){
  setRow(sel.id,'active','Reading tracks…',0);
  writeLog(`Reading ${sel.name}…`);
  const tracks=await fetchTracks(sel);
  writeLog(`${tracks.length} tracks found.`);
  const found=[],missed=[],retryQueue=[];
  async function searchOne(t){
    try{
      const r=await ytm({type:'VIVI_YTM_TRANSFER_SEARCH',track:t});
      if(r.result?.videoId){found.push({...t,videoId:r.result.videoId,match:r.result.score||0});st.matched++;updateStats();return true}
      // Genuinely no match on YouTube Music — not a transient failure, so not worth retrying.
      missed.push(t);st.missed++;updateStats();writeLog(`Not found: ${t.artist} — ${t.song}`);return true;
    }catch{return false}
  }
  for(let i=0;i<tracks.length;i++){
    if(cancelRequested)break;
    setRow(sel.id,'active',`Matching ${i+1}/${tracks.length}`,Math.round((i/tracks.length)*100));
    setOverall(si,0.85*(i/Math.max(1,tracks.length)),n);
    if(!await searchOne(tracks[i]))retryQueue.push(tracks[i]);
  }
  if(!cancelRequested&&retryQueue.length){
    writeLog(`Retrying ${retryQueue.length} track(s) that failed to search…`);
    for(const t of retryQueue){
      if(cancelRequested)break;
      if(!await searchOne(t)){missed.push(t);st.missed++;updateStats();writeLog(`Search failed: ${t.artist} — ${t.song}`)}
    }
  }
  const base={id:sel.id,name:sel.name,total:tracks.length,matched:found.length,missed};
  if(cancelRequested){setRow(sel.id,'skipped','Stopped before creating playlist');writeLog('Stopped before creating this playlist.');return {...base,added:0,cancelled:true}}
  if(!found.length){setRow(sel.id,'failed','No matches found — playlist not created',100);writeLog(`No tracks matched for “${sel.name}”; skipped.`);return {...base,added:0,empty:true}}
  // The user may have switched accounts since the transfer began.
  const cur=await checkYtm();
  if(cur.account.key!==lockedKey)throw fatal(`YouTube Music account changed to ${acctName(cur.account)}. Stopped so nothing is added to the wrong account.`);
  setRow(sel.id,'active','Creating playlist…',100);setOverall(si,0.88,n);
  writeLog(`Creating “${sel.name}”…`);
  const cr=await ytm({type:'VIVI_YTM_TRANSFER_CREATE',title:sel.name,description:`Transferred from Spotify with VIVIMUSIC on ${new Date().toLocaleDateString()}`});
  const ids=found.map(x=>x.videoId);
  let added=0;
  for(let i=0;i<ids.length;i+=50){
    setRow(sel.id,'active',`Adding tracks ${Math.min(i+50,ids.length)}/${ids.length}`,100);
    const ar=await ytm({type:'VIVI_YTM_TRANSFER_ADD',playlistId:cr.playlistId,videoIds:ids.slice(i,i+50)});
    // Trust the real count from YouTube Music, including a genuine 0.
    added+=Number(ar.added)||0;
    setOverall(si,0.88+0.12*Math.min(1,(i+50)/ids.length),n);
  }
  setRow(sel.id,added===tracks.length?'done':'partial',`${added}/${tracks.length} added${missed.length?` · ${missed.length} not found`:''}`,100);
  writeLog(`Done: ${added}/${tracks.length} added.`);
  return {...base,added,playlistId:cr.playlistId};
}

async function run(){
  const chosen=selectedIds().map(id=>sources.find(s=>s.id===id)).filter(Boolean);
  if(!chosen.length||transferring)return;
  let lockedKey;
  try{
    const c=await checkYtm();
    lockedKey=c.account.key;
    if(c.changed){selInfo.textContent='YouTube Music account changed — check it above, then press Transfer again.';selInfo.classList.add('warnText');return}
  }catch(e){selInfo.textContent=`Cannot start: ${e.message}`;selInfo.classList.add('warnText');return}
  const target=ytAccount;
  transferring=true;cancelRequested=false;start.disabled=true;
  st={matched:0,missed:0};updateStats();log.innerHTML='';
  const byId=new Map((window.__playlists||[]).map(p=>[p.id,p]));
  queue.innerHTML=chosen.map(s=>`<div class="qrow" data-id="${esc(s.id)}" data-state="queued">${iconHtml(byId.get(s.id)||{})}<div class="qmain"><b>${esc(s.name)}</b><div class="qstatus">Queued</div><div class="qbar"><i></i></div></div><span class="qstate"></span></div>`).join('');
  hideBrokenImgs(queue);
  $('picker').classList.add('hidden');$('results').classList.add('hidden');$('progress').classList.remove('hidden');
  $('stop').disabled=false;$('stop').textContent='Stop';
  $('progressTitle').textContent=`Transferring to ${acctName(target)}`;
  $('progressSub').textContent=`Playlist 1 of ${chosen.length}`;
  setOverall(0,0,chosen.length);
  t0=Date.now();$('statElapsed').textContent='0:00';timer=setInterval(()=>{$('statElapsed').textContent=fmtTime(Date.now()-t0)},1000);
  window.scrollTo({top:0,behavior:'smooth'});
  writeLog(`Transferring to YouTube Music account: ${acctName(target)}${acctLine(target)?' ('+acctLine(target)+')':''}`);
  const allResults=[];let fatalMsg='';
  for(let si=0;si<chosen.length;si++){
    const sel=chosen[si];
    if(cancelRequested||fatalMsg){setRow(sel.id,'skipped','Skipped');continue}
    $('progressSub').textContent=`Playlist ${si+1} of ${chosen.length} · ${sel.name}`;
    try{allResults.push(await transferOne(sel,si,chosen.length,lockedKey))}
    catch(e){
      writeLog(e.fatal?`TRANSFER STOPPED: ${e.message}`:`Failed “${sel.name}”: ${e.message}`);
      setRow(sel.id,'failed',e.fatal?'Stopped — account changed':`Failed: ${e.message}`,100);
      allResults.push({id:sel.id,name:sel.name,total:0,matched:0,missed:[],added:0,error:e.message});
      if(e.fatal)fatalMsg=e.message;
    }
    setOverall(si+1,0,chosen.length);
  }
  transferring=false;clearInterval(timer);document.title=baseTitle;
  showResults(allResults,{cancelled:cancelRequested,fatalMsg,target,elapsed:Date.now()-t0});
}

function showResults(list,{cancelled,fatalMsg,target,elapsed}){
  const added=list.reduce((a,x)=>a+(x.added||0),0);
  $('resultTitle').textContent=fatalMsg?'Transfer stopped':cancelled?'Transfer stopped':'Transfer complete';
  $('resultSub').textContent=`${added} track${added===1?'':'s'} added to ${acctName(target)}${acctLine(target)?' · '+acctLine(target):''} · ${fmtTime(elapsed)}${fatalMsg?' · '+fatalMsg:''}`;
  $('resultList').innerHTML=list.map(x=>{
    const ok=x.added>0&&x.added===x.total, bad=!!x.error||x.empty||x.cancelled||x.added===0;
    const pill=x.error?'Failed':x.cancelled?'Stopped':x.empty?'No matches':`${x.added}/${x.total} added`;
    const link=x.playlistId?`<a href="https://music.youtube.com/playlist?list=${encodeURIComponent(x.playlistId)}" target="_blank" rel="noopener">Open in YouTube Music ↗</a>`:'';
    const miss=x.missed?.length?`<details><summary>Show ${x.missed.length} track${x.missed.length>1?'s':''} not found</summary><div class="misslist">${x.missed.map(t=>`<div>${esc(t.artist)} — ${esc(t.song)}</div>`).join('')}</div></details>`:'';
    return `<div class="resultRow"><div class="rtop"><b>${esc(x.name)}</b><span class="pill ${ok?'ok':bad?'bad':'warn'}">${esc(pill)}</span></div><div class="meta">${x.missed?.length||0} not found · ${x.total} source tracks${x.error?' · '+esc(x.error):''}</div>${link}${miss}</div>`;
  }).join('');
  $('progress').classList.add('hidden');$('results').classList.remove('hidden');
  window.scrollTo({top:0,behavior:'smooth'});
}

$('reload').onclick=load;
start.onclick=run;
$('stop').onclick=()=>{cancelRequested=true;$('stop').disabled=true;$('stop').textContent='Stopping…';writeLog('Stopping after the current track…')};
$('again').onclick=()=>{
  $('results').classList.add('hidden');$('picker').classList.remove('hidden');
  sourceList.querySelectorAll('input:checked').forEach(i=>{i.checked=false});
  updateSelection();recheckYtm();window.scrollTo({top:0,behavior:'smooth'});
};
$('filter').addEventListener('input',applyFilter);
$('selAll').onclick=()=>{sourceList.querySelectorAll('.source:not([hidden]) input').forEach(i=>{i.checked=true});updateSelection()};
$('selNone').onclick=()=>{sourceList.querySelectorAll('input:checked').forEach(i=>{i.checked=false});updateSelection()};
sourceList.addEventListener('change',updateSelection);
// Banner art: prefers a bundled src/header-art.webp, falls back to the remote copy,
// and quietly hides itself if neither loads (the banner still looks fine without it).
(()=>{
  const art=$('heroArt');if(!art)return;
  const sources=['header-art.webp','https://static.gamsgocdn.com/image/47cb0258a860d502f253589115b65369.webp'];
  let i=0;
  const next=()=>{
    if(i>=sources.length){art.style.display='none';console.warn('[Vivi] Banner image could not be loaded.');return}
    art.src=sources[i++];
  };
  art.addEventListener('load',()=>art.classList.add('on'));
  art.addEventListener('error',next);
  next(); // listeners are attached first, so a failed local file can never be missed
})();
load();
