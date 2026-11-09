// e2e offline/PWA validation of the RustDesk web build (subpath /rustdesk/),
// served over HTTPS with a self-signed cert — like the Pages deployment.
//
// https is load-bearing, not cosmetic: a secure page forbids ws://
// WebSockets — `new WebSocket("ws://…")` throws SecurityError
// SYNCHRONOUSLY. The stock 1.2.5 bridge hard-codes ws:// and probes
// servers at module scope, so on https its ES-module eval aborted,
// window.init was never defined and the app hung on the spinner forever —
// while this gate, serving plain http://127.0.0.1 (secure context by
// localhost exemption, but NO transport mixed-content enforcement),
// passed green. Hence: https server + mixed-content canary + window.init
// liveness assert below, so that class of bug fails CI, not production.
//
// Phase 1: first visit online — SW installs, precaches every RESOURCES entry
//          (incl. lazily-loaded codec wasm); no external font/cdn requests;
//          app renders; bridge module evaluated (window.init defined).
//          Plus the runtime zero-traffic proof: the legacy
//          'rendezvous-server' key (old builds left it pointing at the
//          public fleet) is seeded, api/audit server resolution and an
//          explicit connect attempt are exercised — no rustdesk.com
//          socket or request may ever appear. That gate is three-layered:
//          playwright 'request' events, 'websocket' events (completed-
//          handshake only), and a WebSocket CONSTRUCTOR hook — an attempt
//          that fails before the upgrade fires NEITHER playwright event
//          (demonstrated against the live pre-deploy build: 3 fleet
//          constructions, 0 events). The connect attempt must fail fast
//          locally with a "Connection Error" msgbox — asserted via a stub
//          of window.onGlobalEvent, which in production Dart registers
//          only per connection session, never on the home page.
// Phase 2: HARD PATH — go offline immediately (no online reload first).
//          Reload: navigation, jds/*.js?v=, canvaskit, fonts, ogv workers
//          (?version=) must all come from cache.
// Phase 3: second offline reload — stability of the fully-cached boot.
// Phase 4: deploy handoff — mutate bridge/SW/version on disk mid-session;
//          ONE manual reload must auto-hand off (controllerchange) to the
//          new build and serve the fresh bridge, never the stale cache.
//
// Render proof is DOM-independent: canvaskit draws into a canvas inside
// flt-glass-pane's SHADOW ROOT (light-DOM querySelector cannot see it), so we
// (a) pierce shadow roots for the canvas and (b) poll distinct colors in a
// full-page screenshot until first paint. Locale zh-CN (CJK fallback font
// coverage is precached).
//
// Env:
//   WEB_DIR    build/web to serve (default /tmp/rd125/flutter/build/web)
//   CHROME_PATH  optional chromium executable (default: playwright registry)
// NODE_PATH   makes require('playwright-core') resolvable in CI
const https = require('https');
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { execFileSync } = require('child_process');

let chromium;
try { ({ chromium } = require('playwright-core')); }
catch { ({ chromium } = require('/tmp/browser-test/node_modules/playwright-core')); }

const WEB = process.env.WEB_DIR || '/tmp/rd125/flutter/build/web';
const PREFIX = '/rustdesk/';
const MIME = {'.html':'text/html; charset=utf-8','.js':'text/javascript','.mjs':'text/javascript',
 '.css':'text/css','.wasm':'application/wasm','.json':'application/json','.ttf':'font/ttf',
  '.otf':'font/otf','.svg':'image/svg+xml','.png':'image/png','.md':'text/markdown',
  '.data':'application/octet-stream'};

const req_404s = [];
const failures = [];
const t0 = Date.now();
const ts = () => `[+${String(Math.round((Date.now() - t0) / 1000)).padStart(3)}s]`;

// rendezvous/public-server connection noise — expected both in CI and in the
// LAN-without-internet deployment this build targets; the app renders the UI
// regardless.
const NOISE = /rendezvous|websocket|WebSock|CloseEvent|ws:|wss:|net::ERR|failed to fetch|offline|Flutter Web/i;

// Self-signed cert for the local https origin (openssl ships on the
// runner images; the browser ignores cert errors via the launch flag
// below, the SAN keeps the cert broadly well-formed anyway).
const certDir = fs.mkdtempSync(path.join(os.tmpdir(), 'rd-e2e-https-'));
const keyFile = path.join(certDir, 'key.pem');
const certFile = path.join(certDir, 'cert.pem');
try {
  execFileSync('openssl', ['req', '-x509', '-newkey', 'rsa:2048',
    '-keyout', keyFile, '-out', certFile, '-days', '2', '-nodes',
    '-subj', '/CN=127.0.0.1', '-addext', 'subjectAltName=IP:127.0.0.1'],
    { stdio: 'pipe' });
} catch (e) {
  console.error('E2E_SETUP_FAIL: cannot generate self-signed cert (openssl missing?):', String(e.message));
  process.exit(1);
}

const server = https.createServer(
  { key: fs.readFileSync(keyFile), cert: fs.readFileSync(certFile) },
  (req, res) => {
  let p;
  try { p = decodeURIComponent(new URL(req.url, 'http://x').pathname); }
  catch { res.writeHead(400).end('bad url'); return; }
  if (p === '/rustdesk') p = PREFIX;
  if (!p.startsWith(PREFIX)) { req_404s.push(req.url); res.writeHead(404).end('not found'); return; }
  let rel = p.slice(PREFIX.length);
  if (rel === '' || rel.endsWith('/')) rel += 'index.html';
  const file = path.normalize(path.join(WEB, rel));
  if (!file.startsWith(WEB) || !fs.statSync(file, { throwIfNoEntry: false })?.isFile()) {
    req_404s.push(req.url); res.writeHead(404).end('not found'); return; }
  res.writeHead(200, { 'content-type': MIME[path.extname(file)] || 'application/octet-stream' });
  fs.createReadStream(file).pipe(res);
});

function watch(page, tag) {
  page.on('console', (m) => { const t = m.text();
    if (m.type() !== 'error') return;
    // the live-site killer signature: an https page blocking a ws://
    // WebSocket. NOISE must not swallow this one — but the canary's own
    // deliberate ws:// construction below is expected, not a defect.
    if (/mixed content.*websocket|insecure websocket/i.test(t)) {
      if (!t.includes('mixed-content-canary'))
        failures.push(`${tag}: MIXED CONTENT — insecure WebSocket blocked: ${t.slice(0, 160)}`);
      else console.log(`${ts()} [${tag}] canary console.error (expected): ${t.slice(0, 120)}`);
    }
    else if (!NOISE.test(t))
      failures.push(`${tag}: console.error ${t.slice(0, 160)}`); });
  page.on('pageerror', (e) => { const t = String(e);
    console.log(`${ts()} [${tag} pageerror]`, t.slice(0, 220));
    if (/insecure WebSocket|SecurityError/i.test(t))
      failures.push(`${tag}: pageerror: ${t.slice(0, 160)}`); });
  page.on('requestfailed', (r) => {
    const u = r.url();
    const err = r.failure()?.errorText;
    console.log(`${ts()} [${tag} requestfailed]`, u, err);
    if (u.includes('flutter_service_worker.js')) return;  // SW update ping, expected offline
    // ERR_ABORTED is a client-side cancellation, not a load failure: the
    // phase-4 controllerchange auto-reload kills the doomed document's
    // in-flight fetches BY DESIGN (that is the handoff working — observed in
    // CI as main.dart.js aborted mid-fallback). If a cancelled resource was
    // genuinely needed, the successor document re-requests it and real
    // breakage still surfaces via the 404/render/timeout assertions.
    if (err === 'net::ERR_ABORTED') return;
    if (new URL(u).host === HOST) failures.push(`${tag}: same-origin requestfailed ${u} (${err})`);
  });
  page.on('request', (r) => { const u = r.url();
    if (/gstatic|googleapis|google\.com/.test(u)) failures.push(`${tag}: external font/cdn request ${u}`);
    // zero public-infrastructure traffic: no automatic request to any
    // rustdesk.com host may ever leave the page (docs links are click-only
    // and open in a new tab, so they never surface here)
    if (/(^|\.)rustdesk\.com$/.test(new URL(u).hostname))
      failures.push(`${tag}: request to rustdesk.com public infrastructure: ${u}`); });
  // the stock rendezvous probe uses WebSockets, which don't fire 'request'
  page.on('websocket', (ws) => {
    if (/(^|\.)rustdesk\.com$/.test(new URL(ws.url()).hostname))
      failures.push(`${tag}: WebSocket to rustdesk.com public infrastructure: ${ws.url()}`);
  });
}

// Per-document zero-traffic gate at the construction level: fail if ANY
// WebSocket to a rustdesk.com host was even CONSTRUCTED in this document
// (handshake outcome irrelevant — see the addInitScript hook rationale).
// Must be called per phase: every reload gets a fresh window, and the
// module-scope fleet probe would re-run in each document that had it.
async function wsConstructionGate(page, tag) {
  const built = await page.evaluate(() => window.__wsConstructions || []).catch(() => []);
  const fleet = built.filter((u) => {
    try { return /(^|\.)rustdesk\.com$/.test(new URL(u).hostname); }
    catch { return /rustdesk\.com/.test(u); }
  });
  console.log(`${ts()} [${tag}] WebSocket constructions: ${built.length}` +
    (fleet.length ? ` — FLEET HIT: ${JSON.stringify(fleet)}` : ''));
  if (fleet.length)
    failures.push(`${tag}: WebSocket to rustdesk.com CONSTRUCTED (regardless of handshake outcome): ${fleet.join(', ')}`);
}

async function waitBoot(page, tag, ms = 90000) {
  await page.waitForSelector('flt-glass-pane, flutter-view, body canvas', { timeout: ms });
  console.log(`${ts()} [${tag}] app shell rendered`);
  await page.waitForTimeout(4000);
}

async function cacheCount(page) {
  return page.evaluate(async () => {
    const c = await caches.open('flutter-app-cache');
    return (await c.keys()).length;
  });
}

// canvaskit's canvas lives inside flt-glass-pane's shadow root — pierce it.
async function canvasProbe(page) {
  return page.evaluate(() => {
    const find = (root) => {
      for (const el of root.querySelectorAll('*')) {
        if (el.tagName === 'CANVAS') return el;
        if (el.shadowRoot) { const c = find(el.shadowRoot); if (c) return c; }
      }
      return null;
    };
    const c = find(document);
    return c ? { w: c.width, h: c.height } : null;
  });
}

// distinct sampled colors in a full-page screenshot: a rendered RustDesk home
// screen shows >8; a stuck loading spinner or blank page shows far fewer.
async function screenshotColors(page) {
  const b64 = (await page.screenshot()).toString('base64');
  return page.evaluate(async (b64) => {
    const img = new Image(); img.src = 'data:image/png;base64,' + b64;
    await img.decode();
    const cv = document.createElement('canvas'); cv.width = img.width; cv.height = img.height;
    const cx = cv.getContext('2d', { willReadFrequently: true });
    cx.drawImage(img, 0, 0);
    const d = cx.getImageData(0, 0, cv.width, cv.height).data;
    const s = new Set();
    for (let i = 0; i < d.length; i += 160) s.add((d[i] << 16) | (d[i + 1] << 8) | d[i + 2]);
    return s.size;
  }, b64);
}

async function renderCheck(page, tag) {
  const box = await canvasProbe(page);
  // Threshold calibration (2026-11-09): nobody ever removes the index.html
  // spinner, and being positioned it paints OVER the static glass pane
  // until an opaque UI frame covers it — so glass+canvas (mere engine
  // init) and a low color count are BOTH satisfied by a dead boot (the
  // release-mode empty-container render of a build() throw looks exactly
  // like this). Observed: spinner-only screenshots 4-18 distinct colors;
  // the rendered home page 61 (headless chromium) to 73 (firefox). 30
  // separates them with wide margin.
  let colors = 0;
  const tPaint = Date.now();
  while (colors < 30 && Date.now() - tPaint < 30000) {
    colors = Math.max(colors, await screenshotColors(page));
    if (colors < 30) await page.waitForTimeout(1500);
  }
  console.log(`${ts()} [${tag}] canvas:`, JSON.stringify(box), 'screenshot colors:', colors,
    'cache:', await cacheCount(page));
  if (!box || !box.w) failures.push(`${tag}: no rendered canvas`);
  if (colors < 30) failures.push(`${tag}: screenshot has only ${colors} distinct colors (spinner/blank — app UI not rendered)`);
}

let HOST;

(async () => {
  // ---- pre-check: every RESOURCES key must exist on disk (addAll is atomic;
  // one 404 aborts the entire downloadOffline precache) ----
  const sw = fs.readFileSync(path.join(WEB, 'flutter_service_worker.js'), 'utf8');
  const keys = [...sw.matchAll(/"([^"]+)": "[a-f0-9]{32}"/g)].map((m) => m[1]);
  const EXPECT_CACHE = keys.length;
  const missing = keys.filter((k) => {
    const rel = k === '/' || k === 'index.html' ? 'index.html' : k;
    return !fs.statSync(path.join(WEB, rel), { throwIfNoEntry: false })?.isFile();
  });
  console.log(`${ts()} pre-check: ${EXPECT_CACHE} RESOURCES keys, missing on disk: ${missing.length ? missing : 'none'}`);
  if (missing.length) failures.push(`pre-check: RESOURCES missing on disk: ${missing.join(', ')}`);

  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const ORIGIN = `https://127.0.0.1:${server.address().port}`;
  HOST = new URL(ORIGIN).host;
  const APP_URL = ORIGIN + '/rustdesk/';
  console.log(`${ts()} serving ${WEB} at ${APP_URL}`);

  // --ignore-certificate-errors at the BROWSER level (context-level
  // ignoreHTTPSErrors historically misses service-worker fetches): the
  // origin stays a secure context — mixed-content enforcement is fully
  // active, which is the entire point of the https server.
  const browser = await chromium.launch({ headless: true,
    // chromium >=137 makes software WebGL opt-in; without this flag
    // canvaskit gets no GL context in headless and commits no frames at
    // all (engine "initializes", spinner stays) — the gate would test
    // nothing.
    args: ['--ignore-certificate-errors', '--enable-unsafe-swiftshader'],
    ...(process.env.CHROME_PATH ? { executablePath: process.env.CHROME_PATH } : {}) });
  // context-level too (belt-and-braces next to the browser flag above)
  const ctx = await browser.newContext({ locale: 'zh-CN', ignoreHTTPSErrors: true });
  // Pre-zero-traffic builds wrote the winning public-fleet host into
  // localStorage['rendezvous-server'] on every visit. Seed that stale key
  // for every phase: the patched bridge must ignore it entirely — proven
  // by the phase-1 connect attempt below plus the rustdesk.com gates.
  await ctx.addInitScript(() => {
    try { localStorage.setItem('rendezvous-server', 'rs-sg.rustdesk.com'); } catch {}
    // Strongest zero-traffic observation point: hook the WebSocket
    // CONSTRUCTOR. Playwright's 'websocket' event only fires for handshakes
    // that reach the upgrade — a fleet probe that fails early (DNS refused,
    // TCP reset — common from CI runners and proxies) fires NEITHER 'request'
    // NOR 'websocket' (empirically demonstrated against the live pre-deploy
    // build: 3 fleet constructions visible, 0 playwright events). The hook
    // makes attempts observable regardless of handshake outcome.
    try {
      window.__wsConstructions = [];
      const Orig = window.WebSocket;
      window.WebSocket = class extends Orig {
        constructor(url, protocols) {
          window.__wsConstructions.push(String(url));
          super(url, protocols);
        }
      };
      for (const k of ['CONNECTING', 'OPEN', 'CLOSING', 'CLOSED'])
        Object.defineProperty(window.WebSocket, k, { value: Orig[k] });
    } catch {}
  });
  const page = await ctx.newPage();

  // ---- phase 1: first visit, online ----
  watch(page, 'p1');
  await page.goto(APP_URL, { waitUntil: 'domcontentloaded' });

  // Mixed-content canary: this gate is only meaningful if the environment
  // actually enforces what killed the live site — ws:// from this https
  // page MUST throw SecurityError synchronously. If it ever stops
  // throwing (launch flag lost, scheme regressed to http), fail loudly: a
  // vacuously-green gate is worse than no gate.
  const canary = await page.evaluate(() => {
    try { new WebSocket('ws://mixed-content-canary.invalid:21118'); return 'NO_THROW'; }
    catch (e) { return (e && e.name) || String(e); }
  });
  console.log(`${ts()} [p1] mixed-content canary (ws:// from https page): ${canary}`);
  if (canary !== 'SecurityError')
    failures.push(`canary: ws:// WebSocket did not throw SecurityError on this https page (${canary}) — the gate would be blind`);

  // Bridge liveness: jds/index.js is a deferred module script, so by
  // DOMContentLoaded it has either evaluated (window.init defined) or
  // aborted mid-eval — the live-site hang, where init stayed undefined
  // forever while the spinner spun.
  const initType = await page.evaluate(() => typeof window.init);
  console.log(`${ts()} [p1] window.init: ${initType}`);
  if (initType !== 'function')
    failures.push(`p1: window.init is ${initType} at DOMContentLoaded — bridge ES-module eval aborted`);

  await waitBoot(page, 'p1');
  let n = 0;
  const tPoll = Date.now();
  while ((n = await cacheCount(page)) < EXPECT_CACHE && Date.now() - tPoll < 180000) {
    await page.waitForTimeout(2000);
  }
  console.log(`${ts()} [p1] cache entries: ${n} / expected ${EXPECT_CACHE}`);
  if (n !== EXPECT_CACHE) failures.push(`p1: cache has ${n}, expected ${EXPECT_CACHE} (downloadOffline incomplete?)`);
  console.log(`${ts()} [p1] CJK fallback font requested:`,
    await page.evaluate(() => performance.getEntriesByType('resource').some((e) => e.name.includes('/fonts/notosanssc/'))));
  await renderCheck(page, 'p1');

  // ---- phase 1b: runtime zero-traffic proof. The request/websocket gates
  // observe everything, but boot alone never exercises the paths that used
  // to phone home: resolve the api/audit servers and attempt a connect with
  // the stale legacy key seeded (no custom server configured) ----
  const apiServer = await page.evaluate(() => window.getByName('api_server'));
  const auditServer = await page.evaluate(() => window.getByName('audit_server', 'conn'));
  console.log(`${ts()} [p1] api_server=${JSON.stringify(apiServer)} audit_server=${JSON.stringify(auditServer)}`);
  if (/rustdesk\.com/.test(String(apiServer)) || /rustdesk\.com/.test(String(auditServer)))
    failures.push(`p1: api/audit server resolves to public infrastructure: ${apiServer} / ${auditServer}`);
  // The connect must fail LOCALLY (getDefaultUri() yields the invalid
  // "wss://:21118"; start()'s catch turns it into a "Connection Error"
  // msgbox) without opening any socket; if anything dials the fleet, the
  // websocket gate above fails the run.
  // Dart registers window.onGlobalEvent (web_model.dart setEventCallback)
  // some frames AFTER first paint — a connect that races ahead of it makes
  // the bridge's msgbox call throw a bare ReferenceError that reaches no one
  // (harmless, but it dirties the pageerror log and leaves the fail-fast
  // path unasserted). Wait for the registration, then instrument it so the
  // msgbox is verified positively instead of merely not-timing-out.
  // Dart registers window.onGlobalEvent only PER CONNECTION SESSION
  // (model.dart updateEventListener -> web_model.dart setEventCallback) —
  // the home/login app never does, so waiting for it is futile and an
  // unstubbed msgbox call throws a bare ReferenceError into the void.
  // Stub the callback exactly like Dart would: the fail-fast msgbox
  // becomes positively assertable.
  await page.evaluate(() => {
    const orig = window.onGlobalEvent;
    window.__globalEvents = [];
    window.onGlobalEvent = (m) => {
      window.__globalEvents.push(String(m));
      if (typeof orig === 'function') return orig(m);
    };
  });
  await page.evaluate(() => window.setByName('connect', '123456789'));
  await page.waitForTimeout(4000);
  {
    const evs = await page.evaluate(() => window.__globalEvents);
    console.log(`${ts()} [p1] global events after connect:`, JSON.stringify(evs).slice(0, 300));
    if (!evs.some((m) => m.includes('"name":"msgbox"') && m.includes('Connection Error')))
      failures.push('p1: connect without a rendezvous server produced no "Connection Error" msgbox — local fail-fast path broken');
  }
  await wsConstructionGate(page, 'p1');
  console.log(`${ts()} [p1] connect attempt done — gate saw no rustdesk.com traffic`);

  // ---- phase 2: offline IMMEDIATELY, reload (hard path) ----
  await ctx.setOffline(true);
  console.log(`${ts()} --- OFFLINE (no online reload in between) ---`);
  const p2msgs = [];
  page.on('console', (m) => p2msgs.push(m.text()));
  await page.reload({ waitUntil: 'domcontentloaded' });
  await waitBoot(page, 'p2');
  if (!p2msgs.some((t) => t.includes('Loading app from service worker.')))
    failures.push('p2: no "Loading app from service worker." line while offline (SW not controlling?)');
  await renderCheck(page, 'p2');
  await wsConstructionGate(page, 'p2');

  // ---- phase 3: second offline reload ----
  await page.reload({ waitUntil: 'domcontentloaded' });
  await waitBoot(page, 'p3');
  await renderCheck(page, 'p3');
  await wsConstructionGate(page, 'p3');

  // ---- phase 4: deploy handoff. Simulate a weekly redeploy under a live
  // session: mutate the on-disk bridge (md5 change => activate() evicts the
  // stale cache entry), the SW bytes (=> update installs), and bump
  // serviceWorkerVersion (=> index.html takes the reg.update() branch).
  // The first manual reload may still be served by the OLD worker, but its
  // one-shot controllerchange listener must auto-reload onto the NEW build
  // — no second manual reload, no session spent on the previous deploy. ----
  await ctx.setOffline(false);
  const fJds = path.join(WEB, 'jds/index.js');
  const fSw = path.join(WEB, 'flutter_service_worker.js');
  const fHtml = path.join(WEB, 'index.html');
  const backup = { jds: fs.readFileSync(fJds, 'utf8'),
    sw: fs.readFileSync(fSw, 'utf8'), html: fs.readFileSync(fHtml, 'utf8') };
  const MARKER = 'e2e-handoff-marker';
  const navs = [];
  page.on('framenavigated', (fr) => { if (fr === page.mainFrame()) navs.push(fr.url()); });
  const p4msgs = [];
  page.on('console', (m) => p4msgs.push(m.text()));
  try {
    fs.writeFileSync(fJds, backup.jds + `\n//${MARKER}\n`);
    const newMd5 = crypto.createHash('md5').update(fs.readFileSync(fJds)).digest('hex');
    const sw2 = backup.sw.replace(/("jds\/index\.js":\s*)"[a-f0-9]{32}"/, `$1"${newMd5}"`);
    if (sw2 === backup.sw) throw new Error('phase4: jds md5 anchor missing from RESOURCES');
    fs.writeFileSync(fSw, sw2 + `\n//${MARKER}\n`);
    const html2 = backup.html.replace(/serviceWorkerVersion = "(\d+)"/,
      (m, d) => `serviceWorkerVersion = "${+d + 1}"`);
    if (html2 === backup.html) throw new Error('phase4: serviceWorkerVersion anchor missing');
    const newVer = html2.match(/serviceWorkerVersion = "(\d+)"/)[1];
    fs.writeFileSync(fHtml, html2);

    navs.length = 0;
    await page.reload({ waitUntil: 'domcontentloaded' });  // the user's revisit
    // The new worker installs in the background, evicts the stale jds entry
    // (md5 manifest diff) and claims the page; the document's one-shot
    // controllerchange listener must then reload itself exactly once.
    await page.waitForFunction(
      (ver) => navigator.serviceWorker.controller &&
        navigator.serviceWorker.controller.scriptURL.endsWith(ver),
      newVer, { timeout: 60000 });
    const t4 = Date.now();
    while (navs.length < 2 && Date.now() - t4 < 30000) await page.waitForTimeout(500);
    if (navs.length < 2)
      failures.push(`p4: controllerchange auto-reload never fired (${navs.length} navigation(s)) — a deploy would leave the stale build resident all session`);
    if (!p4msgs.some((t) => t.includes('New service worker took over')))
      failures.push('p4: takeover console marker missing');
    await page.waitForLoadState('domcontentloaded');
    await waitBoot(page, 'p4');
    const fresh = await page.evaluate((mk) =>
      fetch('jds/index.js').then((r) => r.text()).then((t) => t.includes(mk)), MARKER);
    if (!fresh) failures.push('p4: post-handoff document was still served the STALE bridge (marker missing)');
    await renderCheck(page, 'p4');
    await wsConstructionGate(page, 'p4');
    console.log(`${ts()} [p4] deploy handoff complete: ${navs.length} navigations, fresh bridge served`);
  } finally {
    fs.writeFileSync(fJds, backup.jds);
    fs.writeFileSync(fSw, backup.sw);
    fs.writeFileSync(fHtml, backup.html);
  }

  await browser.close(); server.close();

  console.log(`\n${ts()} ================ RESULT ================`);
  console.log('server 404s (all phases):', req_404s.length ? req_404s : 'none');
  if (failures.length) { console.log('FAILURES:'); failures.forEach((f) => console.log('  ✗', f)); process.exitCode = 1; }
  else console.log('ALL PHASES PASSED ✓');
})().catch((e) => { console.error('E2E_CRASH', e); process.exitCode = 1; server.close(); });
