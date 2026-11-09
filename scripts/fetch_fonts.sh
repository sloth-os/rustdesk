#!/bin/bash
# Download + sha256-verify the pinned Noto fallback fonts from fonts.gstatic.com.
# Cached flat under fonts/dl/<family>_<version>_<file>; consumed by build_web.sh.
set -euo pipefail
DIR=$(cd "$(dirname "$0")" && pwd)
exec python3 - "$DIR/../fonts/manifest.json" "$DIR/../fonts/dl" <<'PYEOF'
import hashlib, json, os, sys, time, urllib.request

manifest_path, out_dir = sys.argv[1], sys.argv[2]
man = json.load(open(manifest_path))
os.makedirs(out_dir, exist_ok=True)

def fetch(url):
    req = urllib.request.Request(url, headers={"User-Agent": "Mozilla/5.0"})
    for attempt in range(3):
        try:
            return urllib.request.urlopen(req, timeout=180).read()
        except Exception as e:
            if attempt == 2:
                raise
            print(f"    retry after error: {e}", flush=True)
            time.sleep(3 * (attempt + 1))

ok = True
for key, meta in sorted(man.items()):
    flat = key.replace("/", "_")
    dst = os.path.join(out_dir, flat)
    blob = None
    if os.path.isfile(dst):
        blob = open(dst, "rb").read()
        if hashlib.sha256(blob).hexdigest() == meta["sha256"]:
            print(f"  cached {key} ({len(blob)//1024} KiB)")
            continue
        print(f"  stale   {key} — refetching")
        blob = None
    if blob is None:
        blob = fetch(f"https://fonts.gstatic.com/s/{key}")
        digest = hashlib.sha256(blob).hexdigest()
        if digest != meta["sha256"]:
            print(f"  BAD HASH for {key}: got {digest}")
            ok = False
            continue
        open(dst, "wb").write(blob)
        print(f"  fetched {key} ({len(blob)//1024} KiB)")

total = sum(m["bytes"] for m in man.values())
print(f"fonts: {len(man)} files, {total//1048576} MiB — {'all verified' if ok else 'HASH FAILURES'}")
sys.exit(0 if ok else 1)
PYEOF
