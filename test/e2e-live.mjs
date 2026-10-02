#!/usr/bin/env node
/**
 * Live end-to-end test of the global board: plays a real ranked Beginner game against the leaderboard API as an
 * iPhone would (touch, human-ish pacing), wins it, checks the header status, renames the player in the header and finds the win highlighted on the
 * global board. Prints the measured move latency and the test player's public id so its entries can be purged:
 *
 *     PUPPETEER=/path/to/puppeteer node test/e2e-live.mjs
 *     RESOLVE='MAP eliasv.com 165.232.81.120'  SHOTS=/tmp/shots  NAME='E2E test'  API=http://127.0.0.1:3890
 *
 * RESOLVE is a Chrome host resolver rule (to test a server before DNS points at it), API overrides the page's API
 * base, URL is the page (https://eliasv.com/minesweeper/ by default) and PACE the pause after each tap, in ms (160).
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
  const net = () => page.$eval('#net', (e) => ({ state: e.dataset.state, label: e.getAttribute('aria-label') }));
  await page.waitForFunction(() => document.getElementById('net').dataset.state === 'ok', { timeout: 10000 });
  const defaultName = await page.$eval('#player-name', (e) => e.value);
  assert.match(defaultName, /^Player-[0-9A-F]{4}$/, 'a default name in the header');
  log(`page loaded, ranked; header: "${defaultName}" ${JSON.stringify(await net())}`);
  if (SHOTS) {
    await page.tap('#net');
    await wait(300);
    await page.screenshot({ path: `${SHOTS}/mobile-header-connected.png` });
    await wait(3300);
  }
  const cdp = await page.createCDPSession();
  const throttle = (latency) => cdp.send('Network.emulateNetworkConditions', { offline: false, latency, downloadThroughput: -1, uploadThroughput: -1 });

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
      // Two numbers whose unknown cells nest: the cells only the larger one sees hold the difference in mines.
      for (const a of cons) for (const b of cons) {
        if (a === b || a.set.size >= b.set.size || ![...a.set].every((j) => b.set.has(j))) continue;
        const rest = [...b.set].filter((j) => !a.set.has(j));
        if (b.need === a.need) { rest.forEach((j) => safe.add(j)); changed = true; }
        else if (b.need - a.need === rest.length) { rest.forEach((j) => mines.add(j)); changed = true; }
      }
    }
    return safe;
  }

  // A guess can lose, and a win can be unranked: up to 12 games for one ranked win.
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
      // One slow move on the first game, to see the header's spinner while a ranked game is in play.
      const slow = SHOTS && attempt === 1 && moves === 2;
      if (slow) await throttle(1500);
      await page.tap(`#board .cell[data-i="${pick}"]`);
      moves++;
      if (slow) {
        await page.waitForFunction(() => document.getElementById('net').dataset.state === 'busy', { timeout: 3000 });
        await page.screenshot({ path: `${SHOTS}/mobile-ranked-in-play-syncing.png` });
        log(`while a move is out: ${JSON.stringify(await net())}`);
        await throttle(0);
      }
      await page.waitForFunction(() => window.__minesweeper.pending === 0, { timeout: 15000 });
      await wait(PACE);
    }
    const g = await page.evaluate(() => ({ status: window.__minesweeper.state.status, global: window.__minesweeper.lastGlobal }));
    log(`game ${attempt}: ${g.status} after ${moves} taps${g.status === 'won' ? (g.global ? `, ranked ${g.global.ms} ms` : ', not ranked') : ''}`);
    if (g.status === 'won' && g.global) won = g.global;
  }
  assert.ok(won, 'no ranked win in 12 games');

  // The end of the game shows the verification: spinner, then a check with the rank.
  await page.waitForFunction(() => document.getElementById('result-verify').dataset.state === 'ok', { timeout: 8000 });
  const verdict = await page.$eval('#result-detail', (e) => e.textContent);
  assert.match(verdict, /^Verified/);
  log(`result: "${verdict}", header ${JSON.stringify(await net())}`);
  if (SHOTS) await page.screenshot({ path: `${SHOTS}/mobile-win-verified.png` });

  // Before any rename, the entry carries the default name.
  const pid0 = await page.evaluate(() => JSON.parse(localStorage.getItem('minesweeper-js:v1') || '{}').player?.pid);
  const board0 = await page.evaluate(async (pid) => (await fetch(`${window.__minesweeper.apiBase}/scores?d=beginner&p=all&me=${pid}`)).json(), pid0);
  const mine0 = board0.e.find((e) => e.me);
  assert.equal(mine0?.n, defaultName, 'the unnamed entry shows the default name');

  // Rename in the header: saved here, synced, and the existing entry follows.
  await page.tap('#player-name');
  await wait(200);
  await page.keyboard.press('Backspace');
  await page.type('#player-name', NAME, { delay: 30 });
  if (SHOTS) await page.screenshot({ path: `${SHOTS}/mobile-name-editing.png` });
  await page.keyboard.press('Enter');
  await page.waitForFunction((n) => JSON.parse(localStorage.getItem('minesweeper-js:v1') || '{}').player?.synced === n, { timeout: 8000 }, NAME);
  const player = await page.evaluate(() => JSON.parse(localStorage.getItem('minesweeper-js:v1') || '{}').player || {});
  assert.equal(player.name, NAME);
  log(`renamed to "${player.name}" and synced, pid ${player.pid}; header ${JSON.stringify(await net())}`);

  await page.tap('#btn-scores');
  await page.waitForSelector('.times.global li.is-me', { timeout: 10000 });
  await wait(600);
  const me = await page.$eval('.times.global li.is-me', (e) => e.textContent.replace(/\s+/g, ' ').trim());
  log(`global board shows: "${me}"`);
  assert.ok(me.includes(NAME));
  if (SHOTS) await page.screenshot({ path: `${SHOTS}/mobile-global-scoreboard.png` });
  await page.keyboard.press('Escape');
  await wait(300);

  // Offline: the header turns to a cross, and the game still plays (locally, unranked).
  await page.setOfflineMode(true);
  await page.tap('#btn-again').catch(() => page.tap('#btn-restart'));
  await page.waitForFunction(() => window.__minesweeper.mode === 'offline', { timeout: 10000 });
  const off = await net();
  assert.equal(off.state, 'bad');
  await page.tap(`#board .cell[data-i="40"]`);
  await wait(300);
  assert.equal((await state()).status, 'playing', 'offline game plays');
  log(`offline: ${JSON.stringify(off)}`);
  if (SHOTS) {
    await page.tap('#net');
    await wait(300);
    await page.screenshot({ path: `${SHOTS}/mobile-header-offline.png` });
  }
  await page.setOfflineMode(false);
  // Chrome logs the failed request of the offline step; that one is expected.
  errors.splice(0, errors.length, ...errors.filter((e) => !/Failed to load resource|ERR_INTERNET_DISCONNECTED/.test(e)));

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
