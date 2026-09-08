/*
 * Test for the in-app "Run connection test" screen (app/src/main/assets/www).
 *
 *   cd tools/webtest && npm install jsdom
 *   node test-selftest.js
 *
 * The test screen exists so a user can see WHY a call did not arrive. It must name the two
 * things that silently break calling: an out-of-date worker and an out-of-date call page.
 */
const fs = require('fs');
const path = require('path');
const { JSDOM } = require('jsdom');

const WWW = path.resolve(__dirname, '../../app/src/main/assets/www');

let fails = 0;
const check = (name, cond) => { console.log((cond ? 'PASS  ' : 'FAIL  ') + name); if (!cond) fails++; };
const sleep = ms => new Promise(r => setTimeout(r, ms));

function boot({ status, pageHtml }) {
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

  const nativeState = {
    vehicles: [{ number: 'UP16AB1234', type: 'Car', nick: 'My car' }],
    logs: [],
    online: ['UP16AB1234'],
    link: { UP16AB1234: { peer: 'UP16AB1234' } },
    registered: ['UP16AB1234'],
    pushToken: true,
    settings: { theme: 'dark', link: 'https://example.test/call/', server: 'https://wake.test' },
    env: { app: true, mic: true, notifications: true, push: true, pushServer: true },
    call: { state: 'idle', number: '' }
  };
  window.AndroidBridge = {
    getState: () => JSON.stringify(nativeState),
    saveVehicles: () => {}, saveSettings: () => {}, clearLogs: () => {}, wipeData: () => {},
    goOnline: () => {}, goOffline: () => {}, startCall: () => {},
    shareFile: () => {}, printImage: () => {}, shareText: () => {},
    requestPermissions: () => {}, openNotificationSettings: () => {}, openBatterySettings: () => {}
  };

  window.fetch = url => {
    const u = String(url);
    if (u.includes('/health')) { return Promise.resolve({ json: () => Promise.resolve({ ok: true }) }); }
    if (u.includes('/status')) { return Promise.resolve({ json: () => Promise.resolve(status) }); }
    return Promise.resolve({ text: () => Promise.resolve(pageHtml) });
  };

  const run = f => window.eval(fs.readFileSync(path.join(WWW, f), 'utf8'));
  run('lib/qrcode.js');
  window.jspdf = { jsPDF: function () { this.addImage = () => {}; this.output = () => 'x'; } };
  run('app.js');
  window.document.dispatchEvent(new window.Event('DOMContentLoaded'));
  return window;
}

(async () => {
  /* ------------------------------------------------ everything out of date */
  let window = boot({
    status: { ok: true, plate: 'UP16AB1234', reachable: true },      // old worker: no "awake"
    pageHtml: '<html><script>const WAKE_SERVER = "https://wake.test";</script></html>'
  });
  let $ = id => window.document.getElementById(id);

  check('test button on the garage screen', !!$('selfTestBtn'));
  $('selfTestBtn').dispatchEvent(new window.MouseEvent('click', { bubbles: true }));
  check('result opens immediately', $('testModal').classList.contains('open'));
  await sleep(400);

  let text = $('testList').textContent;
  check('says the worker is out of date', /OLD code/.test(text) && /Server software version/.test(text));
  check('says the call page is out of date', /Call page/.test(text) && /hangs up/.test(text));
  check('tells the user what to do', /worker\.paste\.js/.test($('testHint').textContent));

  /* ------------------------------------------------ everything up to date */
  window = boot({
    status: { ok: true, plate: 'UP16AB1234', reachable: true, awake: true, peerId: 'vca-42' },
    pageHtml: '<html><script>const RING_WINDOW_MS = 60000;</script></html>'
  });
  $ = id => window.document.getElementById(id);
  $('selfTestBtn2').dispatchEvent(new window.MouseEvent('click', { bubbles: true }));
  await sleep(400);

  text = $('testList').textContent;
  check('reports the published id', /vca-42/.test(text));
  check('reports the call page as up to date', /Up to date/.test(text));
  check('closes with an all-clear', /Everything checks out/.test($('testHint').textContent));

  console.log(fails ? 'FAILURES: ' + fails : 'all good');
  process.exit(fails ? 1 : 0);
})();
