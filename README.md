# rustdesk-web

Weekly rebuild and publish of the [RustDesk](https://rustdesk.com) **1.2.5**
web client to GitHub Pages, as an **offline-capable PWA**:

**https://sloth-os.github.io/rustdesk/**

Last public release with a complete, buildable web client (`flutter/web`,
JS bridge, PWA scaffold). Later RustDesk versions made the v2 web client a
private Server-Pro product; upstream's web CI job is dead.

## What the build guarantees

One online visit makes the app fully usable offline (LAN without internet):

- **No external runtime requests.** CanvasKit and every engine fallback
  font are served from the site itself; `--no-web-resources-cdn` disables
  the engine's CDN defaults; the font-fallback URL prefix in `main.dart.js`
  is rewritten to the local `fonts/` tree. Firebase analytics is stripped.
- **Full precache.** The patched service worker precaches all 165
  `RESOURCES` entries — including the lazily-loaded codec wasm — from
  `activate()` (detached, so boot isn't blocked) with a page-side top-up.
- **Subpath-correct.** Stock flutter service-worker logic is broken under
  `/rustdesk/` (origin-derived keys, `?v=`/`?version=` query mismatch,
  path-absolute `/` in `addAll`). All fixed, with hygiene asserts in the
  build.
- **https-correct.** The stock 1.2.5 JS bridge hard-codes `ws://` and
  probes rendezvous servers at module scope; on the https Pages site
  `new WebSocket("ws://…")` throws `SecurityError`, aborting the whole
  ES-module eval — `window.init` never gets defined and the app hangs on
  the loading spinner forever. The build patches the bridge: the
  websocket schema follows the page scheme (`https:` → `wss://`), and the
  latency probe can never abort module eval. The e2e gate itself serves
  the app over https with a mixed-content canary, so this class of bug
  fails CI, not production.
- **Zero public-infrastructure traffic.** The stock bridge probes
  RustDesk's public rendezvous fleet (`rs-sg`/`rs-cn`/`rs-us.rustdesk.com`)
  at module scope, defaults ID connections to it, and falls back to
  `admin.rustdesk.com` as API server. This build empties the fleet and
  neutralises both defaults, so the page makes **no automatic requests to
  any `rustdesk.com` host** — the e2e gate fails CI on any such HTTP or
  WebSocket request. Remaining `rustdesk.com` strings are documentation
  links, opened only on click. Every connection (ID or `IP:port` — the web
  bridge has no direct-dial path) is resolved through the rendezvous
  server: set your own in the settings dialog
  (`custom-rendezvous-server`). Without one, connect attempts fail fast
  locally instead of falling back to the public fleet.
- **Deploy handoff.** Service workers update in the background
  (`skipWaiting` + `clients.claim`), but browsers never reload open tabs —
  without help, a tab open across a deploy (and the first visit after one,
  where the OLD worker still serves the cached old bridge under its
  bare-path cache key) runs the previous build for the whole session.
  `index.html` now reloads once on `controllerchange` — guarded so the
  first-visit claim never reloads mid-boot — and e2e phase 4 simulates a
  full deploy handoff.
- **Proven weekly-fresh.** Every run asserts the pinned toolchain and
  source SHAs, and the e2e gate must pass before anything is deployed.

## One-time manual step

GitHub's workflow token cannot set the Pages source. Do once:
**Settings → Pages → Build and deployment → Source = "GitHub Actions".**

## Repository layout

```
.github/workflows/pages.yml   weekly pipeline: build → e2e gate → deploy
scripts/build_web.sh          canonical build (JS bridge + flutter web + patches)
scripts/fetch_fonts.sh        download + sha256-verify pinned gstatic fonts
scripts/e2e_offline.cjs       headless-chromium offline/PWA proof (the CI gate;
 https origin + mixed-content canary)
scripts/write_build_info.py   weekly provenance record (build-info.json)
fonts/manifest.json           pinned font list (family/version/sha256/bytes)
vendor/web_deps.tar.gz        ogv.js/yuv-canvas/libopus codecs (sha256-pinned;
                              vendored — the release-asset CDN persistently
                              504s GitHub runner IPs)
build-info.json               last build's provenance (committed weekly)
provenance/artifact.sha256   per-file sha256 manifest of the deployed artifact
```

Everything is pinned: rustdesk source SHA, Flutter 3.19.6 tarball sha256,
Yarn Berry 3.6.4 cjs sha256, protoc 36.2.0 (npm), the vendored web_deps
codec tarball sha256, font files sha256. The committed `pubspec.lock`
pins the pub deps (7 git deps at locked SHAs).

The weekly `build-info.json` commit doubles as the repository activity
that keeps the scheduled workflow from being auto-disabled after 60 idle
days — deliberately not a "keepalive" action (those were TOS-disabled by
GitHub for circumventing the inactivity policy).

## Local rehearsal

```sh
scripts/fetch_fonts.sh # fonts/manifest.json -> fonts/dl/
RD_DIR=/path/to/rustdesk-worktree-1.2.5 \
USE_PATH_DEPS=1 PUBGIT_DIR=/path/to/pubgit \
FONTS_DIR=$PWD/fonts scripts/build_web.sh    # -> build/web + artifact.sha256
WEB_DIR=$RD_DIR/flutter/build/web \
NODE_PATH=/path/to/node_modules node scripts/e2e_offline.cjs
```

`USE_PATH_DEPS=1` rewrites the 7 git pub deps to local path deps — only
for sandboxes that cannot reach github.com. CI keeps the git deps.
