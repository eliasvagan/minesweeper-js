/**
 * The daily challenge over real HTTP, like api.test.mjs: a fresh server on a free port for every test, an in-memory
 * database, a fixed daily secret, and a clock the test moves by hand (`clock.t`). It checks that the day's board is
 * the same for everyone whatever they click first, that nothing about it leaks before a game ends, that only the
 * first try per player, day and level counts, the Oslo day boundaries (summer and winter time) and the streak, and
 * the secret seeding. Run by `npm test` in server/, or at the root.
 */
import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Database from 'better-sqlite3';
import { DIFFICULTIES, OPEN, neighbours, solvesByLogic } from '../../minesweeper/engine.js';
import { dayOf } from '../../minesweeper/daily.js';
import { createApp } from '../src/http.js';
import { DailyBoards, dailyKey, keyedRandom, layDaily } from '../src/daily.js';
import { LIMITS, RULES } from '../src/rules.js';
import { RateLimiter } from '../src/ratelimit.js';
import { Sessions, publicId } from '../src/sessions.js';
import { openStore } from '../src/store.js';

const SECRET = 'test-daily-secret';
const TOKEN = 'tok_aaaaaaaaaaaaaaaaaaaa';
const OTHER = 'tok_bbbbbbbbbbbbbbbbbbbb';
const THIRD = 'tok_cccccccccccccccccccc';
// 1 October 2026, 12:00 in Oslo (summer time, UTC+2).
const NOON = Date.UTC(2026, 9, 1, 10);

let clock;
let app;
let store;
let base;

async function start({ dbPath = ':memory:', dailySecret = SECRET, at = NOON } = {}) {
  clock = { t: at };
  const now = () => clock.t;
  store = openStore(dbPath);
  // Loose limits: the fake clock hardly moves, so nothing refills, and an Expert game takes a few hundred moves.
  const limits = { ...LIMITS, create: { rate: 1, burst: 1000 }, move: { rate: 1, burst: 100000 }, win: { rate: 1, burst: 1000 }, read: { rate: 1, burst: 1000 } };
  app = createApp({ store, sessions: new Sessions({ now }), limiter: new RateLimiter(limits, now), now, log: { error() {} }, dailySecret });
  await new Promise((r) => app.server.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${app.server.address().port}`;
}
const stop = () => new Promise((r) => { app.server.close(r); store.close(); });
beforeEach(() => start());
afterEach(stop);

const post = async (path, body, headers = {}) => {
  const res = await fetch(base + path, { method: 'POST', body: JSON.stringify(body), headers: { 'content-type': 'text/plain', ...headers } });
  return { status: res.status, body: await res.json() };
};
const get = async (path) => { const res = await fetch(base + path); return { status: res.status, body: await res.json() }; };

/** A daily game for `token`; `ip` sets X-Real-IP (trusted from loopback, as from nginx). */
async function daily(d = 'intermediate', token = TOKEN, ip = undefined) {
  const headers = ip ? { 'x-real-ip': ip } : {};
  const { status, body } = await post('/games', { d, t: token, daily: true }, headers);
  assert.equal(status, 200, JSON.stringify(body));
  let seq = 0;
  const g = { id: body.id, info: body, token, headers };
  g.play = (moves) => post(`/games/${g.id}/moves`, { t: token, s: ++seq, m: moves }, headers);
  g.session = () => app.sessions.games.get(g.id);
  return g;
}

/**
 * Play a daily game to the end with a peek at the real mines (test-only): the first open names `first` (any cell),
 * then every safe cell, the last one landing `totalMs` after the start. With `lose`, it opens a mine instead.
 * Returns every answer, in order.
 */
async function play(g, { first = 0, totalMs = 60000, lose = false } = {}) {
  const answers = [await g.play([[0, first]])];
  const game = g.session().game;
  while (answers.at(-1).body.st === 'playing') {
    clock.t = g.session().startedAt + totalMs;
    const target = lose
      ? [...game.mine.keys()].find((i) => game.mine[i])
      : [...game.mine.keys()].find((i) => !game.mine[i] && game.view[i] !== OPEN);
    answers.push(await g.play([[0, target]]));
  }
  return answers;
}
const last = (answers) => answers.at(-1).body;

test('the same board for everyone: one opening, the same mines, whatever cell is clicked first', async () => {
  const a = await daily('expert', TOKEN);
  const b = await daily('expert', OTHER);
  assert.equal(a.info.daily.day, '2026-10-01');
  assert.equal(a.info.v, 'ng', 'a no-guess board');
  assert.deepEqual(a.info.daily.start, b.info.daily.start);
  assert.deepEqual([...a.session().game.mine], [...b.session().game.mine]);
  // Different first clicks (a corner, the far corner) open the same region: the day's opening.
  const ra = await a.play([[0, 0]]);
  const rb = await b.play([[0, 30 * 16 - 1]]);
  const cells = (r) => new Set(r.body.o.filter((_, k) => k % 2 === 0));
  assert.deepEqual(cells(ra), cells(rb));
  assert.deepEqual(ra.body.o, rb.body.o);
  assert.ok(cells(ra).has(a.info.daily.start));
  const g = a.session().game;
  assert.equal(g.adjacent[a.info.daily.start], 0, 'the opening is a zero');
  for (const j of [a.info.daily.start, ...neighbours(g, a.info.daily.start)]) assert.equal(g.mine[j], 0);
  assert.equal(solvesByLogic(g, a.info.daily.start), true, 'logic alone clears it from the opening');
  // Each level has its own board, and the next day another one.
  const i = await daily('intermediate', TOKEN);
  assert.equal(i.session().game.cells, 256);
  const today = [...g.mine];
  clock.t += 86400e3;
  const next = await daily('expert', THIRD);
  assert.equal(next.info.daily.day, '2026-10-02');
  assert.notDeepEqual([...next.session().game.mine], today);
});

test('nothing about the board leaves the server before the end', async () => {
  const g = await daily('expert');
  const noMines = (body, where) => {
    assert.equal(body.mines, undefined, where);
    assert.equal(body.x, undefined, where);
    assert.equal(JSON.stringify(body).includes('mine'), false, where);
    for (let k = 1; k < (body.o || []).length; k += 2) assert.ok(body.o[k] >= 0, `${where}: a mine in the answer`);
  };
  noMines(g.info, 'create');
  assert.deepEqual(Object.keys(g.info.daily).sort(), ['day', 'first', 'start']);
  const state = await post(`/games/${g.id}/state`, { t: TOKEN });
  assert.equal(state.body.st, 'ready', 'laid, but nothing opened is nothing to tell');
  assert.deepEqual(state.body.o, []);
  noMines(state.body, 'state before the start');
  noMines((await get(`/daily?d=expert&me=${publicId(TOKEN)}`)).body, 'the daily board');
  const answers = await play(g);
  for (const [k, a] of answers.slice(0, -1).entries()) noMines(a.body, `answer ${k}`);
  noMines((await get('/daily?d=expert')).body, 'the board after a win');
  assert.equal(last(answers).st, 'won');
  assert.equal(last(answers).mines.length, 99, 'the mines come with the end');
  // A loss shows them only at the end too.
  const h = await daily('expert', OTHER);
  const lost = await play(h, { lose: true });
  for (const a of lost.slice(0, -1)) noMines(a.body, 'before the loss');
  assert.equal(last(lost).st, 'lost');
  assert.ok(last(lost).mines.length === 99 && last(lost).x.length === 1);
});

test('only the first try per player, day and level counts; later ones are practice and say so', async () => {
  const first = await daily('intermediate', TOKEN);
  assert.equal(first.info.daily.first, true);
  const won = await play(first, { totalMs: 40000 });
  assert.deepEqual(won[0].body.daily, { day: '2026-10-01', counted: true });
  assert.equal(last(won).ranked, true);
  assert.equal(last(won).daily.rank, 1);
  assert.equal(last(won).daily.n, 1);
  assert.deepEqual(last(won).daily.streak, { now: 1, best: 1 });

  // Again: practice, before the first click and after it, and kept off the board even when faster.
  const again = await daily('intermediate', TOKEN);
  assert.deepEqual([again.info.daily.first, again.info.daily.why], [false, 'played']);
  const practice = await play(again, { totalMs: 20000 });
  assert.deepEqual(practice[0].body.daily, { day: '2026-10-01', counted: false, why: 'played' });
  assert.equal(last(practice).st, 'won');
  assert.equal(last(practice).ranked, false);
  assert.equal(last(practice).why, 'practice');
  let board = (await get(`/daily?d=intermediate&me=${publicId(TOKEN)}`)).body;
  assert.deepEqual(board.e.map((e) => e.ms), [last(won).ms], 'the first try, not the faster practice');
  assert.deepEqual(board.me, { won: true, ms: last(won).ms, r: 1 });
  assert.equal(board.n, 1);

  // Another level is a first try of its own; so is another player's, ranked behind a faster one.
  assert.equal((await daily('expert', TOKEN)).info.daily.first, true);
  const other = await play(await daily('intermediate', OTHER), { totalMs: 50000 });
  assert.equal(last(other).daily.rank, 2);

  // Two games started at once (two tabs): whichever opens first counts; the other cannot start while it runs.
  const tabA = await daily('beginner', THIRD);
  const tabB = await daily('beginner', THIRD);
  assert.equal(tabA.info.daily.first && tabB.info.daily.first, true, 'neither started yet');
  assert.equal((await tabB.play([[0, 0]])).body.daily.counted, true);
  const raced = await tabA.play([[0, 0]]);
  assert.deepEqual([raced.status, raced.body], [409, { id: tabB.id, error: 'daily-in-progress' }]);

  // A loss, or walking away after the first click, still uses the try.
  const loser = await play(await daily('expert', OTHER), { lose: true });
  assert.equal(last(loser).daily.counted, true);
  assert.equal(last(loser).daily.rank, null);
  const D = 'tok_dddddddddddddddddddd';
  const quit = await daily('intermediate', D);
  await quit.play([[0, 0]]);
  const open = await post('/games', { d: 'intermediate', t: D, daily: true });
  assert.deepEqual([open.status, open.body.error, open.body.id], [409, 'daily-in-progress', quit.id], 'still live: no other game, but its id to pick up');
  assert.deepEqual((await post(`/games/${quit.id}/close`, { t: D })).body, { st: 'lost' });
  assert.deepEqual([(await daily('intermediate', D)).info.daily.first, (await daily('intermediate', D)).info.daily.why], [false, 'played']);
  board = (await get(`/daily?d=expert&me=${publicId(OTHER)}`)).body;
  assert.deepEqual(board.me, { won: false, ms: null, r: null });
  assert.equal(board.e.length, 0);
});

test('one address gets a limited number of counted first tries per level and day', async () => {
  const tokens = Array.from({ length: RULES.dailyPerIp + 1 }, (_, k) => `tok_${String(k).padStart(20, 'x')}`);
  for (const t of tokens.slice(0, -1)) {
    const g = await daily('beginner', t, '198.51.100.7');
    assert.equal((await g.play([[0, 0]])).body.daily.counted, true);
  }
  const extra = await daily('beginner', tokens.at(-1), '198.51.100.7');
  assert.deepEqual([extra.info.daily.first, extra.info.daily.why], [false, 'network']);
  assert.deepEqual((await extra.play([[0, 0]])).body.daily, { day: '2026-10-01', counted: false, why: 'network' });
  // Another level is not affected, nor is another player at another address.
  assert.equal((await daily('expert', tokens.at(-1), '198.51.100.7')).info.daily.first, true);
  assert.equal((await daily('beginner', 'tok_zzzzzzzzzzzzzzzzzzzz', '198.51.100.8')).info.daily.first, true);
  // But the player given practice has seen the board (a practice game ends by showing it): no counted try for them
  // at it later, from any address.
  const elsewhere = await daily('beginner', tokens.at(-1), '198.51.100.8');
  assert.deepEqual([elsewhere.info.daily.first, elsewhere.info.daily.why], [false, 'played']);
  assert.deepEqual((await elsewhere.play([[0, 0]])).body.daily, { day: '2026-10-01', counted: false, why: 'played' });
  assert.equal((await get('/daily?d=beginner')).body.n, RULES.dailyPerIp, 'practice rows are not players who took their try');
});

test('no daily mines before your own counted try is over: no practice game while it is live', async () => {
  // The review's leak: a counted try under way, and a practice game at the same board lost on purpose would show
  // its mines. The practice game is refused, at creation and (if made before the counted one started) at its first
  // open, and nothing in those answers says anything about the board.
  const early = await daily('expert', TOKEN); // made before the counted game starts
  const counted = await daily('expert', TOKEN);
  const first = await counted.play([[0, 0]]);
  assert.equal(first.body.daily.counted, true);
  const later = await post('/games', { d: 'expert', t: TOKEN, daily: true });
  assert.deepEqual([later.status, later.body], [409, { id: counted.id, day: '2026-10-01', error: 'daily-in-progress' }]);
  const raced = await early.play([[0, 0]]);
  assert.deepEqual([raced.status, raced.body], [409, { id: counted.id, error: 'daily-in-progress' }]);
  assert.equal(early.session().startedAt, null, 'refused before anything opened');
  assert.equal(early.session().game.view.some((v) => v === OPEN), false);
  // Another level, or another player, is free meanwhile.
  assert.equal((await daily('beginner', TOKEN)).info.daily.first, true);
  assert.equal((await daily('expert', OTHER)).info.daily.first, true);
  // Once the counted try ends, practice is open, and its loss may show the mines.
  await play(counted, { lose: true, first: 0 });
  const practice = await daily('expert', TOKEN);
  assert.equal(practice.info.daily.why, 'played');
  const lost = await play(practice, { lose: true });
  assert.equal(last(lost).mines.length, 99);
  // A counted game that expired (or was lost in a restart) is over too: it no longer blocks practice.
  const quit = await daily('intermediate', THIRD);
  await quit.play([[0, 0]]);
  assert.equal((await post('/games', { d: 'intermediate', t: THIRD, daily: true })).status, 409);
  clock.t += RULES.idleMs + 1;
  const after = await daily('intermediate', THIRD);
  assert.deepEqual([after.info.daily.first, after.info.daily.why], [false, 'played']);
  assert.equal(store.db.prepare('SELECT ended_at FROM daily WHERE game_id = ?').get(quit.id).ended_at, clock.t, 'closed when found gone');
});

test('a counted daily under way is never evicted when the same address makes more games', async () => {
  const ip = '198.51.100.20';
  const counted = await daily('expert', TOKEN, ip);
  assert.equal((await counted.play([[0, 0]])).body.daily.counted, true);
  // A housemate (or a griefer) on the same address starts more games than one address may hold.
  for (let k = 0; k < RULES.maxGamesPerIp + 2; k++) assert.equal((await post('/games', { d: 'beginner', t: OTHER }, { 'x-real-ip': ip })).status, 200);
  const next = await counted.play([[0, counted.session().game.mine.findIndex((m, i) => !m && counted.session().game.view[i] !== OPEN)]]);
  assert.equal(next.status, 200, 'still there');
  const others = [...app.sessions.games.values()].filter((s) => s.ip === ip && !s.daily);
  assert.equal(others.length, RULES.maxGamesPerIp, 'the others share the usual places, the oldest evicted as before');
  // Not started, it is an ordinary candidate (nothing is lost: it had not counted yet).
  const waiting = await daily('beginner', THIRD, ip);
  for (let k = 0; k < RULES.maxGamesPerIp; k++) await post('/games', { d: 'beginner', t: OTHER }, { 'x-real-ip': ip });
  assert.equal(waiting.session(), undefined);
});

test('closing a game: it ends unwon with nothing revealed, and takes no more moves', async () => {
  const g = await daily('intermediate');
  await g.play([[0, 0]]);
  const closed = await post(`/games/${g.id}/close`, { t: TOKEN });
  assert.deepEqual(closed.body, { st: 'lost' });
  assert.equal(JSON.stringify(closed.body).includes('mine'), false);
  assert.equal((await g.play([[0, 1]])).status, 409);
  assert.equal((await post(`/games/${g.id}/close`, { t: OTHER })).status, 403, 'only its own player');
  const row = store.db.prepare('SELECT won, ended_at FROM daily WHERE game_id = ?').get(g.id);
  assert.deepEqual(row, { won: 0, ended_at: clock.t });
  assert.deepEqual((await get(`/daily?d=intermediate&me=${publicId(TOKEN)}`)).body.me, { won: false, ms: null, r: null });
  // An ordinary ranked game closes the same way.
  const plain = (await post('/games', { d: 'beginner', t: TOKEN })).body;
  assert.deepEqual((await post(`/games/${plain.id}/close`, { t: TOKEN })).body, { st: 'lost' });
});

test('days are Oslo calendar days, in summer and winter time; a streak is days in a row with a ranked win', async () => {
  // Summer time ends on 25 October 2026: the 24th ends at 22:00 UTC, the 25th (25 hours long) at 23:00 UTC.
  const at = (iso) => { clock.t = Date.parse(iso); };
  at('2026-10-24T21:59:59Z');
  assert.equal((await daily('expert', TOKEN)).info.daily.day, '2026-10-24');
  at('2026-10-24T22:00:00Z');
  assert.equal((await daily('expert', TOKEN)).info.daily.day, '2026-10-25');
  at('2026-10-25T22:59:59Z');
  assert.equal((await daily('expert', TOKEN)).info.daily.day, '2026-10-25');
  at('2026-10-25T23:00:00Z');
  assert.equal((await daily('expert', TOKEN)).info.daily.day, '2026-10-26');

  const streak = async (iso) => { at(iso); return (await get(`/daily?d=intermediate&me=${publicId(TOKEN)}`)).body.streak; };
  const winOn = async (iso, opts) => { at(iso); return last(await play(await daily('intermediate', TOKEN), opts)); };
  // A win late on the 24th, one just after midnight (the 25th), one late on the 26th (still the 26th in winter).
  assert.equal((await winOn('2026-10-24T21:30:00Z')).daily.streak.now, 1);
  assert.equal((await winOn('2026-10-24T22:10:00Z')).daily.streak.now, 2);
  const third = await winOn('2026-10-26T22:30:00Z');
  assert.deepEqual(third.daily.streak, { now: 3, best: 3 });
  assert.deepEqual(await streak('2026-10-27T12:00:00Z'), { now: 3, best: 3 }, 'alive until the 27th is over');
  assert.deepEqual(await streak('2026-10-28T12:00:00Z'), { now: 0, best: 3 }, 'the 27th went by without a win');
  // A loss and a too-quick win are not days of a streak; a ranked win starts a new one.
  await winOn('2026-10-28T12:00:00Z', { lose: true });
  assert.deepEqual(await streak('2026-10-28T12:30:00Z'), { now: 0, best: 3 });
  at('2026-10-29T12:00:00Z');
  const quick = last(await play(await daily('intermediate', TOKEN), { totalMs: 10 }));
  assert.equal(quick.ranked, false);
  assert.equal(quick.why, 'too-fast');
  assert.deepEqual(quick.daily.streak, { now: 0, best: 3 });
  assert.equal((await winOn('2026-10-30T12:00:00Z')).daily.streak.now, 1);
});

test('a daily belongs to the day it was dealt: no start after midnight, but a finish after it files under its day', async () => {
  // Created at 23:58 Oslo (CEST) on the 1st, first clicked at 00:01 on the 2nd: refused.
  clock.t = Date.parse('2026-10-01T21:58:00Z');
  const late = await daily('intermediate', TOKEN);
  clock.t = Date.parse('2026-10-01T22:01:00Z');
  const refused = await late.play([[0, 0]]);
  assert.deepEqual([refused.status, refused.body.error], [409, 'day-over']);
  assert.equal((await daily('intermediate', TOKEN)).info.daily.day, '2026-10-02', 'and today\'s is a fresh first try');
  // Started at 23:59 on the 2nd, won at 00:00:40 on the 3rd: the 2nd's board, seen as yesterday's from the 3rd.
  clock.t = Date.parse('2026-10-02T21:59:00Z');
  const g = await daily('intermediate', OTHER);
  const won = last(await play(g, { totalMs: 100000 }));
  assert.equal(won.st, 'won');
  assert.equal(dayOf(clock.t), '2026-10-03');
  assert.equal(won.daily.day, '2026-10-02');
  assert.equal(won.daily.rank, 1);
  const yesterday = (await get('/daily?d=intermediate&p=yesterday')).body;
  assert.deepEqual([yesterday.day, yesterday.today, yesterday.e.length], ['2026-10-02', '2026-10-03', 1]);
  assert.equal((await get('/daily?d=intermediate')).body.e.length, 0, 'today\'s board is empty');
  assert.deepEqual(won.daily.streak, { now: 1, best: 1 }, 'a win on yesterday\'s board keeps the streak alive today');
});

test('the boards are seeded from the secret: reproducible with it, different without it, never sent', async () => {
  const g = await daily('expert');
  const board = layDaily(SECRET, '2026-10-01', 'expert');
  assert.deepEqual([...g.session().game.mine], [...board.mine]);
  assert.equal(g.info.daily.start, board.start);
  assert.equal(board.noGuess, true);
  // The seed is HMAC-SHA256 of the day and level under the secret; its keystream is deterministic.
  assert.deepEqual(dailyKey(SECRET, '2026-10-01', 'expert'), createHmac('sha256', SECRET).update('minesweeper-daily:2026-10-01:expert').digest());
  const r1 = keyedRandom(dailyKey(SECRET, '2026-10-01', 'expert'));
  const r2 = keyedRandom(dailyKey(SECRET, '2026-10-01', 'expert'));
  const seq = Array.from({ length: 2000 }, () => r1()); // past one 4 KB block of keystream
  assert.deepEqual(seq, Array.from({ length: 2000 }, () => r2()));
  assert.ok(seq.every((v) => v >= 0 && v < 1));
  // Another secret, another board; and the day, the level and the secret all go into the seed.
  const guess = layDaily('not-the-secret', '2026-10-01', 'expert');
  assert.notDeepEqual([...guess.mine], [...board.mine]);
  assert.notDeepEqual([...layDaily(SECRET, '2026-10-02', 'expert').mine], [...board.mine]);
  // Neither the secret nor the seed is in any answer.
  const answers = [JSON.stringify(g.info), ...(await play(g)).map((a) => JSON.stringify(a.body)), JSON.stringify((await get('/daily?d=expert')).body)];
  const seed = dailyKey(SECRET, '2026-10-01', 'expert');
  for (const a of answers) {
    assert.equal(a.includes(SECRET), false);
    assert.equal(a.includes(seed.toString('hex')), false);
    assert.equal(a.includes(seed.toString('base64')), false);
  }
  // Each level is laid once a day (and cached).
  const boards = new DailyBoards({ secret: SECRET });
  assert.equal(boards.get('2026-10-01', 'beginner'), boards.get('2026-10-01', 'beginner'));
  for (const d of Object.keys(DIFFICULTIES)) assert.equal(boards.get('2026-10-01', d).mine.reduce((a, b) => a + b, 0), DIFFICULTIES[d].mines);
});

test('without DAILY_SECRET the server makes a random secret once and keeps it in the database', async () => {
  await stop();
  const file = join(mkdtempSync(join(tmpdir(), 'ms-daily-')), 'scores.db');
  await start({ dbPath: file, dailySecret: null });
  const kept = store.dailySecret();
  assert.match(kept, /^[0-9a-f]{64}$/);
  const before = [...(await daily('expert')).session().game.mine];
  await stop();
  await start({ dbPath: file, dailySecret: null }); // a restart: same database, same secret, same board
  assert.equal(store.dailySecret(), kept);
  assert.deepEqual([...(await daily('expert')).session().game.mine], before);
  assert.deepEqual(before, [...layDaily(kept, '2026-10-01', 'expert').mine]);
  await stop();
  await start({ dbPath: join(mkdtempSync(join(tmpdir(), 'ms-daily-')), 'scores.db'), dailySecret: null });
  assert.notEqual(store.dailySecret(), kept, 'a new database, a new secret');
});

test('backward compatible: games without daily are as before, and bad requests are refused', async () => {
  const plain = await post('/games', { d: 'expert', t: TOKEN });
  assert.equal(plain.body.daily, undefined);
  assert.equal((await post('/games', { d: 'expert', t: TOKEN, daily: false })).body.daily, undefined);
  assert.equal((await post('/games', { d: 'expert', t: TOKEN, daily: 'yes' })).status, 400);
  assert.equal((await post('/games', { d: 'custom', t: TOKEN, daily: true })).status, 400);
  assert.equal((await get('/daily?d=custom')).status, 400);
  assert.equal((await get('/daily?d=expert&p=tomorrow')).status, 400);
  assert.equal((await get('/daily?d=expert&p=constructor')).status, 400);
  const empty = (await get('/daily?d=expert&me=nothex')).body;
  assert.deepEqual([empty.e, empty.me, empty.n, empty.streak], [[], null, 0, null]);
  // Daily wins stay off the ordinary boards.
  await play(await daily('intermediate'), { totalMs: 30000 });
  assert.equal((await get('/scores?d=intermediate&p=all&v=ng')).body.e.length, 0);
  assert.equal((await get('/scores?d=intermediate&p=all')).body.e.length, 0);
  assert.equal(store.counts().daily, 1);
});

test('a database from before the daily gains its tables, and purging a player takes their dailies', async () => {
  await stop();
  const file = join(mkdtempSync(join(tmpdir(), 'ms-daily-old-')), 'scores.db');
  const old = new Database(file);
  old.exec(`
    CREATE TABLE players (id INTEGER PRIMARY KEY, token_hash TEXT NOT NULL UNIQUE, public_id TEXT NOT NULL UNIQUE,
      name TEXT, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL);
    CREATE TABLE scores (id INTEGER PRIMARY KEY, player_id INTEGER NOT NULL REFERENCES players(id) ON DELETE CASCADE,
      difficulty TEXT NOT NULL, ms INTEGER NOT NULL, bbbv INTEGER NOT NULL, moves INTEGER NOT NULL,
      game_id TEXT NOT NULL UNIQUE, ip_hash TEXT, created_at INTEGER NOT NULL, variant TEXT NOT NULL DEFAULT 'classic');
  `);
  old.close();
  await start({ dbPath: file });
  const tables = store.db.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all().map((r) => r.name);
  assert.ok(tables.includes('daily') && tables.includes('meta'));
  await play(await daily('intermediate'), { totalMs: 30000 });
  assert.equal(store.counts().daily, 1);
  assert.equal(store.purgePlayer(publicId(TOKEN)), 1);
  assert.equal(store.counts().daily, 0);
});

test('a daily table from before uncounted rows gains its column, every old row a counted one', async () => {
  await stop();
  const file = join(mkdtempSync(join(tmpdir(), 'ms-daily-v1-')), 'scores.db');
  const old = openStore(file);
  old.db.exec('DROP TABLE daily');
  old.db.exec(`CREATE TABLE daily (id INTEGER PRIMARY KEY, day TEXT NOT NULL, difficulty TEXT NOT NULL,
    player_id INTEGER NOT NULL REFERENCES players(id) ON DELETE CASCADE, game_id TEXT NOT NULL UNIQUE, ip_hash TEXT,
    started_at INTEGER NOT NULL, ended_at INTEGER, won INTEGER NOT NULL DEFAULT 0, ranked INTEGER NOT NULL DEFAULT 0,
    ms INTEGER, bbbv INTEGER, moves INTEGER, UNIQUE (day, difficulty, player_id))`);
  old.db.exec("INSERT INTO players VALUES (1, 'h', '0123456789abcdef', NULL, 1, 1)");
  old.db.exec("INSERT INTO daily (day, difficulty, player_id, game_id, started_at, ended_at, won, ranked, ms) VALUES ('2026-10-01', 'expert', 1, 'g1', 1, 2, 1, 1, 90000)");
  old.close();
  await start({ dbPath: file });
  assert.ok(store.db.prepare('PRAGMA table_info(daily)').all().some((c) => c.name === 'counted'));
  const board = (await get('/daily?d=expert')).body;
  assert.deepEqual([board.n, board.e.map((e) => e.ms)], [1, [90000]]);
});
