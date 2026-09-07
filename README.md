# Vehicle Call Alert v1.0 (1)

Privacy-first vehicle contact via QR. Owner stays online with car number as PeerID, visitor scans QR to call via WebRTC HD Voice — no phone number exposed.

**Version:** 1.0 (code 1) • **Target SDK:** 36 • **Min SDK:** 21 • **Package:** com.datashield.vehiclecallalert

## Features (v3 Fixed)
- Bottom nav: 3 items only (My Garage, Call Vehicle, Logs) — no menu button
- Minimalist graphic logo: car + bell SVG (no emoji)
- Theme toggle fixed: dark / light / system via html[data-theme]
- QR modal: no URL displayed, clean
- Sticker: professional yellow/black, no Gmail/URL
- Contact: DataShield.studio@gmail.com only in drawer
- PeerJS WebRTC, QR via api.qrserver.com, PDF/JPG export

## How to build (No ZIP — GitHub Web UI only)
1. Create new GitHub repo (public)
2. Use this page to copy each file: Add file > Create new file > paste path + content
3. For www/index.html, ensure folder app/src/main/assets/www/ exists
4. After all files copied, go to Actions tab — workflow builds APK/AAB automatically
5. Download from Artifacts

## Play Store Ready
- No sensitive permissions (only INTERNET, RECORD_AUDIO, MODIFY_AUDIO_SETTINGS)
- Privacy policy & About in drawer
- Supports dark/light
- Edge-to-edge, no ActionBar

Contact: DataShield.studio@gmail.com
