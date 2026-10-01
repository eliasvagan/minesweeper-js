/**
 * Unit tests of minesweeper/records.js: best-time lists, stats and buckets, and the store on a working storage, a
 * broken one, and the default when there is no usable localStorage (as under Node); then the history, the replays
 * kept and their budget, practice games, the daily log, and saves from before all of these. Run by `npm test`.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DIFFICULTIES, createGame, reveal, mulberry32, OPEN } from '../minesweeper/engine.js';
import { MOVE, makeReplay } from '../minesweeper/replay.js';
import {
  TOP, addTime, applyResult, bucketFor, openStore, packGame, parseBucket, unpackGame, winRate,
} from '../minesweeper/records.js';

// A localStorage stand-in that outlives one store, so a second openStore on it is a reload.
const memory = () => {
  const m = new Map();
  return { getItem: (k) => m.get(k) ?? null, setItem: (k, v) => m.set(k, v), removeItem: (k) => m.delete(k), m };
};

test('best times stay sorted, capped at ten, and report the rank', () => {
  let list = [];
  for (const ms of [5000, 3000, 9000]) list = addTime(list, { ms, date: 'd' }).list;
  assert.deepEqual(list.map((e) => e.ms), [3000, 5000, 9000]);
  assert.equal(addTime(list, { ms: 1000 }).rank, 1);
  assert.equal(addTime(list, { ms: 5000 }).rank, 3, 'a tie ranks below the older time');
  for (let i = 0; i < 20; i++) list = addTime(list, { ms: 10000 + i }).list;
  assert.equal(list.length, TOP);
  assert.equal(addTime(list, { ms: 99999 }).rank, null);
});

test('stats count plays, wins and streaks', () => {
  let s;
  for (const won of [true, true, false, true, true, true, false]) s = applyResult(s, won);
  assert.deepEqual(s, { played: 7, won: 5, streak: 0, bestStreak: 3, assisted: 0 });
  assert.equal(Math.round(winRate(s) * 100), 71);
  assert.equal(winRate(undefined), 0);
});

test('custom boards get their own bucket, and no-guess boards one beside each classic one', () => {
  assert.equal(bucketFor('expert', { width: 30, height: 16, mines: 99 }), 'expert');
  assert.equal(bucketFor('custom', { width: 20, height: 10, mines: 30 }), 'custom:20x10x30');
  assert.equal(bucketFor('expert', { width: 30, height: 16, mines: 99 }, { noGuess: true }), 'expert:ng');
  assert.equal(bucketFor('custom', { width: 20, height: 10, mines: 30 }, { noGuess: true }), 'custom:20x10x30:ng');
  assert.deepEqual(parseBucket('expert'), { difficulty: 'expert', noGuess: false, daily: false });
  assert.deepEqual(parseBucket('beginner:ng'), { difficulty: 'beginner', noGuess: true, daily: false });
  assert.deepEqual(parseBucket('custom:20x10x30:ng'), { difficulty: 'custom', noGuess: true, daily: false, width: 20, height: 10, mines: 30 });
  // The daily challenge: a bucket per level, whatever the no-guess setting (its board is always one).
  assert.equal(bucketFor('expert', { width: 30, height: 16, mines: 99 }, { noGuess: false, daily: true }), 'expert:daily');
  assert.deepEqual(parseBucket('expert:daily'), { difficulty: 'expert', noGuess: true, daily: true });
});

test('a win with a hint is played, not won: no best time, the streak ends, and it is counted apart', () => {
  let s = applyResult(undefined, true);
  s = applyResult(s, true);
  s = applyResult(s, true, { hinted: true });
  assert.deepEqual(s, { played: 3, won: 2, streak: 0, bestStreak: 2, assisted: 1 });
  s = applyResult(s, false, { hinted: true }); // a hinted loss is simply a loss
  assert.deepEqual(s, { played: 4, won: 2, streak: 0, bestStreak: 2, assisted: 1 });
  const store = openStore(memory());
  assert.equal(store.record('beginner', { won: true, ms: 9000, hinted: true }).rank, null);
  assert.deepEqual(store.times('beginner'), []);
  assert.equal(store.record('beginner', { won: true, ms: 12000 }).rank, 1, 'a clean win still lands');
  assert.deepEqual(store.stats('beginner'), { played: 2, won: 1, streak: 1, bestStreak: 1, assisted: 1 });
});

test('the store persists settings, times and stats across reloads', () => {
  const backend = memory();
  const a = openStore(backend);
  a.updateSettings({ difficulty: 'expert', questionMarks: true });
  assert.equal(a.record('expert', { won: true, ms: 81234 }).rank, 1);
  a.record('expert', { won: false });
  const b = openStore(backend);
  assert.equal(b.settings.difficulty, 'expert');
  assert.equal(b.settings.questionMarks, true);
  assert.equal(b.settings.haptics, true, 'defaults fill in');
  assert.equal(b.settings.noGuess, false, 'a setting added later fills in too');
  assert.equal(b.times('expert')[0].ms, 81234);
  assert.deepEqual(b.stats('expert'), { played: 2, won: 1, streak: 0, bestStreak: 1, assisted: 0 });
  b.resetRecords();
  assert.deepEqual(openStore(backend).times('expert'), []);
});

test('a broken or unavailable storage never breaks the game', () => {
  const broken = { getItem: () => '{not json', setItem: () => { throw new Error('quota'); }, removeItem() {} };
  const s = openStore(broken);
  assert.equal(s.settings.difficulty, 'beginner');
  assert.equal(s.record('beginner', { won: true, ms: 1 }).rank, 1);
  assert.equal(openStore().settings.difficulty, 'beginner', 'no localStorage in node → memory');
});

/** A won Beginner game's replay, as app.js would keep it (a real board and moves). */
function replayOf(seed, ms = 9000) {
  const rng = mulberry32(seed);
  const g = createGame(DIFFICULTIES.beginner);
  const log = [];
  reveal(g, 40, rng);
  log.push({ t: 0, k: MOVE.open, i: 40 });
  for (let i = 0; i < g.cells && g.status === 'playing'; i++) {
    if (g.mine[i] || g.view[i] === OPEN) continue;
    reveal(g, i);
    log.push({ t: (log.length * ms) / 40, k: MOVE.open, i });
  }
  return makeReplay(g, log, { ms, won: true, level: 'beginner' });
}

test('a save from before the history, the replays and the daily loads as it was, and goes on from there', () => {
  // The format of version 1.1: no history or replay keys, best times without replay ids, no daily log.
  const backend = memory();
  backend.setItem('minesweeper-js:v1', JSON.stringify({
    settings: { difficulty: 'expert', questionMarks: true },
    times: { expert: [{ ms: 81234, date: '2026-09-01T10:00:00.000Z' }], 'beginner:ng': [{ ms: 5000, date: '2026-09-02T10:00:00.000Z' }] },
    stats: { expert: { played: 5, won: 1, streak: 0, bestStreak: 1 } },
    current: { difficulty: 'expert', game: { width: 30 }, elapsed: 1000 },
    player: { token: 'tok_aaaaaaaaaaaaaaaaaaaa', pid: '0123456789abcdef' },
  }));
  const s = openStore(backend);
  assert.equal(s.settings.difficulty, 'expert');
  assert.equal(s.settings.noGuess, false);
  assert.deepEqual(s.times('expert'), [{ ms: 81234, date: '2026-09-01T10:00:00.000Z' }]);
  assert.deepEqual(s.stats('expert'), { played: 5, won: 1, streak: 0, bestStreak: 1, assisted: 0 });
  assert.equal(s.current.elapsed, 1000);
  assert.equal(s.player.pid, '0123456789abcdef');
  assert.deepEqual(s.history(), []);
  assert.equal(s.lastReplay, null);
  assert.equal(s.replay(undefined), null);
  assert.equal(s.dailyPlayed('2026-10-01'), false);
  assert.deepEqual(s.dailyStreak('2026-10-01'), { now: 0, best: 0 });
  // The next game goes into the history and gets its replay; the old entries are kept beside it.
  const { rank, replay } = s.record('expert', { won: true, ms: 70000, bbbv: 150, clicks: 200, replay: replayOf(1, 70000) });
  assert.equal(rank, 1);
  assert.ok(replay);
  assert.deepEqual(s.times('expert').map((e) => [e.ms, Boolean(e.r)]), [[70000, true], [81234, false]]);
  const again = openStore(backend);
  assert.equal(again.history().length, 1);
  assert.equal(again.replay(replay).won, true);
  assert.equal(again.times('beginner:ng')[0].ms, 5000);
});

test('the history keeps each game compactly, newest last, within its cap', () => {
  const row = packGame({ at: Date.UTC(2026, 9, 1, 12), bucket: 'expert:ng', won: true, ranked: true, ms: 87460.4, bbbv: 151, clicks: 180, replay: 'abc' });
  assert.deepEqual(row, [1790856000, 'expert:ng', 9, 87460, 151, 180, 100, 'abc']);
  assert.deepEqual(unpackGame(row), {
    at: Date.UTC(2026, 9, 1, 12), bucket: 'expert:ng', won: true, hinted: false, practice: false, ranked: true, abandoned: false,
    ms: 87460, bbbv: 151, clicks: 180, cleared: 1, replay: 'abc',
  });
  assert.equal(unpackGame(['x']), null);
  // A board the first click clears takes no measurable time: a win is kept at 1 ms at least, never 0.
  assert.equal(packGame({ at: 0, bucket: 'custom:5x5x1', won: true, ms: 0, bbbv: 1, clicks: 1 })[3], 1);
  assert.equal(packGame({ at: 0, bucket: 'beginner', won: false, ms: 0 })[3], 0);
  const s = openStore(memory(), { historyMax: 5 });
  for (let k = 0; k < 8; k++) s.record('beginner', { won: k % 2 === 0, ms: 1000 + k, cleared: 0.5 });
  s.record('expert', { won: false, abandoned: true });
  const all = s.history();
  assert.equal(all.length, 5);
  assert.deepEqual(all.map((g) => g.ms), [1004, 1005, 1006, 1007, 0]);
  assert.equal(all[1].cleared, 0.5);
  assert.equal(all.at(-1).abandoned, true);
  assert.equal(s.history('beginner').length, 4);
});

test('practice (a daily played again) is history only: no stats, no best time', () => {
  const s = openStore(memory());
  s.record('expert:daily', { won: true, ms: 90000 });
  const before = s.stats('expert:daily');
  const r = s.record('expert:daily', { won: true, ms: 50000, practice: true, replay: replayOf(2) });
  assert.equal(r.rank, null);
  assert.deepEqual(s.stats('expert:daily'), before);
  assert.deepEqual(s.times('expert:daily').map((e) => e.ms), [90000]);
  assert.equal(s.history('expert:daily').at(-1).practice, true);
  assert.ok(s.replay(r.replay), 'still the last game, with its replay');
});

test('replays: kept for the best times and the last game, dropped when off the list, and within a budget', () => {
  const backend = memory();
  const s = openStore(backend);
  const kept = [];
  for (let k = 0; k < TOP; k++) kept.push(s.record('beginner', { won: true, ms: 10000 + k * 1000, replay: replayOf(10 + k) }).replay);
  assert.ok(kept.every((id) => s.replay(id)));
  // A loss is the last game now: its replay is kept, and the best times keep theirs.
  const loss = s.record('beginner', { won: false, replay: { ...replayOf(30), won: false } }).replay;
  assert.ok(s.replay(loss));
  assert.equal(s.lastReplay, loss);
  // A faster win pushes the tenth time off the list; its replay goes with it, the loss's (no longer the last) too.
  s.record('beginner', { won: true, ms: 5000, replay: replayOf(31) });
  assert.equal(s.replay(kept.at(-1)), null);
  assert.equal(s.replay(loss), null);
  assert.equal(s.times('beginner').length, TOP);
  assert.ok(s.times('beginner').every((e) => s.replay(e.r)));
  assert.equal(openStore(backend).replay(kept[0]).won, true, 'and they survive a reload');

  // A small budget keeps the best ones and the last game, and drops from the bottom of the list.
  const size = JSON.stringify(replayOf(40)).length;
  const tight = openStore(memory(), { replayBudget: size * 3.5 });
  const ids = [];
  for (let k = 0; k < 6; k++) ids.push(tight.record('beginner', { won: true, ms: 1000 * (k + 1), replay: replayOf(40 + k) }).replay);
  const order = tight.times('beginner').map((e) => e.ms);
  assert.deepEqual(order, [1000, 2000, 3000, 4000, 5000, 6000]);
  assert.deepEqual(tight.times('beginner').map((e) => Boolean(e.r)), [true, true, false, false, false, true], 'the best two, and the last game');
  assert.ok(tight.replay(ids.at(-1)));
});

test('a damaged history or replay store is dropped, not fatal', () => {
  const backend = memory();
  backend.setItem('minesweeper-js:history', '{oops');
  backend.setItem('minesweeper-js:replays', JSON.stringify({ items: 'nope' }));
  const s = openStore(backend);
  assert.deepEqual(s.history(), []);
  assert.equal(s.lastReplay, null);
  s.record('beginner', { won: true, ms: 9000, replay: replayOf(50) });
  assert.equal(openStore(backend).history().length, 1);
});

test('the daily log: tries by day and level, the streak of ranked wins, and reset erases it all', () => {
  const s = openStore(memory());
  s.noteDaily('2026-09-30', 'expert', { c: 1 });
  s.noteDaily('2026-09-30', 'expert', { w: 1, rk: 1, ms: 90000, r: 3 });
  s.noteDaily('2026-10-01', 'beginner', { c: 0 }); // practice only: not a day of the streak
  assert.equal(s.dailyPlayed('2026-10-01'), true);
  assert.equal(s.dailyPlayed('2026-10-02'), false);
  assert.deepEqual(s.dailyTry('2026-09-30', 'expert'), { c: 1, w: 1, rk: 1, ms: 90000, r: 3 });
  assert.deepEqual(s.dailyStreak('2026-10-01'), { now: 1, best: 1 });
  s.noteDaily('2026-10-01', 'expert', { c: 1, w: 1, rk: 1 });
  assert.deepEqual(s.dailyStreak('2026-10-01'), { now: 2, best: 2 });
  s.record('expert', { won: true, ms: 9000, replay: replayOf(60) });
  s.resetRecords();
  assert.equal(s.dailyPlayed('2026-10-01'), false);
  assert.deepEqual(s.history(), []);
  assert.equal(s.lastReplay, null);
  assert.deepEqual(s.times('expert'), []);
});
