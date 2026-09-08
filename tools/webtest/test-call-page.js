/*
 * Regression test for the patched public call page (server/website/index.html).
 *
 *   cd tools/webtest && npm install jsdom
 *   node test-call-page.js
 *
 * Two scenarios:
 *   A. current app  - the wake-up server publishes the live peer id, the page dials exactly
 *      that id, opens the signalling channel and then waits for the owner without cancelling
 *      the ringing call behind their back (that was the "website still says Ringing" bug).
 *   B. older app    - nothing published, so the page falls back to dialling the plate and
 *      retries until the woken app answers.
 */
const fs = require('fs');
const path = require('path');
const { JSDOM } = require('jsdom');

const PAGE = path.resolve(__dirname, '../../server/website/index.html');
const WAKE = 'https://wake.test';
const RAW = fs.readFileSync(PAGE, 'utf8');

let fails = 0;
const check = (name, cond) => { console.log((cond ? 'PASS  ' : 'FAIL  ') + name); if (!cond) fails++; };
const sleep = ms => new Promise(r => setTimeout(r, ms));

function build({ statusBody, fastWait }) {
  let html = RAW.replace(/const WAKE_SERVER = '[^']*';/, `const WAKE_SERVER = '${WAKE}';`);
  if (fastWait) {
    html = html.replace(/const WAKE_WAIT_MS   = \d+;/, 'const WAKE_WAIT_MS   = 2500;');
  }
  const dom = new JSDOM(html, { runScripts: 'outside-only', url: 'https://example.com/?car_id=up16ab1234' });
  const { window } = dom;

  const fetched = [];
  window.fetch = (url, opts) => {
    fetched.push(String(url) + (opts && opts.body ? ' ' + opts.body : ''));
    const body = String(url).includes('/status') ? statusBody() : { ok: true };
    return Promise.resolve({ ok: true, json: () => Promise.resolve(body) });
  };
  window.navigator.mediaDevices = {
    getUserMedia: async () => ({ getTracks: () => [{ stop() {} }], getAudioTracks: () => [{ enabled: true }] })
  };
  window.HTMLMediaElement.prototype.play = () => Promise.resolve();

  const state = { dialled: [], connected: [], sdp: '', signals: [] };

  window.Peer = function () {
    this.on = (event, cb) => { if (event === 'open') { setTimeout(() => cb('caller-id'), 0); } };
    this.destroy = () => {};

    this.connect = target => {
      state.connected.push(target);
      if (!statusBody().peerId) { throw new Error('no data channel on old builds'); }
      const handlers = {};
      const conn = {
        open: false,
        on: (e, cb) => { handlers[e] = cb; },
        send: msg => state.signals.push(msg),
        close() {}
      };
      setTimeout(() => { conn.open = true; if (handlers.open) handlers.open(); }, 10);
      setTimeout(() => { if (handlers.data) handlers.data({ t: 'ringing' }); }, 40);
      return conn;
    };

    this.call = (target, stream, options) => {
      state.dialled.push(target);
      if (options && typeof options.sdpTransform === 'function') {
        state.sdp = options.sdpTransform('v=0\r\na=rtpmap:111 opus/48000/2\r\n');
      }
      const handlers = {};
      const call = { on: (e, cb) => { handlers[e] = cb; }, close() {} };
      const answerAt = statusBody().peerId ? 900 : (state.dialled.length >= 3 ? 50 : null);
      if (answerAt !== null) {
        setTimeout(() => handlers.stream && handlers.stream({}), answerAt);
      }
      return call;
    };
  };

  const script = html.split('<script>\n').pop().split('</script>')[0];
  window.eval(script);
  return { window, fetched, state };
}

async function scenarioLivePeerId() {
  console.log('-- scenario A: wake-up server knows the live peer id');
  const { window, fetched, state } = build({
    statusBody: () => ({ ok: true, reachable: true, awake: true, peerId: 'vca-9x7' })
  });
  const $ = id => window.document.getElementById(id);

  await sleep(100);
  $('callBtn').dispatchEvent(new window.MouseEvent('click', { bubbles: true }));
  await sleep(2500);

  check('reachability checked on load', fetched.some(f => f.includes('/status?plate=UP16AB1234')));
  check('wake push sent before dialling', fetched.some(f => f.includes('/ring') && f.includes('UP16AB1234')));
  check('dialled the id the phone published', state.dialled[0] === 'vca-9x7');
  check('signalling channel opened', state.connected[0] === 'vca-9x7');
  check('call not re-dialled while the phone rings', state.dialled.length === 1);
  check('connected state reached', $('statusTitle').textContent === 'Connected');
  check('call controls visible', $('controls').classList.contains('active'));
  check('opus tuning applied', /useinbandfec=1/.test(state.sdp));
  check('no missed-call cancel after a pick-up', !fetched.some(f => f.includes('/cancel')));
}

async function scenarioLegacyPlate() {
  console.log('-- scenario B: older app, only the plate is dialable');
  const { window, state } = build({
    statusBody: () => ({ ok: true, reachable: true, awake: false, peerId: null }),
    fastWait: true
  });
  const $ = id => window.document.getElementById(id);

  await sleep(100);
  $('callBtn').dispatchEvent(new window.MouseEvent('click', { bubbles: true }));
  await sleep(19000);

  check('fell back to the plate id', state.dialled.every(t => t === 'UP16AB1234'));
  check('kept dialling until the app answered', state.dialled.length >= 3);
  check('connected state reached', $('statusTitle').textContent === 'Connected');
}

(async () => {
  await scenarioLivePeerId();
  await scenarioLegacyPlate();
  console.log(fails ? 'FAILURES: ' + fails : 'all good');
  process.exit(fails ? 1 : 0);
})();
