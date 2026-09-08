# Privacy Policy — Vehicle Call Alert

**Last updated: 8 September 2026**

Vehicle Call Alert ("the app") is published by DataShield Studio. This policy explains what the app
does and does not do with your information. The same text is available inside the app under
**Menu → Privacy Policy**.

## 1. Information we collect

**None.** The app has no user accounts, no analytics SDKs, no advertising SDKs and no crash-reporting
services. We (the developer) never receive your personal data.

## 2. Information stored on your device

The following is stored only in the app's local storage on your phone:

* vehicle numbers, vehicle type and nicknames you add,
* your appearance/QR-link settings,
* your local call history (vehicle number, direction, duration, time).

This data never leaves your device. It is removed when you uninstall the app or when you tap
**Settings → Delete all app data**.

## 3. Microphone

The app requests the `RECORD_AUDIO` permission only so that the other party can hear you during a
voice call. The microphone is opened when a call starts and released as soon as the call ends.
Audio is **never** recorded, stored, or uploaded anywhere.

## 4. Background connection

When you set a vehicle **online**, the app runs a foreground service that keeps the internet
connection open so calls can reach you while the app is closed and after the phone restarts. The
service is visible at all times as a permanent notification, and it stops as soon as every vehicle is
offline. It does **not** use the microphone while it is only waiting for calls — the microphone is
opened only when a call is actually connected.

## 5. Network / third parties

To connect a call, the app uses:

* the public **PeerJS** signalling server, to exchange connection information, and
* public **STUN/TURN** servers, to discover your network address and, if a direct connection is
  impossible, to relay the encrypted call.

These services necessarily see the connection ID (your vehicle number) and your public IP address —
this is required for any internet call. Call audio is peer-to-peer and encrypted in transit
(DTLS-SRTP); it does not pass through our servers.

## 6. Permissions used

| Permission | Why |
|---|---|
| `INTERNET`, `ACCESS_NETWORK_STATE` | place and receive calls, detect connectivity |
| `RECORD_AUDIO` | your voice during an active call |
| `MODIFY_AUDIO_SETTINGS` | route call audio to speaker/earpiece |
| `FOREGROUND_SERVICE` (+ `SPECIAL_USE`, `MICROPHONE`) | stay reachable while the app is closed |
| `POST_NOTIFICATIONS` | incoming-call, ongoing-call and missed-call notifications |
| `USE_FULL_SCREEN_INTENT` | ring on the full screen, like a phone call |
| `RECEIVE_BOOT_COMPLETED` | go back online after the phone restarts |
| `WAKE_LOCK`, `VIBRATE` | wake the screen and vibrate for an incoming call |

The app requests no location, contacts, storage, SMS or phone-number permissions.

## 7. Children

The app is not directed to children under 13 and does not knowingly collect data from them.

## 8. Data deletion

Uninstall the app, or use **Settings → Delete all app data** inside the app. Because we store nothing
on our side, there is no server-side data to delete. You may still contact us with any request.

## 9. Changes

If this policy changes, the updated version will be published in this repository and inside the app.

## 10. Contact

DataShield Studio — **DataShield.studio@gmail.com**
