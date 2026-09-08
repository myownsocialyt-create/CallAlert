/*
 * Head-less presence page. It runs inside the CallService WebView and owns every PeerJS
 * connection, so the vehicle can be reached while the app is minimised, closed or asleep.
 *
 * Reachability works on two levels:
 *
 *   1. The peer tries to register under the plain vehicle number ("UP16AB1234") so old call
 *      pages, which dial the plate directly, keep working.
 *   2. Whatever id it finally gets (the plate, or a random one when the broker still holds a
 *      stale socket for the plate) is reported to the app, which publishes it on the wake-up
 *      server. The call page reads it from there, so a call always reaches this device even
 *      when the plate id is temporarily unavailable.
 *
 * A tiny data channel carries call signalling ("I am ringing", "accepted", "declined") so the
 * caller's page shows the true state instead of guessing from the media stream.
 */
(function () {
  'use strict';

  var native = window.NativePresence || null;
  var hosts = {};           // plate -> host entry
  var dialer = null;        // Peer used for outgoing calls
  var current = null;       // { call, number, direction, connectedAt, pending }
  var localStream = null;
  var muted = false;

  var RETRY_MS = [700, 1200, 2000, 3500, 5000, 8000, 12000];
  /*
   * Older call pages hang up every few seconds and dial again while the owner is still
   * reaching for the phone. Instead of ending the call we hold the ringing state for this
   * long and silently attach the next attempt from the same caller - so pressing Accept
   * works even when the caller's page keeps re-dialling.
   */
  var REDIAL_GRACE_MS = 15000;
  /** After this many attempts we stop insisting on the plate id and take a random one. */
  var PLATE_ATTEMPTS = 3;

  function report(method, args) {
    if (!native || typeof native[method] !== 'function') {
      return;
    }
    try {
      native[method].apply(native, args || []);
    } catch (e) { /* the bridge can disappear while the service stops */ }
  }

  /* ---------------------------------------------------------------- audio quality */

  var AUDIO_CONSTRAINTS = {
    audio: {
      echoCancellation: true,
      noiseSuppression: true,
      autoGainControl: true,
      channelCount: 1,
      sampleRate: 48000,
      sampleSize: 16
    },
    video: false
  };

  // Opus tuning: wideband speech, in-band FEC for packet loss, no DTX cut-outs.
  function boostAudio(sdp) {
    try {
      var lines = sdp.split('\r\n');
      var opusPayload = null;
      var i;
      for (i = 0; i < lines.length; i++) {
        var m = lines[i].match(/^a=rtpmap:(\d+) opus\/48000/i);
        if (m) {
          opusPayload = m[1];
          break;
        }
      }
      if (!opusPayload) {
        return sdp;
      }
      var params = 'stereo=0;sprop-stereo=0;maxaveragebitrate=64000;maxplaybackrate=48000;' +
                   'useinbandfec=1;usedtx=0;cbr=0';
      var found = false;
      for (i = 0; i < lines.length; i++) {
        if (lines[i].indexOf('a=fmtp:' + opusPayload) === 0) {
          lines[i] = 'a=fmtp:' + opusPayload + ' ' + params;
          found = true;
        }
      }
      if (!found) {
        for (i = 0; i < lines.length; i++) {
          if (lines[i].indexOf('a=rtpmap:' + opusPayload) === 0) {
            lines.splice(i + 1, 0, 'a=fmtp:' + opusPayload + ' ' + params);
            break;
          }
        }
      }
      // Give the audio m-line a comfortable bandwidth ceiling.
      for (i = 0; i < lines.length; i++) {
        if (lines[i].indexOf('m=audio') === 0) {
          if (lines[i + 1] && lines[i + 1].indexOf('c=') === 0 &&
              (!lines[i + 2] || lines[i + 2].indexOf('b=AS:') !== 0)) {
            lines.splice(i + 2, 0, 'b=AS:64');
          }
          break;
        }
      }
      return lines.join('\r\n');
    } catch (e) {
      return sdp;
    }
  }

  var CALL_OPTIONS = { sdpTransform: boostAudio };

  /* ---------------------------------------------------------------- microphone */

  function acquireStream() {
    if (localStream && localStream.active) {
      applyMute();
      return Promise.resolve(localStream);
    }
    if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
      return Promise.reject(new Error('no-media'));
    }
    return navigator.mediaDevices.getUserMedia(AUDIO_CONSTRAINTS).then(function (stream) {
      localStream = stream;
      applyMute();
      return stream;
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
    if (!localStream) {
      return;
    }
    localStream.getAudioTracks().forEach(function (t) { t.enabled = !muted; });
  }

  function attachRemote(stream) {
    var audio = document.getElementById('remoteAudio');
    audio.srcObject = stream;
    audio.volume = 1.0;
    var promise = audio.play();
    if (promise && promise.catch) {
      promise.catch(function () { /* autoplay guard */ });
    }
  }

  function detachRemote() {
    var audio = document.getElementById('remoteAudio');
    audio.srcObject = null;
  }

  /* ---------------------------------------------------------------- signalling channel */

  function signal(entry, message) {
    if (!entry) {
      return;
    }
    entry.conns = (entry.conns || []).filter(function (conn) {
      return conn && conn.open;
    });
    entry.conns.forEach(function (conn) {
      try { conn.send(message); } catch (e) { /* ignore */ }
    });
  }

  function signalCurrent(message) {
    if (!current || !current.number) {
      return;
    }
    signal(hosts[current.number], message);
  }

  function bindSignal(entry, conn) {
    entry.conns = entry.conns || [];
    entry.conns.push(conn);

    conn.on('open', function () {
      // "here" tells the caller the phone is awake and listening, so the page can show a
      // truthful "ringing on the owner's phone" instead of blindly retrying.
      try { conn.send({ t: 'here', plate: entry.plate, busy: !!current }); } catch (e) { /* ignore */ }
      if (current && current.number === entry.plate && current.pending) {
        try { conn.send({ t: 'ringing', plate: entry.plate }); } catch (e) { /* ignore */ }
      }
    });

    conn.on('data', function (msg) {
      if (!msg || typeof msg !== 'object') {
        return;
      }
      if (msg.t === 'cancel' && current && current.pending && current.number === entry.plate) {
        finish('Missed', 'incoming', entry.plate);
      }
    });

    conn.on('close', function () {
      entry.conns = (entry.conns || []).filter(function (c) { return c !== conn; });
    });

    conn.on('error', function () {
      entry.conns = (entry.conns || []).filter(function (c) { return c !== conn; });
    });
  }

  /* ---------------------------------------------------------------- call plumbing */

  function clearGrace(state) {
    if (state && state.graceTimer) {
      clearTimeout(state.graceTimer);
      state.graceTimer = 0;
    }
  }

  /** Watches a ringing call: a hang-up before the owner answers starts the grace period. */
  function bindPending(call, plate) {
    call.on('close', function () {
      if (!current || current.call !== call || !current.pending || current.stale) {
        return;
      }
      current.stale = true;
      current.graceTimer = setTimeout(function () {
        if (current && current.stale && current.pending) {
          finish('Missed', 'incoming', plate);
        }
      }, REDIAL_GRACE_MS);
    });
  }

  /** Answers the ringing call with the microphone. Waits for a re-dial when needed. */
  function answerCurrent() {
    var incoming = current;
    if (!incoming || !incoming.pending || incoming.stale) {
      return;
    }
    acquireStream().then(function (stream) {
      if (current !== incoming || !incoming.pending || incoming.stale) {
        return; // the caller re-dialled: the new attempt is answered when it arrives
      }
      incoming.pending = false;
      clearGrace(incoming);
      wire(incoming.call, incoming.number, 'incoming');
      incoming.call.answer(stream, CALL_OPTIONS);
    }).catch(function () {
      finish('Microphone unavailable', 'incoming', incoming.number);
    });
  }

  function finish(status, direction, number) {
    var seconds = 0;
    if (current && current.connectedAt) {
      seconds = Math.floor((Date.now() - current.connectedAt) / 1000);
    }
    var plate = number || (current ? current.number : '');
    var dir = direction || (current ? current.direction : '');
    if (dir === 'incoming') {
      signal(hosts[plate], {
        t: status === 'Declined' ? 'declined' : 'ended',
        plate: plate,
        status: status
      });
    }
    if (current) {
      clearGrace(current);
      try { current.call.close(); } catch (e) { /* ignore */ }
      current = null;
    }
    releaseStream();
    detachRemote();
    report('ended', [plate, dir, status, seconds]);
  }

  function wire(call, number, direction) {
    current = { call: call, number: number, direction: direction, connectedAt: 0 };

    call.on('stream', function (remote) {
      if (!current || current.call !== call) {
        return;
      }
      current.connectedAt = Date.now();
      attachRemote(remote);
      if (direction === 'incoming') {
        signal(hosts[number], { t: 'accepted', plate: number });
      }
      report('connected', [number]);
    });

    call.on('close', function () {
      if (current && current.call === call) {
        finish(current.connectedAt ? 'Answered' : 'Ended', direction, number);
      }
    });

    call.on('error', function () {
      if (current && current.call === call) {
        finish('Call failed', direction, number);
      }
    });
  }

  /* ---------------------------------------------------------------- host peers */

  /*
   * Every online vehicle listens on TWO sockets at once:
   *
   *   "plate"  - the vehicle number itself, which older call pages dial directly. The PeerJS
   *              broker sometimes still holds that name from the previous session, so this one
   *              retries for as long as the vehicle is switched on.
   *   "backup" - a random id that is always available. It is published on the wake-up server,
   *              so a modern call page can reach the phone even while the plate is still taken.
   *
   * Both answer incoming calls, so a call gets through whichever id the caller used.
   */

  function entryFor(plate) {
    if (!hosts[plate]) {
      hosts[plate] = { plate: plate, wanted: true, conns: [], slots: {} };
    }
    return hosts[plate];
  }

  function slotFor(entry, kind) {
    if (!entry.slots[kind]) {
      entry.slots[kind] = { kind: kind, peer: null, id: '', attempt: 0, timer: 0 };
    }
    return entry.slots[kind];
  }

  /** The id we want callers to use: the plate when it is ours, otherwise the random one. */
  function bestId(entry) {
    var plateSlot = entry.slots.plate;
    if (plateSlot && plateSlot.peer && plateSlot.peer.open && plateSlot.id) {
      return plateSlot.id;
    }
    var backup = entry.slots.backup;
    if (backup && backup.peer && backup.peer.open && backup.id) {
      return backup.id;
    }
    return '';
  }

  function announce(entry) {
    var id = bestId(entry);
    if (id) {
      report('online', [entry.plate, id]);
    } else {
      report('offline', [entry.plate]);
    }
  }

  function scheduleSlot(entry, slot) {
    if (!entry.wanted || slot.timer) {
      return;
    }
    var delay = RETRY_MS[Math.min(slot.attempt, RETRY_MS.length - 1)];
    slot.timer = setTimeout(function () {
      slot.timer = 0;
      if (entry.wanted && hosts[entry.plate] === entry) {
        spawnSlot(entry, slot);
      }
    }, delay);
  }

  function dropSlot(slot) {
    if (slot.timer) {
      clearTimeout(slot.timer);
      slot.timer = 0;
    }
    if (slot.peer) {
      try {
        if (!slot.peer.destroyed) {
          slot.peer.destroy();
        }
      } catch (e) { /* ignore */ }
    }
    slot.peer = null;
    slot.id = '';
  }

  function spawnSlot(entry, slot) {
    if (!entry.wanted || hosts[entry.plate] !== entry) {
      return;
    }
    if (typeof window.Peer !== 'function') {
      report('error', [entry.plate, 'engine', 'PeerJS missing']);
      return;
    }
    dropSlot(slot);

    var peer;
    try {
      peer = slot.kind === 'plate' ? new window.Peer(entry.plate) : new window.Peer();
    } catch (e) {
      slot.attempt++;
      scheduleSlot(entry, slot);
      return;
    }
    slot.peer = peer;

    peer.on('open', function (id) {
      if (hosts[entry.plate] !== entry || slot.peer !== peer) {
        return;
      }
      slot.id = id || (slot.kind === 'plate' ? entry.plate : '');
      slot.attempt = 0;
      announce(entry);
    });

    peer.on('call', function (call) {
      if (hosts[entry.plate] !== entry) {
        try { call.close(); } catch (e) { /* ignore */ }
        return;
      }
      if (current && current.stale && current.number === entry.plate && current.pending) {
        // The same caller dialled again during the grace period: keep the ringing screen.
        clearGrace(current);
        current.call = call;
        current.stale = false;
        bindPending(call, entry.plate);
        signal(entry, { t: 'ringing', plate: entry.plate });
        if (current.acceptWanted) {
          answerCurrent();
        }
        return;
      }
      if (current) {
        signal(entry, { t: 'busy', plate: entry.plate });
        try { call.close(); } catch (e) { /* ignore */ }
        return;
      }
      current = {
        call: call,
        number: entry.plate,
        direction: 'incoming',
        connectedAt: 0,
        pending: true,
        stale: false,
        acceptWanted: false,
        graceTimer: 0
      };
      signal(entry, { t: 'ringing', plate: entry.plate });
      report('incoming', [entry.plate]);
      bindPending(call, entry.plate);
    });

    peer.on('connection', function (conn) {
      if (hosts[entry.plate] !== entry) {
        try { conn.close(); } catch (e) { /* ignore */ }
        return;
      }
      bindSignal(entry, conn);
    });

    peer.on('error', function (err) {
      var type = err && err.type ? err.type : 'unknown';
      report('error', [entry.plate, type, err && err.message ? err.message : '']);

      if (type === 'peer-unavailable') {
        return; // an outgoing dial failed, this listening socket is fine
      }
      if (type === 'browser-incompatible' || type === 'invalid-key') {
        entry.wanted = false;
        dropSlot(slot);
        announce(entry);
        return;
      }
      if (hosts[entry.plate] !== entry || slot.peer !== peer) {
        return;
      }
      // unavailable-id / network / server-error / socket-error: the plate frees up within
      // seconds, so keep trying. The backup socket keeps the vehicle callable meanwhile.
      slot.attempt++;
      slot.id = '';
      announce(entry);
      scheduleSlot(entry, slot);
    });

    peer.on('disconnected', function () {
      if (hosts[entry.plate] !== entry || !entry.wanted || slot.peer !== peer) {
        return;
      }
      slot.id = '';
      setTimeout(function () {
        if (hosts[entry.plate] !== entry || !entry.wanted || slot.peer !== peer) {
          return;
        }
        try {
          if (!peer.destroyed) {
            peer.reconnect();
          } else {
            scheduleSlot(entry, slot);
          }
        } catch (e) {
          scheduleSlot(entry, slot);
        }
      }, 1200);
    });

    peer.on('close', function () {
      if (hosts[entry.plate] !== entry || slot.peer !== peer) {
        return;
      }
      slot.id = '';
      announce(entry);
      if (entry.wanted) {
        scheduleSlot(entry, slot);
      }
    });
  }

  function startHost(plate) {
    var entry = entryFor(plate);
    entry.wanted = true;
    ['plate', 'backup'].forEach(function (kind) {
      var slot = slotFor(entry, kind);
      if (slot.peer && !slot.peer.destroyed) {
        if (slot.peer.open) {
          announce(entry);
        } else if (slot.peer.disconnected) {
          try { slot.peer.reconnect(); } catch (e) { spawnSlot(entry, slot); }
        }
        return;
      }
      slot.attempt = 0;
      spawnSlot(entry, slot);
    });
  }

  function destroyHost(plate) {
    var entry = hosts[plate];
    if (!entry) {
      return;
    }
    entry.wanted = false;
    delete hosts[plate];
    Object.keys(entry.slots).forEach(function (kind) { dropSlot(entry.slots[kind]); });
    entry.conns = [];
    report('offline', [plate]);
  }

  function ensureDialer() {
    return new Promise(function (resolve, reject) {
      if (dialer && !dialer.destroyed && dialer.open) {
        resolve(dialer);
        return;
      }
      if (dialer) {
        try { dialer.destroy(); } catch (e) { /* ignore */ }
        dialer = null;
      }
      var peer = new window.Peer();
      var settled = false;

      peer.on('open', function () {
        settled = true;
        dialer = peer;
        resolve(peer);
      });

      peer.on('error', function (err) {
        var type = err && err.type ? err.type : 'unknown';
        if (!settled) {
          settled = true;
          reject(new Error(type));
          return;
        }
        report('error', ['', type, err && err.message ? err.message : '']);
      });

      setTimeout(function () {
        if (!settled) {
          settled = true;
          reject(new Error('timeout'));
        }
      }, 20000);
    });
  }

  /* ---------------------------------------------------------------- public API */

  window.Presence = {

    goOnline: function (number) {
      if (!number) {
        return;
      }
      startHost(number);
    },

    goOffline: function (number) {
      if (current && current.number === number) {
        finish('Ended', current.direction, number);
      }
      destroyHost(number);
    },

    goOfflineAll: function () {
      Object.keys(hosts).forEach(destroyHost);
      if (current) {
        finish('Ended', current.direction, current.number);
      }
    },

    call: function (number) {
      if (!number) {
        return;
      }
      if (current) {
        return;
      }
      acquireStream().then(function (stream) {
        return ensureDialer().then(function (peer) {
          var call = peer.call(number, stream, CALL_OPTIONS);
          if (!call) {
            report('ended', [number, 'outgoing', 'Call failed', 0]);
            releaseStream();
            return;
          }
          wire(call, number, 'outgoing');
          report('ringing', [number]);
        });
      }).catch(function (err) {
        releaseStream();
        var reason = err && err.message === 'timeout' ? 'Service unreachable' : 'Microphone unavailable';
        report('ended', [number, 'outgoing', reason, 0]);
      });
    },

    accept: function () {
      if (!current || !current.pending) {
        return;
      }
      current.acceptWanted = true;
      signalCurrent({ t: 'answering', plate: current.number });
      if (current.stale) {
        // The caller's page hung up a moment ago and is about to dial again: warm up the
        // microphone now so the next attempt is answered instantly.
        acquireStream().catch(function () { /* reported when the call arrives */ });
        return;
      }
      answerCurrent();
    },

    decline: function () {
      if (!current) {
        return;
      }
      finish('Declined', current.direction, current.number);
    },

    rejectBusy: function () {
      // Only ever drops a call that is still ringing - never the one in progress.
      if (current && current.pending) {
        finish('Missed (busy)', 'incoming', current.number);
      }
    },

    hangup: function () {
      if (!current) {
        return;
      }
      finish(current.connectedAt ? 'Answered' : 'Cancelled', current.direction, current.number);
    },

    setMute: function (value) {
      muted = !!value;
      applyMute();
    },

    networkUp: function () {
      Object.keys(hosts).forEach(function (plate) {
        var entry = hosts[plate];
        if (entry && entry.wanted) {
          startHost(plate);
        }
      });
    },

    /** Comma separated "PLATE=peerid" list - used by the in-app diagnostics screen. */
    status: function () {
      return Object.keys(hosts).map(function (plate) {
        return plate + '=' + (bestId(hosts[plate]) || 'connecting');
      }).join(',');
    }
  };

  window.addEventListener('offline', function () {
    if (current) {
      finish('Connection lost', current.direction, current.number);
    }
  });

  window.addEventListener('online', function () {
    window.Presence.networkUp();
  });

  report('ready', []);
})();
