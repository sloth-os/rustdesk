#!/bin/bash
# Canonical RustDesk 1.2.5 web build — the exact pipeline the weekly Pages
# workflow runs. Produces an offline-capable PWA:
#   - canvaskit and every engine fallback font served locally (no gstatic/cdn)
#   - service worker fixed for the /rustdesk/ subpath, full precache
#     (including the lazily-loaded codec wasm), query-string-proof keys
#   - firebase analytics stripped, PWA manifest name/orientation fixed
# Every source mutation is idempotent: re-running on a patched tree is a
# no-op apart from the rebuild itself.
#
# Env inputs (defaults = the local rehearsal layout under /tmp):
#   RD_DIR        rustdesk worktree at tag 1.2.5              /tmp/rd125
#   FLUTTER_DIR   extracted Flutter 3.19.6 SDK root           /tmp/flsdk/flutter
#   FONTS_DIR     fetch_fonts.sh output (manifest.json + dl/) /tmp/fonts_local
#   YARN_CJS      standalone Yarn Berry 3.6.4 cli             /tmp/yarn-3.6.4.cjs
#   PROTOC_DIR    protoc 36.2 binary dir                      /tmp/protocpkg/node_modules/.bin
#   WEBDEPS       web_deps.tar.gz (ogv.js/yuv-canvas/libopus) /tmp/web_deps.tar.gz
#   USE_PATH_DEPS 1 = rewrite the 7 git pub deps to local path deps — offline
#                 rehearsal only; CI keeps the git deps         0
#   PUBGIT_DIR    pre-staged dep sources when USE_PATH_DEPS=1 /tmp/pubgit
# Output: $RD_DIR/flutter/build/web  +  $RD_DIR/artifact.sha256
set -uo pipefail
RD_DIR=${RD_DIR:-/tmp/rd125}
FLUTTER_DIR=${FLUTTER_DIR:-/tmp/flsdk/flutter}
FONTS_DIR=${FONTS_DIR:-/tmp/fonts_local}
YARN_CJS=${YARN_CJS:-/tmp/yarn-3.6.4.cjs}
PROTOC_DIR=${PROTOC_DIR:-/tmp/protocpkg/node_modules/.bin}
WEBDEPS=${WEBDEPS:-/tmp/web_deps.tar.gz}
USE_PATH_DEPS=${USE_PATH_DEPS:-0}
PUBGIT_DIR=${PUBGIT_DIR:-/tmp/pubgit}
WEBDEPS_SHA256=b66011c4fc066b90c46ba0c78884fe5d1a7e5a7fad3dce401300ad893de63818
export RD_DIR FONTS_DIR PUBGIT_DIR
export PATH="$FLUTTER_DIR/bin:$PROTOC_DIR:$PATH"
log(){ echo "[$(date +%H:%M:%S)] $*"; }

[ -d "$RD_DIR/flutter" ] || { log "RD_DIR/flutter missing: $RD_DIR"; exit 1; }
[ -x "$FLUTTER_DIR/bin/flutter" ] || { log "flutter SDK missing: $FLUTTER_DIR"; exit 1; }
[ -s "$YARN_CJS" ] || { log "yarn cli missing: $YARN_CJS"; exit 1; }
[ -x "$PROTOC_DIR/protoc" ] || { log "protoc missing: $PROTOC_DIR/protoc"; exit 1; }
[ -f "$WEBDEPS" ] || { log "webdeps tarball missing: $WEBDEPS"; exit 1; }
# gen_js_from_hbb.py / ts_proto.py invoke `python`; runners only ship python3
if ! command -v python >/dev/null 2>&1; then
  mkdir -p /tmp/pybin && ln -sf "$(command -v python3)" /tmp/pybin/python
  export PATH="/tmp/pybin:$PATH"
fi

# ---------------- [0] JS bridge (yarn berry 3.6.4 + vite 2.8) ----------------
log "[0] JS bridge build"
cd "$RD_DIR/flutter" || exit 1
if [ -f web/jds/index.js ]; then
  log "  already staged (web/jds present)"
else
  # third-party codec libs, pinned tarball (ogv.js 1.8.6, yuv-canvas, libopus)
  if [ ! -d web/ogvjs-1.8.6 ]; then
    echo "$WEBDEPS_SHA256  $WEBDEPS" | sha256sum -c - || { log "WEBDEPS_SHA_FAIL"; exit 1; }
    tar xzf "$WEBDEPS" -C web/
    log "  extracted web deps ($(tar tzf "$WEBDEPS" | wc -l) files)"
  fi
  cd web/js || exit 1
  node "$YARN_CJS" install 2>&1 | tail -4
  [ -x node_modules/.bin/tsc ] || { log "YARN_INSTALL_FAIL"; exit 1; }
  node "$YARN_CJS" build 2>&1 | tail -8
  [ -f dist/index.js ] && [ -f dist/vendor.js ] || { log "BRIDGE_BUILD_FAIL"; exit 1; }
  sha256sum dist/index.js dist/vendor.js
  cd "$RD_DIR/flutter" || exit 1
fi

# ---------------- source patches (idempotent) ----------------

log "[1] web/index.html: firebase strip, jds rename, precache trigger"
python3 - <<'PYEOF'
import os
p = os.path.join(os.environ['RD_DIR'], 'flutter/web/index.html')
s = open(p).read()
changed = []
# firebase scripts + init block: third-party trackers, useless offline
if 'libs/firebase-app.js' in s:
    a = s.index('  <script src="libs/firebase-app.js')
    b = s.index('</body>')
    s = s[:a] + s[b:]
    changed.append('firebase strip')
# deprecated engine configuration block
if 'flutterConfiguration' in s:
    a = s.index('  <script>\n    // Take CanvasKit')
    b = s.index('</head>')
    s = s[:a] + s[b:]
    changed.append('flutterConfiguration strip')
# JS bridge path: build output is staged at web/jds (runtime-shaped tree)
if 'js/dist/index.js' in s:
    s = s.replace('js/dist/index.js', 'jds/index.js').replace('js/dist/vendor.js', 'jds/vendor.js')
    changed.append('jds rename')
# page-side precache top-up (the SW also precaches from activate(); this
# re-runs downloadOffline on every load — a cheap no-op when nothing is
# missing, and a retry when the activate-time pass was cut short)
if "postMessage('downloadOffline')" not in s:
    anchor = "        // If service worker doesn't succeed in a reasonable amount of time,"
    ins = """        // Precache every RESOURCES entry — including the lazily-loaded
        // codec wasm — so a single online visit makes the app fully
        // usable offline (LAN without internet).
        navigator.serviceWorker.ready.then((reg) => {
          reg.active && reg.active.postMessage('downloadOffline');
        });

"""
    assert anchor in s, 'trigger anchor missing'
    s = s.replace(anchor, ins + anchor, 1)
    changed.append('precache trigger')
open(p, 'w').write(s)
print('  index.html:', ', '.join(changed) if changed else 'already patched')
PYEOF

log "[2] pubspec.yaml: vendored Roboto fallback family"
python3 - <<'PYEOF'
import os
p = os.path.join(os.environ['RD_DIR'], 'flutter/pubspec.yaml')
s = open(p).read()
# Vendored Roboto: without a "Roboto" entry in FontManifest the engine
# downloads it from fonts.gstatic.com at startup — breaks offline/LAN use.
if 'family: Roboto' not in s:
    anchor = """    - family: AddressBook
      fonts:
        - asset: assets/address_book.ttf
"""
    ins = anchor + """
    # Vendored Roboto: without a "Roboto" entry in FontManifest the engine
    # downloads it from fonts.gstatic.com at startup, which breaks the
    # client in networks that cannot reach gstatic.com.
    - family: Roboto
      fonts:
        - asset: web/fonts/Roboto-Regular.ttf
"""
    assert anchor in s, 'Roboto anchor missing'
    open(p, 'w').write(s.replace(anchor, ins, 1))
    print('  pubspec: Roboto family added')
else:
    print('  pubspec: Roboto family already present')
PYEOF

if [ "$USE_PATH_DEPS" = "1" ]; then
log "[2b] pubspec.yaml: git -> path deps (LOCAL REHEARSAL ONLY — CI keeps git deps)"
python3 - <<'PYEOF'
import os, re
p = os.path.join(os.environ['RD_DIR'], 'flutter/pubspec.yaml')
lines = open(p).read().split('\n')
# The local sandbox cannot git-clone github.com over :443; the same commits
# are pre-staged under the pubgit dir. CI runners reach github.com and keep
# the git deps unchanged.
pubgit = os.environ['PUBGIT_DIR']
PATHS = {
 'dash_chat_2': pubgit + '/dash_chat_2',
 'desktop_multi_window': pubgit + '/desktop_multi_window',
 'dynamic_layouts': pubgit + '/dynamic_layouts',
 'flutter_gpu_texture_renderer': pubgit + '/flutter_gpu_texture_renderer',
 'flutter_improved_scrolling': pubgit + '/flutter_improved_scrolling',
 'window_manager': pubgit + '/window_manager',
 'window_size': pubgit + '/flutter-desktop-embedding/plugins/window_size',
}
out, i, changed = [], 0, 0
while i < len(lines):
    m = re.match(r'^  ([a-z_0-9]+):$', lines[i])
    if m and m.group(1) in PATHS:
        name, k, isgit = m.group(1), i + 1, False
        while k < len(lines) and not re.match(r'^  [a-z_0-9#]', lines[k]) and not re.match(r'^[a-z#]', lines[k]):
            if lines[k].strip() == 'git:':
                isgit = True
            k += 1
        if isgit:
            out.append(f'  {name}:')
            out.append(f'    path: {PATHS[name]}')
            changed += 1
            i = k
            continue
    out.append(lines[i]); i += 1
open(p, 'w').write('\n'.join(out))
print(f'  pubspec: rewrote {changed} git deps to path deps' if changed else '  pubspec: git deps already path deps')
PYEOF
fi

log "[3] web/manifest.json: PWA name + orientation"
python3 - <<'PYEOF'
import json, os
p = os.path.join(os.environ['RD_DIR'], 'flutter/web/manifest.json')
s = open(p).read()
s = s.replace('"name": "rustdesk"', '"name": "RustDesk"')
s = s.replace('"short_name": "rustdesk"', '"short_name": "RustDesk"')
# portrait-primary is wrong for a desktop-mirroring client
s = s.replace('"orientation": "portrait-primary"', '"orientation": "any"')
open(p, 'w').write(s)
m = json.load(open(p))
assert m['name'] == 'RustDesk' and m['orientation'] == 'any', m
print('  manifest:', m['name'], '/', m['orientation'])
PYEOF

log "[4] stage pinned fallback fonts at gstatic-relative paths"
python3 - <<'PYEOF'
import json, os, shutil
env = os.environ
man = json.load(open(os.path.join(env['FONTS_DIR'], 'manifest.json')))
dst_root = os.path.join(env['RD_DIR'], 'flutter/web/fonts')
copied = 0
for key, meta in man.items():
    flat = key.replace('/', '_')
    src = os.path.join(env['FONTS_DIR'], 'dl', flat)
    dst = os.path.join(dst_root, key)
    assert os.path.isfile(src), src
    os.makedirs(os.path.dirname(dst), exist_ok=True)
    shutil.copyfile(src, dst)
    copied += 1
# the vendored Roboto asset is the same file (byte-identical gstatic v20)
shutil.copyfile(os.path.join(dst_root, 'roboto/v20/KFOmCnqEu92Fr1Me5WZLCzYlKw.ttf'),
                os.path.join(dst_root, 'Roboto-Regular.ttf'))
print(f'  staged {copied} fonts ({sum(m["bytes"] for m in man.values())//1048576} MB) + Roboto-Regular.ttf')
PYEOF

log "[5] stage JS bridge -> web/jds"
if [ -f web/js/dist/index.js ]; then
  mkdir -p web/jds
  cp web/js/dist/index.js web/js/dist/vendor.js web/jds/
  rm -rf web/js web/libs   # libs/ = firebase scripts, dead after the strip
  echo "  staged from web/js/dist; removed web/js web/libs"
else
  echo "  already staged (web/jds present, web/js removed)"
fi

log "[6] flutter pub get"
flutter pub get 2>&1 | tail -3
[ -f .dart_tool/package_config.json ] || { log "PUBGET_FAIL"; exit 1; }

log "[7] flutter build web (canvaskit, local resources, /rustdesk/ base)"
rm -rf build/web
flutter build web --release \
  --web-renderer canvaskit \
  --base-href /rustdesk/ \
  --no-web-resources-cdn \
  --dart-define=FLUTTER_WEB_CANVASKIT_URL=canvaskit/ \
  2>&1 | tail -6
[ -f build/web/main.dart.js ] || { log "BUILD_FAIL"; exit 1; }
log "build ok"

cd build/web || exit 1

# ---------------- post-build patches ----------------
log "[8] post-build patches"
python3 - <<'PYEOF'
import hashlib

# (a) engine font-fallback prefix -> relative fonts/ tree. The prefix is a
# compile-time const in 3.19.6 (no override hook), so rewrite it post-build.
p = 'main.dart.js'
s = open(p, encoding='utf-8').read()
n = s.count('https://fonts.gstatic.com/s/')
assert n > 0, 'gstatic font prefix not found in main.dart.js'
open(p, 'w', encoding='utf-8').write(s.replace('https://fonts.gstatic.com/s/', 'fonts/'))
print(f'  main.dart.js: rewrote {n} font-prefix constants -> fonts/')

# (b)-(g) service worker fixes
p = 'flutter_service_worker.js'
s = open(p).read()

# (b) subpath origin: stock derives keys from origin only, so under
# /rustdesk/ no key ever matches. Derive from the worker's own URL.
old = 'var origin = self.location.origin;'
new = "var origin = self.location.origin + self.location.pathname.replace(/\\/[^\\/]*$/, '');"
assert s.count(old) == 2, f'origin decls: {s.count(old)}'
s = s.replace(old, new)

# (c) fetch handler: strip ANY query — index.html's "?v=" and ogv.js's
# "?version=" on worker scripts — so keys match RESOURCES entries.
old = """  // Redirect URLs to the index.html
  if (key.indexOf('?v=') != -1) {
    key = key.split('?v=')[0];
  }"""
new = """  // Strip any cache-busting query — index.html's "?v=" and ogv.js's
  // "?version=" on worker scripts — so the key matches the RESOURCES entry.
  if (key.indexOf('?') != -1) {
    key = key.split('?')[0];
  }"""
assert s.count(old) == 1
s = s.replace(old, new)

# (d) cache lookup must ignore the query as well (precache keys are bare).
old = "\n      return cache.match(event.request).then((response) => {"
new = "\n      return cache.match(event.request, {ignoreSearch: true}).then((response) => {"
assert s.count(old) == 1
s = s.replace(old, new)

# (e) lazy cache.put under the bare path (no "?version=" duplicate keys).
old = "\n            cache.put(event.request, response.clone());"
new = """\n            // Store under the bare path so lazily fetched "?version="
            // URLs don't create duplicate entries next to the precache.
            cache.put(event.request.url.split('?')[0], response.clone());"""
assert s.count(old) == 1
s = s.replace(old, new)

# (f) downloadOffline: local origin decl (stock references a bare global
# `origin` — a latent bug), query strip, and '/' -> './' mapping ('/' is
# path-absolute: under a subpath addAll would 404 on the domain root and
# abort the whole precache).
old = """async function downloadOffline() {
  var resources = [];"""
new = """async function downloadOffline() {
  var origin = self.location.origin + self.location.pathname.replace(/\\/[^\\/]*$/, '');
  var resources = [];"""
assert s.count(old) == 1
s = s.replace(old, new)

old = """    var key = request.url.substring(origin.length + 1);
    if (key == "") {
      key = "/";
    }
    currentContent[key] = true;"""
new = """    var key = request.url.substring(origin.length + 1);
    if (key.indexOf('?') != -1) {
      key = key.split('?')[0];
    }
    if (key == "") {
      key = "/";
    }
    currentContent[key] = true;"""
assert s.count(old) == 1
s = s.replace(old, new)

old = """    if (!currentContent[resourceKey]) {
      resources.push(resourceKey);
    }"""
new = """    if (!currentContent[resourceKey]) {
      // "/" is path-absolute: under a subpath deployment addAll would
      // fetch the domain root (404) and abort the whole precache.
      resources.push(resourceKey == '/' ? './' : resourceKey);
    }"""
assert s.count(old) == 1
s = s.replace(old, new)

# (g) precache from BOTH activate branches, detached — not awaited: awaiting
# would hold the worker in "activating" until every resource downloads,
# delaying app boot, which waits for the "activated" state. Invoked here —
# after the cache reset — it cannot race it; the page's postMessage trigger
# re-runs it as a top-up if this pass is cut short.
old = "\n        self.clients.claim();\n        return;"
new = """\n        self.clients.claim();
        // Precache the full RESOURCES list (incl. lazily-loaded codec wasm).
        // Detached, not awaited: awaiting would hold this worker in
        // "activating" until every resource downloads, delaying app boot,
        // which waits for the "activated" state. Invoked here — after the
        // cache reset above — it cannot race the reset; the page's
        // postMessage trigger re-runs it as a top-up if this pass is cut short.
        downloadOffline().catch((e) => {
          console.error('offline precache incomplete, will retry next visit: ' + e);
        });
        return;"""
assert s.count(old) == 1
s = s.replace(old, new)

old = "\n      self.clients.claim();\n      return;"
new = """\n      self.clients.claim();
      // Top up after an upgrade too (detached — see above), so one online
      // visit after a weekly rebuild restores full offline coverage.
      downloadOffline().catch((e) => {
        console.error('offline precache incomplete, will retry next visit: ' + e);
      });
      return;"""
assert s.count(old) == 1
s = s.replace(old, new)

open(p, 'w').write(s)
print('  flutter_service_worker.js: subpath origin, query strip, ignoreSearch,'
      ' bare-path put, downloadOffline fixes, activate-time precache')

# (h) cache-busters for the JS bridge (vite emits unhashed filenames).
p = 'index.html'
s = open(p).read()
for f in ('jds/index.js', 'jds/vendor.js'):
    h = hashlib.sha1(open(f, 'rb').read()).hexdigest()[:10]
    assert s.count(f) >= 1, f
    s = s.replace(f, f + '?v=' + h, 1)
open(p, 'w').write(s)
print('  index.html: ?v= busting for jds/*.js')
PYEOF
[ $? -eq 0 ] || { log "POSTBUILD_FAIL"; exit 1; }

# ---------------- verification ----------------
log "[9] inspection"
python3 - <<'PYEOF'
import json, os, re, sys
sw = open('flutter_service_worker.js').read()
ih = open('index.html').read()
mdj = open('main.dart.js', encoding='utf-8').read()
man = json.load(open('manifest.json'))

# patch markers
checks = [
  ('origin pathname.replace', sw.count('pathname.replace'), 3),
  ("query strip indexOf('?')", sw.count("indexOf('?')"), 2),
  ('ignoreSearch lookup', sw.count('ignoreSearch: true'), 1),
  ('bare-path cache.put', sw.count("url.split('?')[0]"), 1),
  ('activate precache triggers', sw.count('downloadOffline().catch'), 2),
  ('page-side precache trigger', ih.count("postMessage('downloadOffline')"), 1),
  ('jds cache-busted', ih.count('jds/index.js?v=') + ih.count('jds/vendor.js?v='), 2),
  ('firebase gone', ih.count('firebase'), 0),
  ('gstatic gone from main.dart.js', mdj.count('gstatic'), 0),
  ('canvaskit local', ih.count('canvaskit'), 0),  # no canvaskit URL in html; engine uses dart-define
]
ok = True
for name, got, want in checks:
    mark = 'OK' if got == want else '!!'
    if got != want: ok = False
    print(f'  [{mark}] {name}: {got} (want {want})')

# manifest
print(f'  [{"OK" if man["name"] == "RustDesk" and man["orientation"] == "any" else "!!"}] '
      f'manifest: {man["name"]} / {man["orientation"]}')

# every RESOURCES key on disk (addAll is atomic: one 404 aborts precache)
keys = re.findall(r'"([^"]+)": "[a-f0-9]{32}"', sw)
missing = [k for k in keys if not os.path.isfile('index.html' if k in ('/', 'index.html') else k)]
print(f'  [{"OK" if not missing else "!!"}] RESOURCES: {len(keys)} keys, missing: {missing or "none"}')
ok = ok and not missing and len(keys) == 165

sys.exit(0 if ok else 1)
PYEOF
[ $? -eq 0 ] || { log "INSPECTION_FAIL"; exit 1; }

log "[10] artifact manifest (reproducibility baseline)"
( find . -type f -print0 | sort -z | xargs -0 sha256sum ) > "$RD_DIR/artifact.sha256"
echo "  $(wc -l < "$RD_DIR/artifact.sha256") files hashed -> $RD_DIR/artifact.sha256"

echo "--- total size: $(du -sh . | cut -f1)"
log "ALL_STAGES_DONE"
