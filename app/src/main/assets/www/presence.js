/*
 * Head-less presence page. It runs inside the foreground CallService WebView and owns every
 * PeerJS connection, so the vehicle stays reachable while the app is minimised or closed.
 *
 * Peer IDs are the plain vehicle numbers (e.g. "UP16AB1234") so the public QR landing page,
 * which calls peer.call(carId), reaches this device directly.
 */
(function () {
  'use strict';

  var native = window.NativePresence || null;
  var hosts = {};           // number -> Peer (listening for calls)
  var dialer = null;        // Peer used for outgoing calls
  var current = null;       // { call, number, direction, connected }
  var localStream = null;
  var muted = false;

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
    var promise = audio.play();
    if (promise && promise.catch) {
      promise.catch(function () { /* autoplay guard */ });
    }
  }

  function detachRemote() {
    var audio = document.getElementById('remoteAudio');
    audio.srcObject = null;
  }

  /* ---------------------------------------------------------------- call plumbing */

  function finish(status, direction, number) {
    var seconds = 0;
    if (current && current.connectedAt) {
      seconds = Math.floor((Date.now() - current.connectedAt) / 1000);
    }
    var plate = number || (current ? current.number : '');
    var dir = direction || (current ? current.direction : '');
    if (current) {
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

  function bindHost(number, peer) {
    peer.on('open', function () {
      report('online', [number]);
    });

    peer.on('call', function (call) {
      if (current) {
        try { call.close(); } catch (e) { /* ignore */ }
        return;
      }
      current = { call: call, number: number, direction: 'incoming', connectedAt: 0, pending: true };
      report('incoming', [number]);

      call.on('close', function () {
        if (current && current.call === call && current.pending) {
          finish('Missed', 'incoming', number);
        }
      });
    });

    peer.on('error', function (err) {
      var type = err && err.type ? err.type : 'unknown';
      report('error', [number, type, err && err.message ? err.message : '']);
      if (type === 'unavailable-id' || type === 'invalid-id') {
        destroyHost(number);
      }
    });

    peer.on('disconnected', function () {
      if (hosts[number] === peer && !peer.destroyed) {
        setTimeout(function () {
          try { peer.reconnect(); } catch (e) { /* ignore */ }
        }, 1500);
      }
    });

    peer.on('close', function () {
      if (hosts[number] === peer) {
        delete hosts[number];
        report('offline', [number]);
      }
    });
  }

  function destroyHost(number) {
    var peer = hosts[number];
    if (!peer) {
      return;
    }
    delete hosts[number];
    try {
      if (!peer.destroyed) {
        peer.destroy();
      }
    } catch (e) { /* ignore */ }
    report('offline', [number]);
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
      if (hosts[number]) {
        var existing = hosts[number];
        if (existing.open) {
          report('online', [number]);
          return;
        }
        if (existing.disconnected && !existing.destroyed) {
          try { existing.reconnect(); } catch (e) { /* ignore */ }
          return;
        }
        destroyHost(number);
      }
      if (typeof window.Peer !== 'function') {
        report('error', [number, 'engine', 'PeerJS missing']);
        return;
      }
      // Default PeerJS configuration is used on purpose: it contains both STUN and TURN
      // servers, which is what the public QR landing page uses as well.
      var peer = new window.Peer(number);
      hosts[number] = peer;
      bindHost(number, peer);
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
      var incoming = current;
      acquireStream().then(function (stream) {
        if (!current || current !== incoming) {
          return;
        }
        incoming.pending = false;
        wire(incoming.call, incoming.number, 'incoming');
        incoming.call.answer(stream, CALL_OPTIONS);
      }).catch(function () {
        finish('Microphone unavailable', 'incoming', incoming.number);
      });
    },

    decline: function () {
      if (!current) {
        return;
      }
      finish('Declined', current.direction, current.number);
    },

    rejectBusy: function () {
      // Only ever drops a call that is still ringing — never the one in progress.
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
      Object.keys(hosts).forEach(function (number) {
        var peer = hosts[number];
        if (!peer) {
          return;
        }
        if (peer.destroyed) {
          delete hosts[number];
          window.Presence.goOnline(number);
        } else if (peer.disconnected) {
          try { peer.reconnect(); } catch (e) { window.Presence.goOnline(number); }
        }
      });
    },

    status: function () {
      return Object.keys(hosts).join(',');
    }
  };

  window.addEventListener('offline', function () {
    if (current) {
      finish('Connection lost', current.direction, current.number);
    }
  });

  report('ready', []);
})();
