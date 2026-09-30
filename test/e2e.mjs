#!/usr/bin/env node
/**
 * End-to-end smoke test: serves the repository, drives the real page in headless Chrome at a desktop size and
 * as an iPhone (touch), and fails on the first broken expectation or on any console error.
 *
 *     PUPPETEER=/path/to/node_modules/puppeteer npm run e2e     # or with puppeteer installed: npm run e2e
 *     SHOTS=/tmp/shots npm run e2e                               # also save screenshots there
 *
 * Puppeteer is not a dependency of the game; point PUPPETEER at any install of it.
 */
import { createServer } from 'node:http';
import { mkdirSync, readFileSync, statSync } from 'node:fs';
import { createRequire } from 'node:module';
import { extname, join, normalize, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import assert from 'node:assert/strict';

const ROOT = resolve(fileURLToPath(new URL('..', import.meta.url)));
const SHOTS = process.env.SHOTS ? resolve(process.env.SHOTS) : null;
if (SHOTS) mkdirSync(SHOTS, { recursive: true });

async function loadPuppeteer() {
  const where = process.env.PUPPETEER;
  if (where) {
    const entry = createRequire(import.meta.url).resolve(resolve(where));
    return (await import(pathToFileURL(entry).href)).default;
  }
  return (await import('puppeteer')).default;
}

const TYPES = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.svg': 'image/svg+xml', '.png': 'image/png', '.json': 'application/json', '.webmanifest': 'application/manifest+json' };
function serve() {
  const server = createServer((req, res) => {
    let path = normalize(decodeURIComponent(new URL(req.url, 'http://x').pathname));
    let file = join(ROOT, path);
    if (!file.startsWith(ROOT)) return res.writeHead(403).end();
    try {
      if (statSync(file).isDirectory()) file = join(file, 'index.html');
      res.writeHead(200, { 'content-type': TYPES[extname(file)] || 'application/octet-stream', 'cache-control': 'no-store' });
      res.end(readFileSync(file));
    } catch {
      res.writeHead(404).end('not found');
    }
  });
  return new Promise((done) => server.listen(0, '127.0.0.1', () => done(server)));
}

const wait = (ms) => new Promise((r) => setTimeout(r, ms));
let passed = 0;
async function step(name, fn) {
  const t = Date.now();
  await fn();
  passed++;
  console.log(`  ok  ${name} (${Date.now() - t} ms)`);
}

const puppeteer = await loadPuppeteer();
const server = await serve();
const base = `http://127.0.0.1:${server.address().port}/`;
const browser = await puppeteer.launch({ args: ['--no-sandbox'] });
const errors = [];

async function open(viewport, label, { url = base, clean = true } = {}) {
  const context = await browser.createBrowserContext();
  const page = await context.newPage();
  page.on('console', (m) => { if (m.type() === 'error') errors.push(`${label}: ${m.text()}`); });
  page.on('pageerror', (e) => errors.push(`${label}: ${e.message}`));
  page.on('requestfailed', (r) => { if (r.url().startsWith(base)) errors.push(`${label}: failed ${r.url()}`); });
  // Record haptics instead of buzzing.
  await page.evaluateOnNewDocument(() => {
    window.__buzz = [];
    Object.defineProperty(navigator, 'vibrate', { value: (p) => { window.__buzz.push(p); return true; }, configurable: true });
  });
  await page.setViewport(viewport);
  await page.goto(url, { waitUntil: 'networkidle0' });
  if (clean) {
    await page.evaluate(() => localStorage.clear());
    await page.reload({ waitUntil: 'networkidle0' });
  }
  return { page, context };
}

const state = (page) => page.evaluate(() => window.__minesweeper.state);
const mines = (page) => page.evaluate(() => window.__minesweeper.mineIndices());
const centre = (page, i) => page.$eval(`#cell-${i}`, (el) => {
  el.scrollIntoView({ block: 'nearest', inline: 'nearest' });
  const r = el.getBoundingClientRect();
  return { x: r.x + r.width / 2, y: r.y + r.height / 2 };
});
const cls = (page, i) => page.$eval(`#cell-${i}`, (el) => el.className);
const overflowX = (page) => page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
const neighboursOf = (w, h, i) => {
  const x = i % w; const y = Math.floor(i / w); const out = [];
  for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) {
    const nx = x + dx; const ny = y + dy;
    if ((dx || dy) && nx >= 0 && ny >= 0 && nx < w && ny < h) out.push(ny * w + nx);
  }
  return out;
};
async function shot(page, name) {
  if (SHOTS) await page.screenshot({ path: join(SHOTS, `${name}.png`) });
}
async function choose(page, levelId) {
  await page.click('#btn-level');
  await page.waitForSelector('#dlg-level[open]');
  await page.click(`[data-level="${levelId}"]`);
  await page.waitForFunction(() => !document.querySelector('#dlg-level[open]'));
}

/** Find an opened number, flag its mines through `flag`, then chord it through `chord`; returns what opened. */
async function chordSomewhere(page, flag, chord) {
  const { width, height } = await state(page);
  const mineSet = new Set(await mines(page));
  const target = await page.evaluate(({ width, height, mineList }) => {
    const mineSet = new Set(mineList);
    for (const el of document.querySelectorAll('.cell.is-open')) {
      const i = Number(el.dataset.i);
      if (!/\bn\d\b/.test(el.className)) continue;
      const x = i % width; const y = Math.floor(i / width); let covered = 0;
      for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) {
        const nx = x + dx; const ny = y + dy;
        if (!(dx || dy) || nx < 0 || ny < 0 || nx >= width || ny >= height) continue;
        const j = ny * width + nx;
        const c = document.getElementById(`cell-${j}`).className;
        if (!c.includes('is-open') && !mineSet.has(j) && !c.includes('is-flag')) covered++;
      }
      if (covered > 0) return i;
    }
    return -1;
  }, { width, height, mineList: [...mineSet] });
  assert.ok(target >= 0, 'an opened number with safe covered neighbours exists');
  const around = neighboursOf(width, height, target);
  for (const j of around) if (mineSet.has(j) && !(await cls(page, j)).includes('is-flag')) await flag(j);
  const before = (await state(page)).opened;
  await chord(target);
  await wait(150);
  const after = await state(page);
  for (const j of around) if (!mineSet.has(j)) assert.match(await cls(page, j), /is-open/, `neighbour ${j} opened by chord`);
  return after.opened - before;
}

/** Open every safe cell with `open`; returns the page state after. */
async function clearBoard(page, open) {
  const mineSet = new Set(await mines(page));
  const { cells } = await page.evaluate(() => ({ cells: document.querySelectorAll('.cell').length }));
  for (let i = 0; i < cells; i++) {
    if (mineSet.has(i)) continue;
    if ((await cls(page, i)).includes('is-open')) continue;
    await open(i);
  }
  await wait(200);
  return state(page);
}

try {
  console.log('\ndesktop 1280×800');
  {
    const { page, context } = await open({ width: 1280, height: 800 }, 'desktop');
    const click = async (i, button = 'left') => { const c = await centre(page, i); await page.mouse.click(c.x, c.y, { button }); };

    await step('renders the beginner board with counters at zero', async () => {
      const s = await state(page);
      assert.deepEqual([s.width, s.height, s.mines, s.status], [9, 9, 10, 'ready']);
      assert.equal(await page.$$eval('.cell', (c) => c.length), 81);
      assert.equal(await page.$eval('#mines-left', (e) => e.textContent), '010');
      assert.equal(await page.$eval('#timer', (e) => e.textContent), '000');
      await shot(page, 'desktop-new');
    });

    await step('right click flags and unflags; the counter follows', async () => {
      await click(0, 'right');
      assert.match(await cls(page, 0), /is-flag/);
      assert.equal(await page.$eval('#mines-left', (e) => e.textContent), '009');
      await click(0, 'left');
      assert.match(await cls(page, 0), /is-flag/, 'a left click does not open a flag');
      await click(0, 'right');
      assert.doesNotMatch(await cls(page, 0), /is-flag/);
      assert.equal(await page.evaluate(() => document.querySelector('#board').dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true }))), false, 'context menu suppressed');
    });

    await step('first click is safe, opens an area and starts the clock', async () => {
      await click(40);
      const s = await state(page);
      assert.equal(s.status, 'playing');
      const m = new Set(await mines(page));
      assert.equal(m.size, 10);
      for (const j of [40, ...neighboursOf(9, 9, 40)]) assert.ok(!m.has(j), 'no mine in or around the first click');
      assert.ok(s.opened >= 9);
      await wait(1100);
      assert.notEqual(await page.$eval('#timer', (e) => e.textContent), '000');
    });

    await step('clicking a satisfied number chords', async () => {
      await chordSomewhere(page, (j) => click(j, 'right'), (i) => click(i));
    });

    await step('left+right press chords too', async () => {
      if ((await state(page)).status !== 'playing') return;
      await chordSomewhere(page, (j) => click(j, 'right'), async (i) => {
        const c = await centre(page, i);
        await page.mouse.move(c.x, c.y);
        await page.mouse.down({ button: 'left' });
        await page.mouse.down({ button: 'right' });
        await page.mouse.up({ button: 'right' });
        await page.mouse.up({ button: 'left' });
      }).catch((e) => { if (!/exists/.test(e.message)) throw e; });
    });

    await step('clearing every safe cell wins, records the time and highlights it', async () => {
      const s = await clearBoard(page, (i) => click(i));
      assert.equal(s.status, 'won');
      assert.equal(s.flags, 10);
      assert.equal(await page.$eval('#mines-left', (e) => e.textContent), '000');
      assert.match(await page.$eval('#result-title', (e) => e.textContent), /^Cleared in \d/);
      assert.equal(await page.$eval('#result', (e) => e.hidden), false);
      await wait(900);
      await shot(page, 'desktop-won');
      await page.click('#btn-scores');
      await page.waitForSelector('#dlg-scores[open]');
      assert.equal(await page.$$eval('.times li', (l) => l.length), 1);
      assert.equal(await page.$$eval('.times li.is-new', (l) => l.length), 1);
      const stats = await page.$$eval('.stats dd', (d) => d.map((x) => x.textContent));
      assert.deepEqual(stats, ['1', '1', '100%', '1', '1']);
      await wait(400);
      await shot(page, 'desktop-scores');
      await page.keyboard.press('Escape');
    });

    await step('hitting a mine loses: every mine shown, the hit one marked, wrong flags crossed', async () => {
      await page.click('#btn-restart');
      assert.equal((await state(page)).status, 'ready');
      await click(40);
      const m = await mines(page);
      const safeCovered = await page.evaluate((mineList) => [...document.querySelectorAll('.cell:not(.is-open)')].map((e) => Number(e.dataset.i)).filter((i) => !mineList.includes(i)), m);
      if (safeCovered.length) await click(safeCovered[0], 'right'); // a wrong flag
      await click(m[0]);
      const s = await state(page);
      assert.equal(s.status, 'lost');
      assert.equal(await page.$$eval('.cell.is-hit', (c) => c.length), 1);
      assert.match(await cls(page, m[0]), /is-hit/);
      assert.equal(await page.$$eval('.cell.is-mine', (c) => c.length), 10);
      if (safeCovered.length) assert.match(await cls(page, safeCovered[0]), /is-wrong/);
      assert.equal(await page.$eval('#result-title', (e) => e.textContent), 'Mine hit');
      await click(m[1]);
      assert.equal((await state(page)).status, 'lost', 'the board is frozen');
      await wait(900);
      await shot(page, 'desktop-lost');
    });

    await step('keyboard: arrows move, F flags, Space opens, N restarts', async () => {
      await page.keyboard.press('n');
      await page.focus('#board');
      await page.keyboard.press('ArrowRight');
      await page.keyboard.press('f');
      const flagged = await page.$$eval('.cell.is-flag', (c) => c.map((e) => Number(e.dataset.i)));
      assert.deepEqual(flagged, [41]);
      await page.keyboard.press('ArrowDown');
      await page.keyboard.press('Space');
      assert.equal((await state(page)).status, 'playing');
      assert.match(await cls(page, 50), /is-open/);
    });

    await step('difficulty and settings persist; an unfinished game is resumed after a reload', async () => {
      await choose(page, 'intermediate');
      assert.deepEqual(Object.values(await state(page)).slice(0, 3), ['ready', 16, 16]);
      await page.click('#btn-settings');
      await page.click('label:has(#set-question)');
      await page.keyboard.press('Escape');
      await click(100);
      const before = await state(page);
      await page.reload({ waitUntil: 'networkidle0' });
      const after = await state(page);
      assert.equal(after.level, 'intermediate');
      assert.equal(after.status, 'playing');
      assert.equal(after.opened, before.opened);
      assert.equal(await page.$eval('#set-question', (e) => e.checked), true);
      const covered = await page.$eval('.cell:not(.is-open)', (e) => Number(e.dataset.i));
      await click(covered, 'right');
      await click(covered, 'right');
      assert.match(await cls(page, covered), /is-question/, 'question marks setting applies');
      await click(covered, 'right');
      assert.doesNotMatch(await cls(page, covered), /is-question|is-flag/);
      // abandoning it counts as a game played
      await page.click('#btn-restart');
      await page.click('#btn-scores');
      await page.click('[data-bucket="intermediate"]');
      assert.equal(await page.$eval('.stats dd', (d) => d.textContent), '1');
      await page.keyboard.press('Escape');
    });

    await step('expert fits a desktop window untransposed; custom boards are clamped', async () => {
      await choose(page, 'expert');
      const s = await state(page);
      assert.deepEqual([s.width, s.height, s.mines, s.layout.transposed], [30, 16, 99, false]);
      assert.equal(await overflowX(page), 0);
      await shot(page, 'desktop-expert');
      await page.click('#btn-level');
      await page.click('[data-level="custom"]');
      await page.$eval('#custom-width', (e) => { e.value = '3'; });
      await page.$eval('#custom-height', (e) => { e.value = '500'; });
      await page.$eval('#custom-mines', (e) => { e.value = '99999'; });
      await page.click('#custom-form button[type=submit]');
      const c = await state(page);
      assert.deepEqual([c.width, c.height, c.mines, c.level], [5, 40, 191, 'custom']);
    });

    await step('the old address forwards to the game', async () => {
      await page.goto(`${base}minesweeper/index.html`, { waitUntil: 'networkidle0' });
      assert.equal(new URL(page.url()).pathname, '/');
      assert.ok(await page.$('#board .cell'));
    });
    await context.close();
  }

  console.log('\niPhone 390×844, touch');
  {
    const phone = { width: 390, height: 844, isMobile: true, hasTouch: true, deviceScaleFactor: 3 };
    const { page, context } = await open(phone, 'mobile');
    const tap = async (i) => { const c = await centre(page, i); await page.touchscreen.tap(c.x, c.y); await wait(30); };
    const longPress = async (i, ms = 450) => {
      const c = await centre(page, i);
      await page.touchscreen.touchStart(c.x, c.y);
      await wait(ms);
      await page.touchscreen.touchEnd();
      await wait(30);
    };

    await step('beginner and intermediate fit the width; expert turns to 16 × 30', async () => {
      assert.equal(await overflowX(page), 0);
      let s = await state(page);
      assert.ok(s.layout.cell >= 36, `beginner cells are ${s.layout.cell}px`);
      for (const [id, cols] of [['intermediate', 16], ['expert', 16]]) {
        await choose(page, id);
        s = await state(page);
        assert.equal(s.layout.cols, cols);
        assert.equal(await overflowX(page), 0, `${id}: no horizontal page overflow`);
        const board = await page.$eval('#board', (b) => b.getBoundingClientRect().width);
        assert.ok(board <= 390, `${id}: board ${board}px wide fits`);
        assert.ok(s.layout.cell >= 20, `${id}: cells ${s.layout.cell}px`);
      }
      assert.equal((await state(page)).layout.transposed, true);
      await tap(15 * 30 + 3);
      await wait(600);
      await shot(page, 'mobile-expert');
      await choose(page, 'beginner');
    });

    await step('tap opens; long press flags with a buzz and no context menu', async () => {
      await tap(40);
      assert.equal((await state(page)).status, 'playing');
      const m = await mines(page);
      const covered = await page.$$eval('.cell:not(.is-open)', (c) => c.map((e) => Number(e.dataset.i)));
      const mineCell = m.find((i) => covered.includes(i));
      await longPress(mineCell);
      assert.match(await cls(page, mineCell), /is-flag/);
      assert.equal((await state(page)).flags, 1);
      assert.deepEqual(await page.evaluate(() => window.__buzz), [12]);
      await tap(mineCell);
      assert.match(await cls(page, mineCell), /is-flag/, 'a tap never opens a flag');
      await longPress(mineCell);
      assert.doesNotMatch(await cls(page, mineCell), /is-flag/, 'long press again removes it');
      const safe = covered.find((i) => !m.includes(i));
      await longPress(safe, 120);
      assert.match(await cls(page, safe), /is-open/, 'a short press is a tap and opens');
    });

    await step('flag mode swaps tap and long press', async () => {
      await page.click('#btn-restart');
      await tap(40);
      const m = await mines(page);
      const covered = await page.$$eval('.cell:not(.is-open)', (c) => c.map((e) => Number(e.dataset.i)));
      const target = m.find((i) => covered.includes(i));
      await page.tap('#btn-flag-mode');
      assert.equal(await page.$eval('#btn-flag-mode', (b) => b.getAttribute('aria-pressed')), 'true');
      await tap(target);
      assert.match(await cls(page, target), /is-flag/, 'flag mode: tap flags');
      await tap(target);
      assert.doesNotMatch(await cls(page, target), /is-flag/, 'flag mode: tap again unflags');
      const safe = covered.find((i) => !m.includes(i));
      await longPress(safe);
      assert.match(await cls(page, safe), /is-open/, 'flag mode: long press opens');
      await page.tap('#btn-flag-mode');
      assert.equal(await page.$eval('#btn-flag-mode', (b) => b.getAttribute('aria-pressed')), 'false');
    });

    await step('tapping a satisfied number opens the rest around it', async () => {
      await chordSomewhere(page, (j) => longPress(j), (i) => tap(i));
      await shot(page, 'mobile-play');
    });

    await step('a won game lands on the scoreboard, highlighted', async () => {
      const s = await clearBoard(page, tap);
      assert.equal(s.status, 'won');
      await wait(900);
      await shot(page, 'mobile-won');
      await page.tap('#btn-scores');
      await page.waitForSelector('#dlg-scores[open]');
      await wait(400);
      assert.equal(await page.$$eval('.times li.is-new', (l) => l.length), 1);
      assert.equal(await overflowX(page), 0);
      await shot(page, 'mobile-scores');
    });

    await step('edge fades show on the sides with more board, follow the scroll, and take no taps', async () => {
      await page.keyboard.press('Escape');
      const fades = () => page.$eval('#board-frame', (f) => ['Top', 'Bottom', 'Left', 'Right'].filter((k) => f.dataset[`fade${k}`] === '1').join(' '));
      const scrollTo = async (fx, fy) => {
        await page.$eval('#board-area', (a, fx, fy) => { a.scrollLeft = (a.scrollWidth - a.clientWidth) * fx; a.scrollTop = (a.scrollHeight - a.clientHeight) * fy; }, fx, fy);
        await wait(80);
      };
      await choose(page, 'beginner');
      assert.equal(await fades(), '', 'a board that fits has none');
      await page.click('#btn-level');
      await page.waitForSelector('#dlg-level[open]');
      await page.$eval('[data-level="custom"]', (b) => b.click()); // the bottom sheet may need scrolling to it
      await page.$eval('#custom-width', (e) => { e.value = '40'; });
      await page.$eval('#custom-height', (e) => { e.value = '40'; });
      await page.$eval('#custom-mines', (e) => { e.value = '150'; });
      await page.$eval('#custom-form button[type=submit]', (b) => b.click());
      await page.waitForFunction(() => !document.querySelector('#dlg-level[open]'));
      await wait(200);
      await scrollTo(0, 0);
      assert.equal(await fades(), 'Bottom Right', 'at the start');
      await scrollTo(0.5, 0.5);
      assert.equal(await fades(), 'Top Bottom Left Right', 'in the middle');
      await scrollTo(1, 1);
      assert.equal(await fades(), 'Top Left', 'at the end');
      // The fade is over the edge cells, and a tap there still reaches the cell.
      const under = await page.evaluate(() => {
        const a = document.getElementById('board-area').getBoundingClientRect();
        return document.elementFromPoint(a.left + 8, a.top + a.height / 2).closest('.cell') !== null;
      });
      assert.ok(under, 'the cell under the left fade is what a tap hits');
      await choose(page, 'beginner');
      assert.equal(await fades(), '', 'none again once it fits');
    });

    await step('the page never scrolls sideways, in portrait or landscape', async () => {
      await page.keyboard.press('Escape');
      await page.setViewport({ ...phone, width: 844, height: 390 });
      await wait(300);
      assert.equal(await overflowX(page), 0);
      for (const id of ['beginner', 'intermediate']) {
        await choose(page, id);
        assert.equal(await overflowX(page), 0, `${id} landscape`);
      }
      await tap(8 * 16 + 8);
      await wait(600);
      await shot(page, 'mobile-landscape');
      const small = { width: 320, height: 568, isMobile: true, hasTouch: true, deviceScaleFactor: 2 };
      await page.setViewport(small);
      await choose(page, 'beginner');
      assert.equal(await overflowX(page), 0, 'a 320 px phone');
    });
    await context.close();
  }

  assert.deepEqual(errors, [], 'no console errors');
  console.log(`\n${passed} checks passed, no console errors.\n`);
} catch (error) {
  console.error('\nFAILED:', error.message);
  if (errors.length) console.error('console errors:', errors);
  process.exitCode = 1;
} finally {
  await browser.close();
  server.close();
}
