#!/usr/bin/env node
/**
 * Live end-to-end test of the global board: plays a real ranked Beginner game against the leaderboard API as an
 * iPhone would (touch, human-ish pacing), wins it, answers the name prompt and finds the win highlighted on the
 * global board. Prints the measured move latency and the test player's public id so its entries can be purged:
 *
 *     PUPPETEER=/path/to/puppeteer node test/e2e-live.mjs
 *     URL=https://eliasvagan.github.io/minesweeper-js/ node test/e2e-live.mjs     # the Pages copy (CORS)
 *     RESOLVE='MAP eliasv.com 134.209.83.197'  SHOTS=/tmp/shots  NAME='E2E test'  API=http://127.0.0.1:3890
 *
 * Then remove the test entries on the server:  node server/admin.js purge-player <pid>
 */
import { createRequire } from 'node:module';
import { mkdirSync } from 'node:fs';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import assert from 'node:assert/strict';

const URL_ = process.env.URL || 'https://eliasv.com/minesweeper/';
const NAME = process.env.NAME || 'E2E test';
const SHOTS = process.env.SHOTS ? resolve(process.env.SHOTS) : null;
const PACE = Number(process.env.PACE || 160);
if (SHOTS) mkdirSync(SHOTS, { recursive: true });

async function loadPuppeteer() {
  const where = process.env.PUPPETEER;
  if (where) return (await import(pathToFileURL(createRequire(import.meta.url).resolve(resolve(where))).href)).default;
  return (await import('puppeteer')).default;
}
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const t0 = Date.now();
const log = (m) => console.log(`  ${((Date.now() - t0) / 1000).toFixed(1).padStart(5)}s  ${m}`);

const puppeteer = await loadPuppeteer();
const args = ['--no-sandbox'];
if (process.env.RESOLVE) args.push(`--host-resolver-rules=${process.env.RESOLVE}`);
const browser = await puppeteer.launch({ args });
const errors = [];
let exit = 0;
try {
  const page = await browser.newPage();
  page.on('pageerror', (e) => errors.push(e.message));
  page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });
  await page.setUserAgent('Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Mobile/15E148 Safari/604.1');
  await page.setViewport({ width: 390, height: 844, deviceScaleFactor: 3, isMobile: true, hasTouch: true });
  await page.goto(URL_, { waitUntil: 'networkidle0' });
  await page.evaluate((api) => {
    localStorage.clear();
    if (api) localStorage.setItem('minesweeper-js:api', api);
  }, process.env.API || '');
  await page.reload({ waitUntil: 'networkidle0' });

  const state = () => page.evaluate(() => ({ ...window.__minesweeper.state, mode: window.__minesweeper.mode, pending: window.__minesweeper.pending }));
  let s = await state();
  if (s.level !== 'beginner') {
    await page.tap('#btn-level');
    await wait(400);
    await page.evaluate(() => [...document.querySelectorAll('.level-option')].find((b) => b.dataset.level === 'beginner').click());
    await wait(400);
    s = await state();
  }
  assert.equal(s.level, 'beginner');
  await page.waitForFunction(() => window.__minesweeper.mode === 'ranked', { timeout: 10000 });
  const label = await page.$eval('#level-mode', (e) => e.textContent);
  assert.match(label, /ranked/);
  log(`page loaded, game is "${label.trim()}"`);

  // Reads the board from the DOM only (what a player sees) and deduces safe cells.
  const read = () => page.evaluate(() => [...document.querySelectorAll('#board .cell')].map((el) => {
    const m = /\bn(\d)\b/.exec(el.className);
    return [Number(el.dataset.i), el.classList.contains('is-open') ? (m ? Number(m[1]) : 0) : -1];
  }));
  function deduce(view, w, h, mines) {
    const nb = (i) => {
      const x = i % w, y = (i - x) / w, out = [];
      for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) {
        const nx = x + dx, ny = y + dy;
        if ((dx || dy) && nx >= 0 && ny >= 0 && nx < w && ny < h) out.push(ny * w + nx);
      }
      return out;
    };
    let changed = true;
    const safe = new Set();
    while (changed) {
      changed = false;
      const cons = [];
      for (let i = 0; i < view.length; i++) {
        if (view[i] <= 0) continue;
        const cov = nb(i).filter((j) => view[j] === -1 && !safe.has(j));
        const unk = cov.filter((j) => !mines.has(j));
        const need = view[i] - cov.filter((j) => mines.has(j)).length;
        if (!unk.length) continue;
        if (need === 0) { unk.forEach((j) => safe.add(j)); changed = true; }
        else if (need === unk.length) { unk.forEach((j) => mines.add(j)); changed = true; }
        else cons.push({ set: new Set(unk), need });
      }
      if (changed) continue;
      for (const a of cons) for (const b of cons) {
        if (a === b || a.set.size >= b.set.size || ![...a.set].every((j) => b.set.has(j))) continue;
        const rest = [...b.set].filter((j) => !a.set.has(j));
        if (b.need === a.need) { rest.forEach((j) => safe.add(j)); changed = true; }
        else if (b.need - a.need === rest.length) { rest.forEach((j) => mines.add(j)); changed = true; }
      }
    }
    return safe;
  }

  let won = null;
  for (let attempt = 1; attempt <= 12 && !won; attempt++) {
    if (attempt > 1) {
      await page.tap('#btn-again').catch(() => page.tap('#btn-restart'));
      await page.waitForFunction(() => window.__minesweeper.mode === 'ranked' && window.__minesweeper.state.status === 'ready', { timeout: 10000 });
    }
    const mines = new Set();
    let moves = 0;
    for (;;) {
      s = await state();
      if (s.status === 'won' || s.status === 'lost') break;
      const cells = await read();
      const view = new Array(s.width * s.height);
      for (const [i, v] of cells) view[i] = v;
      const safe = [...deduce(view, s.width, s.height, mines)].filter((i) => view[i] === -1);
      let pick = safe[0];
      if (pick === undefined) {
        const covered = cells.filter(([i, v]) => v === -1 && !mines.has(i)).map(([i]) => i);
        pick = moves === 0 ? covered[Math.floor(covered.length / 2)] : covered[Math.floor(Math.random() * covered.length)];
      }
      await page.tap(`#board .cell[data-i="${pick}"]`);
      moves++;
      await page.waitForFunction(() => window.__minesweeper.pending === 0, { timeout: 15000 });
      await wait(PACE);
    }
    const g = await page.evaluate(() => ({ status: window.__minesweeper.state.status, global: window.__minesweeper.lastGlobal }));
    log(`game ${attempt}: ${g.status} after ${moves} taps${g.status === 'won' ? (g.global ? `, ranked ${g.global.ms} ms` : ', not ranked') : ''}`);
    if (g.status === 'won' && g.global) won = g.global;
  }
  assert.ok(won, 'no ranked win in 12 games');

  await page.waitForFunction(() => document.getElementById('dlg-name').open, { timeout: 5000 });
  await wait(500);
  const lead = await page.$eval('#name-lead', (e) => e.textContent);
  log(`name prompt: "${lead}"`);
  if (SHOTS) await page.screenshot({ path: `${SHOTS}/mobile-name-prompt.png` });
  await page.type('#name-input', 'x');
  await page.$eval('#name-input', (e) => { e.value = ''; });
  await page.type('#name-input', NAME, { delay: 40 });
  await page.tap('#name-form button[type=submit]');
  await page.waitForFunction(() => !document.getElementById('dlg-name').open, { timeout: 8000 });
  const player = await page.evaluate(() => JSON.parse(localStorage.getItem('minesweeper-js:v1') || '{}').player || {});
  assert.equal(player.name, NAME);
  log(`name saved as "${player.name}", pid ${player.pid}`);

  await page.tap('#btn-scores');
  await page.waitForSelector('.times.global li.is-me', { timeout: 10000 });
  await wait(600);
  const me = await page.$eval('.times.global li.is-me', (e) => e.textContent.replace(/\s+/g, ' ').trim());
  log(`global board shows: "${me}"`);
  assert.ok(me.includes(NAME));
  if (SHOTS) await page.screenshot({ path: `${SHOTS}/mobile-global-scoreboard.png` });

  const lat = (await page.evaluate(() => window.__minesweeper.latency())).sort((a, b) => a - b);
  const q = (p) => lat[Math.min(lat.length - 1, Math.floor(p * lat.length))];
  log(`move round trips: n=${lat.length} median ${q(0.5)} ms, p90 ${q(0.9)} ms, max ${lat.at(-1)} ms`);
  if (errors.length) throw new Error(`console errors:\n${errors.join('\n')}`);
  console.log(`\nPASS  pid=${player.pid}`);
} catch (e) {
  console.error(`\nFAIL  ${e.stack || e}`);
  exit = 1;
} finally {
  await browser.close();
}
process.exit(exit);
