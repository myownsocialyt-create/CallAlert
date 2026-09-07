/*
 * Vehicle Call Alert — offline web UI.
 * All libraries are bundled with the app; nothing is loaded from the network at runtime.
 */
(function () {
  'use strict';

  /* ------------------------------------------------------------------ config */

  var KEY = {
    vehicles: 'vca_vehicles',
    logs: 'vca_logs',
    theme: 'vca_theme',
    link: 'vca_link_base'
  };

  var DEFAULT_LINK = 'https://datashield-cloud.github.io/Temp-call/';
  var PEER_PREFIX = 'vca-';
  var ICE_SERVERS = [
    { urls: ['stun:stun.l.google.com:19302', 'stun:stun1.l.google.com:19302'] }
  ];
  var CALL_TIMEOUT_MS = 35000;

  var bridge = window.AndroidBridge || null;

  /* ------------------------------------------------------------------ helpers */

  function $(id) { return document.getElementById(id); }
  function all(sel, root) { return Array.prototype.slice.call((root || document).querySelectorAll(sel)); }

  function load(key, fallback) {
    try {
      var raw = localStorage.getItem(key);
      if (!raw) return fallback;
      var value = JSON.parse(raw);
      return value === null || value === undefined ? fallback : value;
    } catch (e) {
      return fallback;
    }
  }

  function save(key, value) {
    try { localStorage.setItem(key, JSON.stringify(value)); } catch (e) { /* storage full */ }
  }

  var toastTimer = null;
  function toast(message) {
    var el = $('toast');
    el.textContent = message;
    el.classList.add('show');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(function () { el.classList.remove('show'); }, 2600);
  }

  function escapeHtml(text) {
    return String(text).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  }

  function normalizePlate(value) {
    return String(value || '').toUpperCase().replace(/[^A-Z0-9]/g, '');
  }

  function peerIdFor(number) { return PEER_PREFIX + number; }

  function two(n) { return (n < 10 ? '0' : '') + n; }

  function formatDuration(seconds) {
    var m = Math.floor(seconds / 60);
    var s = seconds % 60;
    return two(m) + ':' + two(s);
  }

  function formatWhen(ts) {
    var d = new Date(ts);
    var today = new Date();
    var sameDay = d.toDateString() === today.toDateString();
    var time = two(d.getHours()) + ':' + two(d.getMinutes());
    return sameDay ? 'Today ' + time : d.getDate() + '/' + (d.getMonth() + 1) + '/' + d.getFullYear() + ' ' + time;
  }

  /* ------------------------------------------------------------------ state */

  var vehicles = load(KEY.vehicles, []);
  var logs = load(KEY.logs, []);
  var theme = localStorage.getItem(KEY.theme) || 'system';
  var linkBase = localStorage.getItem(KEY.link) || DEFAULT_LINK;

  var hosts = {};            // vehicle number -> { peer, ready }
  var outgoingPeer = null;   // Peer used to place calls
  var localStream = null;    // microphone stream, only alive during a call
  var activeCall = null;     // { call, number, direction, connected, startedAt }
  var pendingIncoming = null;
  var callTimerId = null;
  var callTimeoutId = null;
  var muted = false;
  var speakerOn = true;
  var qrNumber = null;
  var cardNumber = null;

  /* ------------------------------------------------------------------ theme */

  var media = window.matchMedia ? window.matchMedia('(prefers-color-scheme: dark)') : null;

  function applyTheme(next) {
    theme = next;
    localStorage.setItem(KEY.theme, next);
    var dark = next === 'dark' || (next === 'system' && (!media || media.matches));
    document.documentElement.setAttribute('data-theme', dark ? 'dark' : 'light');
    var icon = $('themeIcon');
    if (dark) {
      icon.innerHTML = '<path d="M21 12.8A9 9 0 1 1 11.2 3a7 7 0 0 0 9.8 9.8z"/>';
    } else {
      icon.innerHTML = '<circle cx="12" cy="12" r="4.2"/><path d="M12 2v2M12 20v2M2 12h2M20 12h2M4.9 4.9l1.5 1.5M17.6 17.6l1.5 1.5M19.1 4.9l-1.5 1.5M6.4 17.6l-1.5 1.5"/>';
    }
    var select = $('themeSelect');
    if (select) select.value = next;
  }

  if (media && media.addEventListener) {
    media.addEventListener('change', function () { if (theme === 'system') applyTheme('system'); });
  }

  /* ------------------------------------------------------------------ navigation */

  var SECTIONS = ['garage', 'call', 'logs', 'howto', 'settings', 'privacy', 'about'];

  function showSection(name) {
    if (SECTIONS.indexOf(name) === -1) name = 'garage';
    SECTIONS.forEach(function (s) {
      var el = $('sec-' + s);
      if (el) el.classList.toggle('hidden', s !== name);
    });
    all('.nav-item').forEach(function (item) {
      item.classList.toggle('active', item.getAttribute('data-section') === name);
    });
    window.scrollTo(0, 0);
  }

  function setDrawer(open) {
    var drawer = $('drawer');
    drawer.classList.toggle('open', open);
    drawer.setAttribute('aria-hidden', open ? 'false' : 'true');
  }

  function openModal(id) { $(id).classList.add('open'); }
  function closeModal(id) { $(id).classList.remove('open'); }

  /* ------------------------------------------------------------------ microphone */

  function micUnavailableMessage() {
    return 'Microphone is not available. Allow microphone access in Android Settings to make calls.';
  }

  function getMicStream() {
    if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
      return Promise.reject(new Error('unsupported'));
    }
    return navigator.mediaDevices.getUserMedia({
      audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true },
      video: false
    });
  }

  function requestMicPermission() {
    return getMicStream().then(function (stream) {
      stream.getTracks().forEach(function (t) { t.stop(); });
      return true;
    }).catch(function () {
      toast(micUnavailableMessage());
      return false;
    });
  }

  function acquireStream() {
    if (localStream && localStream.active) return Promise.resolve(localStream);
    return getMicStream().then(function (stream) {
      localStream = stream;
      applyMute();
      return stream;
    }).catch(function () {
      toast(micUnavailableMessage());
      return null;
    });
  }

  function releaseStream() {
    if (localStream) {
      localStream.getTracks().forEach(function (t) { t.stop(); });
      localStream = null;
    }
    muted = false;
  }

  function applyMute() {
    if (!localStream) return;
    localStream.getAudioTracks().forEach(function (t) { t.enabled = !muted; });
  }

  /* ------------------------------------------------------------------ vehicles */

  function findVehicle(number) {
    for (var i = 0; i < vehicles.length; i++) {
      if (vehicles[i].number === number) return vehicles[i];
    }
    return null;
  }

  function isOnline(number) {
    return !!(hosts[number] && hosts[number].ready);
  }

  function addVehicle() {
    var number = normalizePlate($('newNumber').value);
    var type = $('newType').value;
    var nick = ($('newNick').value || '').trim() || type;

    if (number.length < 4) { toast('Enter a valid vehicle number (at least 4 characters).'); return; }
    if (number.length > 15) { toast('Vehicle number is too long.'); return; }
    if (findVehicle(number)) { toast('This vehicle is already in your garage.'); return; }

    vehicles.push({ number: number, type: type, nick: nick, createdAt: Date.now() });
    save(KEY.vehicles, vehicles);
    $('newNumber').value = '';
    $('newNick').value = '';
    renderVehicles();
    toast('Vehicle added.');
  }

  function deleteVehicle(number) {
    if (!window.confirm('Remove ' + number + ' from your garage?')) return;
    goOffline(number);
    vehicles = vehicles.filter(function (v) { return v.number !== number; });
    save(KEY.vehicles, vehicles);
    renderVehicles();
  }

  function renderVehicles() {
    var list = $('vehicleList');
    $('vehicleCount').textContent = String(vehicles.length);

    if (!vehicles.length) {
      list.innerHTML = '<div class="card"><div class="empty">No vehicles yet.<br>Add your car or bike above.</div></div>';
      return;
    }

    list.innerHTML = vehicles.map(function (v) {
      var online = isOnline(v.number);
      return '' +
        '<div class="card">' +
          '<div class="plate">' +
            '<div>' +
              '<div class="plate-meta">' + escapeHtml(v.type) + ' • ' + escapeHtml(v.nick) + '</div>' +
              '<div class="plate-number">' + escapeHtml(v.number) + '</div>' +
            '</div>' +
            '<span class="status-dot ' + (online ? 'online' : '') + '" title="' + (online ? 'Online' : 'Offline') + '"></span>' +
          '</div>' +
          '<div class="actions">' +
            '<button class="btn ' + (online ? 'btn-danger' : 'btn-success') + '" data-act="toggle" data-num="' + escapeHtml(v.number) + '">' +
              (online ? 'Go offline' : 'Go online') + '</button>' +
            '<button class="btn btn-ghost" data-act="qr" data-num="' + escapeHtml(v.number) + '">QR code</button>' +
            '<button class="btn btn-ghost" data-act="card" data-num="' + escapeHtml(v.number) + '">Windshield card</button>' +
            '<button class="btn btn-ghost" data-act="delete" data-num="' + escapeHtml(v.number) + '">Remove</button>' +
          '</div>' +
          (online
            ? '<p class="small mt8" style="color:var(--green)">Online — people can call this vehicle while the app is open.</p>'
            : '<p class="small muted mt8">Offline — go online so people can reach you.</p>') +
        '</div>';
    }).join('');
  }

  /* ------------------------------------------------------------------ presence (receiving calls) */

  function goOnline(number) {
    if (isOnline(number) || hosts[number]) return;
    if (!navigator.onLine) { toast('No internet connection.'); return; }
    if (typeof window.Peer !== 'function') { toast('Calling engine failed to load.'); return; }

    requestMicPermission().then(function (granted) {
      if (!granted) return;

      var peer = new window.Peer(peerIdFor(number), { debug: 0, config: { iceServers: ICE_SERVERS } });
      hosts[number] = { peer: peer, ready: false };

      peer.on('open', function () {
        if (!hosts[number]) return;
        hosts[number].ready = true;
        renderVehicles();
        toast(number + ' is online.');
      });

      peer.on('call', function (call) { handleIncoming(number, call); });

      peer.on('error', function (err) {
        var type = err && err.type ? err.type : '';
        if (type === 'unavailable-id') {
          toast('This vehicle number is already online on another device.');
        } else if (type === 'network' || type === 'server-error' || type === 'socket-error') {
          toast('Could not reach the calling service. Check your internet.');
        } else if (type === 'peer-unavailable') {
          return; // handled by the outgoing call flow
        } else {
          toast('Connection problem: ' + (type || 'unknown'));
        }
        cleanupHost(number);
      });

      peer.on('disconnected', function () {
        if (hosts[number] && !peer.destroyed) {
          try { peer.reconnect(); } catch (e) { /* ignore */ }
        }
      });

      peer.on('close', function () { cleanupHost(number); });
    });
  }

  function cleanupHost(number) {
    var host = hosts[number];
    if (!host) return;
    delete hosts[number];
    try { if (!host.peer.destroyed) host.peer.destroy(); } catch (e) { /* ignore */ }
    renderVehicles();
  }

  function goOffline(number) {
    if (!hosts[number]) return;
    cleanupHost(number);
    toast(number + ' is offline.');
  }

  function goOfflineAll() {
    Object.keys(hosts).forEach(cleanupHost);
  }

  /* ------------------------------------------------------------------ calls */

  function openCallUi(number, direction) {
    $('callTitle').textContent = number;
    $('callKicker').textContent = direction === 'incoming' ? 'Incoming call for' : 'Calling';
    $('callStatus').textContent = direction === 'incoming' ? 'Someone is calling about this vehicle' : 'Connecting…';
    $('callTimer').textContent = '00:00';
    $('callActions').classList.toggle('hidden', direction === 'incoming');
    $('incomingActions').classList.toggle('hidden', direction !== 'incoming');
    $('muteBtn').classList.remove('btn-active');
    $('muteBtn').textContent = 'Mute';
    $('speakerBtn').classList.toggle('hidden', !bridge || !bridge.setSpeakerphone);
    openModal('callModal');
    speakerOn = true;
    $('speakerBtn').textContent = 'Speaker';
    if (bridge && bridge.startCallAudio) { try { bridge.startCallAudio(); } catch (e) { /* ignore */ } }
  }

  function closeCallUi() {
    closeModal('callModal');
    if (bridge && bridge.stopCallAudio) { try { bridge.stopCallAudio(); } catch (e) { /* ignore */ } }
  }

  function startCallTimer() {
    stopCallTimer();
    callTimerId = setInterval(function () {
      if (!activeCall || !activeCall.startedAt) return;
      var secs = Math.floor((Date.now() - activeCall.startedAt) / 1000);
      $('callTimer').textContent = formatDuration(secs);
    }, 1000);
  }

  function stopCallTimer() {
    if (callTimerId) { clearInterval(callTimerId); callTimerId = null; }
  }

  function attachRemote(stream) {
    var audio = $('remoteAudio');
    audio.srcObject = stream;
    var playing = audio.play();
    if (playing && playing.catch) playing.catch(function () { /* autoplay guard */ });
  }

  function wireCall(call, number, direction) {
    activeCall = { call: call, number: number, direction: direction, connected: false, startedAt: 0 };

    callTimeoutId = setTimeout(function () {
      if (activeCall && !activeCall.connected) {
        finishCall(direction === 'outgoing' ? 'No answer' : 'Missed', 0);
      }
    }, CALL_TIMEOUT_MS);

    call.on('stream', function (remote) {
      if (!activeCall) return;
      clearTimeout(callTimeoutId);
      activeCall.connected = true;
      activeCall.startedAt = Date.now();
      attachRemote(remote);
      $('callStatus').textContent = 'Connected — HD voice';
      $('callActions').classList.remove('hidden');
      $('incomingActions').classList.add('hidden');
      startCallTimer();
    });

    call.on('close', function () { finishCall('Ended'); });

    call.on('error', function () { finishCall('Call failed'); });
  }

  function finishCall(reason, forcedDuration) {
    stopCallTimer();
    clearTimeout(callTimeoutId);

    if (activeCall) {
      var duration = typeof forcedDuration === 'number'
        ? forcedDuration
        : (activeCall.startedAt ? Math.floor((Date.now() - activeCall.startedAt) / 1000) : 0);

      addLog({
        number: activeCall.number,
        direction: activeCall.direction,
        status: activeCall.connected ? 'Answered' : reason,
        duration: duration,
        ts: Date.now()
      });

      try { activeCall.call.close(); } catch (e) { /* ignore */ }
      activeCall = null;
    }

    pendingIncoming = null;
    releaseStream();
    var audio = $('remoteAudio');
    audio.srcObject = null;
    closeCallUi();
    if (reason) toast(reason);
  }

  function handleIncoming(number, call) {
    if (activeCall || pendingIncoming) {
      try { call.close(); } catch (e) { /* ignore */ }
      addLog({ number: number, direction: 'incoming', status: 'Missed (busy)', duration: 0, ts: Date.now() });
      return;
    }
    pendingIncoming = { call: call, number: number };
    openCallUi(number, 'incoming');

    call.on('close', function () {
      if (pendingIncoming && pendingIncoming.call === call) {
        pendingIncoming = null;
        addLog({ number: number, direction: 'incoming', status: 'Missed', duration: 0, ts: Date.now() });
        closeCallUi();
      }
    });
  }

  function acceptIncoming() {
    if (!pendingIncoming) return;
    var incoming = pendingIncoming;
    pendingIncoming = null;

    acquireStream().then(function (stream) {
      if (!stream) {
        try { incoming.call.close(); } catch (e) { /* ignore */ }
        closeCallUi();
        return;
      }
      $('callStatus').textContent = 'Connecting…';
      $('callActions').classList.remove('hidden');
      $('incomingActions').classList.add('hidden');
      wireCall(incoming.call, incoming.number, 'incoming');
      incoming.call.answer(stream);
    });
  }

  function declineIncoming() {
    if (!pendingIncoming) return;
    var incoming = pendingIncoming;
    pendingIncoming = null;
    try { incoming.call.close(); } catch (e) { /* ignore */ }
    addLog({ number: incoming.number, direction: 'incoming', status: 'Declined', duration: 0, ts: Date.now() });
    closeCallUi();
  }

  function ensureOutgoingPeer() {
    return new Promise(function (resolve, reject) {
      if (outgoingPeer && !outgoingPeer.destroyed && outgoingPeer.open) {
        resolve(outgoingPeer);
        return;
      }
      if (outgoingPeer) {
        try { outgoingPeer.destroy(); } catch (e) { /* ignore */ }
        outgoingPeer = null;
      }
      if (typeof window.Peer !== 'function') { reject(new Error('engine')); return; }

      var peer = new window.Peer(undefined, { debug: 0, config: { iceServers: ICE_SERVERS } });
      var settled = false;

      peer.on('open', function () {
        settled = true;
        outgoingPeer = peer;
        resolve(peer);
      });

      peer.on('error', function (err) {
        var type = err && err.type ? err.type : '';
        if (!settled) {
          settled = true;
          reject(new Error(type || 'error'));
          return;
        }
        if (type === 'peer-unavailable') {
          finishCall('Vehicle is offline right now', 0);
        } else if (type === 'network' || type === 'server-error' || type === 'socket-error') {
          finishCall('Network problem — call failed', 0);
        }
      });

      peer.on('disconnected', function () {
        if (peer && !peer.destroyed) {
          try { peer.reconnect(); } catch (e) { /* ignore */ }
        }
      });

      setTimeout(function () {
        if (!settled) { settled = true; reject(new Error('timeout')); }
      }, 15000);
    });
  }

  function placeCall(rawNumber) {
    var number = normalizePlate(rawNumber);
    if (number.length < 4) { toast('Enter a valid vehicle number.'); return; }
    if (!navigator.onLine) { toast('No internet connection.'); return; }
    if (activeCall || pendingIncoming) { toast('A call is already in progress.'); return; }
    if (isOnline(number)) { toast('This is your own vehicle and it is online on this device.'); return; }

    openCallUi(number, 'outgoing');

    acquireStream().then(function (stream) {
      if (!stream) { closeCallUi(); return; }
      return ensureOutgoingPeer().then(function (peer) {
        var call = peer.call(peerIdFor(number), stream);
        if (!call) { finishCall('Could not start the call'); return; }
        wireCall(call, number, 'outgoing');
        $('callStatus').textContent = 'Ringing…';
      });
    }).catch(function (err) {
      var msg = err && err.message === 'timeout'
        ? 'Could not reach the calling service.'
        : 'Call failed. Please try again.';
      finishCall(msg, 0);
    });
  }

  function hangUp() {
    if (activeCall) {
      finishCall('Call ended');
    } else if (pendingIncoming) {
      declineIncoming();
    } else {
      closeCallUi();
    }
  }

  function toggleMute() {
    muted = !muted;
    applyMute();
    var btn = $('muteBtn');
    btn.textContent = muted ? 'Unmute' : 'Mute';
    btn.classList.toggle('btn-active', muted);
  }

  function toggleSpeaker() {
    speakerOn = !speakerOn;
    if (bridge && bridge.setSpeakerphone) {
      try { bridge.setSpeakerphone(speakerOn); } catch (e) { /* ignore */ }
    }
    var btn = $('speakerBtn');
    btn.textContent = speakerOn ? 'Speaker' : 'Earpiece';
    btn.classList.toggle('btn-active', !speakerOn);
  }

  /* ------------------------------------------------------------------ logs */

  function addLog(entry) {
    logs.unshift(entry);
    if (logs.length > 100) logs = logs.slice(0, 100);
    save(KEY.logs, logs);
    renderLogs();
  }

  function logRow(entry) {
    var icon = entry.direction === 'incoming' ? '&#8600;' : '&#8599;';
    var extra = entry.duration ? ' • ' + formatDuration(entry.duration) : '';
    return '' +
      '<div class="log-row">' +
        '<div class="log-icon">' + icon + '</div>' +
        '<div class="log-main">' +
          '<div class="log-title">' + escapeHtml(entry.number) + '</div>' +
          '<div class="log-sub">' + escapeHtml(entry.status) + extra + ' • ' + formatWhen(entry.ts) + '</div>' +
        '</div>' +
      '</div>';
  }

  function renderLogs() {
    var full = $('logList');
    var home = $('homeLogs');
    if (!logs.length) {
      full.innerHTML = '<div class="empty">No calls yet.</div>';
      home.innerHTML = '<div class="empty">No calls yet.</div>';
      return;
    }
    full.innerHTML = logs.map(logRow).join('');
    home.innerHTML = logs.slice(0, 3).map(logRow).join('');
  }

  function clearLogs() {
    if (!logs.length) return;
    if (!window.confirm('Clear the whole call history?')) return;
    logs = [];
    save(KEY.logs, logs);
    renderLogs();
    toast('Call history cleared.');
  }

  /* ------------------------------------------------------------------ QR + windshield card */

  function callLinkFor(number) {
    var base = (linkBase || DEFAULT_LINK).trim().replace(/[?&]+$/, '');
    var sep = base.indexOf('?') === -1 ? '?' : '&';
    return base + sep + 'v=' + encodeURIComponent(number);
  }

  function drawQr(canvas, text, quiet) {
    var ctx = canvas.getContext('2d');
    var qr = window.qrcode(0, 'M');
    qr.addData(text);
    qr.make();

    var count = qr.getModuleCount();
    var margin = typeof quiet === 'number' ? quiet : 4;
    var size = canvas.width;
    var cell = Math.floor(size / (count + margin * 2));
    var offset = Math.floor((size - cell * count) / 2);

    ctx.fillStyle = '#ffffff';
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    ctx.fillStyle = '#000000';
    for (var r = 0; r < count; r++) {
      for (var c = 0; c < count; c++) {
        if (qr.isDark(r, c)) {
          ctx.fillRect(offset + c * cell, offset + r * cell, cell, cell);
        }
      }
    }
  }

  function showQr(number) {
    qrNumber = number;
    $('qrNumber').textContent = number;
    drawQr($('qrCanvas'), callLinkFor(number));
    openModal('qrModal');
  }

  function roundRect(ctx, x, y, w, h, r) {
    ctx.beginPath();
    ctx.moveTo(x + r, y);
    ctx.arcTo(x + w, y, x + w, y + h, r);
    ctx.arcTo(x + w, y + h, x, y + h, r);
    ctx.arcTo(x, y + h, x, y, r);
    ctx.arcTo(x, y, x + w, y, r);
    ctx.closePath();
  }

  function drawCard(number) {
    var canvas = $('cardCanvas');
    var ctx = canvas.getContext('2d');
    var W = canvas.width;
    var H = canvas.height;

    ctx.fillStyle = '#ffffff';
    ctx.fillRect(0, 0, W, H);

    // border
    ctx.strokeStyle = '#111114';
    ctx.lineWidth = 14;
    ctx.strokeRect(7, 7, W - 14, H - 14);

    // header
    ctx.fillStyle = '#111114';
    ctx.fillRect(14, 14, W - 28, 110);
    ctx.fillStyle = '#ffffff';
    ctx.font = 'bold 52px Arial, sans-serif';
    ctx.textBaseline = 'middle';
    ctx.fillText('VEHICLE CALL ALERT', 44, 70);

    ctx.fillStyle = '#facc15';
    roundRect(ctx, W - 340, 38, 296, 62, 14);
    ctx.fill();
    ctx.fillStyle = '#111114';
    ctx.font = 'bold 34px Arial, sans-serif';
    ctx.textAlign = 'center';
    ctx.fillText('SCAN & CALL', W - 192, 70);
    ctx.textAlign = 'left';

    // QR
    var qrSize = 380;
    var qrCanvas = document.createElement('canvas');
    qrCanvas.width = qrSize;
    qrCanvas.height = qrSize;
    drawQr(qrCanvas, callLinkFor(number), 2);
    ctx.drawImage(qrCanvas, 56, 170, qrSize, qrSize);
    ctx.strokeStyle = '#111114';
    ctx.lineWidth = 6;
    ctx.strokeRect(56, 170, qrSize, qrSize);

    // text block
    var x = 490;
    ctx.fillStyle = '#111114';
    ctx.font = 'bold 40px "Courier New", monospace';
    ctx.fillText(number, x, 200);

    ctx.font = 'bold 68px Arial, sans-serif';
    ctx.fillText('NEED ME?', x, 275);
    ctx.fillText('SCAN & CALL!', x, 350);

    ctx.font = '30px Arial, sans-serif';
    ctx.fillStyle = '#333333';
    ctx.fillText('Blocked in? Wrong parking? Emergency?', x, 415);
    ctx.fillText('1. Scan the QR code', x, 462);
    ctx.fillText('2. Tap "Call owner"', x, 505);
    ctx.fillStyle = '#111114';
    ctx.font = 'bold 28px Arial, sans-serif';
    ctx.fillText('Private call — my number stays hidden.', x, 552);

    // footer
    ctx.fillStyle = '#facc15';
    ctx.fillRect(14, H - 104, W - 28, 90);
    ctx.fillStyle = '#111114';
    ctx.font = 'bold 40px Arial, sans-serif';
    ctx.textAlign = 'center';
    ctx.fillText('PLEASE CALL — I WILL MOVE MY VEHICLE ASAP', W / 2, H - 59);
    ctx.textAlign = 'left';
  }

  function showCard(number) {
    cardNumber = number;
    drawCard(number);
    openModal('cardModal');
  }

  function shareDataUrl(dataUrl, mime, fileName) {
    var base64 = dataUrl.substring(dataUrl.indexOf(',') + 1);
    if (bridge && bridge.shareFile) {
      try {
        bridge.shareFile(base64, mime, fileName);
        return;
      } catch (e) { /* fall through */ }
    }
    toast('Saving is only available inside the app.');
  }

  function shareQr() {
    if (!qrNumber) return;
    var canvas = document.createElement('canvas');
    canvas.width = 720;
    canvas.height = 720;
    drawQr(canvas, callLinkFor(qrNumber), 4);
    shareDataUrl(canvas.toDataURL('image/jpeg', 0.95), 'image/jpeg', 'vehicle-call-alert-qr-' + qrNumber + '.jpg');
  }

  function shareCardJpg() {
    if (!cardNumber) return;
    shareDataUrl($('cardCanvas').toDataURL('image/jpeg', 0.95), 'image/jpeg',
      'vehicle-call-alert-card-' + cardNumber + '.jpg');
  }

  function shareCardPdf() {
    if (!cardNumber) return;
    var jsPdfNs = window.jspdf;
    if (!jsPdfNs || !jsPdfNs.jsPDF) { toast('PDF export is unavailable.'); return; }
    try {
      var doc = new jsPdfNs.jsPDF({ orientation: 'landscape', unit: 'mm', format: 'a6' });
      var dataUrl = $('cardCanvas').toDataURL('image/jpeg', 0.95);
      doc.addImage(dataUrl, 'JPEG', 5, 5, 138, 95);
      var pdfUri = doc.output('datauristring');
      shareDataUrl(pdfUri, 'application/pdf', 'vehicle-call-alert-card-' + cardNumber + '.pdf');
    } catch (e) {
      toast('Could not create the PDF.');
    }
  }

  /* ------------------------------------------------------------------ settings */

  function saveSettings() {
    applyTheme($('themeSelect').value);
    var value = ($('linkBase').value || '').trim();
    if (value && !/^https:\/\/[^\s]+$/i.test(value)) {
      toast('The QR link must start with https://');
      return;
    }
    linkBase = value || DEFAULT_LINK;
    localStorage.setItem(KEY.link, linkBase);
    $('linkBase').value = linkBase;
    toast('Settings saved.');
  }

  function wipeData() {
    if (!window.confirm('Delete all vehicles, history and settings from this device?')) return;
    goOfflineAll();
    [KEY.vehicles, KEY.logs, KEY.link].forEach(function (k) {
      try { localStorage.removeItem(k); } catch (e) { /* ignore */ }
    });
    vehicles = [];
    logs = [];
    linkBase = DEFAULT_LINK;
    $('linkBase').value = linkBase;
    renderVehicles();
    renderLogs();
    toast('All app data deleted.');
  }

  /* ------------------------------------------------------------------ connectivity */

  function updateOnlineBanner() {
    $('offlineBanner').classList.toggle('hidden', navigator.onLine);
  }

  /* ------------------------------------------------------------------ native hooks */

  window.applyNativeInsets = function (top, bottom) {
    var root = document.documentElement;
    root.style.setProperty('--safe-top', (top || 0) + 'px');
    root.style.setProperty('--safe-bottom', (bottom || 0) + 'px');
  };

  window.onNativeBack = function () {
    if ($('callModal').classList.contains('open')) { hangUp(); return true; }
    if ($('qrModal').classList.contains('open')) { closeModal('qrModal'); return true; }
    if ($('cardModal').classList.contains('open')) { closeModal('cardModal'); return true; }
    if ($('drawer').classList.contains('open')) { setDrawer(false); return true; }
    return false;
  };

  /* ------------------------------------------------------------------ wiring */

  function bindEvents() {
    $('menuBtn').addEventListener('click', function () { setDrawer(true); });
    all('[data-close-drawer]').forEach(function (el) {
      el.addEventListener('click', function () { setDrawer(false); });
    });

    all('[data-section]').forEach(function (el) {
      el.addEventListener('click', function () {
        showSection(el.getAttribute('data-section'));
        setDrawer(false);
      });
    });

    all('[data-close-modal]').forEach(function (el) {
      el.addEventListener('click', function () { closeModal(el.getAttribute('data-close-modal')); });
    });

    $('themeBtn').addEventListener('click', function () {
      applyTheme(document.documentElement.getAttribute('data-theme') === 'dark' ? 'light' : 'dark');
    });

    $('addVehicleBtn').addEventListener('click', addVehicle);

    $('vehicleList').addEventListener('click', function (event) {
      var btn = event.target.closest('[data-act]');
      if (!btn) return;
      var number = btn.getAttribute('data-num');
      switch (btn.getAttribute('data-act')) {
        case 'toggle':
          if (hosts[number]) { goOffline(number); } else { goOnline(number); }
          break;
        case 'qr': showQr(number); break;
        case 'card': showCard(number); break;
        case 'delete': deleteVehicle(number); break;
        default: break;
      }
    });

    $('callBtn').addEventListener('click', function () { placeCall($('callNumber').value); });
    $('callNumber').addEventListener('keydown', function (e) {
      if (e.key === 'Enter') placeCall($('callNumber').value);
    });

    $('clearLogsBtn').addEventListener('click', clearLogs);

    $('hangupBtn').addEventListener('click', hangUp);
    $('muteBtn').addEventListener('click', toggleMute);
    $('speakerBtn').addEventListener('click', toggleSpeaker);
    $('acceptBtn').addEventListener('click', acceptIncoming);
    $('declineBtn').addEventListener('click', declineIncoming);

    $('shareQrBtn').addEventListener('click', shareQr);
    $('cardJpgBtn').addEventListener('click', shareCardJpg);
    $('cardPdfBtn').addEventListener('click', shareCardPdf);

    $('saveSettingsBtn').addEventListener('click', saveSettings);
    $('wipeBtn').addEventListener('click', wipeData);

    window.addEventListener('online', function () { updateOnlineBanner(); });
    window.addEventListener('offline', function () {
      updateOnlineBanner();
      if (activeCall) finishCall('Connection lost');
    });

    window.addEventListener('pagehide', function () {
      goOfflineAll();
      releaseStream();
    });
  }

  /* ------------------------------------------------------------------ init */

  function init() {
    applyTheme(theme);
    $('linkBase').value = linkBase;
    renderVehicles();
    renderLogs();
    updateOnlineBanner();
    bindEvents();
    showSection('garage');
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})();
