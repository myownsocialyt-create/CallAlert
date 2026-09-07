# Privacy Policy — Vehicle Call Alert

**Last updated: 7 September 2026**

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

## 4. Network / third parties

To connect a call, the app uses:

* the public **PeerJS** signalling server, to exchange connection information, and
* public **STUN** servers operated by Google, to discover your network address.

These services necessarily see the connection ID (your vehicle number) and your public IP address —
this is required for any internet call. Call audio is peer-to-peer and encrypted in transit
(DTLS-SRTP); it does not pass through our servers.

## 5. Permissions used

| Permission | Why |
|---|---|
| `INTERNET`, `ACCESS_NETWORK_STATE` | place and receive calls, detect connectivity |
| `RECORD_AUDIO` | your voice during an active call |
| `MODIFY_AUDIO_SETTINGS` | route call audio to speaker/earpiece |

The app requests no location, contacts, storage, SMS or phone-number permissions.

## 6. Children

The app is not directed to children under 13 and does not knowingly collect data from them.

## 7. Data deletion

Uninstall the app, or use **Settings → Delete all app data** inside the app. Because we store nothing
on our side, there is no server-side data to delete. You may still contact us with any request.

## 8. Changes

If this policy changes, the updated version will be published in this repository and inside the app.

## 9. Contact

DataShield Studio — **DataShield.studio@gmail.com**
