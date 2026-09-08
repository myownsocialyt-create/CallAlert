/*
 * Unit test for the app's presence engine (app/src/main/assets/www/presence.js).
 *
 *   cd tools/webtest && npm install jsdom
 *   node test-presence.js
 *
 * Covers the failures seen on the phone:
 *   - the PeerJS broker still holds the plate id ("unavailable-id") -> retry, then fall back
 *     to a random id and report it so the wake-up server can publish it;
 *   - an incoming call must reach the app and tell the caller "ringing" / "accepted";
 *   - a network hiccup must never silently leave the vehicle unreachable.
 */
const fs = require('fs');
const path = require('path');
const { JSDOM } = require('jsdom');

const SRC = fs.readFileSync(path.resolve(__dirname, '../../app/src/main/assets/www/presence.js'), 'utf8');

let fails = 0;
const check = (name, cond) => { console.log((cond ? 'PASS  ' : 'FAIL  ') + name); if (!cond) fails++; };
const sleep = ms => new Promise(r => setTimeout(r, ms));

function build() {
  const dom = new JSDOM('<audio id="remoteAudio"></audio>', { runScripts: 'outside-only', url: 'https://appassets.androidplatform.net/' });
  const { window } = dom;
  const calls = [];
  const peers = [];

  window.HTMLMediaElement.prototype.play = () => Promise.resolve();
  window.navigator.mediaDevices = {
    getUserMedia: async () => ({
      active: true,
      getTracks: () => [{ stop() {} }],
      getAudioTracks: () => [{ enabled: true }]
    })
  };

  const native = {};
  ['ready', 'online', 'offline', 'error', 'incoming', 'ringing', 'connected', 'ended'].forEach(name => {
    native[name] = (...args) => calls.push([name, ...args]);
  });
  window.NativePresence = native;

  window.Peer = function (id) {
    const handlers = {};
    const peer = {
      id: id || 'random-' + peers.length,
      requestedId: id || null,
      open: false,
      destroyed: false,
      disconnected: false,
      handlers,
      on: (event, cb) => { handlers[event] = cb; },
      destroy() { this.destroyed = true; },
      reconnect() { this.disconnected = false; },
      emit(event, arg) { if (handlers[event]) handlers[event](arg); },
      ready() { this.open = true; this.emit('open', this.id); }
    };
    peers.push(peer);
    return peer;
  };

  window.eval(SRC);
  return { window, calls, peers };
}

(async () => {
  /* ---------------------------------------------------------- taken id -> random id */
  const { window, calls, peers } = build();
  check('engine reported ready', calls.some(c => c[0] === 'ready'));

  window.Presence.goOnline('UP16AB1234');
  check('first attempt claims the plate itself', peers[0].requestedId === 'UP16AB1234');

  // The broker still holds the socket from the previous session.
  peers[0].emit('error', { type: 'unavailable-id', message: 'ID is taken' });
  check('a taken id is reported, not swallowed',
    calls.some(c => c[0] === 'error' && c[2] === 'unavailable-id'));

  await sleep(1500);
  check('it retried instead of giving up', peers.length === 2);
  peers[1].emit('error', { type: 'unavailable-id', message: 'ID is taken' });
  await sleep(2500);
  peers[2].emit('error', { type: 'unavailable-id', message: 'ID is taken' });
  await sleep(4000);
  check('falls back to a random id', peers.length === 4 && peers[3].requestedId === null);

  peers[3].ready();
  const online = calls.filter(c => c[0] === 'online').pop();
  check('the working peer id is reported to the app',
    online && online[1] === 'UP16AB1234' && online[2] === peers[3].id);

  /* ---------------------------------------------------------- incoming call */
  const sent = [];
  const connHandlers = {};
  const conn = {
    open: true,
    on: (e, cb) => { connHandlers[e] = cb; },
    send: msg => sent.push(msg),
    close() {}
  };
  peers[3].emit('connection', conn);
  connHandlers.open();
  check('caller handshake answered', sent.some(m => m.t === 'here'));

  const callHandlers = {};
  let answered = null;
  peers[3].emit('call', {
    on: (e, cb) => { callHandlers[e] = cb; },
    answer: stream => { answered = stream; },
    close() {}
  });
  check('incoming call handed to the app', calls.some(c => c[0] === 'incoming' && c[1] === 'UP16AB1234'));
  check('caller told the phone is ringing', sent.some(m => m.t === 'ringing'));

  window.Presence.accept();
  await sleep(50);
  check('microphone attached on accept', !!answered);
  check('caller told we are answering', sent.some(m => m.t === 'answering'));

  callHandlers.stream({ id: 'remote' });
  check('connected reported to the app', calls.some(c => c[0] === 'connected'));
  check('caller told the call was accepted', sent.some(m => m.t === 'accepted'));

  window.Presence.hangup();
  check('hang-up reported', calls.some(c => c[0] === 'ended' && c[3] === 'Answered'));

  /* ---------------------------------------------------------- network hiccup */
  const before = peers.length;
  peers[3].emit('error', { type: 'network', message: 'lost' });
  await sleep(1500);
  check('a network error triggers a reconnect', peers.length > before);

  console.log(fails ? 'FAILURES: ' + fails : 'all good');
  process.exit(fails ? 1 : 0);
})();
