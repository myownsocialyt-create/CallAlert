/**
 * Vehicle Call Alert — wake-up server.
 *
 * A tiny Cloudflare Worker that turns "somebody scanned a QR code" into a high priority
 * Firebase push, so the Android app only has to run while a call is actually happening.
 *
 * Endpoints
 *   POST /register    { plate, token, platform }  -> remembers which phone owns a plate
 *   POST /unregister  { plate, token }            -> forgets it
 *   POST /peer        { plate, token, peerId }     -> the id the phone answers calls on
 *   POST /ring        { plate }                   -> wakes that phone ("ring" push)
 *   POST /cancel      { plate }                   -> caller gave up (missed-call push)
 *   GET  /status?plate=XX                         -> { reachable, peerId, awake }
 *   GET  /call?car_id=XX                          -> the ready-made call page (no website needed)
 *   GET  /health
 *   GET  /diag                                    -> self-check: KV bound? secret valid?
 *
 * Storage: one Workers KV namespace (free tier). Nothing personal is stored — only the
 * uppercase plate, the FCM token and a timestamp.
 */

const PLATE_RE = /^[A-Z0-9]{4,20}$/;
const RING_COOLDOWN_SECONDS = 4;
/** A published peer id is only meaningful while that socket is alive. */
const PEER_TTL_SECONDS = 150;
const TOKEN_TTL_SECONDS = 60 * 60 * 24 * 180; // re-registered by the app on every launch

export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    if (request.method === 'OPTIONS') {
      return cors(new Response(null, { status: 204 }), request, env);
    }

    try {
      switch (`${request.method} ${url.pathname}`) {
        case 'GET /call':
          return cors(page(), request, env);
        case 'GET /health':
          return cors(json({ ok: true, service: 'vehicle-call-alert-wake' }), request, env);
        case 'GET /diag':
          return cors(await diag(env), request, env);
        case 'GET /status':
          return cors(await status(url, env), request, env);
        case 'POST /register':
          return cors(await register(request, env), request, env);
        case 'POST /unregister':
          return cors(await unregister(request, env), request, env);
        case 'POST /peer':
          return cors(await peer(request, env), request, env);
        case 'POST /ring':
          return cors(await ring(request, env, 'ring'), request, env);
        case 'POST /cancel':
          return cors(await ring(request, env, 'cancel'), request, env);
        default:
          return cors(json({ ok: false, error: 'not_found' }, 404), request, env);
      }
    } catch (err) {
      return cors(json({ ok: false, error: 'server_error', detail: String(err && err.message) }, 500), request, env);
    }
  }
};

/* ------------------------------------------------------------------ handlers */

/*
 * The call page is served straight from the worker, so a vehicle owner does not have to run a
 * website at all: the QR code can point at <worker>/call?car_id=PLATE. The page talks to this
 * same origin, so there is nothing to configure and nothing that can drift out of date.
 * The HTML below is generated from server/website/index.html by tools/build-worker.py.
 */
const CALL_PAGE = `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>Vehicle Contact - Privacy Call</title>
<link href="https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700&family=JetBrains+Mono:wght@700&display=swap" rel="stylesheet">
<script src="https://unpkg.com/peerjs@1.5.2/dist/peerjs.min.js"></script>
<style>
:root{ --bg:#0a0a0b; --card:#17171a; --border:#27272a; --text:#fafafa; --muted:#a1a1aa; --green:#22c55e; --red:#ef4444; }
*{margin:0;padding:0;box-sizing:border-box}
body{font-family:'Inter',sans-serif;background:var(--bg);color:var(--text);min-height:100vh;display:flex;align-items:center;justify-content:center;padding:20px}
body::before{content:'';position:fixed;inset:0;background: radial-gradient(600px at 50% -10%, rgba(255,255,255,0.08), transparent), radial-gradient(800px at 90% 90%, rgba(120,119,198,0.15), transparent);pointer-events:none}
.card{width:100%;max-width:420px;background:linear-gradient(180deg, rgba(39,39,42,0.8), rgba(23,23,26,0.9));border:1px solid var(--border);border-radius:24px;padding:32px 28px;backdrop-filter:blur(20px);box-shadow:0 25px 50px -12px rgba(0,0,0,0.5);position:relative;z-index:1}
.header{text-align:center;margin-bottom:28px}
.logo{width:48px;height:48px;background:#fff;color:#000;border-radius:12px;display:inline-flex;align-items:center;justify-content:center;font-size:22px;margin-bottom:16px}
.header h1{font-size:20px;font-weight:600}
.header p{font-size:14px;color:var(--muted);margin-top:6px;line-height:1.5}
.plate-wrap{display:flex;justify-content:center;margin:24px 0}
.plate{background:#fff;color:#111;border-radius:10px;padding:14px 20px;display:flex;align-items:center;gap:12px;box-shadow:0 4px 12px rgba(0,0,0,0.2)}
.plate-flag{width:36px;height:42px;background:#1e40af;border-radius:4px;display:flex;flex-direction:column;align-items:center;justify-content:center;color:#fff;font-size:10px;font-weight:700}
.plate-number{font-family:'JetBrains Mono',monospace;font-weight:700;font-size:22px;letter-spacing:0.04em;min-width:160px;text-align:center}
.plate-dot{width:10px;height:10px;border-radius:50%;background:var(--green);box-shadow:0 0 0 4px rgba(34,197,94,0.2);transition:background .3s, box-shadow .3s}
.plate-dot.off{background:#52525b;box-shadow:0 0 0 4px rgba(82,82,91,0.2)}
.status-box{background:#09090b;border:1px solid var(--border);border-radius:16px;padding:16px;display:flex;align-items:center;gap:14px;margin:20px 0}
.status-box.hidden{display:none}
.status-icon{width:40px;height:40px;border-radius:50%;display:flex;align-items:center;justify-content:center;flex-shrink:0}
.status-icon.connecting{background:rgba(234,179,8,0.15);color:#eab308}
.status-icon.ringing{background:rgba(59,130,246,0.15);color:#3b82f6}
.status-icon.connected{background:rgba(34,197,94,0.15);color:var(--green)}
.status-icon.error{background:rgba(239,68,68,0.15);color:var(--red)}
.status-icon.waking{background:rgba(168,85,247,0.15);color:#a855f7}
.status-text h4{font-size:14px;font-weight:600}
.status-text p{font-size:12px;color:var(--muted);margin-top:2px}
.btn{width:100%;border:none;border-radius:14px;padding:16px;font-size:16px;font-weight:600;cursor:pointer;display:flex;align-items:center;justify-content:center;gap:10px}
.btn-primary{background:#fff;color:#000}
.btn-primary:disabled{opacity:0.5}
.btn-danger{background:var(--red);color:#fff}
.btn-secondary{background:#27272a;color:#fff;border:1px solid #3f3f46}
.controls{display:none;gap:12px;margin-top:16px}
.controls.active{display:flex}
.controls .btn{flex:1}
.input-group{margin:20px 0;display:none}
.input-group.active{display:block}
.input-group input{width:100%;background:#09090b;border:1px solid var(--border);border-radius:12px;padding:14px 16px;color:#fff;font-family:'JetBrains Mono';font-size:16px;outline:none}
</style>
</head>
<body>
<div class="card">
  <div class="header">
    <div class="logo">P</div>
    <h1>Contact Vehicle Owner</h1>
    <p>Privacy-first voice call. No phone numbers shared.</p>
  </div>
  <div class="plate-wrap">
    <div class="plate">
      <div class="plate-flag">IND</div>
      <div class="plate-number" id="carDisplay">-- -- ----</div>
      <div class="plate-dot" id="plateDot"></div>
    </div>
  </div>
  <div class="input-group" id="inputGroup">
    <input type="text" id="carInput" placeholder="UP16AB1234" />
  </div>
  <div class="status-box hidden" id="statusBox">
    <div class="status-icon" id="statusIcon">●</div>
    <div class="status-text">
      <h4 id="statusTitle">Idle</h4>
      <p id="statusDesc">Ready to call</p>
    </div>
    <div id="timer" style="font-family:JetBrains Mono;font-size:13px">00:00</div>
  </div>
  <button class="btn btn-primary" id="callBtn">📞 Call Vehicle Owner</button>
  <div class="controls" id="controls">
    <button class="btn btn-secondary" id="muteBtn">🎙️ Mute</button>
    <button class="btn btn-danger" id="endBtn">✕ End Call</button>
  </div>
  <audio id="remoteAudio" autoplay playsinline></audio>
</div>
<script>
/* =========================================================================
   CONFIG — paste your Cloudflare Worker URL here (no trailing slash).
   Leave it empty ('') and the page behaves exactly like before.
   ========================================================================= */
const WAKE_SERVER = location.origin;
/* ======================================================================= */

const $=id=>document.getElementById(id);
const carDisplay=$('carDisplay'), carInput=$('carInput'), inputGroup=$('inputGroup'), statusBox=$('statusBox'), statusIcon=$('statusIcon'), statusTitle=$('statusTitle'), statusDesc=$('statusDesc'), callBtn=$('callBtn'), controls=$('controls'), endBtn=$('endBtn'), muteBtn=$('muteBtn'), timerEl=$('timer'), remoteAudio=$('remoteAudio'), plateDot=$('plateDot');
let carId=null, peer=null, currentCall=null, localStream=null, timerInterval=null, seconds=0, isMuted=false;
let connected=false, cancelled=false, lastPeerError=null, attemptFail=null;

function getCarId(){ const p=new URLSearchParams(location.search); let id=p.get('car_id')||p.get('carId'); return id? id.trim().toUpperCase().replace(/[^A-Z0-9]/g,''): null; }
function setStatus(t,ti,d){ statusBox.classList.remove('hidden'); statusTitle.textContent=ti; statusDesc.textContent=d; statusIcon.className='status-icon '+t; }
function startTimer(){ seconds=0; timerInterval=setInterval(()=>{ seconds++; timerEl.textContent=\`\${String(Math.floor(seconds/60)).padStart(2,'0')}:\${String(seconds%60).padStart(2,'0')}\` },1000); }
function stopTimer(){ clearInterval(timerInterval); }
const sleep=ms=>new Promise(r=>setTimeout(r,ms));

/* ---------- wake-up server (optional) ---------- */
async function wakeServer(path, body){
  if(!WAKE_SERVER) return null;
  try{
    const r = await fetch(WAKE_SERVER+path,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(body)});
    return await r.json().catch(()=>({ok:r.ok}));
  }catch(e){ return null; }
}
async function checkReachable(plate){
  if(!WAKE_SERVER || !plate) return;
  try{
    const r = await fetch(\`\${WAKE_SERVER}/status?plate=\${encodeURIComponent(plate)}\`);
    const data = await r.json();
    plateDot.classList.toggle('off', !(data && data.reachable));
  }catch(e){ /* leave the dot as-is */ }
}

/* ---------- HD audio tuning (matches the app) ---------- */
function boostAudio(sdp){
  try{
    const lines=sdp.split('\\r\\n');
    let pt=null;
    for(const l of lines){ const m=l.match(/^a=rtpmap:(\\d+) opus\\/48000/i); if(m){ pt=m[1]; break; } }
    if(!pt) return sdp;
    const params='stereo=0;sprop-stereo=0;maxaveragebitrate=64000;maxplaybackrate=48000;useinbandfec=1;usedtx=0;cbr=0';
    let found=false;
    for(let i=0;i<lines.length;i++){ if(lines[i].startsWith('a=fmtp:'+pt)){ lines[i]='a=fmtp:'+pt+' '+params; found=true; } }
    if(!found){ for(let i=0;i<lines.length;i++){ if(lines[i].startsWith('a=rtpmap:'+pt)){ lines.splice(i+1,0,'a=fmtp:'+pt+' '+params); break; } } }
    return lines.join('\\r\\n');
  }catch(e){ return sdp; }
}
const CALL_OPTIONS={ sdpTransform: boostAudio };

/* ---------- calling ---------- */
const RING_WINDOW_MS = 60000;   // how long we keep ringing the owner
const WAKE_WAIT_MS   = 25000;   // how long we wait for the phone to come online
let signalConn=null, signalState='', callTarget=null, giveUp=null;

/** Asks the wake-up server where the phone is answering right now. */
async function livePeerId(){
  if(!WAKE_SERVER) return null;
  try{
    const r = await fetch(\`\${WAKE_SERVER}/status?plate=\${encodeURIComponent(carId)}\`,{cache:'no-store'});
    const d = await r.json();
    if(d && d.reachable) plateDot.classList.remove('off');
    return (d && d.awake && d.peerId) ? d.peerId : null;
  }catch(e){ return null; }
}

/** Waits until the owner's phone is connected to the call network. */
async function waitForPhone(untilMs){
  while(!cancelled && Date.now()<untilMs){
    const id = await livePeerId();
    if(id) return id;
    await sleep(1200);
  }
  return null;
}

/** Small data channel used only for call signalling, so we show the true state. */
function openSignal(target){
  return new Promise(resolve=>{
    let done=false;
    const finish=v=>{ if(!done){ done=true; resolve(v); } };
    let conn;
    try{ conn = peer.connect(target,{reliable:true, serialization:'json'}); }
    catch(e){ finish(null); return; }
    if(!conn){ finish(null); return; }

    const timer=setTimeout(()=>{ finish(null); }, 8000);
    conn.on('open',()=>{ clearTimeout(timer); signalConn=conn; finish(conn); });
    conn.on('error',()=>{ clearTimeout(timer); finish(null); });
    conn.on('data', msg=>{
      if(!msg || typeof msg!=='object') return;
      signalState = msg.t || '';
      if(msg.t==='ringing'){
        setStatus('ringing','Ringing...',\`The phone of \${carId} is ringing\`);
      }else if(msg.t==='answering'){
        setStatus('connecting','Answering...','Owner picked up, connecting audio');
      }else if(msg.t==='busy'){
        setStatus('error','Owner is busy','The owner is already on another call.');
        if(giveUp) giveUp('busy');
      }else if(msg.t==='declined'){
        setStatus('error','Call declined','The owner declined the call.');
        if(giveUp) giveUp('declined');
      }else if(msg.t==='ended' && !connected){
        setStatus('error','No answer','The owner did not pick up.');
        if(giveUp) giveUp('ended');
      }
    });
    conn.on('close',()=>{ if(signalConn===conn) signalConn=null; });
  });
}

function tellOwner(message){
  if(signalConn && signalConn.open){
    try{ signalConn.send(message); }catch(e){}
  }
}

/** Places the media call and keeps it ringing - it is never cancelled behind the owner's back. */
function placeCall(target, waitMs){
  return new Promise(resolve=>{
    let settled=false;
    const finish=v=>{ if(settled) return; settled=true; clearTimeout(timer); attemptFail=null; resolve(v); };
    attemptFail=()=>finish(false);          // peer-unavailable from the peer object
    giveUp=()=>{ try{ call && call.close(); }catch(e){} finish('stop'); };

    const call=peer.call(target, localStream, CALL_OPTIONS);
    if(!call){ finish(false); return; }
    currentCall=call;

    const timer=setTimeout(()=>{ try{ call.close(); }catch(e){} finish(false); }, waitMs);

    call.on('stream', s=>{
      connected=true; currentCall=call;
      remoteAudio.srcObject=s;
      remoteAudio.volume=1.0;
      remoteAudio.play().catch(()=>{});
      setStatus('connected','Connected','Talking now');
      callBtn.style.display='none'; controls.classList.add('active');
      startTimer();
      call.on('close', ()=>{ if(!cancelled){ setStatus('','Call Ended','Call finished'); } cleanup(); });
      finish(true);
    });
    call.on('error', ()=>finish(false));
    call.on('close', ()=>{ if(!connected) finish(false); });
  });
}

async function startCall(){
  if(!carId){ alert('Add ?car_id=UP16AB1234 to URL'); return; }
  connected=false; cancelled=false; lastPeerError=null; signalState=''; callTarget=null;
  try{
    callBtn.disabled=true; setStatus('connecting','Requesting mic','Please allow mic access...');
    localStream=await navigator.mediaDevices.getUserMedia({audio:{echoCancellation:true, noiseSuppression:true, autoGainControl:true, channelCount:1, sampleRate:48000}, video:false});

    // 1. wake the owner's phone (push) before dialling
    if(WAKE_SERVER){
      setStatus('waking','Waking the owner\\u2019s phone','Sending a notification to the vehicle owner...');
      const ring = await wakeServer('/ring',{plate:carId});
      if(ring && ring.ok===false && ring.error==='not_registered'){
        plateDot.classList.add('off');
        setStatus('error','Vehicle not registered','This vehicle is not set up in the Vehicle Call Alert app.');
        cleanup(); return;
      }
    }

    setStatus('connecting','Connecting...',\`Connecting to \${carId}\`);
    peer=new Peer();
    await new Promise((resolve,reject)=>{
      peer.on('open',resolve);
      peer.on('error',e=>{
        lastPeerError=e;
        if(e && e.type==='peer-unavailable'){ if(attemptFail) attemptFail(); return; } // app not up yet
        reject(e);
      });
      setTimeout(()=>reject(new Error('Signalling server timeout')),15000);
    });

    // 2. wait until the phone is actually listening, then dial exactly where it listens
    const deadline = Date.now()+RING_WINDOW_MS;
    if(WAKE_SERVER){
      setStatus('waking','Waking the owner\\u2019s phone','This takes a few seconds if the phone was asleep...');
      callTarget = await waitForPhone(Math.min(Date.now()+WAKE_WAIT_MS, deadline));
    }
    if(cancelled) return;
    if(!callTarget) callTarget = carId;   // older app builds answer on the plate itself

    // 3. handshake, then ring - and keep ringing while the owner walks to the phone
    setStatus('ringing','Ringing...',\`Calling owner of \${carId}\`);
    await openSignal(callTarget);
    if(cancelled) return;
    if(signalConn){ setStatus('ringing','Ringing...',\`The phone of \${carId} is ringing\`); }

    while(!connected && !cancelled && Date.now()<deadline){
      const left = deadline-Date.now();
      // With a live handshake the phone is definitely there: give the owner the full window.
      const result = await placeCall(callTarget, signalConn ? left : Math.min(6000,left));
      if(result===true || result==='stop' || cancelled) break;
      await sleep(800);
      if(!connected && !cancelled && WAKE_SERVER){
        const fresh = await livePeerId();
        if(fresh && fresh!==callTarget){ callTarget=fresh; await openSignal(callTarget); }
      }
    }

    if(!connected && !cancelled && !['declined','busy','ended'].includes(signalState)){
      await wakeServer('/cancel',{plate:carId});
      setStatus('error','No answer', WAKE_SERVER
        ? 'The owner did not pick up \\u2014 a missed call notification was sent.'
        : 'Owner app not active.');
    }
    if(!connected) cleanup();
  }catch(e){
    const msg = (e && e.name==='NotAllowedError') ? 'Allow mic'
              : (e && e.name==='NotFoundError') ? 'No mic'
              : (e && e.message) ? e.message : 'Call failed';
    setStatus('error','Call failed', msg);
    cleanup();
  }
}

function cleanup(){
  stopTimer(); callBtn.disabled=false; callBtn.style.display='flex'; controls.classList.remove('active');
  if(currentCall){ try{currentCall.close()}catch(e){} }
  if(signalConn){ try{signalConn.close()}catch(e){} }
  if(localStream){ localStream.getTracks().forEach(t=>t.stop()); }
  if(peer){ try{peer.destroy()}catch(e){} }
  currentCall=localStream=peer=null; signalConn=null; connected=false; attemptFail=null; giveUp=null;
}

function init(){
  carId=getCarId();
  if(carId){ carDisplay.textContent=carId; checkReachable(carId); }
  else{
    inputGroup.classList.add('active'); carDisplay.textContent='NO ID';
    carInput.addEventListener('input',()=>{ const v=carInput.value.toUpperCase().replace(/[^A-Z0-9]/g,''); carId=v; carDisplay.textContent=v||'NO ID'; });
    carInput.addEventListener('change',()=>checkReachable(carId));
  }
}

callBtn.addEventListener('click',startCall);
endBtn.addEventListener('click',()=>{
  cancelled=true;
  tellOwner({t:'cancel'});
  if(giveUp) giveUp('cancel');
  if(!connected && carId){ wakeServer('/cancel',{plate:carId}); }
  if(currentCall){ try{currentCall.close()}catch(e){} }
  setStatus('','Call Ended','Ended'); cleanup();
});
muteBtn.addEventListener('click',()=>{ if(!localStream)return; isMuted=!isMuted; localStream.getAudioTracks().forEach(t=>t.enabled=!isMuted); muteBtn.textContent=isMuted?'🔇 Unmute':'🎙️ Mute'; });
window.addEventListener('beforeunload',()=>{ if(!connected && carId && !cancelled){ tellOwner({t:'cancel'}); wakeServer('/cancel',{plate:carId}); } });
init();
</script>
</body>
</html>
`;

function page() {
  return new Response(CALL_PAGE, {
    headers: {
      'Content-Type': 'text/html; charset=utf-8',
      'Cache-Control': 'no-store',
      'X-Content-Type-Options': 'nosniff'
    }
  });
}

async function register(request, env) {
  const body = await readJson(request);
  const plate = normalizePlate(body.plate);
  const token = String(body.token || '').trim();

  if (!plate) return json({ ok: false, error: 'bad_plate' }, 400);
  if (token.length < 20 || token.length > 4096) return json({ ok: false, error: 'bad_token' }, 400);

  await env.TOKENS.put(
    `plate:${plate}`,
    JSON.stringify({ token, platform: String(body.platform || 'android'), updated: Date.now() }),
    { expirationTtl: TOKEN_TTL_SECONDS }
  );
  return json({ ok: true, plate });
}

async function unregister(request, env) {
  const body = await readJson(request);
  const plate = normalizePlate(body.plate);
  if (!plate) return json({ ok: false, error: 'bad_plate' }, 400);

  const record = await readRecord(env, plate);
  // Only the phone that owns the registration may remove it.
  if (record && body.token && record.token !== body.token) {
    return json({ ok: true, plate, kept: true });
  }
  await env.TOKENS.delete(`plate:${plate}`);
  await env.TOKENS.delete(`peer:${plate}`);
  return json({ ok: true, plate });
}

/**
 * The phone tells us which PeerJS id it is listening on. It usually registers under the plate
 * itself, but when the broker still holds a stale socket for that id the app takes a random
 * one - publishing it here is what keeps calls connecting instead of ringing into the void.
 */
async function peer(request, env) {
  const body = await readJson(request);
  const plate = normalizePlate(body.plate);
  const peerId = String(body.peerId || '').trim().replace(/[^A-Za-z0-9_-]/g, '').slice(0, 64);
  const token = String(body.token || '').trim();
  if (!plate) return json({ ok: false, error: 'bad_plate' }, 400);

  const record = await readRecord(env, plate);
  if (record && token && record.token !== token) {
    // Somebody else's phone must not move a plate's calls to its own peer id.
    return json({ ok: false, error: 'not_owner' }, 403);
  }

  if (!peerId) {
    await env.TOKENS.delete(`peer:${plate}`);
    return json({ ok: true, plate, cleared: true });
  }

  await env.TOKENS.put(
    `peer:${plate}`,
    JSON.stringify({ peerId, ts: Date.now() }),
    { expirationTtl: PEER_TTL_SECONDS }
  );
  return json({ ok: true, plate, peerId });
}

/** Self-check used during setup: reports which pieces are configured, without leaking them. */
async function diag(env) {
  const result = { ok: false, kv: false, secret: false, project_id: null, google_auth: null };

  try {
    await env.TOKENS.get('diag:probe');
    result.kv = true;
  } catch (err) {
    result.kv_error = 'KV namespace binding "TOKENS" is missing (Settings -> Bindings)';
  }

  let account = null;
  try {
    account = serviceAccount(env);
    result.secret = true;
    result.project_id = account.project_id || null;
  } catch (err) {
    result.secret_error = 'Secret "FIREBASE_SERVICE_ACCOUNT" is missing or is not valid JSON';
  }

  if (account && result.kv) {
    try {
      await accessTokenFor(env, account);
      result.google_auth = 'ok';
    } catch (err) {
      result.google_auth = String(err && err.message).slice(0, 200);
    }
  }

  result.ok = result.kv && result.secret && result.google_auth === 'ok';
  result.next_step = result.ok
    ? 'Everything is ready - send this worker URL back to the developer.'
    : (!result.kv ? 'Add the KV binding named TOKENS, then Deploy again.'
      : !result.secret ? 'Add the secret FIREBASE_SERVICE_ACCOUNT, then Deploy again.'
        : 'Check that the pasted service-account JSON is the complete file.');
  return json(result);
}

async function status(url, env) {
  const plate = normalizePlate(url.searchParams.get('plate'));
  if (!plate) return json({ ok: false, error: 'bad_plate' }, 400);
  const record = await readRecord(env, plate);
  const live = await readPeer(env, plate);
  return json({
    ok: true,
    plate,
    reachable: !!record,
    // "awake" means the phone is connected to the signalling network right now.
    awake: !!live,
    peerId: live ? live.peerId : null,
    peerAge: live ? Math.round((Date.now() - (live.ts || 0)) / 1000) : null
  });
}

async function ring(request, env, type) {
  const body = await readJson(request);
  const plate = normalizePlate(body.plate);
  if (!plate) return json({ ok: false, error: 'bad_plate' }, 400);

  const record = await readRecord(env, plate);
  if (!record) {
    // Nobody registered this plate: the owner never turned the vehicle online.
    return json({ ok: false, error: 'not_registered', reachable: false }, 404);
  }

  if (type === 'ring') {
    const cooldownKey = `cooldown:${plate}`;
    if (await env.TOKENS.get(cooldownKey)) {
      return json({ ok: true, plate, throttled: true });
    }
    await env.TOKENS.put(cooldownKey, '1', { expirationTtl: RING_COOLDOWN_SECONDS });
  }

  const result = await sendPush(env, record.token, {
    type,
    plate,
    ts: String(Date.now())
  });

  if (result.unregistered) {
    await env.TOKENS.delete(`plate:${plate}`);
    await env.TOKENS.delete(`peer:${plate}`);
    return json({ ok: false, error: 'not_registered', reachable: false }, 404);
  }
  if (!result.ok) {
    return json({ ok: false, error: 'push_failed', detail: result.detail }, 502);
  }
  return json({ ok: true, plate, sent: true });
}

/* ------------------------------------------------------------------ Firebase */

async function sendPush(env, token, data) {
  const account = serviceAccount(env);
  const accessToken = await accessTokenFor(env, account);

  const response = await fetch(
    `https://fcm.googleapis.com/v1/projects/${account.project_id}/messages:send`,
    {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${accessToken}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        message: {
          token,
          data,
          android: {
            priority: 'HIGH',
            ttl: '120s'
          }
        }
      })
    }
  );

  if (response.ok) {
    return { ok: true };
  }
  const detail = await response.text();
  const unregistered =
    response.status === 404 ||
    detail.includes('UNREGISTERED') ||
    detail.includes('INVALID_ARGUMENT');
  return { ok: false, unregistered, detail: detail.slice(0, 300) };
}

function serviceAccount(env) {
  if (!env.FIREBASE_SERVICE_ACCOUNT) {
    throw new Error('FIREBASE_SERVICE_ACCOUNT secret is missing');
  }
  return typeof env.FIREBASE_SERVICE_ACCOUNT === 'string'
    ? JSON.parse(env.FIREBASE_SERVICE_ACCOUNT)
    : env.FIREBASE_SERVICE_ACCOUNT;
}

/** OAuth2 access token for the FCM HTTP v1 API, cached in KV for 50 minutes. */
async function accessTokenFor(env, account) {
  const cached = await env.TOKENS.get('oauth:access_token');
  if (cached) {
    return cached;
  }

  const now = Math.floor(Date.now() / 1000);
  const claim = {
    iss: account.client_email,
    scope: 'https://www.googleapis.com/auth/firebase.messaging',
    aud: 'https://oauth2.googleapis.com/token',
    iat: now,
    exp: now + 3600
  };

  const header = { alg: 'RS256', typ: 'JWT' };
  const unsigned = `${base64url(JSON.stringify(header))}.${base64url(JSON.stringify(claim))}`;
  const key = await importPrivateKey(account.private_key);
  const signature = await crypto.subtle.sign(
    'RSASSA-PKCS1-v1_5',
    key,
    new TextEncoder().encode(unsigned)
  );
  const jwt = `${unsigned}.${base64urlBytes(new Uint8Array(signature))}`;

  const response = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer',
      assertion: jwt
    })
  });

  if (!response.ok) {
    throw new Error(`oauth failed: ${(await response.text()).slice(0, 200)}`);
  }
  const payload = await response.json();
  await env.TOKENS.put('oauth:access_token', payload.access_token, { expirationTtl: 3000 });
  return payload.access_token;
}

async function importPrivateKey(pem) {
  const body = pem
    .replace('-----BEGIN PRIVATE KEY-----', '')
    .replace('-----END PRIVATE KEY-----', '')
    .replace(/\s+/g, '');
  const binary = Uint8Array.from(atob(body), c => c.charCodeAt(0));
  return crypto.subtle.importKey(
    'pkcs8',
    binary.buffer,
    { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' },
    false,
    ['sign']
  );
}

/* ------------------------------------------------------------------ helpers */

async function readRecord(env, plate) {
  const raw = await env.TOKENS.get(`plate:${plate}`);
  if (!raw) return null;
  try {
    return JSON.parse(raw);
  } catch (e) {
    return null;
  }
}

async function readPeer(env, plate) {
  const raw = await env.TOKENS.get(`peer:${plate}`);
  if (!raw) return null;
  try {
    const value = JSON.parse(raw);
    return value && value.peerId ? value : null;
  } catch (e) {
    return null;
  }
}

async function readJson(request) {
  try {
    return await request.json();
  } catch (e) {
    return {};
  }
}

function normalizePlate(value) {
  const plate = String(value || '').toUpperCase().replace(/[^A-Z0-9]/g, '');
  return PLATE_RE.test(plate) ? plate : '';
}

function json(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' }
  });
}

function cors(response, request, env) {
  const allowed = (env.ALLOWED_ORIGINS || '*').split(',').map(s => s.trim());
  const origin = request.headers.get('Origin') || '';
  const value = allowed.includes('*') ? '*' : (allowed.includes(origin) ? origin : allowed[0] || '');

  const headers = new Headers(response.headers);
  headers.set('Access-Control-Allow-Origin', value);
  headers.set('Access-Control-Allow-Methods', 'GET,POST,OPTIONS');
  headers.set('Access-Control-Allow-Headers', 'Content-Type');
  headers.set('Access-Control-Max-Age', '86400');
  return new Response(response.body, { status: response.status, headers });
}

function base64url(text) {
  return base64urlBytes(new TextEncoder().encode(text));
}

function base64urlBytes(bytes) {
  let binary = '';
  for (let i = 0; i < bytes.length; i++) {
    binary += String.fromCharCode(bytes[i]);
  }
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}
