'use strict';
// Legends Live: UI, real-time WebSocket synchronization, and peer-to-peer WebRTC voice.
const $ = (id) => document.getElementById(id);
const AVATARS = ['🦊','🐼','🐸','🤖','🐯','🦄','🐺','🐲'];
const SESSION_KEY = 'legends-live-session-v1';
const RTC_CONFIG = { iceServers: [{ urls: ['stun:stun.l.google.com:19302', 'stun:stun1.l.google.com:19302'] }] };
// For restrictive cellular networks, add your own TURN server settings to RTC_CONFIG.iceServers.

let ws = null;
let intentionalAction = null;
let selfId = null;
let room = null;
let selectedAvatar = AVATARS[0];
let entryMode = 'create';
let peers = new Map();
let micStream = null;
let speakerMuted = false;
let retryTimer = null;
let toastTimer = null;
let previousPhase = '';
let previousRound = -1;
let lastJudgeId = null;
let revealedTimer = null;
let turnIntroTimer = null;
let chatRenderedIds = '';
let chatOpen = false;
let unread = 0;
let pendingVoiceSignals = [];

function toast(message) {
  const box = $('toast'); box.textContent = message; box.classList.add('show');
  clearTimeout(toastTimer); toastTimer = setTimeout(() => box.classList.remove('show'), 3800);
}
function clean(text) { return String(text ?? '').replace(/[&<>"']/g, (c) => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c])); }
function safeSession() { try { return JSON.parse(sessionStorage.getItem(SESSION_KEY) || 'null'); } catch { return null; } }
function putSession(obj) { sessionStorage.setItem(SESSION_KEY, JSON.stringify(obj)); }
function send(type, data = {}) {
  if (!ws || ws.readyState !== WebSocket.OPEN) { toast('الاتصال مقطوع — جاري إعادة الاتصال'); return false; }
  ws.send(JSON.stringify({ type, ...data })); return true;
}
function getPlayer(id) { return room?.players?.find(p => p.id === id); }
function me() { return getPlayer(selfId); }
function isHost() { return room?.host === selfId; }
function getInviteUrl(code = room?.code || '') {
  const url = new URL(window.location.href); url.searchParams.set('room', code); return url.toString();
}
async function copyText(value) {
  try { await navigator.clipboard.writeText(value); toast('تم نسخ الرابط! أرسله لأصحابك ✦'); }
  catch {
    const el = document.createElement('textarea'); el.value = value; document.body.appendChild(el); el.select();
    try { document.execCommand('copy'); toast('تم نسخ رابط الغرفة ✦'); } catch { toast('انسخ الرابط من شريط العنوان'); }
    el.remove();
  }
}
function setEntryMode(mode) {
  entryMode = mode;
  $('createTab').classList.toggle('active', mode === 'create');
  $('joinTab').classList.toggle('active', mode === 'join');
  $('createTab').setAttribute('aria-selected', String(mode === 'create'));
  $('joinTab').setAttribute('aria-selected', String(mode === 'join'));
  $('joinCodeWrap').classList.toggle('hidden', mode !== 'join');
  $('enterText').textContent = mode === 'create' ? 'إنشاء الغرفة الآن' : 'دخول الغرفة الآن';
}
function initEntry() {
  const picker = $('avatarPicker');
  AVATARS.forEach(face => {
    const b = document.createElement('button'); b.type='button'; b.className='avatar-option' + (face===selectedAvatar?' active':''); b.textContent=face;
    b.setAttribute('aria-label','اختيار شخصية '+face);
    b.addEventListener('click', () => { selectedAvatar=face; picker.querySelectorAll('button').forEach(btn=>btn.classList.toggle('active', btn===b)); });
    picker.appendChild(b);
  });
  $('createTab').addEventListener('click',()=>setEntryMode('create'));
  $('joinTab').addEventListener('click',()=>setEntryMode('join'));
  $('roomCodeInput').addEventListener('input', e=>e.target.value=e.target.value.toUpperCase().replace(/[^A-Z2-9]/g,'').slice(0,6));
  $('roomCodeInput').addEventListener('keydown', e=>{if(e.key==='Enter') enterGame();});
  $('playerName').addEventListener('keydown', e=>{if(e.key==='Enter')enterGame();});
  $('enterBtn').addEventListener('click',enterGame);
  const prefill = new URLSearchParams(window.location.search).get('room');
  if (prefill) { setEntryMode('join'); $('roomCodeInput').value=prefill.toUpperCase().slice(0,6); }
  const old = safeSession();
  if (old && (!prefill || prefill.toUpperCase() === old.code)) {
    $('playerName').value = old.name || '';
    selectedAvatar = old.avatar || AVATARS[0];
    picker.querySelectorAll('button').forEach(btn=>btn.classList.toggle('active',btn.textContent===selectedAvatar));
    intentionalAction = {type:'room:resume', code:old.code, token:old.token};
    connect();
  }
}
function enterGame() {
  const name = $('playerName').value.trim();
  if (!name) { toast('اكتب اسمك أولاً 👋'); $('playerName').focus(); return; }
  const code = $('roomCodeInput').value.trim().toUpperCase();
  if (entryMode === 'join' && code.length !== 6) { toast('كود الغرفة لازم يكون ٦ أحرف'); $('roomCodeInput').focus(); return; }
  const payload = {type: entryMode === 'create' ? 'room:create' : 'room:join', name, avatar:selectedAvatar};
  if (entryMode === 'join') payload.code=code;
  intentionalAction=payload;
  connect();
}
function connect() {
  if (ws && ws.readyState === WebSocket.OPEN) { if (intentionalAction) { const a=intentionalAction;intentionalAction=null;send(a.type,a); } return; }
  if (ws && ws.readyState === WebSocket.CONNECTING) return;
  const proto=location.protocol==='https:'?'wss:':'ws:';
  ws = new WebSocket(proto+'//'+location.host+'/ws');
  ws.addEventListener('open',()=>{
    $('connectionLabel').textContent='متصل';
    const action=intentionalAction; intentionalAction=null;
    if(action) send(action.type,action);
    else { const old=safeSession(); if(old) send('room:resume',old); }
  });
  ws.addEventListener('message', e=>{
    let data; try { data=JSON.parse(e.data); } catch { return; }
    handleServer(data);
  });
  ws.addEventListener('close',()=>{
    $('connectionLabel').textContent='جارِ الاتصال...';
    // Clear dead peer connections, create new ones when rejoined.
    for(const id of Array.from(peers.keys())) closePeer(id);
    if (room) toast('انقطع الاتصال مؤقتاً، نحاول استعادته...');
    clearTimeout(retryTimer);
    if (room || safeSession() || intentionalAction) retryTimer=setTimeout(connect, 2200);
  });
  ws.addEventListener('error',()=>{
    if (!room) toast('تعذر الوصول لخادم اللعبة. شغّل الخادم أولاً.');
  });
}
function handleServer(data) {
  if(data.type==='error') {
    toast(data.message || 'حدث خطأ');
    if(!room && safeSession()) { sessionStorage.removeItem(SESSION_KEY); intentionalAction=null; }
    return;
  }
  if(data.type==='room:welcome') {
    selfId=data.id; room=data.state;
    const present=getPlayer(selfId);
    putSession({code:room.code,token:data.token,name:present?.name||'',avatar:present?.avatar||'🦊'});
    $('entry').classList.add('hidden'); $('game').classList.remove('hidden');
    try { history.replaceState(null,'',getInviteUrl(room.code)); } catch{}
    previousPhase=''; previousRound=-1;
    render(); syncPeers();
    for (const earlySignal of pendingVoiceSignals.splice(0)) handleVoiceSignal(earlySignal.sender, earlySignal.signal);
    if(micStream?.getAudioTracks()?.[0]?.readyState === 'live') send('voice:status',{enabled:true});
    return;
  }
  if(data.type==='room:state') {
    if(!selfId) return;
    room=data.state;
    render(); syncPeers(); return;
  }
  if(data.type==='room:chat') {
    if (!room) return;
    if (!room.chat.some(m=>m.id===data.message.id)) room.chat.push(data.message);
    room.chat=room.chat.slice(-60);
    renderChat();
    if(data.message.from!==selfId && !chatOpen && window.innerWidth<=860) {
      unread=Math.min(99,unread+1); $('unreadBadge').textContent=unread; $('unreadBadge').classList.remove('hidden');
    }
    return;
  }
  if(data.type==='voice:signal') {
    if (!room || !selfId) pendingVoiceSignals.push(data);
    else handleVoiceSignal(data.sender,data.signal);
    return;
  }
  if(data.type==='voice:left') { closePeer(data.id); return; }
  if(data.type==='voice:status') {
    const p=getPlayer(data.id); if(p) { p.mic=data.enabled; renderRoster(); }
  }
}
function render() {
  if(!room)return;
  $('roomCodeLabel').textContent=room.code;
  $('playerCount').textContent=`${room.players.filter(p=>p.online).length} / 10`;
  $('roundIndicator').textContent=room.phase==='lobby'?'مرحلة الانتظار':room.phase==='results'?'نهاية المباراة':`الدور ${room.round} ✦`;
  $('arenaTitle').textContent=room.phase==='lobby'?'ساحة الأبطال':room.phase==='results'?'قاعة المجد':'الجرأة والصراحة';
  $('endMatchBtn').classList.toggle('hidden',!isHost() || room.phase==='lobby' || room.phase==='results');
  renderRoster();
  renderChat();
  const phaseChanged=room.phase!==previousPhase || (room.phase==='choice' && room.round!==previousRound) || (room.phase==='write' && room.judge!==lastJudgeId);
  if(phaseChanged) {
    drawStage();
    showOverlayForPhase();
    previousPhase=room.phase; previousRound=room.round; lastJudgeId=room.judge;
  }
}
function renderRoster() {
  if(!room) return;
  const roster=$('roster'); roster.innerHTML='';
  for (const p of room.players) {
    const tile=document.createElement('div');tile.className='player-tile'+(p.id===room.active?' active':'')+(p.online?'':' offline');
    tile.innerHTML=`<div class="tile-avatar">${clean(p.avatar)}</div><div class="tile-info"><strong title="${clean(p.name)}">${clean(p.name)} ${p.id===room.host?'<span class="crown">♛</span>':''}${p.id===selfId?' <span style="color:#a7f8e3">(أنت)</span>':''}</strong><small>${p.score} PTS</small></div><span class="tile-mic">${!p.online?'◌':p.mic?'🎙️':''}</span>`;
    roster.appendChild(tile);
  }
}
function drawStage() {
  if(!room)return;
  const stage=$('stage');
  const active=getPlayer(room.active); const judge=getPlayer(room.judge);
  let markup='';
  if(room.phase==='lobby') {
    markup=`<div class="stage-inner"><div class="stage-eyebrow">THE GATHERING · غرفة خاصة</div><div class="lobby-sigil"><span>✦</span></div><h3 class="stage-title">الأبطال يتجمعون...</h3><p class="stage-description">شارك الكود مع أصدقائك حتى يدخل كل واحد من جواله. بعدين ابدأوا المباراة!</p><div class="lobby-code"><strong>${clean(room.code)}</strong><button data-action="copy">نسخ الرابط ↗</button></div><div style="margin-top:17px">${isHost()?'<button class="stage-btn" data-action="start">✦ ابدأ المباراة</button>':'<div class="waiting-label">بانتظار قائد الغرفة يبدأ المباراة</div>'}</div><div class="waiting-dots"><b></b><b></b><b></b><span>جاهزين نبدأ؟</span></div></div>`;
  } else if(room.phase==='choice') {
    const mine=room.active===selfId;
    markup=`<div class="stage-inner"><div class="stage-eyebrow">IT'S YOUR TURN · الدور الحالي</div><div class="player-halo"><span>${clean(active?.avatar||'✦')}</span></div><h3 class="stage-title">${mine?'الدور إلك يا ': 'الدور على '}${clean(active?.name||'اللاعب')}!</h3><p class="stage-description">${mine?'قدامك خيارين... شو بتختار؟':'الكل عم ينتظر... رح يختار جرأة ولا صراحة؟'}</p>${mine?`<div class="category-buttons"><button data-action="truth" class="category-btn truth-btn"><span class="cat-icon">💜</span><strong>صــراحــة</strong><small>جاوب بدون لف ودوران</small></button><button data-action="dare" class="category-btn dare-btn"><span class="cat-icon">⚡</span><strong>جــرأة</strong><small>خليك شجاع وتحدّى</small></button></div>`:'<div class="waiting-label">✦ ننتظر اختيار البطل</div>'}</div>`;
  } else if(room.phase==='write') {
    const mine=room.judge===selfId;
    markup=`<div class="stage-inner"><div class="stage-eyebrow">THE SECRET VERDICT</div><div class="wait-graphic">◈</div><h3 class="stage-title">الحكم يتشكّل في الظلام...</h3><p class="stage-description">اختار ${clean(active?.name||'اللاعب')} ${room.category==='dare'?'جرأة ⚡':'صراحة 💜'} — الآن ${mine?'أنتَ':'الحكم '+clean(judge?.name||'')} تكتب ${mine?'سؤالك السرّي':'الحكم السرّي'}. </p><div class="waiting-label">✦ الكشف قريباً</div></div>`;
  } else if(room.phase==='reveal') {
    markup=`<div class="stage-inner"><div class="wait-graphic">✦</div><h3 class="stage-title">الحُكم صدر...</h3><p class="stage-description">ظهر الحكم الآن على شاشة جميع اللاعبين.</p></div>`;
  } else if(room.phase==='results') {
    const sorted=[...room.players].sort((a,b)=>b.score-a.score);
    markup=`<div class="stage-inner"><div class="stage-eyebrow">HALL OF LEGENDS</div><div class="results-trophy">🏆</div><h3 class="stage-title">انتهت معركة الأساطير!</h3><p class="stage-description">هي نتيجة الأبطال بعد ${Math.max(0,room.round-1)} أحكام</p><div class="results-list">${sorted.map((p,i)=>`<div class="results-entry"><span>${['🥇','🥈','🥉'][i]||'✦'} ${clean(p.avatar)} ${clean(p.name)}</span><strong>${p.score} PTS</strong></div>`).join('')}</div>${isHost()?'<button class="stage-btn end-match" data-action="start">↺ العبوا من جديد</button>':'<div class="waiting-label">بانتظار قائد الغرفة يعيد المباراة</div>'}</div>`;
  }
  stage.innerHTML=markup;
}
function showOverlayForPhase() {
  $('judgeOverlay').classList.add('hidden'); $('revealOverlay').classList.add('hidden');
  $('turnIntro').classList.add('hidden'); clearTimeout(turnIntroTimer);
  $('revealContent').classList.add('hidden');
  clearTimeout(revealedTimer);
  if(room.phase==='choice') {
    $('turnIntroName').textContent=(getPlayer(room.active)?.name||'بطل جديد');
    $('turnIntro').classList.remove('hidden');
    turnIntroTimer=setTimeout(()=>$('turnIntro').classList.add('hidden'),1280);
  }
  if(room.phase==='write' && room.judge===selfId) {
    $('judgeOverlay').classList.remove('hidden');
    const target=getPlayer(room.active);
    $('judgeDescription').textContent=`${target?.name||'اللاعب'} اختار ${room.category==='truth'?'صراحة':'جرأة'}. اكتب سؤالك أو تحدّيك ولن يراه أحد حتى ترسله.`;
    $('judgeCategory').textContent=room.category==='truth'?'💜 سؤال صراحة':'⚡ تحدي جرأة';
    $('rulingInput').value='';$('judgeCounter').textContent='0 / 220';
    setTimeout(()=>$('rulingInput').focus(),330);
  }
  if(room.phase==='reveal') {
    $('revealOverlay').classList.remove('hidden'); // A synchronized BLACK screen for everyone.
    $('revealText').textContent=room.ruling;
    $('revealTarget').textContent=`الحكم موجّه إلى: ${getPlayer(room.active)?.name||'اللاعب'} ${getPlayer(room.active)?.avatar||''}`;
    $('revealJudge').textContent=`كتبه الحكم: ${getPlayer(room.judge)?.name||'الحكم'}`;
    $('revealCategory').textContent=room.category==='truth'?'💜 صراحة':'⚡ جرأة';
    $('revealActions').classList.toggle('hidden',selfId!==room.active && !isHost());
    $('revealWaiting').classList.toggle('hidden',selfId===room.active || isHost());
    revealedTimer=setTimeout(()=>$('revealContent').classList.remove('hidden'),1100);
  }
}
function renderChat() {
  if(!room)return;
  const signature=room.chat.map(m=>m.id).join('|');
  if(signature===chatRenderedIds)return;
  chatRenderedIds=signature;
  const list=$('chatMessages');const wasBottom=list.scrollHeight-list.scrollTop-list.clientHeight<105;
  list.replaceChildren();
  if(room.chat.length===0) {
    const empty=document.createElement('div');empty.className='chat-empty';empty.innerHTML='<span class="chat-empty-icon">✉</span>الشات لسه فاضي...<br>كن أول واحد يفتح السالفة!';list.append(empty);
    return;
  }
  for(const m of room.chat) {
    const box=document.createElement('div');box.className='chat-message'+(m.from===selfId?' mine':'');
    const face=document.createElement('div');face.className='message-avatar';face.textContent=m.avatar;
    const body=document.createElement('div');body.className='message-body';
    const header=document.createElement('div');header.className='message-top';
    const name=document.createElement('span');name.textContent=m.from===selfId?'أنت':m.name;
    const time=document.createElement('time');time.textContent=new Date(m.time*1000).toLocaleTimeString('ar',{hour:'2-digit',minute:'2-digit'});
    header.append(name,time);
    const text=document.createElement('div');text.className='message-text';text.textContent=m.text;
    body.append(header,text);box.append(face,body);list.append(box);
  }
  if(wasBottom || room.chat.length<=4) list.scrollTop=list.scrollHeight;
}
function openChat() { chatOpen=true;$('chatPanel').classList.add('open');$('chatBackdrop').classList.remove('hidden');unread=0;$('unreadBadge').classList.add('hidden');setTimeout(()=>$('chatInput').focus(),280); }
function closeChat() { chatOpen=false;$('chatPanel').classList.remove('open');$('chatBackdrop').classList.add('hidden'); }

// WebRTC mesh audio. Each participant connects directly to every other participant.
function createPeer(playerId) {
  if(playerId===selfId || peers.has(playerId))return peers.get(playerId);
  const pc = new RTCPeerConnection(RTC_CONFIG);
  const peer={pc, polite:selfId>playerId, makingOffer:false, ignoreOffer:false, settingAnswer:false, iceQueue:[], audio:null, sender:null};
  peers.set(playerId,peer);
  const transceiver=pc.addTransceiver('audio',{direction:'sendrecv'});
  peer.sender=transceiver.sender;
  const live=micStream?.getAudioTracks()?.[0];
  if(live && live.readyState==='live') peer.sender.replaceTrack(live).catch(()=>{});
  pc.onnegotiationneeded=async()=>{
    try {peer.makingOffer=true;await pc.setLocalDescription();send('voice:signal',{to:playerId,signal:{description:pc.localDescription}});}
    catch(err) { console.warn('offer',err); }
    finally {peer.makingOffer=false;}
  };
  pc.onicecandidate=({candidate})=>{if(candidate)send('voice:signal',{to:playerId,signal:{candidate}});};
  pc.ontrack=(event)=>{
    if(!peer.audio){
      const audio=document.createElement('audio'); audio.autoplay=true;audio.playsInline=true;audio.hidden=true; audio.muted=speakerMuted;
      document.body.append(audio);peer.audio=audio;
    }
    peer.audio.srcObject=event.streams?.[0] || new MediaStream([event.track]);
    peer.audio.play().catch(()=>{});
  };
  pc.onconnectionstatechange=()=>{
    if(pc.connectionState==='failed') { try {pc.restartIce();} catch{} }
  };
  return peer;
}
function syncPeers(){
  if(!room || !selfId || typeof RTCPeerConnection==='undefined')return;
  const expected=new Set(room.players.filter(p=>p.online && p.id!==selfId).map(p=>p.id));
  for(const id of Array.from(peers.keys()))if(!expected.has(id))closePeer(id);
  for(const id of expected)createPeer(id);
}
async function handleVoiceSignal(sender,signal){
  if(!room || !getPlayer(sender) || sender===selfId || typeof RTCPeerConnection==='undefined')return;
  const peer=createPeer(sender);const pc=peer.pc;
  try{
    if(signal.description){
      const description=signal.description;
      const ready=!peer.makingOffer && (pc.signalingState==='stable'||peer.settingAnswer);
      const collision=description.type==='offer'&&!ready;
      peer.ignoreOffer=!peer.polite&&collision;
      if(peer.ignoreOffer)return;
      peer.settingAnswer=description.type==='answer';
      await pc.setRemoteDescription(description);
      peer.settingAnswer=false;
      if(description.type==='offer') {await pc.setLocalDescription();send('voice:signal',{to:sender,signal:{description:pc.localDescription}});}
      while(peer.iceQueue.length) { const c=peer.iceQueue.shift();await pc.addIceCandidate(c).catch(()=>{}); }
    }
    if(signal.candidate){
      if(!pc.remoteDescription){peer.iceQueue.push(signal.candidate);return;}
      await pc.addIceCandidate(signal.candidate).catch(err=>{if(!peer.ignoreOffer)console.warn('ice',err);});
    }
  }catch(err){console.warn('peer signaling',err);peer.settingAnswer=false;}
}
function closePeer(id) {const peer=peers.get(id);if(!peer)return;try{peer.pc.close();peer.audio?.remove();}catch{}peers.delete(id);}
async function toggleMic(){
  const live=micStream?.getAudioTracks()?.[0];
  if(live && live.readyState==='live') {
    for(const p of peers.values())await p.sender.replaceTrack(null).catch(()=>{});
    micStream.getTracks().forEach(t=>t.stop());micStream=null;
    send('voice:status',{enabled:false});renderMicButton();return;
  }
  if(!navigator.mediaDevices?.getUserMedia) {
    toast('المايك يحتاج رابط HTTPS آمن. انشر اللعبة على استضافة HTTPS ليعمل من كل جوال.');return;
  }
  try {
    const stream=await navigator.mediaDevices.getUserMedia({audio:{echoCancellation:true,noiseSuppression:true,autoGainControl:true},video:false});
    micStream=stream;
    for(const p of peers.values())await p.sender.replaceTrack(stream.getAudioTracks()[0]).catch(()=>{});
    send('voice:status',{enabled:true}); renderMicButton();
    toast('المايك شغّال 🎙️ الجميع يستطيع سماعك');
  }catch(err){
    const msg=err?.name==='NotAllowedError'?'اسمح للمتصفح باستخدام المايك من شريط العنوان':'تعذر تشغيل المايك، تأكد من إذن الميكروفون واتصال HTTPS';
    toast(msg);
  }
}
function renderMicButton(){
  const on=Boolean(micStream?.getAudioTracks()?.[0]?.readyState==='live');
  $('micBtn').classList.toggle('on',on);$('micIcon').textContent=on?'🎙️':'🎤';$('micLabel').textContent=on?'إيقاف المايك':'تشغيل المايك';
}
function bindUI(){
  $('copyRoomBtn').addEventListener('click',()=>room&&copyText(getInviteUrl()));
  $('endMatchBtn').addEventListener('click',()=>{
    if (room && isHost() && window.confirm('متأكد بدك تنهي المباراة وتعرض النتائج؟')) send('room:end');
  });
  $('shareBtn').addEventListener('click',async()=>{
    if(!room)return;
    const url=getInviteUrl();
    if(navigator.share){try{await navigator.share({title:'أساطير لايف',text:`ادخل معنا! كود الغرفة: ${room.code}`,url});return;}catch{}}
    copyText(url);
  });
  $('stage').addEventListener('click',e=>{
    const b=e.target.closest('[data-action]');if(!b)return;
    const action=b.dataset.action;
    if(action==='start')send('room:start');
    if(action==='truth'||action==='dare') {
      b.disabled=true;
      // Short flash before the secret writer's blackout scene.
      b.style.filter='brightness(1.65)';b.style.transform='scale(1.05)';
      send('game:pick',{category:action});
    }
    if(action==='copy')copyText(getInviteUrl());
  });
  $('rulingInput').addEventListener('input',()=>{$('judgeCounter').textContent=$('rulingInput').value.length+' / 220';});
  $('submitRuling').addEventListener('click',()=>{
    const ruling=$('rulingInput').value.trim();
    if(ruling.length<3){toast('اكتب حكماً من ٣ أحرف على الأقل');return;}
    send('game:submit',{ruling});
  });
  $('doneBtn').addEventListener('click',()=>send('game:complete',{result:'done'}));
  $('skipBtn').addEventListener('click',()=>send('game:complete',{result:'skip'}));
  $('chatForm').addEventListener('submit', e=>{
    e.preventDefault();const value=$('chatInput').value.trim();if(!value)return;
    if(send('room:chat',{text:value}))$('chatInput').value='';
  });
  document.querySelectorAll('[data-emoji]').forEach(btn=>btn.addEventListener('click',()=>send('room:chat',{text:btn.dataset.emoji})));
  $('chatToggle').addEventListener('click',()=>chatOpen?closeChat():openChat());
  $('closeChat').addEventListener('click',closeChat);
  $('chatBackdrop').addEventListener('click',closeChat);
  $('micBtn').addEventListener('click',toggleMic);
  $('speakerBtn').addEventListener('click',()=>{
    speakerMuted=!speakerMuted;
    for(const p of peers.values())if(p.audio)p.audio.muted=speakerMuted;
    $('speakerBtn').textContent=speakerMuted?'🔇':'🔊';
    $('speakerBtn').classList.toggle('off',speakerMuted);
    toast(speakerMuted?'تم كتم صوت الآخرين':'تم تشغيل صوت الآخرين');
  });
  document.addEventListener('keydown',e=>{if(e.key==='Escape')closeChat();});
  window.addEventListener('beforeunload',()=>{for(const p of peers.values())try{p.pc.close();}catch{}});
}
initEntry(); bindUI();renderMicButton();
