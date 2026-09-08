/*
 * Tests the worker without deploying it (server/worker/src/index.js).
 *
 *   node tools/webtest/test-worker.js
 *
 * The worker is plain ES module code, so it is loaded into a sandbox with a fake KV namespace.
 * The important guarantees: the self-hosted call page is served and points at the worker
 * itself, /status hands out the live peer id, and /peer only accepts the owning phone.
 */
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const SRC = path.resolve(__dirname, '../../server/worker/src/index.js');

let fails = 0;
const check = (name, cond) => { console.log((cond ? 'PASS  ' : 'FAIL  ') + name); if (!cond) fails++; };

function load() {
  const code = fs.readFileSync(SRC, 'utf8').replace('export default', 'module.exports =');
  const sandbox = { module: { exports: {} }, console, URL, Response, Request, Headers, fetch: async () => {
    throw new Error('network disabled in this test');
  }, crypto, atob, btoa, TextEncoder, TextDecoder, Date };
  sandbox.globalThis = sandbox;
  vm.createContext(sandbox);
  vm.runInContext(code, sandbox);
  return sandbox.module.exports;
}

function kv() {
  const store = new Map();
  return {
    store,
    get: async k => (store.has(k) ? store.get(k) : null),
    put: async (k, v) => { store.set(k, v); },
    delete: async k => { store.delete(k); }
  };
}

const post = (url, body) => new Request(url, {
  method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body)
});

(async () => {
  const worker = load();
  const env = { TOKENS: kv() };
  const call = (req) => worker.fetch(req, env);

  let res = await call(new Request('https://w.test/health'));
  check('health answers', (await res.json()).ok === true);

  res = await call(new Request('https://w.test/call?car_id=UP16AB1234'));
  const html = await res.text();
  check('the worker serves the call page', res.headers.get('Content-Type').includes('text/html'));
  check('the served page is the current one', html.includes('RING_WINDOW_MS'));
  check('the page talks to the worker itself', html.includes('const WAKE_SERVER = location.origin;'));
  check('no unresolved template markers', !html.includes('__CALL_PAGE__') && !html.includes('\\${'));

  const token = 'a'.repeat(40);
  res = await call(post('https://w.test/register', { plate: 'UP16AB1234', token, platform: 'android' }));
  check('registration accepted', (await res.json()).ok === true);

  res = await call(new Request('https://w.test/status?plate=UP16AB1234'));
  let status = await res.json();
  check('status reports a registered vehicle', status.reachable === true && status.awake === false);

  res = await call(post('https://w.test/peer', { plate: 'UP16AB1234', token, peerId: 'vca-42' }));
  check('the phone can publish its peer id', (await res.json()).peerId === 'vca-42');

  res = await call(new Request('https://w.test/status?plate=UP16AB1234'));
  status = await res.json();
  check('callers are told where to dial', status.awake === true && status.peerId === 'vca-42');

  res = await call(post('https://w.test/peer', { plate: 'UP16AB1234', token: 'b'.repeat(40), peerId: 'evil' }));
  check('another phone cannot hijack a plate', res.status === 403);

  res = await call(post('https://w.test/peer', { plate: 'UP16AB1234', token, peerId: '' }));
  await res.json();
  res = await call(new Request('https://w.test/status?plate=UP16AB1234'));
  check('going offline clears the published id', (await res.json()).awake === false);

  res = await call(post('https://w.test/unregister', { plate: 'UP16AB1234', token }));
  await res.json();
  res = await call(new Request('https://w.test/status?plate=UP16AB1234'));
  check('unregistering removes the vehicle', (await res.json()).reachable === false);

  res = await call(post('https://w.test/ring', { plate: 'UP16AB1234' }));
  check('ringing an unknown plate says so', (await res.json()).error === 'not_registered');

  res = await call(new Request('https://w.test/status?plate=abc'));
  check('a nonsense plate is rejected', res.status === 400);

  console.log(fails ? 'FAILURES: ' + fails : 'all good');
  process.exit(fails ? 1 : 0);
})();
