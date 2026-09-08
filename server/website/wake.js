/**
 * Vehicle Call Alert — wake-up helper for the public call page.
 *
 * Drop this file next to your page and load it before your own script:
 *
 *   <script src="wake.js"></script>
 *
 * Then replace the place where you currently do `peer.call(carId, stream)` with:
 *
 *   const call = await VCAWake.callWithWake({
 *     peer: peer,
 *     plate: carId,
 *     stream: localStream,
 *     onStatus: (text) => { statusEl.textContent = text; }
 *   });
 *
 * What it does: asks the wake-up server to push the owner's phone, then keeps retrying the
 * PeerJS call for a few seconds while the app starts up. If the owner never registered the
 * vehicle (or uninstalled the app) it fails immediately with "unreachable" instead of ringing
 * into the void, and it reports a missed call when the caller gives up.
 */
(function (global) {
  'use strict';

  var DEFAULT_SERVER = 'https://vehicle-call-alert-wake.YOUR-SUBDOMAIN.workers.dev';

  var VCAWake = {

    /** Set this to your deployed Worker URL. */
    serverUrl: DEFAULT_SERVER,

    /** Asks the server to wake the owner's phone. Resolves to true when a push was sent. */
    ring: function (plate) {
      return this._post('/ring', { plate: plate })
        .then(function (result) { return !!(result && result.ok); })
        .catch(function () { return false; });
    },

    /** Tells the server the caller gave up, so the owner gets a missed-call notification. */
    cancel: function (plate) {
      return this._post('/cancel', { plate: plate }).catch(function () { return null; });
    },

    /** true when a phone is currently registered for this plate. */
    isReachable: function (plate) {
      var url = this.serverUrl + '/status?plate=' + encodeURIComponent(plate);
      return fetch(url)
        .then(function (r) { return r.json(); })
        .then(function (data) { return !!(data && data.reachable); })
        .catch(function () { return true; }); // never block a call because the server hiccuped
    },

    /**
     * Wakes the owner's phone and then calls it, retrying while the app boots.
     * Resolves with the connected PeerJS MediaConnection, rejects with an Error whose
     * message is 'unreachable' or 'no_answer'.
     */
    callWithWake: function (options) {
      var self = this;
      var peer = options.peer;
      var plate = String(options.plate || '').toUpperCase().replace(/[^A-Z0-9]/g, '');
      var stream = options.stream;
      var status = options.onStatus || function () {};
      var totalMs = options.timeoutMs || 25000;
      var attemptMs = options.attemptMs || 4000;

      status('Waking the owner\u2019s phone\u2026');

      return this._post('/ring', { plate: plate }).then(function (result) {
        if (result && result.ok === false && result.error === 'not_registered') {
          throw new Error('unreachable');
        }

        var deadline = Date.now() + totalMs;
        status('Ringing\u2026');

        function attempt() {
          if (Date.now() > deadline) {
            self.cancel(plate);
            throw new Error('no_answer');
          }
          return new Promise(function (resolve) {
            var call = peer.call(plate, stream);
            if (!call) {
              setTimeout(function () { resolve(null); }, 800);
              return;
            }
            var settled = false;
            var timer = setTimeout(function () {
              if (settled) { return; }
              settled = true;
              try { call.close(); } catch (e) { /* ignore */ }
              resolve(null);
            }, attemptMs);

            call.on('stream', function (remote) {
              if (settled) { return; }
              settled = true;
              clearTimeout(timer);
              resolve({ call: call, remote: remote });
            });
            call.on('error', function () {
              if (settled) { return; }
              settled = true;
              clearTimeout(timer);
              resolve(null);
            });
          }).then(function (connected) {
            return connected || attempt();
          });
        }

        return attempt();
      });
    },

    _post: function (path, body) {
      return fetch(this.serverUrl + path, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body)
      }).then(function (response) {
        return response.json().catch(function () { return { ok: response.ok }; });
      });
    }
  };

  global.VCAWake = VCAWake;
})(typeof window !== 'undefined' ? window : this);
