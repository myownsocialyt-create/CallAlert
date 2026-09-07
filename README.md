# Vehicle Call Alert

Privacy-first way to reach a vehicle owner: a QR code on the windshield lets anyone start an
encrypted internet voice call with the owner — **the phone number is never shown or shared**.

| | |
|---|---|
| Package | `com.datashield.vehiclecallalert` |
| Version | 1.0 (versionCode 1) |
| min / target / compile SDK | 24 / 36 / 36 |
| Language | Java + bundled offline web UI (WebView) |
| Build | Gradle 8.11.1, Android Gradle Plugin 8.9.1, JDK 17 |

---

## Features

* **My Garage** — add vehicles (number, type, nickname), stored only on the device.
* **Go online / offline** — your vehicle number becomes a peer ID people can call.
* **Call a vehicle** — type a vehicle number and talk over WebRTC HD voice.
* **QR code + windshield card** — generated offline, saved/shared as JPG or PDF via the Android share sheet.
* **Call history** — local only, clearable.
* **Dark / light / system theme**, edge-to-edge, works on Android 7 – 16.

## Project layout

```
app/
  src/main/java/com/datashield/vehiclecallalert/
      MainActivity.java     WebView host (WebViewAssetLoader, permissions, insets, back handling)
      WebAppBridge.java     @JavascriptInterface: share file/text, call audio, keep screen on
  src/main/assets/www/      the whole UI (index.html, styles.css, app.js)
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
* ✅ only four permissions, each used by a visible feature; no location, contacts or storage access
* ✅ microphone opened only during a call, released immediately afterwards, nothing recorded
* ✅ no cleartext traffic, network-security config included
* ✅ no remotely loaded / interpreted code (all web assets bundled)
* ✅ backup and data-extraction rules declared
* ✅ adaptive + monochrome launcher icon, 512×512 store icon in `store-assets/`
* ✅ in-app privacy policy and [`PRIVACY_POLICY.md`](PRIVACY_POLICY.md) to host as the Play Store policy URL
* ⚠️ Data safety form: declare **no data collected, no data shared**; microphone used for calls only,
  processed ephemerally.
* ⚠️ Host `PRIVACY_POLICY.md` on a public URL (e.g. GitHub Pages) and paste that link into the Play Console.

## Third-party licences

* [PeerJS](https://peerjs.com) — MIT
* [jsPDF](https://github.com/parallax/jsPDF) — MIT
* [qrcode-generator](https://github.com/kazuhikoarase/qrcode-generator) by Kazuhiko Arase — MIT

## Support

DataShield Studio — DataShield.studio@gmail.com
