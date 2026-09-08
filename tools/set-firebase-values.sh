#!/usr/bin/env bash
# Enables Firebase push WITHOUT google-services.json, by writing the four string resources
# that the google-services Gradle plugin would normally generate. Use this when the JSON file
# is hard to transfer - the values are visible in the Firebase console under
# Project settings -> General.
#
#   ./tools/set-firebase-values.sh \
#        "1:123456789012:android:abcdef1234567890" \   # App ID  (mobilesdk_app_id)
#        "AIzaSy..." \                                  # Web API key (current_key)
#        "123456789012" \                               # Project number = sender id
#        "vehicle-call-alert"                           # Project ID
#
set -euo pipefail

if [ "$#" -ne 4 ]; then
  sed -n '2,12p' "$0"
  exit 1
fi

app_id="$1"; api_key="$2"; sender_id="$3"; project_id="$4"
root="$(cd "$(dirname "$0")/.." && pwd)"
out="$root/app/src/main/res/values/firebase_options.xml"

case "$app_id" in
  1:*:android:*) ;;
  *) echo "ERROR: App ID must look like 1:123456789012:android:abcdef…" >&2; exit 1;;
esac

cat > "$out" <<XML
<?xml version="1.0" encoding="utf-8"?>
<!--
    Firebase configuration for push wake-up.

    These are the same values the google-services Gradle plugin generates from
    google-services.json; they are not secrets (they ship inside every APK).
    Regenerate with tools/set-firebase-values.sh.
-->
<resources xmlns:tools="http://schemas.android.com/tools" tools:ignore="UnusedResources">
    <string name="google_app_id" translatable="false">${app_id}</string>
    <string name="google_api_key" translatable="false">${api_key}</string>
    <string name="gcm_defaultSenderId" translatable="false">${sender_id}</string>
    <string name="project_id" translatable="false">${project_id}</string>
</resources>
XML

echo "Wrote $out"
echo "Push wake-up will be compiled into the next build."
