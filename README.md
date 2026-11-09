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
scripts/e2e_offline.cjs       headless-chromium offline/PWA proof (the CI gate)
scripts/write_build_info.py   weekly provenance record (build-info.json)
fonts/manifest.json           pinned font list (family/version/sha256/bytes)
build-info.json               last build's provenance (committed weekly)
provenance/artifact.sha256   per-file sha256 manifest of the deployed artifact
```

Everything is pinned: rustdesk source SHA, Flutter 3.19.6 tarball sha256,
Yarn Berry 3.6.4 cjs sha256, protoc 36.2.0 (npm), web_deps codec tarball
sha256, font files sha256. The committed `pubspec.lock` pins the pub deps
(7 git deps at locked SHAs).

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
