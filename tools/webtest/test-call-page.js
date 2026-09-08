/*
 * Regression test for the patched public call page (server/website/index.html).
 *
 *   cd tools/webtest && npm install jsdom
 *   node test-call-page.js
 *
 * Simulates a phone that needs three dialling attempts before the woken app answers.
 */
const fs = require('fs');
const path = require('path');
const { JSDOM } = require('jsdom');

const PAGE = path.resolve(__dirname, '../../server/website/index.html');
const WAKE = 'https://wake.test';
const html = fs.readFileSync(PAGE, 'utf8').replace("const WAKE_SERVER = '';", `const WAKE_SERVER = '${WAKE}';`);

const dom = new JSDOM(html, { runScripts: 'outside-only', url: 'https://example.com/?car_id=up16ab1234' });
const { window } = dom;

const fetched = [];
window.fetch = (url, opts) => {
  fetched.push(String(url) + (opts && opts.body ? ' ' + opts.body : ''));
  return Promise.resolve({ ok: true, json: () => Promise.resolve({ ok: true, reachable: true }) });
};
window.navigator.mediaDevices = {
  getUserMedia: async () => ({ getTracks: () => [{ stop() {} }], getAudioTracks: () => [{ enabled: true }] })
};
window.HTMLMediaElement.prototype.play = () => Promise.resolve();

let attempts = 0;
let sdp = '';
window.Peer = function () {
  this.on = (event, cb) => { if (event === 'open') { setTimeout(() => cb('id'), 0); } };
  this.destroy = () => {};
  this.call = (plate, stream, options) => {
    attempts++;
    if (options && typeof options.sdpTransform === 'function') {
      sdp = options.sdpTransform('v=0\r\na=rtpmap:111 opus/48000/2\r\n');
    }
    const handlers = {};
    const call = { on: (e, cb) => { handlers[e] = cb; }, close() {} };
    if (attempts >= 3) { setTimeout(() => handlers.stream && handlers.stream({}), 50); }
    return call;
  };
};

const script = html.split('<script>\n').pop().split('</script>')[0];
window.eval(script);

let fails = 0;
const check = (name, cond) => { console.log((cond ? 'PASS  ' : 'FAIL  ') + name); if (!cond) fails++; };
const $ = id => window.document.getElementById(id);

setTimeout(() => {
  $('callBtn').dispatchEvent(new window.MouseEvent('click', { bubbles: true }));
  setTimeout(() => {
    check('reachability checked on load', fetched.some(f => f.includes('/status?plate=UP16AB1234')));
    check('wake push sent before dialling', fetched.some(f => f.includes('/ring') && f.includes('UP16AB1234')));
    check('kept dialling until the app answered', attempts >= 3);
    check('connected state reached', $('statusTitle').textContent === 'Connected');
    check('call controls visible', $('controls').classList.contains('active'));
    check('opus tuning applied', /useinbandfec=1/.test(sdp));
    console.log(fails ? 'FAILURES: ' + fails : 'all good');
    process.exit(fails ? 1 : 0);
  }, 13000);
}, 100);
