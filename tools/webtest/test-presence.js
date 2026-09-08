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
  check('claims the plate itself for old call pages', peers[0].requestedId === 'UP16AB1234');
  check('opens a always-available backup id as well',
    peers.length === 2 && peers[1].requestedId === null);

  // The broker still holds the plate from the previous session.
  peers[0].emit('error', { type: 'unavailable-id', message: 'ID is taken' });
  check('a taken id is reported, not swallowed',
    calls.some(c => c[0] === 'error' && c[2] === 'unavailable-id'));

  peers[1].ready();
  const first = calls.filter(c => c[0] === 'online').pop();
  check('the backup id keeps the vehicle callable',
    first && first[1] === 'UP16AB1234' && first[2] === peers[1].id);

  await sleep(1500);
  check('the plate is retried instead of given up', peers.length === 3);
  peers[2].ready();
  const preferred = calls.filter(c => c[0] === 'online').pop();
  check('once the plate is free it becomes the published id', preferred[2] === 'UP16AB1234');

  /* ---------------------------------------------------------- incoming call */
  const sent = [];
  const connHandlers = {};
  const conn = {
    open: true,
    on: (e, cb) => { connHandlers[e] = cb; },
    send: msg => sent.push(msg),
    close() {}
  };
  const host = peers[2];
  host.emit('connection', conn);
  connHandlers.open();
  check('caller handshake answered', sent.some(m => m.t === 'here'));

  const callHandlers = {};
  let answered = null;
  host.emit('call', {
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
  host.emit('error', { type: 'network', message: 'lost' });
  await sleep(1500);
  check('a network error triggers a reconnect', peers.length > before);

  /* ---------------------------------------------------------- caller re-dials while ringing */
  // Older call pages hang up every few seconds and dial again. The ringing screen must survive
  // that, and Accept pressed in between must answer the next attempt instead of dying.
  const mockCall = () => {
    const h = {};
    return {
      answered: false,
      on: (e, cb) => { h[e] = cb; },
      answer() { this.answered = true; },
      close() {},
      fire: (e, arg) => { if (h[e]) h[e](arg); }
    };
  };

  const endedBefore = calls.filter(c => c[0] === 'ended').length;
  const attempt1 = mockCall();
  host.emit('call', attempt1);
  check('a new call rings again', calls.filter(c => c[0] === 'incoming').length === 2);

  attempt1.fire('close');                       // the caller's page hung up mid-ring
  await sleep(20);
  check('a hang-up before the answer does not end the call',
    calls.filter(c => c[0] === 'ended').length === endedBefore);

  window.Presence.accept();                     // owner presses Accept in that gap
  await sleep(30);
  const attempt2 = mockCall();
  host.emit('call', attempt2);                  // the page dials again
  await sleep(60);
  check('the re-dial is answered straight away', attempt2.answered === true);

  attempt2.fire('stream', { id: 'remote2' });
  check('the reconnected call is reported as connected',
    calls.filter(c => c[0] === 'connected').length === 2);

  console.log(fails ? 'FAILURES: ' + fails : 'all good');
  process.exit(fails ? 1 : 0);
})();
