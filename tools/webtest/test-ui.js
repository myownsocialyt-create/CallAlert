/*
 * Smoke test for the bundled web UI (app/src/main/assets/www).
 *
 *   npm install jsdom      # once, anywhere
 *   node tools/webtest/test-ui.js
 *
 * It loads index.html in jsdom with a fake AndroidBridge and checks that every user action
 * reaches the native layer with the right arguments.
 */
const fs = require('fs');
const path = require('path');
const { JSDOM } = require('jsdom');

const WWW = path.resolve(__dirname, '../../app/src/main/assets/www');
const dom = new JSDOM(fs.readFileSync(path.join(WWW, 'index.html'), 'utf8'), {
  runScripts: 'outside-only',
  pretendToBeVisual: true,
  url: 'https://appassets.androidplatform.net/assets/www/index.html'
});
const { window } = dom;

window.HTMLCanvasElement.prototype.getContext = function () {
  const noop = () => {};
  return new Proxy({}, { get: (t, p) => (p === 'canvas' ? this : (t[p] !== undefined ? t[p] : noop)), set: () => true });
};
window.HTMLCanvasElement.prototype.toDataURL = () => 'data:image/jpeg;base64,QUJD';
window.confirm = () => true;

const calls = [];
const nativeState = {
  vehicles: [], logs: [], online: [],
  settings: { theme: 'dark', link: 'https://vehicle-alert.techeditz8.workers.dev/call' },
  env: { app: true, mic: true, notifications: false, batteryUnrestricted: false },
  call: { state: 'idle', number: '' }
};
window.AndroidBridge = {
  getState: () => JSON.stringify(nativeState),
  saveVehicles: j => { nativeState.vehicles = JSON.parse(j); calls.push('saveVehicles'); },
  saveSettings: j => { nativeState.settings = JSON.parse(j); calls.push('saveSettings'); },
  clearLogs: () => { nativeState.logs = []; calls.push('clearLogs'); },
  wipeData: () => { nativeState.vehicles = []; nativeState.logs = []; nativeState.online = []; calls.push('wipeData'); },
  goOnline: n => { calls.push('goOnline:' + n); if (nativeState.online.indexOf(n) === -1) nativeState.online.push(n); },
  goOffline: n => { calls.push('goOffline:' + n); nativeState.online = nativeState.online.filter(x => x !== n); },
  startCall: n => calls.push('startCall:' + n),
  shareFile: (b, m, f) => calls.push('shareFile:' + m + ':' + f),
  printImage: (b, j) => calls.push('printImage:' + j),
  requestPermissions: () => calls.push('requestPermissions'),
  openNotificationSettings: () => calls.push('openNotificationSettings'),
  openBatterySettings: () => calls.push('openBatterySettings')
};

const errors = [];
window.addEventListener('error', e => errors.push(e.message));
const run = f => window.eval(fs.readFileSync(path.join(WWW, f), 'utf8'));
run('lib/qrcode.js');
window.jspdf = { jsPDF: function () { this.addImage = () => {}; this.output = () => 'data:application/pdf;base64,QUJD'; } };
run('app.js');
window.document.dispatchEvent(new window.Event('DOMContentLoaded'));

const $ = id => window.document.getElementById(id);
const click = el => el.dispatchEvent(new window.MouseEvent('click', { bubbles: true }));
let fails = 0;
const check = (name, cond) => { console.log((cond ? 'PASS  ' : 'FAIL  ') + name); if (!cond) fails++; };

check('renders empty garage', $('vehicleList').innerHTML.includes('No vehicles yet'));
check('env checklist rendered', $('envList').innerHTML.includes('Microphone'));
check('env shows notification warning', $('envList').innerHTML.includes('Not allowed'));

$('newNumber').value = 'up16ab1234';
$('newNick').value = 'Swift';
click($('addVehicleBtn'));
check('vehicle saved through bridge', calls.includes('saveVehicles') && nativeState.vehicles[0].number === 'UP16AB1234');
check('vehicle rendered', $('vehicleList').innerHTML.includes('UP16AB1234'));
check('auto online on add', calls.includes('goOnline:UP16AB1234'));

window.onNativeState(JSON.stringify(nativeState));
check('online state rendered', $('vehicleList').innerHTML.includes('Go offline'));
check('online help text', $('vehicleList').innerHTML.includes('after a restart'));

click(window.document.querySelector('[data-act="toggle"]'));
check('go offline via bridge', calls.includes('goOffline:UP16AB1234'));

click(window.document.querySelector('[data-act="qr"]'));
check('qr modal opens', $('qrModal').classList.contains('open'));
click($('shareQrBtn'));
check('qr share', calls.some(c => c.startsWith('shareFile:image/jpeg:vehicle-call-alert-qr-UP16AB1234')));
click($('printQrBtn'));
check('qr print', calls.some(c => c.startsWith('printImage:QR code UP16AB1234')));
click(window.document.querySelector('[data-close-modal="qrModal"]'));

click(window.document.querySelector('[data-act="card"]'));
click($('cardJpgBtn'));
click($('cardPdfBtn'));
click($('cardPrintBtn'));
check('card jpg', calls.some(c => c.includes('card-UP16AB1234.jpg')));
check('card pdf', calls.some(c => c.includes('application/pdf')));
check('card print', calls.some(c => c.startsWith('printImage:Windshield card')));
click(window.document.querySelector('[data-close-modal="cardModal"]'));

click(window.document.querySelector('.nav-item[data-section="call"]'));
$('callNumber').value = 'dl01xy9999';
click($('callBtn'));
check('startCall via bridge', calls.includes('startCall:DL01XY9999'));

click($('menuBtn'));
click(window.document.querySelector('.drawer-item[data-section="settings"]'));
const envBtns = window.document.querySelectorAll('#envList [data-env]');
check('env fix buttons rendered', envBtns.length >= 2);
envBtns.forEach(b => click(b));
check('permission actions wired', calls.includes('openNotificationSettings') && calls.includes('openBatterySettings'));

$('linkBase').value = 'https://example.com/call';
click($('saveSettingsBtn'));
check('settings saved', nativeState.settings.link === 'https://example.com/call');

window.onNativeState(JSON.stringify(nativeState));
check('native state refresh keeps ui', $('vehicleCount').textContent === '1');

window.applyNativeInsets(30, 40);
check('insets applied', window.document.documentElement.style.getPropertyValue('--safe-bottom') === '40px');
click($('menuBtn'));
check('back closes drawer', window.onNativeBack() === true);

click($('wipeBtn'));
check('wipe via bridge', calls.includes('wipeData'));

console.log(errors.length ? 'JS ERRORS: ' + errors.join('; ') : 'no window errors');
process.exitCode = (fails || errors.length) ? 1 : 0;
