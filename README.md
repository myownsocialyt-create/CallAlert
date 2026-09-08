# Vehicle Call Alert

Privacy-first way to reach a vehicle owner: a QR code on the windshield lets anyone start an
encrypted internet voice call with the owner — **the phone number is never shown or shared**.

| | |
|---|---|
| Package | `com.datashield.vehiclecallalert` |
| Version | 1.0 (versionCode 1) |
| min / target / compile SDK | 24 / 36 / 36 |
| Language | Java + bundled offline web UI (WebView) |
| Build | Gradle 8.14.5, Android Gradle Plugin 8.13.0, JDK 17 |

---

## Features

* **My Garage** — add vehicles (number, type, nickname), stored only on the device.
* **Always online** — tap *Go online* once; a foreground service keeps the peer connection alive with
  the app minimised, closed or the screen off, and restores it automatically after a reboot. It stays
  online until you tap *Go offline*.
* **Full-screen incoming calls** — calls ring over the lock screen with Accept / Decline, like a
  normal phone call, and are answered natively (no need to open the app first).
* **Missed-call notifications** — declined, unanswered or network-dropped calls leave a missed-call
  notification with a tap-to-call-back action.
* **Call a vehicle** — type a vehicle number and talk over WebRTC HD voice (Opus 48 kHz, in-band FEC,
  echo cancellation and noise suppression on both directions).
* **QR code + windshield card** — generated offline; **save, share or print** as JPG or PDF.
* **Call history** — local only, clearable.
* **Dark / light / system theme**, edge-to-edge, works on Android 7 – 16.

### Two ways of receiving calls

| Mode | When it is used | Trade-off |
|---|---|---|
| **Instant wake-up (recommended)** | a Firebase config (`app/google-services.json`) **and** a wake-up server URL are set | no permanent notification; the app sleeps and a high-priority push wakes it when someone scans the QR code. Setup: [`server/README.md`](server/README.md) |
| **Always-connected fallback** | no Firebase / no server configured | a foreground service keeps the PeerJS connection open, with a permanent notification |

Both modes end in the same place: `CallService` connects the call and `CallActivity` rings full
screen. The app switches automatically — nothing to toggle.

### How always-online works

```
MainActivity (WebView UI)  ──commands──▶  CallService  (foreground service)
        ▲                                      │  hosts a head-less WebView: assets/www/presence.html
        └────── state pushes ──── CallBus ◀─────┘  which owns every PeerJS connection

BootReceiver ──▶ CallService.sync()   (re-registers vehicles that were left online)
PushService  ──▶ CallService.wake()   (FCM high-priority push: come online for one call)
CallActivity ◀── full-screen intent   (incoming ring / active call UI, works over the lock screen)
```

The service declares `specialUse` (standby presence, justified in the manifest) plus `microphone`,
which is only relevant while a call is running and the call screen is in the foreground.
Android may still stop the service on aggressive OEM skins — the app's **Settings → Always-online
checklist** links directly to the microphone, notification and battery-optimisation screens so the
user can set battery usage to *Unrestricted*.

In the always-connected fallback a missed-call notification can only be shown for calls that actually
reached the device. With the wake-up server the push is queued by Google while the phone is offline,
so the missed call is reported as soon as the phone comes back online.

## Project layout

```
app/
  src/main/java/com/datashield/vehiclecallalert/
      MainActivity.java     WebView host (WebViewAssetLoader, permissions, insets, back handling)
      WebAppBridge.java     @JavascriptInterface: state, presence commands, share, print, settings
      CallService.java      foreground service: presence WebView, notifications, ringer, audio focus
      CallActivity.java     full-screen incoming/active call screen (shows over the lock screen)
      CallBus.java          in-process call-state bus (service → activities)
      BootReceiver.java     restores online vehicles after reboot / app update
      Prefs.java            local storage (vehicles, logs, online set, settings, push token)
      PushService.java      FCM receiver: wake for a call, or show a late/missed call
      PushRegistrar.java    registers "plate -> push token" with the wake-up server
  src/main/assets/www/      the UI (index.html, styles.css, app.js)
  src/main/assets/www/presence.html + presence.js   head-less PeerJS layer run by CallService
server/worker/            free Cloudflare Worker that turns a QR scan into an FCM push
server/website/wake.js    drop-in helper for the public call page
tools/preview/            HTML preview of the full-screen call design
tools/webtest/            jsdom smoke test for the bundled web UI
  src/main/assets/www/lib/  bundled MIT libraries: peerjs, jspdf, qrcode-generator
  src/main/res/             icons (adaptive + legacy), themes, backup & network-security rules
.github/workflows/          CI that builds the debug APK, release APK and release AAB
store-assets/               512×512 Play Store icon
```

No JavaScript, CSS or library is downloaded at runtime — everything ships inside the APK/AAB, which
keeps the app usable offline and compliant with Google Play's rules on remotely loaded code.

## Building locally

```bash
# JDK 17 + Android SDK required
./gradlew assembleDebug        # app/build/outputs/apk/debug/app-debug.apk
./gradlew assembleRelease      # app/build/outputs/apk/release/app-release.apk
./gradlew bundleRelease        # app/build/outputs/bundle/release/app-release.aab  <- upload this to Play
```

## Building in CI

Every push runs `.github/workflows/android-build.yml`, which builds all three artifacts, runs
Android Lint and uploads everything (plus the R8 `mapping.txt`) as workflow artifacts.

### Signing the release for Google Play

Create an upload key once and keep it safe — losing it means you can no longer update the app.

```bash
keytool -genkeypair -v \
  -keystore release.keystore -alias upload \
  -keyalg RSA -keysize 2048 -validity 10000
base64 -w0 release.keystore > release.keystore.b64   # macOS: base64 -i release.keystore -o release.keystore.b64
```

Then add four **repository secrets** (Settings → Secrets and variables → Actions):

| Secret | Value |
|---|---|
| `KEYSTORE_BASE64` | contents of `release.keystore.b64` |
| `KEYSTORE_PASSWORD` | keystore password |
| `KEY_ALIAS` | e.g. `upload` |
| `KEY_PASSWORD` | key password |

With the secrets set, CI produces a **signed** `app-release.aab`. Without them the build still
succeeds, but the bundle is unsigned and Play Console will reject it.

Locally you can instead create `keystore.properties` in the project root (git-ignored):

```properties
storeFile=release.keystore
storePassword=…
keyAlias=upload
keyPassword=…
```

## Google Play checklist

* ✅ targets API 36 (required for new apps and updates from 31 Aug 2026)
* ✅ Android App Bundle (`.aab`) output, R8 shrinking + `mapping.txt` for deobfuscated crash reports
* ✅ every permission maps to a visible feature; no location, contacts or storage access
* ✅ microphone opened only during a call, released immediately afterwards, nothing recorded
* ✅ foreground-service types declared (`specialUse` + `microphone`) with an in-manifest justification;
  `REQUEST_IGNORE_BATTERY_OPTIMIZATIONS` deliberately **not** requested — the app opens the system
  battery-optimisation screen instead
* ✅ `USE_FULL_SCREEN_INTENT` used for incoming calls only (allowed for calling apps)
* ✅ no cleartext traffic, network-security config included
* ✅ no remotely loaded / interpreted code (all web assets bundled)
* ✅ backup and data-extraction rules declared
* ✅ adaptive + monochrome launcher icon, 512×512 store icon in `store-assets/`
* ✅ in-app privacy policy and [`PRIVACY_POLICY.md`](PRIVACY_POLICY.md) to host as the Play Store policy URL
* ⚠️ Data safety form: declare **no data collected, no data shared**; microphone used for calls only,
  processed ephemerally.
* ⚠️ Host `PRIVACY_POLICY.md` on a public URL (e.g. GitHub Pages) and paste that link into the Play Console.

## Interoperability with the QR landing page

The QR code and the shareable link point to the public call page with `?car_id=<PLATE>`, and the
PeerJS ID the app registers is the **plain vehicle number** (A–Z and 0–9, uppercase). That is what the
landing page calls, so scanning the code reaches the phone directly. The app answers with a live
microphone stream, which is what makes the caller's page switch from *Ringing* to *Connected*.

## Third-party licences

* [PeerJS](https://peerjs.com) — MIT
* [jsPDF](https://github.com/parallax/jsPDF) — MIT
* [qrcode-generator](https://github.com/kazuhikoarase/qrcode-generator) by Kazuhiko Arase — MIT

## Support

DataShield Studio — DataShield.studio@gmail.com
