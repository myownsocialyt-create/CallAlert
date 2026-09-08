#!/usr/bin/env bash
# Installs a downloaded google-services.json into the app module and sanity-checks it.
#
#   ./tools/add-firebase.sh ~/Downloads/"google-services (1).json"
#
set -euo pipefail

src="${1:-}"
if [ -z "$src" ] || [ ! -f "$src" ]; then
  echo "usage: $0 <path to google-services.json>" >&2
  exit 1
fi

root="$(cd "$(dirname "$0")/.." && pwd)"
dest="$root/app/google-services.json"
cp "$src" "$dest"

python3 - "$dest" "$root/app/build.gradle" <<'PY'
import json, re, sys, pathlib
cfg = json.loads(pathlib.Path(sys.argv[1]).read_text())
gradle = pathlib.Path(sys.argv[2]).read_text()
app_id = re.search(r'applicationId\s+"([^"]+)"', gradle).group(1)
packages = [c["client_info"]["android_client_info"]["package_name"] for c in cfg["client"]]
print("Firebase project :", cfg["project_info"]["project_id"])
print("applicationId    :", app_id)
print("config packages  :", packages)
if app_id not in packages:
    sys.exit(f"ERROR: no Firebase Android app for {app_id} - add it in the Firebase console.")
print("OK - push wake-up will be compiled into the next build.")
PY

echo "Installed at app/google-services.json"
