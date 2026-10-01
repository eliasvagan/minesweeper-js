#!/usr/bin/env node
/**
 * End-to-end smoke test: serves the repository, drives the real page in headless Chrome at a desktop size and
 * as an iPhone (touch), and fails on the first broken expectation or on any console error.
 *
 *     PUPPETEER=/path/to/node_modules/puppeteer npm run e2e     # or with puppeteer installed: npm run e2e
 *     SHOTS=/tmp/shots npm run e2e                               # also save screenshots there
 *
 * Puppeteer is not a dependency of the game; point PUPPETEER at any install of it.
 *
 * There is no API here (apiBase() is null on 127.0.0.1), so every game is local, and the test reads where the mines
 * are through window.__minesweeper. Ranked play is test/e2e-live.mjs's job; one step here fakes the API's answers
 * (request interception) only to see what the page does in a ranked game: no hints, and the variant it asks for.
 *
 * The no-guess, hint and look-back steps check the page against engine.js run here in Node: the board the page laid
 * is rebuilt from its mines and must be solvable by logic, and a forced-guess position is built here and resumed.
 */
import { createServer } from 'node:http';
import { mkdirSync, readFileSync, statSync } from 'node:fs';
import { createRequire } from 'node:module';
import { extname, join, normalize, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import assert from 'node:assert/strict';
import {
  DIFFICULTIES, OPEN, analyze, bbbv, computeAdjacent, createGame, mulberry32, placeMines, reveal, serialize, solvesByLogic,
} from '../minesweeper/engine.js';

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

/** A page in a browser context of its own, its console errors collected; `clean` starts it on empty storage. */
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

/** The page's board, rebuilt here from its mines (for engine.js to judge). */
async function boardOf(page) {
  const s = await state(page);
  const g = createGame({ width: s.width, height: s.height, mines: s.mines });
  for (const i of await mines(page)) g.mine[i] = 1;
  computeAdjacent(g);
  return g;
}
const saved = (page) => page.evaluate(() => JSON.parse(localStorage.getItem('minesweeper-js:v1') || '{}'));
async function toggleSetting(page, id) {
  await page.click('#btn-settings');
  await page.waitForSelector('#dlg-settings[open]');
  await page.click(`label:has(#${id})`);
  await page.keyboard.press('Escape');
  await page.waitForFunction(() => !document.querySelector('#dlg-settings[open]'));
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
      }).catch((e) => { if (!/exists/.test(e.message)) throw e; }); // no number left to chord is not a failure
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

    await step('no guessing: the setting deals a board that logic alone clears from the first click', async () => {
      await choose(page, 'intermediate');
      await toggleSetting(page, 'set-noguess'); // nothing played yet, so it applies at once
      assert.equal((await saved(page)).settings.noGuess, true);
      assert.equal(await page.evaluate(() => window.__minesweeper.noGuess), true);
      assert.equal(await page.$eval('#level-variant', (e) => e.hidden), false, 'the level line says so');
      assert.match(await page.$eval('#btn-level', (e) => e.getAttribute('aria-label')), /no guessing/);
      const first = 8 * 16 + 8;
      await click(first);
      assert.equal(await page.evaluate(() => window.__minesweeper.noGuess), true, 'no fallback at this density');
      assert.equal(solvesByLogic(await boardOf(page), first), true, 'engine.js agrees: no guess needed');
    });

    await step('an avoidable loss: the verdict leads, one safe cell is marked, and D opens the details', async () => {
      // A no-guess board always has a provably safe cell, so opening a mine here is always avoidable.
      const m = await mines(page);
      const covered = await page.$$eval('.cell:not(.is-open)', (c) => c.map((e) => Number(e.dataset.i)));
      await click(m.find((i) => covered.includes(i)));
      assert.equal((await state(page)).status, 'lost');
      assert.match(await page.$eval('#result-detail', (e) => e.textContent), /^Avoidable · \d+% cleared$/);
      const marked = await page.$$eval('.cell.is-mark', (c) => c.map((e) => Number(e.dataset.i)));
      assert.equal(marked.length, 1, 'one safe cell marked');
      assert.ok(!m.includes(marked[0]), 'and it is safe');
      assert.match(await page.$eval(`#cell-${marked[0]}`, (e) => e.getAttribute('aria-label')), /was safe/);
      assert.match(await page.$eval('#announce', (e) => e.textContent), /was safe for sure/);
      assert.equal(await page.$eval('#result-panel', (e) => e.hidden), true, 'details only on demand');
      await page.keyboard.press('d');
      assert.equal(await page.$eval('#result-panel', (e) => e.hidden), false);
      assert.equal(await page.$eval('#btn-details', (e) => e.getAttribute('aria-expanded')), 'true');
      assert.match(await page.$eval('#result-panel', (e) => e.textContent), /safe for sure.*chance of a mine|was a mine for sure/);
      await shot(page, 'desktop-lost-details');
      await page.keyboard.press('Escape');
      assert.equal(await page.$eval('#result-panel', (e) => e.hidden), true, 'Escape puts them away');
    });

    await step('hint: a provably safe cell; the game is marked, and its win keeps no best time', async () => {
      await page.click('#btn-again');
      await page.keyboard.press('h');
      assert.match(await page.$eval('#hint-tip', (e) => e.textContent), /first click is always safe/);
      assert.equal(await page.evaluate(() => window.__minesweeper.hinted), false, 'nothing given away before the first click');
      await click(8 * 16 + 8);
      await page.click('#btn-hint');
      const clue = await page.evaluate(() => window.__minesweeper.clue);
      assert.equal(clue.safe, true, 'a no-guess board always has one');
      assert.ok(!(await mines(page)).includes(clue.i));
      assert.match(await cls(page, clue.i), /is-clue/);
      assert.doesNotMatch(await cls(page, clue.i), /is-open/);
      assert.match(await page.$eval('#announce', (e) => e.textContent), /^Hint: the cell at row \d+, column \d+ is safe\.$/);
      assert.equal(await page.evaluate(() => window.__minesweeper.hinted), true);
      assert.match(await page.$eval('#btn-hint', (e) => e.className), /is-used/);
      await click(clue.i);
      assert.equal(await page.$$eval('.cell.is-clue', (c) => c.length), 0, 'the mark goes with the next move');
      // From the keyboard: H puts the cursor on the hinted cell, so Space opens it.
      await page.focus('#board');
      await page.keyboard.press('ArrowLeft');
      await page.keyboard.press('h');
      const next = await page.evaluate(() => window.__minesweeper.clue);
      assert.equal(next.safe, true);
      assert.equal(await page.$eval('#board', (b) => b.getAttribute('aria-activedescendant')), `cell-${next.i}`);
      await page.keyboard.press('Space');
      assert.match(await cls(page, next.i), /is-open/);
      // A reload does not launder the hint away.
      await page.reload({ waitUntil: 'networkidle0' });
      assert.equal(await page.evaluate(() => window.__minesweeper.hinted), true);
      const s = await clearBoard(page, (i) => click(i));
      assert.equal(s.status, 'won');
      assert.match(await page.$eval('#result-detail', (e) => e.textContent), /With a hint, so no best time/);
      const store = await saved(page);
      assert.deepEqual(store.times['intermediate:ng'] || [], [], 'no time kept');
      assert.equal(store.stats['intermediate:ng'].assisted, 1);
      assert.equal(store.stats['intermediate:ng'].won, 0, 'played, not won');
    });

    await step('a win shows 3BV, 3BV/s, clicks and efficiency on demand', async () => {
      const b = bbbv(await boardOf(page));
      const clicks = await page.evaluate(() => window.__minesweeper.clicks);
      await page.click('#btn-details');
      const facts = await page.$$eval('#result-panel .facts div', (d) => d.map((x) => [x.querySelector('dt').textContent, x.querySelector('dd').textContent]));
      assert.deepEqual(facts.map(([k]) => k), ['3BV', '3BV/s', 'Clicks', 'Efficiency']);
      assert.equal(Number(facts[0][1]), b, '3BV as engine.js counts it');
      assert.equal(Number(facts[2][1]), clicks);
      assert.equal(facts[3][1], `${Math.round((b / clicks) * 100)}%`);
      assert.ok(Number(facts[1][1]) > 0);
      await shot(page, 'desktop-won-details');
      await page.click('#btn-details');
      // The scores sheet opens on this game's kind of board, and switches to the other.
      await page.click('#btn-scores');
      await page.waitForSelector('#dlg-scores[open]');
      assert.equal(await page.$eval('[data-variant="ng"]', (e) => e.getAttribute('aria-pressed')), 'true');
      assert.equal(await page.$eval('.tab[aria-selected="true"]', (e) => e.dataset.bucket), 'intermediate:ng');
      assert.match(await page.$eval('#score-panel', (e) => e.textContent), /win with a hint counted as played, not won/);
      await page.click('[data-variant="classic"]');
      assert.equal(await page.$eval('.tab[aria-selected="true"]', (e) => e.dataset.bucket), 'intermediate');
      await page.keyboard.press('Escape');
      await toggleSetting(page, 'set-noguess'); // back to classic boards for the steps that follow
      assert.equal(await page.evaluate(() => window.__minesweeper.noGuess), true, 'a finished game keeps its kind');
      await page.click('#btn-again');
      assert.equal(await page.evaluate(() => window.__minesweeper.noGuess), false, 'the next one is classic');
    });

    await step('a forced guess: the hint says so and offers the safest cell; losing there is called a forced guess', async () => {
      // Built here: a Beginner game played by logic until no cell is provably safe, saved as the game in progress.
      let g;
      for (let seed = 1; ; seed++) {
        g = createGame(DIFFICULTIES.beginner);
        reveal(g, 40, mulberry32(seed));
        for (let a = analyze(g); g.status === 'playing' && a.safe.length; a = analyze(g)) for (const i of a.safe) reveal(g, i);
        if (g.status === 'playing') break;
      }
      await page.evaluate((current) => {
        const data = JSON.parse(localStorage.getItem('minesweeper-js:v1'));
        data.settings.difficulty = 'beginner';
        data.current = current;
        localStorage.setItem('minesweeper-js:v1', JSON.stringify(data));
      }, { difficulty: 'beginner', game: serialize(g), elapsed: 4000 });
      await page.reload({ waitUntil: 'networkidle0' });
      assert.equal((await state(page)).opened, g.opened, 'resumed');
      await page.click('#btn-hint');
      const clue = await page.evaluate(() => window.__minesweeper.clue);
      const a = analyze(g);
      assert.equal(clue.safe, false);
      assert.ok(a.safest.includes(clue.i), 'the safest cell, by engine.js');
      assert.match(await cls(page, clue.i), /is-clue is-guess/);
      assert.match(await page.$eval('#hint-tip', (e) => e.textContent), /^A guess: (about )?(\d+%|under 1%) chance of a mine$/);
      assert.match(await page.$eval('#announce', (e) => e.textContent), /so this is a guess/);
      // Open a mine that the numbers leave uncertain: a forced guess, and nothing to mark.
      const m = [...g.mine.keys()].find((i) => g.mine[i] && g.view[i] !== OPEN && a.probability[i] < 1);
      await click(m);
      assert.equal((await state(page)).status, 'lost');
      assert.match(await page.$eval('#result-detail', (e) => e.textContent), /^Forced guess · /);
      assert.equal(await page.$$eval('.cell.is-mark', (c) => c.length), 0);
      const look = await page.evaluate(() => window.__minesweeper.analysis);
      assert.equal(look.avoidable, false);
      assert.ok(Math.abs(look.p - a.probability[m]) < 1e-9, 'the chance it had, by engine.js');
      await page.click('#btn-details');
      assert.match(await page.$eval('#result-panel', (e) => e.textContent), /so a guess was forced/);
      await page.click('#btn-details');
    });

    await step('a board too dense for no-guess: the page says so, drops the tag and files the game as classic', async () => {
      await toggleSetting(page, 'set-noguess');
      await page.click('#btn-level');
      await page.waitForSelector('#dlg-level[open]');
      await page.click('[data-level="custom"]');
      await page.$eval('#custom-width', (e) => { e.value = '20'; });
      await page.$eval('#custom-height', (e) => { e.value = '20'; });
      await page.$eval('#custom-mines', (e) => { e.value = '200'; });
      await page.click('#custom-form button[type=submit]');
      await page.waitForFunction(() => !document.querySelector('#dlg-level[open]'));
      assert.equal(await page.evaluate(() => window.__minesweeper.noGuess), true, 'asked for, before the first click');
      await click(10 * 20 + 10); // half the cells mines: the generator gives up and lays an ordinary board
      assert.equal(await page.evaluate(() => window.__minesweeper.noGuess), false);
      assert.equal(await page.$eval('#level-variant', (e) => e.hidden), true, 'the tag goes');
      assert.doesNotMatch(await page.$eval('#btn-level', (e) => e.getAttribute('aria-label')), /no guessing/);
      assert.match(await page.$eval('#announce', (e) => e.textContent), /may need a guess/);
      assert.match(await page.$eval('#net', (e) => e.getAttribute('aria-label')), /may need a guess/, 'said where the status is');
      const m = await mines(page);
      const covered = await page.$$eval('.cell:not(.is-open)', (c) => c.map((e) => Number(e.dataset.i)));
      await click(m.find((i) => covered.includes(i)));
      assert.equal((await state(page)).status, 'lost');
      const { stats } = await saved(page);
      assert.equal(stats['custom:20x20x200']?.played, 1, 'filed as classic');
      assert.equal(stats['custom:20x20x200:ng'], undefined, 'and not as no-guess');
      await toggleSetting(page, 'set-noguess');
    });

    await step('a ranked loss while the proven cells are still on their way to the server is a forced guess', async () => {
      // A board built here and played by a fake server that answers late: tap every cell proven safe after the opening,
      // then a mine, before any answer is back. Nothing safe was left to tap, so the mine was a forced guess.
      const first = 40;
      let real;
      let proven;
      let mine;
      for (let seed = 1; ; seed++) {
        real = createGame(DIFFICULTIES.beginner);
        placeMines(real, first, mulberry32(seed));
        reveal(real, first);
        if (real.status !== 'playing') continue;
        const a = analyze(real);
        proven = a.safe;
        mine = [...real.mine.keys()].find((i) => real.mine[i] && a.probability[i] > 0 && a.probability[i] < 1);
        if (proven.length >= 2 && mine !== undefined) break;
      }
      const server = createGame(DIFFICULTIES.beginner);
      server.mine.set(real.mine);
      computeAdjacent(server);
      server.status = 'playing';
      const ctx = await browser.createBrowserContext();
      const ranked = await ctx.newPage();
      ranked.on('console', (msg) => { if (msg.type() === 'error') errors.push(`slow: ${msg.text()}`); });
      ranked.on('pageerror', (e) => errors.push(`slow: ${e.message}`));
      await ranked.setRequestInterception(true);
      let batches = 0;
      ranked.on('request', (r) => {
        const url = new URL(r.url());
        if (!url.pathname.startsWith('/api/')) return r.continue();
        const answer = (body) => r.respond({ status: 200, contentType: 'application/json', body: JSON.stringify(body) });
        if (url.pathname === '/api/games') return answer({ id: 'slow000000000000', w: 9, h: 9, m: 10, v: 'classic', exp: Date.now() + 9e5 });
        if (!url.pathname.endsWith('/moves')) return answer({ e: [], me: null, v: 'classic' });
        const { s, m } = JSON.parse(r.postData());
        const o = [];
        for (const [, i] of m) {
          if (server.status !== 'playing') break;
          for (const [j] of reveal(server, i).opened) o.push(j, server.mine[j] ? -1 : server.adjacent[j]);
        }
        const body = { s, o, st: server.status };
        if (server.status === 'lost') Object.assign(body, { mines: [...server.mine.keys()].filter((j) => server.mine[j]), x: server.exploded, ms: 9000 });
        setTimeout(() => answer(body), batches++ === 0 ? 0 : 1500); // the opening at once, everything after late
      });
      await ranked.setViewport({ width: 1280, height: 800 });
      await ranked.goto(base, { waitUntil: 'networkidle0' });
      await ranked.evaluate(() => { localStorage.clear(); localStorage.setItem('minesweeper-js:api', '/api'); });
      await ranked.reload({ waitUntil: 'networkidle0' });
      await ranked.waitForFunction(() => window.__minesweeper.mode === 'ranked');
      const press = async (i) => {
        const c = await ranked.$eval(`#cell-${i}`, (el) => { const b = el.getBoundingClientRect(); return { x: b.x + b.width / 2, y: b.y + b.height / 2 }; });
        await ranked.mouse.click(c.x, c.y);
      };
      await press(first);
      await ranked.waitForFunction((n) => window.__minesweeper.state.opened === n && window.__minesweeper.pending === 0, {}, real.opened);
      for (const i of proven) await press(i);
      await press(mine);
      await ranked.waitForFunction(() => window.__minesweeper.state.status === 'lost', { timeout: 10000 });
      assert.match(await ranked.$eval('#result-detail', (e) => e.textContent), /^Forced guess · /);
      assert.equal(await ranked.$$eval('.cell.is-mark', (c) => c.length), 0);
      const look = await ranked.evaluate(() => window.__minesweeper.analysis);
      assert.equal(look.avoidable, false);
      await ranked.click('#btn-details');
      assert.match(await ranked.$eval('#result-panel', (e) => e.textContent), /tapped already and was still opening/);
      await ctx.close();
    });

    await step('ranked games: no hint (with the reason), and the variant goes to the server', async () => {
      // A fake API: just enough answers for the page to believe it is in a ranked game.
      const ctx = await browser.createBrowserContext();
      const ranked = await ctx.newPage();
      ranked.on('console', (msg) => { if (msg.type() === 'error') errors.push(`ranked: ${msg.text()}`); });
      ranked.on('pageerror', (e) => errors.push(`ranked: ${e.message}`));
      const asked = [];
      let oldServer = false; // from before variants: ignores v, answers with the classic board and no v
      await ranked.setRequestInterception(true);
      ranked.on('request', (r) => {
        const url = new URL(r.url());
        if (!url.pathname.startsWith('/api/')) return r.continue();
        asked.push(`${r.method()} ${url.pathname}${url.search} ${r.postData() || ''}`);
        let body = {};
        if (url.pathname === '/api/games') {
          const v = JSON.parse(r.postData()).v === 'ng' ? 'ng' : 'classic';
          body = { id: 'e2e0000000000000', w: 9, h: 9, m: 10, v, exp: Date.now() + 9e5 };
        } else if (url.pathname === '/api/scores') {
          body = oldServer ? { e: [{ r: 1, n: 'Classic', ms: 9000 }], me: null } : { e: [], me: null, v: url.searchParams.get('v') || 'classic' };
        }
        r.respond({ status: 200, contentType: 'application/json', body: JSON.stringify(body) });
      });
      await ranked.setViewport({ width: 1280, height: 800 });
      await ranked.goto(base, { waitUntil: 'networkidle0' });
      await ranked.evaluate(() => { localStorage.clear(); localStorage.setItem('minesweeper-js:api', '/api'); });
      await ranked.reload({ waitUntil: 'networkidle0' });
      await ranked.waitForFunction(() => window.__minesweeper.mode === 'ranked');
      assert.equal(await ranked.$eval('#btn-hint', (e) => e.getAttribute('aria-disabled')), 'true');
      assert.match(await ranked.$eval('#btn-hint', (e) => e.getAttribute('aria-label')), /off in ranked games/);
      await ranked.click('#btn-hint');
      assert.match(await ranked.$eval('#hint-tip', (e) => e.textContent), /off in ranked games/);
      assert.equal(await ranked.evaluate(() => window.__minesweeper.hinted), false);
      assert.ok(asked.some((q) => q.startsWith('POST /api/games') && !q.includes('"v"')), 'a classic game is asked for as before');
      // No guessing on: the next ranked game asks for one, and the scores sheet asks for the no-guess board.
      await ranked.click('#btn-settings');
      await ranked.click('label:has(#set-noguess)');
      await ranked.keyboard.press('Escape');
      await ranked.waitForFunction(() => window.__minesweeper.mode === 'ranked' && window.__minesweeper.noGuess);
      assert.ok(asked.some((q) => q.startsWith('POST /api/games') && q.includes('"v":"ng"')));
      await ranked.click('#btn-scores');
      await ranked.waitForSelector('#score-panel .empty');
      assert.ok(asked.some((q) => q.startsWith('GET /api/scores?d=beginner&p=all&v=ng')), asked.join('\\n'));
      assert.match(await ranked.$eval('#score-panel', (e) => e.textContent), /No ranked no-guess wins yet/);
      await shot(ranked, 'desktop-ranked-scores-ng');
      // An old server's classic times must not show up as no-guess ones.
      oldServer = true;
      await ranked.click('.scope[data-scope="day"]');
      await ranked.waitForSelector('#score-panel .empty');
      assert.match(await ranked.$eval('#score-panel', (e) => e.textContent), /no no-guess boards yet/);
      assert.equal(await ranked.$$eval('.times.global li', (l) => l.length), 0);
      await ctx.close();
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

    await step('the hint sits beside flag mode as a 44 px target; so is the details toggle', async () => {
      await page.keyboard.press('Escape'); // the scores sheet from the step before
      await choose(page, 'beginner');
      const box = (sel) => page.$eval(sel, (e) => { const r = e.getBoundingClientRect(); return { x: r.x, y: r.y, w: r.width, h: r.height }; });
      const hintBox = await box('#btn-hint');
      const flagBox = await box('#btn-flag-mode');
      assert.ok(hintBox.h >= 44 && hintBox.w >= 44, JSON.stringify(hintBox));
      assert.ok(Math.abs(hintBox.y + hintBox.h / 2 - (flagBox.y + flagBox.h / 2)) < 2, 'on one row with flag mode');
      await tap(40);
      await page.tap('#btn-hint');
      assert.ok(await page.evaluate(() => window.__minesweeper.clue !== null || window.__minesweeper.state.status !== 'playing'));
      const tip = await box('#hint-tip');
      assert.ok(tip.x >= 0 && tip.x + tip.w <= 390, 'the tip stays on screen');
      if ((await state(page)).status === 'playing') {
        const m = await mines(page);
        const covered = await page.$$eval('.cell:not(.is-open)', (c) => c.map((e) => Number(e.dataset.i)));
        await tap(m.find((i) => covered.includes(i)));
      }
      // The chevron is drawn small, but a finger 20 px off its centre still lands on it.
      const t = await box('#btn-details');
      const cx = t.x + t.w / 2;
      const cy = t.y + t.h / 2;
      for (const [dx, dy] of [[-20, 0], [20, 0], [0, -20], [0, 20]]) {
        assert.ok(await page.evaluate((x, y) => document.elementFromPoint(x, y)?.closest('#btn-details') !== null, cx + dx, cy + dy), `${dx},${dy}`);
      }
      await page.tap('#btn-details');
      const panel = await box('#result-panel');
      assert.ok(panel.y >= 0 && panel.x >= 0 && panel.x + panel.w <= 390, 'the details stay on screen');
      await shot(page, 'mobile-details');
      await page.tap('#btn-details');
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
      await wait(80); // the fades follow on the next frame (queueFades), like the scroll checks above
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
    await step('a short landscape phone fits a finished no-guess game, tag and all, without scrolling', async () => {
      await page.setViewport({ width: 568, height: 320, isMobile: true, hasTouch: true, deviceScaleFactor: 2 });
      await toggleSetting(page, 'set-noguess'); // nothing played yet: a no-guess game at once
      await wait(300);
      assert.equal(await page.$eval('#level-variant', (e) => e.hidden), false);
      await tap(40);
      const m = await mines(page);
      const covered = await page.$$eval('.cell:not(.is-open)', (c) => c.map((e) => Number(e.dataset.i)));
      await tap(m.find((i) => covered.includes(i)));
      await wait(500);
      assert.equal((await state(page)).status, 'lost');
      const scroll = await page.evaluate(() => [document.documentElement.scrollHeight - document.documentElement.clientHeight, document.documentElement.scrollWidth - document.documentElement.clientWidth]);
      assert.deepEqual(scroll, [0, 0], 'neither way');
      await shot(page, 'mobile-landscape-ng-lost');
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
