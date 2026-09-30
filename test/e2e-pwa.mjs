#!/usr/bin/env node
/**
 * The installable app, end to end, the way it is served in production: the repository at /minesweeper/ with the
 * real API proxied at /minesweeper/api/ and no-cache headers like nginx's. In headless Chrome it checks that
 *
 *   - the manifest parses with no installability errors (Chrome's own check, what Lighthouse reports),
 *   - the service worker registers and controls the page, and never serves or caches /api/,
 *   - with the server gone entirely, a reload still launches, marks itself offline and plays a game to a win,
 *   - navigations fall back to the game, and an update waits while a game is in progress, then applies.
 *
 *     PUPPETEER=/path/to/node_modules/puppeteer npm run e2e:pwa     # SHOTS=dir to also save screenshots
 */
import { createServer, request as httpRequest } from 'node:http';
import { spawn } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, statSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { extname, join, normalize, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import assert from 'node:assert/strict';

const ROOT = resolve(fileURLToPath(new URL('..', import.meta.url)));
const SHOTS = process.env.SHOTS ? resolve(process.env.SHOTS) : null;
if (SHOTS) mkdirSync(SHOTS, { recursive: true });
const PREFIX = '/minesweeper/';

async function loadPuppeteer() {
  const where = process.env.PUPPETEER;
  if (where) return (await import(pathToFileURL(createRequire(import.meta.url).resolve(resolve(where))).href)).default;
  return (await import('puppeteer')).default;
}

const TYPES = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.svg': 'image/svg+xml', '.png': 'image/png', '.webmanifest': 'application/manifest+json' };
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const hits = []; // every request that reached the static server or the API
let swSuffix = ''; // appended to sw.js to publish a "new version"

// The API, for real, on a throwaway database.
const apiPort = 39000 + Math.floor(Math.random() * 900);
const api = spawn(process.execPath, [join(ROOT, 'server/src/index.js')], {
  env: { ...process.env, PORT: String(apiPort), DB_PATH: join(mkdtempSync(join(tmpdir(), 'ms-pwa-')), 'scores.db'), EXTRA_ORIGINS: 'http://127.0.0.1' },
  stdio: 'ignore',
});

const sockets = new Set();
const server = createServer((req, res) => {
  const path = new URL(req.url, 'http://x').pathname;
  hits.push(path);
  if (path.startsWith(`${PREFIX}api/`)) {
    const up = httpRequest({ host: '127.0.0.1', port: apiPort, path: req.url.slice(`${PREFIX}api`.length), method: req.method, headers: req.headers }, (r) => {
      res.writeHead(r.statusCode, r.headers);
      r.pipe(res);
    });
    up.on('error', () => res.writeHead(502).end());
    req.pipe(up);
    return;
  }
  if (!path.startsWith(PREFIX)) return res.writeHead(404).end();
  let file = join(ROOT, normalize(decodeURIComponent(path.slice(PREFIX.length - 1))));
  if (!file.startsWith(ROOT)) return res.writeHead(403).end();
  try {
    if (statSync(file).isDirectory()) file = join(file, 'index.html');
    let body = readFileSync(file);
    if (file.endsWith('sw.js')) body = Buffer.concat([body, Buffer.from(swSuffix)]);
    res.writeHead(200, { 'content-type': TYPES[extname(file)] || 'application/octet-stream', 'cache-control': 'no-cache' });
    res.end(body);
  } catch {
    res.writeHead(404).end('not found');
  }
});
server.on('connection', (s) => { sockets.add(s); s.on('close', () => sockets.delete(s)); });
const listen = (port = 0) => new Promise((done) => server.listen(port, '127.0.0.1', () => done(server.address().port)));
const unplug = () => new Promise((done) => { server.close(done); for (const s of sockets) s.destroy(); });

let passed = 0;
async function step(name, fn) {
  const t = Date.now();
  await fn();
  passed++;
  console.log(`  ok  ${name} (${Date.now() - t} ms)`);
}

const port = await listen();
const origin = `http://127.0.0.1:${port}`;
const url = `${origin}${PREFIX}`;
for (let i = 0; i < 50; i++) { // the API is up when its health check answers
  try { if ((await fetch(`http://127.0.0.1:${apiPort}/health`)).ok) break; } catch { /* starting */ }
  await wait(100);
}

const puppeteer = await loadPuppeteer();
const browser = await puppeteer.launch({ args: ['--no-sandbox'] });
const errors = [];
let offline = false;

// The default context, not an incognito one: Chrome does not offer installs from incognito.
const page = await browser.newPage();
page.on('pageerror', (e) => errors.push(e.message));
page.on('console', (m) => { if (m.type() === 'error' && !offline) errors.push(m.text()); });
const apiResponses = [];
page.on('response', (r) => { if (r.url().includes('/api/')) apiResponses.push({ url: r.url(), sw: r.fromServiceWorker() }); });
// Point the page at the proxied API (on eliasv.com that is the default).
await page.evaluateOnNewDocument(() => {
  try { if (localStorage.getItem('minesweeper-js:api') === null) localStorage.setItem('minesweeper-js:api', '/minesweeper/api'); } catch { /* not the game */ }
});
await page.setViewport({ width: 390, height: 844, deviceScaleFactor: 2, isMobile: true, hasTouch: true });

const state = () => page.evaluate(() => window.__minesweeper.state);
const net = () => page.$eval('#net', (el) => el.dataset.state);
/** A finger tap on a cell (the page is a touch phone; mouse clicks are not how it is played there). */
async function tap(i) {
  const c = await page.$eval(`#cell-${i}`, (el) => {
    el.scrollIntoView({ block: 'nearest', inline: 'nearest' });
    const r = el.getBoundingClientRect();
    return { x: r.x + r.width / 2, y: r.y + r.height / 2 };
  });
  await page.touchscreen.tap(c.x, c.y);
  await wait(30);
}
async function winLocally() {
  // First click in the middle, then every safe cell the game says is still covered.
  const s = await state();
  await tap(Math.floor(s.height / 2) * s.width + Math.floor(s.width / 2));
  await page.waitForFunction(() => window.__minesweeper.state.opened > 0 && !window.__minesweeper.pending, { timeout: 5000 });
  const mines = new Set(await page.evaluate(() => window.__minesweeper.mineIndices()));
  for (let i = 0; i < s.width * s.height; i++) {
    if (mines.has(i)) continue;
    if (await page.$eval(`#cell-${i}`, (el) => el.classList.contains('is-open'))) continue;
    await tap(i);
    if ((await state()).status !== 'playing') break;
  }
  await page.waitForFunction(() => window.__minesweeper.state.status === 'won', { timeout: 5000 });
}

try {
  console.log(`\nPWA at ${url} (API proxied to :${apiPort})`);

  await step('the manifest is valid and installable (no installability errors)', async () => {
    await page.goto(url, { waitUntil: 'networkidle0' });
    const cdp = await page.createCDPSession();
    const manifest = await cdp.send('Page.getAppManifest');
    assert.equal(manifest.url, `${url}manifest.webmanifest`);
    assert.deepEqual(manifest.errors, [], 'manifest parse errors');
    const parsed = manifest.parsed || JSON.parse(manifest.data);
    assert.equal(parsed.name ?? JSON.parse(manifest.data).name, 'Minesweeper');
    await page.waitForFunction(() => navigator.serviceWorker.controller);
    const { installabilityErrors } = await cdp.send('Page.getInstallabilityErrors');
    assert.deepEqual(installabilityErrors, [], JSON.stringify(installabilityErrors));
    const m = JSON.parse(manifest.data);
    assert.equal(new URL(m.start_url, manifest.url).href, url);
    assert.equal(new URL(m.scope, manifest.url).href, url);
    assert.equal(await page.title(), 'Minesweeper');
  });

  await step('the service worker registers, controls the page and precaches the shell', async () => {
    const info = await page.evaluate(async () => {
      const reg = await navigator.serviceWorker.ready;
      const keys = await caches.keys();
      const shell = keys.find((k) => k.startsWith('minesweeper-shell-'));
      const urls = (await (await caches.open(shell)).keys()).map((r) => new URL(r.url).pathname);
      return { scope: reg.scope, controlled: !!navigator.serviceWorker.controller, script: navigator.serviceWorker.controller.scriptURL, keys, urls };
    });
    assert.equal(info.scope, url);
    assert.ok(info.controlled);
    assert.equal(info.script, `${url}sw.js`);
    assert.equal(info.keys.filter((k) => k.startsWith('minesweeper-shell-')).length, 1, 'one shell cache');
    for (const p of ['', 'minesweeper/app.js', 'minesweeper/pwa.js', 'manifest.webmanifest', 'favicon.svg']) assert.ok(info.urls.includes(PREFIX + p), p);
  });

  await step('ranked play talks to the API over the network only; nothing of it is cached', async () => {
    await page.reload({ waitUntil: 'networkidle0' }); // now under the worker's control from the start
    await page.waitForFunction(() => document.querySelector('#net').dataset.state === 'ok', { timeout: 8000 });
    const s = await state();
    await tap(Math.floor(s.height / 2) * s.width + Math.floor(s.width / 2));
    await page.waitForFunction(() => window.__minesweeper.state.opened > 0 && !window.__minesweeper.pending, { timeout: 8000 });
    assert.ok(apiResponses.length >= 2, 'the API was called');
    assert.ok(apiResponses.every((r) => !r.sw), 'no API response came from the service worker');
    const cached = await page.evaluate(async () => {
      const all = [];
      for (const k of await caches.keys()) for (const r of await (await caches.open(k)).keys()) all.push(r.url);
      return all;
    });
    assert.ok(!cached.some((u) => u.includes('/api/')), 'no API response in any cache');
    assert.ok(hits.some((h) => h.startsWith(`${PREFIX}api/games`)), 'moves reached the API');
  });

  await step('an update waits while a game is in progress, and applies once it is over', async () => {
    // A local game here, so the test knows where the mines are.
    await page.evaluate(() => localStorage.setItem('minesweeper-js:api', ''));
    await page.reload({ waitUntil: 'networkidle0' });
    const s = await state();
    await tap(Math.floor(s.height / 2) * s.width + Math.floor(s.width / 2));
    await page.waitForFunction(() => window.__minesweeper.state.status === 'playing', { timeout: 5000 });
    const loaded = await page.evaluate(() => performance.timeOrigin);
    swSuffix = '\n// next version\n';
    await page.evaluate(() => navigator.serviceWorker.getRegistration().then((r) => r.update()));
    await page.waitForFunction(async () => !!(await navigator.serviceWorker.getRegistration()).waiting, { timeout: 8000 });
    await wait(300);
    assert.equal((await state()).status, 'playing');
    assert.ok(await page.$eval('#btn-update', (b) => b.hidden), 'no hint mid-game');
    await page.$eval('#btn-update', (b) => b.click()); // even a click on the hidden button does nothing now
    await wait(300);
    assert.equal(await page.evaluate(() => performance.timeOrigin), loaded, 'no reload mid-game');
    await winLocally();
    await page.waitForFunction(() => !document.getElementById('btn-update').hidden, { timeout: 4000 });
    if (SHOTS) await page.screenshot({ path: join(SHOTS, 'pwa-update-ready.png') });
    await Promise.all([page.waitForNavigation({ waitUntil: 'networkidle0' }), page.click('#btn-update')]);
    assert.notEqual(await page.evaluate(() => performance.timeOrigin), loaded, 'reloaded into the new version');
    const keys = await page.evaluate(() => caches.keys());
    assert.equal(keys.filter((k) => k.startsWith('minesweeper-shell-')).length, 1, 'the old shell cache is gone');
    assert.ok(await page.evaluate(async () => !(await navigator.serviceWorker.getRegistration()).waiting));
    swSuffix = '';
    await page.evaluate(() => localStorage.setItem('minesweeper-js:api', '/minesweeper/api'));
  });

  await step('offline (server gone): a reload launches from the cache, says offline, and plays to a win', async () => {
    await page.reload({ waitUntil: 'networkidle0' });
    await page.waitForFunction(() => document.querySelector('#net').dataset.state === 'ok', { timeout: 8000 });
    offline = true;
    await unplug();
    api.kill();
    await page.reload({ waitUntil: 'load' });
    await page.waitForFunction(() => window.__minesweeper && document.querySelectorAll('.cell').length > 0);
    assert.equal(await page.title(), 'Minesweeper');
    await page.waitForFunction(() => document.querySelector('#net').dataset.state === 'bad', { timeout: 10000 });
    if (SHOTS) await page.screenshot({ path: join(SHOTS, 'pwa-offline.png') });
    await winLocally();
    assert.match(await page.$eval('#result-title', (el) => el.textContent), /Cleared in/);
  });

  await step('offline navigations fall back to the game', async () => {
    await page.goto(`${url}minesweeper/`, { waitUntil: 'load' });
    await page.waitForFunction((u) => location.href.startsWith(u) && document.querySelectorAll('.cell').length > 0, {}, url);
    assert.equal(new URL(page.url()).pathname, PREFIX);
    await page.goto(`${url}?from=homescreen`, { waitUntil: 'load' });
    await page.waitForFunction(() => document.querySelectorAll('.cell').length > 0);
  });

  assert.deepEqual(errors, [], 'no page errors');
  console.log(`\n${passed} checks passed.\n`);
} catch (error) {
  console.error('\nFAILED:', error.message);
  if (errors.length) console.error('errors:', errors);
  process.exitCode = 1;
} finally {
  await browser.close();
  api.kill();
  server.close();
}
