/**
 * The leaderboard API over real HTTP: a fresh server on a free port for every test, with an in-memory database and a
 * clock the test moves by hand (`clock.t`). Run by `npm test` in server/ (after `npm ci` there, for better-sqlite3),
 * or by `npm test` at the root, which runs this after the game's own tests.
 */
import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Database from 'better-sqlite3';
import { neighbours, OPEN, solvesByLogic } from '../../minesweeper/engine.js';
import { createApp } from '../src/http.js';
import { LIMITS, RULES } from '../src/rules.js';
import { RateLimiter } from '../src/ratelimit.js';
import { Sessions, publicId } from '../src/sessions.js';
import { openStore } from '../src/store.js';
import { defaultName } from '../../minesweeper/names.js';

let clock;
let app;
let store;
let base;
const TOKEN = 'tok_aaaaaaaaaaaaaaaaaaaa'; // two devices, with tokens the server accepts
const OTHER = 'tok_bbbbbbbbbbbbbbbbbbbb';

// Loose limits on creating, winning and reading, so tests that play many games never hit a 429; the rate-limit
// test starts again with the real ones.
async function start({ limits = { ...LIMITS, create: { rate: 1, burst: 1000 }, win: { rate: 1, burst: 1000 }, read: { rate: 1, burst: 1000 } }, rules } = {}) {
  clock = { t: Date.UTC(2026, 8, 30, 12) };
  const now = () => clock.t;
  store = openStore(':memory:');
  app = createApp({ store, sessions: new Sessions({ now, rules }), limiter: new RateLimiter(limits, now), now, log: { error() {} } });
  await new Promise((r) => app.server.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${app.server.address().port}`;
}
beforeEach(() => start());
afterEach(() => new Promise((r) => { app.server.close(r); store.close(); }));

const post = async (path, body, headers = {}) => {
  const res = await fetch(base + path, { method: 'POST', body: JSON.stringify(body), headers: { 'content-type': 'text/plain', ...headers } });
  return { status: res.status, body: await res.json(), headers: res.headers };
};
const get = async (path) => { const res = await fetch(base + path); return { status: res.status, body: await res.json() }; };

/** A client that plays by the server's answers only, with a peek at the real mines (test-only) to play well. */
async function newGame(d = 'beginner', token = TOKEN, v = undefined) {
  const { status, body } = await post('/games', v === undefined ? { d, t: token } : { d, t: token, v });
  assert.equal(status, 200);
  let seq = 0;
  const handle = {};
  const play = async (moves, t = token) => post(`/games/${handle.id}/moves`, { t, s: ++seq, m: moves });
  return Object.assign(handle, { id: body.id, info: { ...body, d }, token, play, session: () => app.sessions.games.get(handle.id), setSeq: (s) => { seq = s; } });
}
const minesOf = (g) => [...g.session().game.mine.keys()].filter((i) => g.session().game.mine[i]);

/** Open every safe cell. The clock lands the win at exactly `totalMs` after the first click (or steps by `stepMs`). */
async function winGame(g, { stepMs = 0, totalMs = stepMs ? null : 20000 } = {}) {
  let r = await g.play([[0, 40]]);
  while (r.body.st === 'won') {
    // The first click's flood fill cleared the whole board (it happens on Beginner): a 0 ms win, which is never
    // ranked. Deal again, like a player would.
    Object.assign(g, await newGame(g.info.d, g.token, g.info.v));
    r = await g.play([[0, 40]]);
  }
  const game = g.session().game;
  while (r.body.st === 'playing') {
    const left = [...game.mine.keys()].filter((i) => !game.mine[i] && game.view[i] !== OPEN);
    // Any move may be the last (a flood fill can take the final few cells at once), so with `totalMs` every
    // move after the first happens at that moment.
    if (totalMs !== null) clock.t = g.session().startedAt + totalMs;
    else clock.t += stepMs;
    r = await g.play([[0, left[0]]]);
  }
  return r;
}

test('create: only the three ranked levels, only with a device token', async () => {
  assert.equal((await post('/games', { d: 'custom', t: TOKEN })).status, 400);
  assert.equal((await post('/games', { d: '__proto__', t: TOKEN })).status, 400);
  assert.equal((await post('/games', { d: 'beginner', t: 'short' })).status, 400);
  const ok = await post('/games', { d: 'expert', t: TOKEN });
  assert.deepEqual([ok.body.w, ok.body.h, ok.body.m], [30, 16, 99]);
  assert.match(ok.body.id, /^[A-Za-z0-9_-]{16}$/);
});

test('first open is safe, answers with numbers, and never leaks a mine while playing', async () => {
  const g = await newGame();
  const r = await g.play([[0, 40]]);
  assert.equal(r.body.st, 'playing');
  assert.ok(r.body.o.length >= 18, 'an opening: pairs of [cell, number]');
  const mines = new Set(minesOf(g));
  for (const j of [40, ...neighbours(g.session().game, 40)]) assert.ok(!mines.has(j));
  for (let k = 0; k < r.body.o.length; k += 2) {
    assert.ok(!mines.has(r.body.o[k]));
    assert.equal(r.body.o[k + 1], g.session().game.adjacent[r.body.o[k]]);
  }
  assert.equal(r.body.mines, undefined);
  assert.equal(JSON.stringify(r.body).includes('mine'), false);
  const state = await post(`/games/${g.id}/state`, { t: TOKEN });
  assert.deepEqual(new Set(state.body.o), new Set(r.body.o));
  assert.equal(JSON.stringify(state.body).includes('mine'), false);
});

test('a win is recorded once, with the server clock, and shows on the board', async () => {
  const g = await newGame();
  const r = await winGame(g);
  assert.equal(r.body.st, 'won');
  assert.equal(r.body.ranked, true);
  assert.equal(r.body.ms, clock.t - g.session().startedAt);
  assert.deepEqual(r.body.rank, { day: 1, week: 1, all: 1 });
  assert.equal(r.body.named, false);
  assert.equal(r.body.mines.length, 10);
  const board = await get(`/scores?d=beginner&p=day&me=${publicId(TOKEN)}`);
  assert.equal(board.body.e.length, 1);
  assert.equal(board.body.e[0].me, true);
  assert.equal(board.body.e[0].n, defaultName(publicId(TOKEN)), 'unnamed: the default name');
  assert.deepEqual(board.body.me, { r: 1, ms: r.body.ms });
  assert.equal(store.counts().scores, 1);
});

test('replaying a finished game: the same batch returns the same answer, nothing more is accepted or filed', async () => {
  const g = await newGame();
  const won = await winGame(g);
  const lastSeq = won.body.s;
  g.setSeq(lastSeq - 1);
  const again = await g.play([[0, 0]]);
  assert.deepEqual(again.body, won.body);
  assert.equal((await g.play([[0, 0]])).status, 409);
  assert.equal(store.counts().scores, 1, 'filed once');
});

test('forged submissions: no endpoint accepts a result, and nobody else can play your game', async () => {
  assert.equal((await post('/scores', { d: 'beginner', ms: 1234, t: TOKEN })).status, 404);
  assert.equal((await post('/games/x/win', { t: TOKEN })).status, 404);
  assert.equal((await post('/games/doesnotexist0000/moves', { t: TOKEN, s: 1, m: [[0, 1]] })).status, 404);
  const g = await newGame();
  assert.equal((await g.play([[0, 40]], OTHER)).status, 403);
  g.setSeq(0);
  // Nonsense moves are refused one by one and change nothing.
  const r = await g.play([[0, -1], [0, 81], [0, 1.5], [7, 3], 'x', [0, '4']]);
  assert.deepEqual(r.body.r, [0, 1, 2, 3, 4, 5]);
  assert.equal(r.body.o.length, 0);
  assert.equal(r.body.st, 'ready');
  // Out-of-order batches are refused.
  g.setSeq(5);
  assert.equal((await g.play([[0, 40]])).status, 409);
  // Blind clicking reaches a mine long before a win: there is no way around opening every safe cell.
  const blind = await newGame();
  let res;
  for (let i = 0; i < 81; i++) {
    res = await blind.play([[0, i]]);
    if (res.body.st !== 'playing') break;
  }
  assert.equal(res.body.st, 'lost');
  assert.equal(store.counts().scores, 0);
});

test('chords: refused on unsatisfied numbers or bad flags, lose on wrong flags, open on right ones', async () => {
  const g = await newGame();
  await g.play([[0, 40]]);
  const game = g.session().game;
  const mines = new Set(minesOf(g));
  const target = [...game.view.keys()].find((i) => game.view[i] === OPEN && game.adjacent[i] > 0
    && neighbours(game, i).some((j) => game.view[j] !== OPEN && !mines.has(j)));
  const around = neighbours(game, target);
  const real = around.filter((j) => mines.has(j));
  const coveredSafe = around.filter((j) => game.view[j] !== OPEN && !mines.has(j));
  const openCell = around.find((j) => game.view[j] === OPEN);
  const far = [...game.view.keys()].find((j) => !around.includes(j) && j !== target && game.view[j] !== OPEN);

  const refused = [
    [1, target, []], // no flags on a number
    [1, target, real.slice(1)], // too few
    [1, target, [...real, real[0]]], // duplicate
    [1, target, [...real.slice(1), far]], // a flag that is not a neighbour
    [1, target, 'nope'],
  ];
  if (openCell !== undefined) refused.push([1, target, [...real.slice(1), openCell]]);
  const r = await g.play(refused);
  assert.equal(r.body.r.length, refused.length);
  assert.equal(r.body.o.length, 0);

  if (coveredSafe.length >= 1 && real.length >= 1) {
    const good = await g.play([[1, target, real]]);
    assert.equal(good.body.r, undefined);
    for (const j of coveredSafe) assert.ok(good.body.o.includes(j));
  }

  const h = await newGame();
  await h.play([[0, 40]]);
  const hg = h.session().game;
  const hm = new Set(minesOf(h));
  const t2 = [...hg.view.keys()].find((i) => hg.view[i] === OPEN && hg.adjacent[i] > 0
    && neighbours(hg, i).filter((j) => hg.view[j] !== OPEN && !hm.has(j)).length >= hg.adjacent[i]);
  if (t2 !== undefined) {
    const wrong = neighbours(hg, t2).filter((j) => hg.view[j] !== OPEN && !hm.has(j)).slice(0, hg.adjacent[t2]);
    const lost = await h.play([[1, t2, wrong]]);
    assert.equal(lost.body.st, 'lost');
    assert.ok(lost.body.x.length >= 1);
  }
});

test('too fast to be human: the win stands but is not ranked', async () => {
  const g = await newGame();
  const r = await winGame(g, { stepMs: 5 });
  assert.equal(r.body.st, 'won');
  assert.equal(r.body.ranked, false);
  assert.equal(r.body.why, 'too-fast');
  assert.equal(store.counts().scores, 0);
});

test('games expire: untouched, idle, or finished long ago', async () => {
  const a = await newGame();
  clock.t += RULES.readyMs + 1;
  assert.equal((await a.play([[0, 40]])).status, 410);
  const b = await newGame();
  await b.play([[0, 40]]);
  clock.t += RULES.idleMs + 1;
  assert.equal((await b.play([[0, 0]])).status, 410);
  assert.equal((await b.play([[0, 0]])).status, 404, 'and then it is gone');
});

test('rate limits per client', async () => {
  await new Promise((r) => { app.server.close(r); store.close(); });
  await start({ limits: LIMITS });
  const codes = [];
  for (let k = 0; k < LIMITS.create.burst + 2; k++) codes.push((await post('/games', { d: 'beginner', t: TOKEN })).status);
  assert.equal(codes.filter((c) => c === 429).length, 2);
  assert.equal((await post('/games', { d: 'beginner', t: TOKEN }, { 'x-real-ip': '203.0.113.9' })).status, 200, 'a different client, via nginx');
});

test('names: validated, and a rename shows on every entry', async () => {
  assert.equal((await post('/player', { t: TOKEN, n: 'x' })).status, 422);
  assert.equal((await post('/player', { t: TOKEN, n: 'fuckface' })).status, 422);
  const g = await newGame();
  const won = await winGame(g);
  const fallback = defaultName(publicId(TOKEN));
  assert.match(fallback, /^Player-[0-9A-F]{4}$/);
  assert.equal(won.body.name, fallback, 'an unnamed win carries the default name');
  const unnamed = (await get('/scores?d=beginner&p=all')).body.e[0];
  assert.equal(unnamed.n, fallback, 'an unnamed entry shows the default name');
  assert.equal(unnamed.d, 1);
  const named = await post('/player', { t: TOKEN, n: '  Elias  ' });
  assert.deepEqual(named.body, { pid: publicId(TOKEN), name: 'Elias', custom: true });
  assert.equal((await get('/scores?d=beginner&p=all')).body.e[0].n, 'Elias');
  const second = await newGame();
  assert.equal((await winGame(second)).body.named, true);
  // Nobody can take another device's default name; typing your own back in (or nothing) resets to it.
  assert.equal((await post('/player', { t: OTHER, n: fallback })).status, 422);
  assert.equal((await post('/player', { t: TOKEN, n: 'player-' + fallback.slice(7).toLowerCase() })).body.custom, false);
  assert.equal((await get('/scores?d=beginner&p=all')).body.e[0].n, fallback);
  await post('/player', { t: TOKEN, n: 'Elias' });
  assert.deepEqual((await post('/player', { t: TOKEN, n: '' })).body, { pid: publicId(TOKEN), name: fallback, custom: false });
});

test('board: best per player, ordered, with day / week / all-time windows', async () => {
  const g1 = await newGame('beginner', TOKEN);
  const w1 = await winGame(g1, { totalMs: 30000 });
  clock.t += 2 * 86400e3; // two days later, someone else, faster
  const g2 = await newGame('beginner', OTHER);
  const w2 = await winGame(g2, { totalMs: 25000 });
  assert.ok(w2.body.ms < w1.body.ms);
  assert.deepEqual(w2.body.rank, { day: 1, week: 1, all: 1 });
  const all = (await get('/scores?d=beginner&p=all')).body.e;
  assert.deepEqual(all.map((e) => e.ms), [w2.body.ms, w1.body.ms]);
  assert.equal((await get('/scores?d=beginner&p=day')).body.e.length, 1);
  assert.equal((await get('/scores?d=beginner&p=week')).body.e.length, 2);
  assert.equal((await get('/scores?d=custom&p=all')).status, 400);
  assert.equal((await get('/scores?d=beginner&p=year')).status, 400);
  // A slower win by the same player does not add a second row.
  const g3 = await newGame('beginner', OTHER);
  await winGame(g3, { totalMs: 40000 });
  assert.equal((await get('/scores?d=beginner&p=all')).body.e.length, 2);
});

test('CORS: GitHub Pages and eliasv.com only; no preflight needed for text/plain', async () => {
  const pages = await post('/games', { d: 'beginner', t: TOKEN }, { origin: 'https://eliasvagan.github.io' });
  assert.equal(pages.headers.get('access-control-allow-origin'), 'https://eliasvagan.github.io');
  const evil = await post('/games', { d: 'beginner', t: TOKEN }, { origin: 'https://evil.example' });
  assert.equal(evil.headers.get('access-control-allow-origin'), null);
  assert.equal((await fetch(`${base}/games`, { method: 'POST', body: '{"d":' })).status, 400);
  assert.equal((await fetch(`${base}/games`, { method: 'POST', body: 'x'.repeat(20000) }).catch(() => ({ status: 413 }))).status, 413);
});

test('no-guess games: asked for with v, laid by the server so logic alone clears them, ranked on their own board', async () => {
  assert.equal((await post('/games', { d: 'expert', t: TOKEN, v: 'bogus' })).status, 400);
  assert.equal((await post('/games', { d: 'expert', t: TOKEN, v: 7 })).status, 400);
  assert.equal((await post('/games', { d: 'expert', t: TOKEN })).body.v, 'classic', 'an older client gets a classic game');
  const ng = await post('/games', { d: 'expert', t: TOKEN, v: 'ng' });
  assert.equal(ng.body.v, 'ng');

  // The server lays an Expert no-guess board around the first open, and keeps it to itself.
  const ex = await newGame('expert', TOKEN, 'ng');
  const first = await ex.play([[0, 8 * 30 + 15]]);
  assert.equal(first.body.st, 'playing');
  assert.equal(first.body.v, undefined, 'no fallback to report');
  assert.equal(JSON.stringify(first.body).includes('mine'), false);
  assert.equal(ex.session().variant, 'ng');
  assert.equal(solvesByLogic(ex.session().game, 8 * 30 + 15), true);
  assert.equal((await post(`/games/${ex.id}/state`, { t: TOKEN })).body.v, 'ng');

  // A no-guess win lands on the no-guess board and nowhere else; a classic one the other way round.
  const won = await winGame(await newGame('beginner', TOKEN, 'ng'));
  assert.equal(won.body.ranked, true);
  assert.deepEqual(won.body.rank, { day: 1, week: 1, all: 1 });
  assert.equal((await get('/scores?d=beginner&p=all&v=ng')).body.e.length, 1);
  assert.equal((await get('/scores?d=beginner&p=all')).body.e.length, 0, 'not on the classic board');
  assert.equal((await get('/scores?d=beginner&p=all&v=classic')).body.e.length, 0);
  const classic = await winGame(await newGame('beginner', OTHER), { totalMs: 15000 });
  assert.deepEqual(classic.body.rank, { day: 1, week: 1, all: 1 }, 'first on its own board, though faster than nobody there');
  assert.equal((await get('/scores?d=beginner&p=all&v=ng')).body.e.length, 1);
  assert.equal((await get('/scores?d=beginner&p=all')).body.e.length, 1);
  assert.deepEqual((await get(`/scores?d=beginner&p=all&v=ng&me=${publicId(TOKEN)}`)).body.me, { r: 1, ms: won.body.ms });
  assert.equal((await get('/scores?d=beginner&p=all&v=hard')).status, 400);
  // Each answer says which board it is: a page can tell a server from before variants (no v) from this one.
  assert.equal((await get('/scores?d=beginner&p=all&v=ng')).body.v, 'ng');
  assert.equal((await get('/scores?d=beginner&p=all')).body.v, 'classic');
});

test('plausibility covers no-guess wins too: too fast is never ranked', async () => {
  const r = await winGame(await newGame('beginner', TOKEN, 'ng'), { stepMs: 5 });
  assert.equal(r.body.st, 'won');
  assert.equal(r.body.ranked, false);
  assert.equal(r.body.why, 'too-fast');
  assert.equal(store.counts().scores, 0);
});

test('a no-guess game whose generator gives up goes on as classic, says so, and ranks as classic', async () => {
  await new Promise((r) => { app.server.close(r); store.close(); });
  await start({ rules: { ...RULES, noGuessLimits: { layouts: 0 } } }); // no layouts at all: every try falls back
  const g = await newGame('beginner', TOKEN, 'ng');
  const first = await g.play([[0, 40]]);
  assert.equal(first.body.v, 'classic');
  assert.equal(g.session().variant, 'classic');
  assert.equal((await post(`/games/${g.id}/state`, { t: TOKEN })).body.v, 'classic');
  // Finished, it is a classic win.
  const game = g.session().game;
  let r = first;
  while (r.body.st === 'playing') {
    clock.t = g.session().startedAt + 20000;
    r = await g.play([[0, [...game.mine.keys()].find((i) => !game.mine[i] && game.view[i] !== OPEN)]]);
  }
  if (r.body.st === 'won' && r.body.ranked) {
    assert.equal((await get('/scores?d=beginner&p=all')).body.e.length, 1);
    assert.equal((await get('/scores?d=beginner&p=all&v=ng')).body.e.length, 0);
  }
});

test('a database from before variants: old scores become classic ones, and no-guess ones file beside them', () => {
  const file = join(mkdtempSync(join(tmpdir(), 'ms-migrate-')), 'scores.db');
  const old = new Database(file);
  old.exec(`
    CREATE TABLE players (id INTEGER PRIMARY KEY, token_hash TEXT NOT NULL UNIQUE, public_id TEXT NOT NULL UNIQUE,
      name TEXT, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL);
    CREATE TABLE scores (id INTEGER PRIMARY KEY, player_id INTEGER NOT NULL REFERENCES players(id) ON DELETE CASCADE,
      difficulty TEXT NOT NULL, ms INTEGER NOT NULL, bbbv INTEGER NOT NULL, moves INTEGER NOT NULL,
      game_id TEXT NOT NULL UNIQUE, ip_hash TEXT, created_at INTEGER NOT NULL);
    CREATE INDEX scores_board ON scores (difficulty, created_at, ms);
    CREATE INDEX scores_player ON scores (player_id, difficulty, ms);
    INSERT INTO players VALUES (1, 'h', '0123456789abcdef', 'Old', 1, 1);
    INSERT INTO scores VALUES (1, 1, 'expert', 90000, 150, 200, 'g1', NULL, 1);
  `);
  old.close();
  const migrated = openStore(file);
  const board = (v) => migrated.board({ difficulty: 'expert', variant: v, since: 0, limit: 20, me: null }).e;
  assert.deepEqual(board('classic').map((e) => [e.n, e.ms]), [['Old', 90000]]);
  assert.deepEqual(board('ng'), []);
  migrated.addWin({ tokenHash: 'h', pid: '0123456789abcdef', difficulty: 'expert', variant: 'ng', ms: 80000, bbbv: 140, moves: 150, gameId: 'g2', ip: null, at: 2, periods: RULES.periods });
  assert.deepEqual(board('ng').map((e) => e.ms), [80000]);
  assert.deepEqual(board('classic').map((e) => e.ms), [90000]);
  const indexes = migrated.db.prepare("SELECT name FROM sqlite_master WHERE type = 'index' AND tbl_name = 'scores'").all().map((r) => r.name);
  assert.ok(indexes.includes('scores_board_v') && !indexes.includes('scores_board'));
  migrated.close();
  // Opening it again changes nothing (the migration runs once).
  const again = openStore(file);
  assert.equal(again.counts().scores, 2);
  again.close();
});
