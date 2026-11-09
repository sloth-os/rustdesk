// e2e offline/PWA validation of the RustDesk web build (subpath /rustdesk/).
//
// Phase 1: first visit online — SW installs, precaches every RESOURCES entry
//          (incl. lazily-loaded codec wasm); no external font/cdn requests;
//          app renders.
// Phase 2: HARD PATH — go offline immediately (no online reload first).
//          Reload: navigation, jds/*.js?v=, canvaskit, fonts, ogv workers
//          (?version=) must all come from cache.
// Phase 3: second offline reload — stability of the fully-cached boot.
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
const http = require('http');
const fs = require('fs');
const path = require('path');

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

const server = http.createServer((req, res) => {
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
    if (m.type() === 'error' && !NOISE.test(t))
      failures.push(`${tag}: console.error ${t.slice(0, 160)}`); });
  page.on('pageerror', (e) => console.log(`${ts()} [${tag} pageerror]`, String(e).slice(0, 220)));
  page.on('requestfailed', (r) => {
    const u = r.url();
    console.log(`${ts()} [${tag} requestfailed]`, u, r.failure()?.errorText);
    if (u.includes('flutter_service_worker.js')) return;  // SW update ping, expected offline
    if (new URL(u).host === HOST) failures.push(`${tag}: same-origin requestfailed ${u} (${r.failure()?.errorText})`);
  });
  page.on('request', (r) => { const u = r.url();
    if (/gstatic|googleapis|google\.com/.test(u)) failures.push(`${tag}: external font/cdn request ${u}`); });
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
  // first paint can land a few frames after boot — poll until the canvas
  // actually has pixels (up to 30s).
  let colors = 0;
  const tPaint = Date.now();
  while (colors < 8 && Date.now() - tPaint < 30000) {
    colors = Math.max(colors, await screenshotColors(page));
    if (colors < 8) await page.waitForTimeout(1500);
  }
  console.log(`${ts()} [${tag}] canvas:`, JSON.stringify(box), 'screenshot colors:', colors,
    'cache:', await cacheCount(page));
  if (!box || !box.w) failures.push(`${tag}: no rendered canvas`);
  if (colors < 8) failures.push(`${tag}: screenshot has only ${colors} distinct colors (app not rendered?)`);
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
  const ORIGIN = `http://127.0.0.1:${server.address().port}`;
  HOST = new URL(ORIGIN).host;
  const APP_URL = ORIGIN + '/rustdesk/';
  console.log(`${ts()} serving ${WEB} at ${APP_URL}`);

  const browser = await chromium.launch({ headless: true,
    ...(process.env.CHROME_PATH ? { executablePath: process.env.CHROME_PATH } : {}) });
  const ctx = await browser.newContext({ locale: 'zh-CN' });
  const page = await ctx.newPage();

  // ---- phase 1: first visit, online ----
  watch(page, 'p1');
  await page.goto(APP_URL, { waitUntil: 'domcontentloaded' });
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

  // ---- phase 3: second offline reload ----
  await page.reload({ waitUntil: 'domcontentloaded' });
  await waitBoot(page, 'p3');
  await renderCheck(page, 'p3');

  await browser.close(); server.close();

  console.log(`\n${ts()} ================ RESULT ================`);
  console.log('server 404s (all phases):', req_404s.length ? req_404s : 'none');
  if (failures.length) { console.log('FAILURES:'); failures.forEach((f) => console.log('  ✗', f)); process.exitCode = 1; }
  else console.log('ALL PHASES PASSED ✓');
})().catch((e) => { console.error('E2E_CRASH', e); process.exitCode = 1; server.close(); });
