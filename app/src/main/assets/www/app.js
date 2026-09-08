/*
 * Vehicle Call Alert — UI layer.
 *
 * Calling and presence run natively in CallService (so they keep working when the app is
 * closed); this file only renders state and sends commands through AndroidBridge.
 * When opened in a plain browser it falls back to localStorage so the UI stays testable.
 */
(function () {
  'use strict';

  var DEFAULT_LINK = 'https://datashield-cloud.github.io/Temp-call/';
  var DEFAULT_SERVER = 'https://vehicle-alert.techeditz8.workers.dev';
  var LS_KEY = 'vca_web_state';

  var bridge = window.AndroidBridge || null;

  var state = {
    vehicles: [],
    logs: [],
    online: [],
    settings: {},
    env: { app: false, mic: false, notifications: false, batteryUnrestricted: false },
    call: { state: 'idle', number: '' }
  };

  var qrNumber = null;
  var cardNumber = null;

  /* ------------------------------------------------------------------ helpers */

  function $(id) { return document.getElementById(id); }
  function all(sel, root) { return Array.prototype.slice.call((root || document).querySelectorAll(sel)); }

  var toastTimer = null;
  function toast(message) {
    var el = $('toast');
    el.textContent = message;
    el.classList.add('show');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(function () { el.classList.remove('show'); }, 2800);
  }

  function escapeHtml(text) {
    return String(text).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  }

  function normalizePlate(value) {
    return String(value || '').toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 20);
  }

  function two(n) { return (n < 10 ? '0' : '') + n; }

  function formatDuration(seconds) {
    seconds = Math.max(0, Math.floor(seconds || 0));
    return two(Math.floor(seconds / 60)) + ':' + two(seconds % 60);
  }

  function formatWhen(ts) {
    var d = new Date(ts);
    var sameDay = d.toDateString() === new Date().toDateString();
    var time = two(d.getHours()) + ':' + two(d.getMinutes());
    return sameDay ? 'Today ' + time
      : d.getDate() + '/' + (d.getMonth() + 1) + '/' + d.getFullYear() + ' ' + time;
  }

  /* ------------------------------------------------------------------ state */

  function normalizeState(raw) {
    var next = raw && typeof raw === 'object' ? raw : {};
    state.vehicles = Array.isArray(next.vehicles) ? next.vehicles : [];
    state.logs = Array.isArray(next.logs) ? next.logs : [];
    state.online = Array.isArray(next.online) ? next.online : [];
    state.settings = next.settings && typeof next.settings === 'object' ? next.settings : {};
    state.call = next.call && typeof next.call === 'object' ? next.call : { state: 'idle', number: '' };
    state.env = next.env && typeof next.env === 'object'
      ? next.env
      : { app: !!bridge, mic: false, notifications: false, batteryUnrestricted: false };
    if (!state.settings.link) { state.settings.link = DEFAULT_LINK; }
    if (!state.settings.theme) { state.settings.theme = 'system'; }
    if (typeof state.settings.server !== 'string') { state.settings.server = DEFAULT_SERVER; }
  }

  function loadState() {
    if (bridge && bridge.getState) {
      try {
        normalizeState(JSON.parse(bridge.getState()));
        return;
      } catch (e) { /* fall through to browser storage */ }
    }
    try {
      normalizeState(JSON.parse(localStorage.getItem(LS_KEY) || '{}'));
    } catch (e) {
      normalizeState({});
    }
  }

  function persistVehicles() {
    if (bridge && bridge.saveVehicles) {
      bridge.saveVehicles(JSON.stringify(state.vehicles));
    } else {
      saveLocal();
    }
  }

  function persistSettings() {
    if (bridge && bridge.saveSettings) {
      bridge.saveSettings(JSON.stringify(state.settings));
    } else {
      saveLocal();
    }
  }

  function saveLocal() {
    try {
      localStorage.setItem(LS_KEY, JSON.stringify({
        vehicles: state.vehicles, logs: state.logs, online: state.online, settings: state.settings
      }));
    } catch (e) { /* ignore */ }
  }

  window.onNativeState = function (json) {
    try {
      normalizeState(JSON.parse(json));
      renderAll();
    } catch (e) { /* ignore malformed payloads */ }
  };

  /* ------------------------------------------------------------------ theme */

  var media = window.matchMedia ? window.matchMedia('(prefers-color-scheme: dark)') : null;

  function applyTheme(next) {
    state.settings.theme = next;
    var dark = next === 'dark' || (next === 'system' && (!media || media.matches));
    document.documentElement.setAttribute('data-theme', dark ? 'dark' : 'light');
    var icon = $('themeIcon');
    icon.innerHTML = dark
      ? '<path d="M21 12.8A9 9 0 1 1 11.2 3a7 7 0 0 0 9.8 9.8z"/>'
      : '<circle cx="12" cy="12" r="4.2"/><path d="M12 2v2M12 20v2M2 12h2M20 12h2M4.9 4.9l1.5 1.5M17.6 17.6l1.5 1.5M19.1 4.9l-1.5 1.5M6.4 17.6l-1.5 1.5"/>';
    var select = $('themeSelect');
    if (select) { select.value = next; }
  }

  if (media && media.addEventListener) {
    media.addEventListener('change', function () {
      if (state.settings.theme === 'system') { applyTheme('system'); }
    });
  }

  /* ------------------------------------------------------------------ navigation */

  var SECTIONS = ['garage', 'call', 'logs', 'howto', 'settings', 'privacy', 'about'];

  function showSection(name) {
    if (SECTIONS.indexOf(name) === -1) { name = 'garage'; }
    SECTIONS.forEach(function (s) {
      var el = $('sec-' + s);
      if (el) { el.classList.toggle('hidden', s !== name); }
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

  /* ------------------------------------------------------------------ vehicles */

  function findVehicle(number) {
    for (var i = 0; i < state.vehicles.length; i++) {
      if (state.vehicles[i].number === number) { return state.vehicles[i]; }
    }
    return null;
  }

  function isOnline(number) {
    return state.online.indexOf(number) !== -1;
  }

  function addVehicle() {
    var number = normalizePlate($('newNumber').value);
    var type = $('newType').value;
    var nick = ($('newNick').value || '').trim() || type;

    if (number.length < 4) { toast('Enter a valid vehicle number (at least 4 characters).'); return; }
    if (findVehicle(number)) { toast('This vehicle is already in your garage.'); return; }

    state.vehicles.push({ number: number, type: type, nick: nick, createdAt: Date.now() });
    persistVehicles();
    $('newNumber').value = '';
    $('newNick').value = '';
    renderVehicles();

    // Go online straight away: the user should never have to switch it on again.
    if (bridge && bridge.goOnline) {
      bridge.goOnline(number);
      toast('Vehicle added — going online.');
    } else {
      toast('Vehicle added.');
    }
  }

  function deleteVehicle(number) {
    if (!window.confirm('Remove ' + number + ' from your garage?')) { return; }
    if (isOnline(number) && bridge && bridge.goOffline) { bridge.goOffline(number); }
    state.vehicles = state.vehicles.filter(function (v) { return v.number !== number; });
    state.online = state.online.filter(function (n) { return n !== number; });
    persistVehicles();
    renderVehicles();
  }

  function toggleOnline(number) {
    if (!bridge) {
      toast('Going online only works inside the Android app.');
      return;
    }
    if (isOnline(number)) {
      bridge.goOffline(number);
      toast(number + ' will go offline.');
    } else {
      bridge.goOnline(number);
      toast('Connecting ' + number + '…');
    }
  }

  function renderVehicles() {
    var list = $('vehicleList');
    $('vehicleCount').textContent = String(state.vehicles.length);

    if (!state.vehicles.length) {
      list.innerHTML = '<div class="card"><div class="empty">No vehicles yet.<br>Add your car or bike above.</div></div>';
      return;
    }

    list.innerHTML = state.vehicles.map(function (v) {
      var online = isOnline(v.number);
      return '' +
        '<div class="card">' +
          '<div class="plate">' +
            '<div>' +
              '<div class="plate-meta">' + escapeHtml(v.type || '') + ' • ' + escapeHtml(v.nick || '') + '</div>' +
              '<div class="plate-number">' + escapeHtml(v.number) + '</div>' +
            '</div>' +
            '<span class="status-dot ' + (online ? 'online' : '') + '"></span>' +
          '</div>' +
          '<div class="actions">' +
            '<button class="btn ' + (online ? 'btn-danger' : 'btn-success') + '" data-act="toggle" data-num="' + escapeHtml(v.number) + '">' +
              (online ? 'Go offline' : 'Go online') + '</button>' +
            '<button class="btn btn-ghost" data-act="qr" data-num="' + escapeHtml(v.number) + '">QR code</button>' +
            '<button class="btn btn-ghost" data-act="card" data-num="' + escapeHtml(v.number) + '">Windshield card</button>' +
            '<button class="btn btn-ghost" data-act="delete" data-num="' + escapeHtml(v.number) + '">Remove</button>' +
          '</div>' +
          (online
            ? '<p class="small mt8" style="color:var(--green)">Online — stays online in the background and after a restart, until you tap “Go offline”.</p>'
            : '<p class="small muted mt8">Offline — go online so people can reach you.</p>') +
        '</div>';
    }).join('');
  }

  /* ------------------------------------------------------------------ logs */

  function logRow(entry) {
    var icon = entry.direction === 'incoming' ? '&#8600;' : '&#8599;';
    var extra = entry.duration ? ' • ' + formatDuration(entry.duration) : '';
    return '' +
      '<div class="log-row">' +
        '<div class="log-icon">' + icon + '</div>' +
        '<div class="log-main">' +
          '<div class="log-title">' + escapeHtml(entry.number || '') + '</div>' +
          '<div class="log-sub">' + escapeHtml(entry.status || '') + extra + ' • ' + formatWhen(entry.ts) + '</div>' +
        '</div>' +
      '</div>';
  }

  function renderLogs() {
    var full = $('logList');
    var home = $('homeLogs');
    if (!state.logs.length) {
      full.innerHTML = '<div class="empty">No calls yet.</div>';
      home.innerHTML = '<div class="empty">No calls yet.</div>';
      return;
    }
    full.innerHTML = state.logs.map(logRow).join('');
    home.innerHTML = state.logs.slice(0, 3).map(logRow).join('');
  }

  function clearLogs() {
    if (!state.logs.length) { return; }
    if (!window.confirm('Clear the whole call history?')) { return; }
    state.logs = [];
    if (bridge && bridge.clearLogs) { bridge.clearLogs(); } else { saveLocal(); }
    renderLogs();
    toast('Call history cleared.');
  }

  /* ------------------------------------------------------------------ QR + card */

  function callLinkFor(number) {
    var base = (state.settings.link || DEFAULT_LINK).trim().replace(/[?&]+$/, '');
    var sep = base.indexOf('?') === -1 ? '?' : '&';
    // The public landing page reads ?car_id=…
    return base + sep + 'car_id=' + encodeURIComponent(number);
  }

  function drawQr(canvas, text, quiet) {
    var ctx = canvas.getContext('2d');
    var qr = window.qrcode(0, 'M');
    qr.addData(text);
    qr.make();

    var count = qr.getModuleCount();
    var margin = typeof quiet === 'number' ? quiet : 4;
    var cell = Math.floor(canvas.width / (count + margin * 2));
    var offset = Math.floor((canvas.width - cell * count) / 2);

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

    ctx.strokeStyle = '#111114';
    ctx.lineWidth = 14;
    ctx.strokeRect(7, 7, W - 14, H - 14);

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

    var qrSize = 380;
    var qrCanvas = document.createElement('canvas');
    qrCanvas.width = qrSize;
    qrCanvas.height = qrSize;
    drawQr(qrCanvas, callLinkFor(number), 2);
    ctx.drawImage(qrCanvas, 56, 170, qrSize, qrSize);
    ctx.strokeStyle = '#111114';
    ctx.lineWidth = 6;
    ctx.strokeRect(56, 170, qrSize, qrSize);

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
    ctx.fillText('2. Tap "Call Vehicle Owner"', x, 505);
    ctx.fillStyle = '#111114';
    ctx.font = 'bold 28px Arial, sans-serif';
    ctx.fillText('Private call — my number stays hidden.', x, 552);

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

  function base64Of(dataUrl) {
    return dataUrl.substring(dataUrl.indexOf(',') + 1);
  }

  function shareDataUrl(dataUrl, mime, fileName) {
    if (bridge && bridge.shareFile) {
      bridge.shareFile(base64Of(dataUrl), mime, fileName);
      return;
    }
    toast('Saving is only available inside the app.');
  }

  function printDataUrl(dataUrl, jobName) {
    if (bridge && bridge.printImage) {
      bridge.printImage(base64Of(dataUrl), jobName);
      return;
    }
    toast('Printing is only available inside the app.');
  }

  function qrExportCanvas() {
    var canvas = document.createElement('canvas');
    canvas.width = 900;
    canvas.height = 900;
    drawQr(canvas, callLinkFor(qrNumber), 4);
    return canvas;
  }

  /* ------------------------------------------------------------------ settings */

  function saveSettings() {
    applyTheme($('themeSelect').value);
    var value = ($('linkBase').value || '').trim();
    if (value && !/^https:\/\/[^\s]+$/i.test(value)) {
      toast('The QR link must start with https://');
      return;
    }
    var server = ($('serverBase').value || '').trim().replace(/\/+$/, '');
    if (server && !/^https:\/\/[^\s]+$/i.test(server)) {
      toast('The wake-up server URL must start with https://');
      return;
    }
    state.settings.link = value || DEFAULT_LINK;
    state.settings.server = server;
    $('linkBase').value = state.settings.link;
    $('serverBase').value = server;
    persistSettings();
    toast('Settings saved.');
  }

  function wipeData() {
    if (!window.confirm('Delete all vehicles, history and settings from this device?')) { return; }
    if (bridge && bridge.wipeData) {
      bridge.wipeData();
    } else {
      try { localStorage.removeItem(LS_KEY); } catch (e) { /* ignore */ }
    }
    state.vehicles = [];
    state.logs = [];
    state.online = [];
    state.settings = { theme: state.settings.theme, link: DEFAULT_LINK };
    renderAll();
    toast('All app data deleted.');
  }

  var LINK_ERRORS = {
    'unavailable-id': 'Reconnecting — the number was still held by the previous session',
    'network': 'No internet connection',
    'server-error': 'Call network unreachable, retrying…',
    'socket-error': 'Call network unreachable, retrying…',
    'socket-closed': 'Call network closed the connection, retrying…',
    'browser-incompatible': 'This device cannot make WebRTC calls',
    'engine': 'Calling engine failed to load — reinstall the app'
  };

  function renderEnvironment() {
    var env = state.env || {};
    var inApp = !!bridge;
    var rows = [];

    if (!inApp) {
      rows.push(['Preview mode', 'Calling, saving and printing need the Android app.', null, null]);
    } else {
      rows.push(['Microphone', env.mic ? 'Allowed' : 'Not allowed — calls will fail',
        env.mic ? null : 'Allow', 'permissions']);
      rows.push(['Call notifications', env.notifications ? 'Allowed' : 'Not allowed — you will not see incoming calls',
        env.notifications ? null : 'Allow', 'notifications']);
      if (env.push) {
        rows.push(['Delivery mode', 'Instant wake-up (push) — no permanent notification', null, null]);
      } else if (env.pushServer) {
        rows.push(['Delivery mode', 'Wake-up server set, waiting for the push token', null, null]);
      } else {
        rows.push(['Delivery mode', 'Always-connected background service (permanent notification)', null, null]);
        rows.push(['Battery restrictions', env.batteryUnrestricted ? 'Unrestricted (recommended)'
          : 'Restricted — Android may close the connection', env.batteryUnrestricted ? null : 'Fix', 'battery']);
      }
    }

    // Per-vehicle connection state: this is what turns "it does not ring" into a diagnosis.
    if (inApp) {
      state.online.forEach(function (plate) {
        var info = (state.link || {})[plate] || {};
        var registered = (state.registered || []).indexOf(plate) >= 0;
        var text;
        if (info.peer) {
          text = 'Reachable' + (info.peer === plate ? '' : ' (id ' + info.peer + ')');
        } else if (info.err) {
          text = LINK_ERRORS[info.err] || ('Connection problem: ' + info.err);
        } else if (registered) {
          text = 'Sleeping — will be woken by a push when someone calls';
        } else if (env.pushServer) {
          text = 'Registering with the wake-up server…';
        } else {
          text = 'Connecting…';
        }
        rows.push([plate, text, null, null]);
      });
    }

    $('envList').innerHTML = rows.map(function (row) {
      return '' +
        '<div class="log-row">' +
          '<div class="log-main">' +
            '<div class="log-title">' + escapeHtml(row[0]) + '</div>' +
            '<div class="log-sub">' + escapeHtml(row[1]) + '</div>' +
          '</div>' +
          (row[2] ? '<button class="btn btn-ghost btn-sm" data-env="' + row[3] + '">' + escapeHtml(row[2]) + '</button>' : '') +
        '</div>';
    }).join('');
  }

  /* ------------------------------------------------------------------ native hooks */

  window.applyNativeInsets = function (top, bottom) {
    var root = document.documentElement;
    root.style.setProperty('--safe-top', (top || 0) + 'px');
    root.style.setProperty('--safe-bottom', (bottom || 0) + 'px');
  };

  window.onNativeBack = function () {
    if ($('qrModal').classList.contains('open')) { closeModal('qrModal'); return true; }
    if ($('cardModal').classList.contains('open')) { closeModal('cardModal'); return true; }
    if ($('drawer').classList.contains('open')) { setDrawer(false); return true; }
    return false;
  };

  /* ------------------------------------------------------------------ rendering */

  function renderAll() {
    applyTheme(state.settings.theme || 'system');
    $('linkBase').value = state.settings.link || DEFAULT_LINK;
    $('serverBase').value = state.settings.server || '';
    renderVehicles();
    renderLogs();
    renderEnvironment();
    updateOnlineBanner();
  }

  function updateOnlineBanner() {
    $('offlineBanner').classList.toggle('hidden', navigator.onLine);
  }

  /* ------------------------------------------------------------------ events */

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
      persistSettings();
    });

    $('addVehicleBtn').addEventListener('click', addVehicle);

    $('vehicleList').addEventListener('click', function (event) {
      var btn = event.target.closest('[data-act]');
      if (!btn) { return; }
      var number = btn.getAttribute('data-num');
      switch (btn.getAttribute('data-act')) {
        case 'toggle': toggleOnline(number); break;
        case 'qr': showQr(number); break;
        case 'card': showCard(number); break;
        case 'delete': deleteVehicle(number); break;
        default: break;
      }
    });

    $('callBtn').addEventListener('click', function () {
      var number = normalizePlate($('callNumber').value);
      if (number.length < 4) { toast('Enter a valid vehicle number.'); return; }
      if (!navigator.onLine) { toast('No internet connection.'); return; }
      if (!bridge || !bridge.startCall) { toast('Calling only works inside the Android app.'); return; }
      bridge.startCall(number);
    });

    $('clearLogsBtn').addEventListener('click', clearLogs);

    $('shareQrBtn').addEventListener('click', function () {
      if (!qrNumber) { return; }
      shareDataUrl(qrExportCanvas().toDataURL('image/jpeg', 0.95), 'image/jpeg',
        'vehicle-call-alert-qr-' + qrNumber + '.jpg');
    });

    $('printQrBtn').addEventListener('click', function () {
      if (!qrNumber) { return; }
      printDataUrl(qrExportCanvas().toDataURL('image/png'), 'QR code ' + qrNumber);
    });

    $('cardJpgBtn').addEventListener('click', function () {
      if (!cardNumber) { return; }
      shareDataUrl($('cardCanvas').toDataURL('image/jpeg', 0.95), 'image/jpeg',
        'vehicle-call-alert-card-' + cardNumber + '.jpg');
    });

    $('cardPdfBtn').addEventListener('click', function () {
      if (!cardNumber) { return; }
      var ns = window.jspdf;
      if (!ns || !ns.jsPDF) { toast('PDF export is unavailable.'); return; }
      try {
        var doc = new ns.jsPDF({ orientation: 'landscape', unit: 'mm', format: 'a6' });
        doc.addImage($('cardCanvas').toDataURL('image/jpeg', 0.95), 'JPEG', 5, 5, 138, 95);
        shareDataUrl(doc.output('datauristring'), 'application/pdf',
          'vehicle-call-alert-card-' + cardNumber + '.pdf');
      } catch (e) {
        toast('Could not create the PDF.');
      }
    });

    $('cardPrintBtn').addEventListener('click', function () {
      if (!cardNumber) { return; }
      printDataUrl($('cardCanvas').toDataURL('image/png'), 'Windshield card ' + cardNumber);
    });

    $('saveSettingsBtn').addEventListener('click', saveSettings);
    $('wipeBtn').addEventListener('click', wipeData);

    $('envList').addEventListener('click', function (event) {
      var btn = event.target.closest('[data-env]');
      if (!btn || !bridge) { return; }
      switch (btn.getAttribute('data-env')) {
        case 'permissions': if (bridge.requestPermissions) { bridge.requestPermissions(); } break;
        case 'notifications': if (bridge.openNotificationSettings) { bridge.openNotificationSettings(); } break;
        case 'battery': if (bridge.openBatterySettings) { bridge.openBatterySettings(); } break;
        default: break;
      }
    });

    window.addEventListener('online', updateOnlineBanner);
    window.addEventListener('offline', updateOnlineBanner);
  }

  /* ------------------------------------------------------------------ init */

  function init() {
    loadState();
    bindEvents();
    renderAll();
    showSection('garage');
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})();
