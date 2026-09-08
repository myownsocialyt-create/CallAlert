# Instant wake-up (Firebase push) — setup guide

This removes the permanent "online" notification. Instead of holding a connection open all the
time, the app sleeps and is woken by a push exactly when somebody scans a QR code.

```
QR scan → call page → POST /ring → Cloudflare Worker → FCM high-priority push
        → phone wakes (even in Doze) → app connects PeerJS → full-screen ringing screen
```

Everything below is free: Firebase Spark plan and the Cloudflare Workers free plan (100,000
requests/day, no credit card). Firebase **Cloud Functions are not used**, so no Blaze plan.

---

## 1. Firebase (5 minutes)

1. Go to <https://console.firebase.google.com> → **Add project** (name: `vehicle-call-alert`).
   Google Analytics can be turned off.
2. Inside the project: **Add app → Android**.
   * Android package name: `com.datashield.vehiclecallalert`
   * Nickname: `Vehicle Call Alert`
   * SHA-1: not required for messaging.
3. Download **`google-services.json`** and put it at `app/google-services.json` in this
   repository (commit it — it contains no secret, it ships inside every Android app).
4. In the console: **⚙️ Project settings → Service accounts → Generate new private key**.
   A JSON file is downloaded — **this one is secret**. It is used by the Worker in step 2.

The Gradle build enables Firebase automatically as soon as `app/google-services.json` exists;
without it the app keeps using the always-connected foreground service.

## 2. Cloudflare Worker (10 minutes)

> Prefer clicking to typing? Follow [`DASHBOARD-SETUP.md`](DASHBOARD-SETUP.md) instead — same
> result, no command line.

```bash
cd server/worker
npm install                       # installs wrangler locally
npx wrangler login                # opens the browser, free account, no card

# storage for "plate -> push token"
npx wrangler kv namespace create TOKENS
#   → prints: id = "abc123..."   ← paste it into wrangler.toml

# the secret service-account key from step 1.4 (paste the whole JSON, then Ctrl-D)
npx wrangler secret put FIREBASE_SERVICE_ACCOUNT

npx wrangler deploy
#   → https://vehicle-alert.techeditz8.workers.dev
```

Check it:

```bash
curl https://vehicle-alert.techeditz8.workers.dev/health
# {"ok":true,"service":"vehicle-call-alert-wake"}
```

Optionally set `ALLOWED_ORIGINS` in `wrangler.toml` to your call page origin
(e.g. `https://datashield-cloud.github.io`) instead of `*`.

## 3. Tell the app about the server

In the app: **Settings → Instant wake-up server** → paste the Worker URL → **Save settings**.
The app registers every online vehicle with the server and then stops its background
connection — from that moment there is no permanent notification.

## 4. Patch the call page

**The patched page is already in this repo: [`server/website/index.html`](website/index.html).**
Open it, put your Worker URL in the one config line at the top of the script…

```js
const WAKE_SERVER = 'https://vehicle-alert.techeditz8.workers.dev';
```

…and upload it over the `index.html` of the call site (`datashield-cloud/Temp-call`). It keeps
your existing design and adds: wake-push before dialling, retry-while-the-app-boots, a
"vehicle not registered" message, missed-call reporting when the caller gives up, an online dot
on the number plate, and the same HD-audio (Opus/FEC) tuning the app uses. With
`WAKE_SERVER = ''` the page behaves exactly like the current one.

<details>
<summary>Alternative: patch your own page by hand with wake.js</summary>

Copy `server/website/wake.js` next to your `index.html` and load it **before** your own script:

```html
<script src="wake.js"></script>
```

Set the server URL once, at the top of your script:

```js
VCAWake.serverUrl = 'https://vehicle-alert.techeditz8.workers.dev';
```

Then replace the direct `peer.call(...)` with the wake-up version:

```js
// BEFORE
// const call = peer.call(carId, localStream);
// call.on('stream', remote => { audio.srcObject = remote; setStatus('Connected'); });

// AFTER
try {
  const { call, remote } = await VCAWake.callWithWake({
    peer: peer,
    plate: carId,
    stream: localStream,
    onStatus: setStatus            // "Waking the owner's phone…" → "Ringing…"
  });
  audio.srcObject = remote;
  setStatus('Connected');
  call.on('close', () => setStatus('Call ended'));
} catch (err) {
  setStatus(err.message === 'unreachable'
    ? 'This vehicle is not registered in the app.'
    : 'No answer — the owner has been notified of your missed call.');
}
```

`callWithWake` sends the push first and then retries `peer.call()` for ~25 seconds while the
phone wakes up, so the old "Owner app not active" race disappears.

</details>

## 5. How the pieces behave

| Situation | Result |
|---|---|
| Owner online, phone idle/locked | push wakes the app in 1–3 s, full-screen ringing screen |
| Owner's phone has no internet | push is queued by Google; when the phone reconnects the app shows a **missed call** (the push is marked stale after 90 s) |
| Caller gives up | page calls `/cancel` → missed-call notification |
| Vehicle never registered | `/ring` returns `not_registered` → the page says so immediately |
| Firebase/server not configured | the app automatically falls back to the always-connected foreground service |

## 6. How a call finds the phone

The PeerJS broker sometimes still holds the previous socket for a plate, so the app cannot
always register under the vehicle number itself. That is why the phone publishes the id it is
actually answering on:

```
app  ->  POST /peer   { plate, token, peerId }      (kept for 150 s)
page <-  GET  /status?plate=XX -> { reachable, awake, peerId }
```

The page waits until `awake` is true, dials `peerId`, opens a tiny data channel for
signalling ("ringing" / "answering" / "accepted" / "declined") and only then rings - so it
never cancels a call the owner is about to pick up, and it shows the true state instead of a
permanent "Ringing...". Pages that predate this still work: without a published id they dial
the plate and retry.

## 7. What the server stores

`PLATE → { fcm_token, platform, updated }` in Workers KV, the current PeerJS id
(`peer:PLATE`, 150 s), a 4-second anti-spam marker per plate and a cached Google OAuth token.
No phone numbers, no names, no call content, no logs of who called whom.
