/**
 * Unit tests of minesweeper/records.js: best-time lists, stats and buckets, and the store on a working storage, a
 * broken one, and the default when there is no usable localStorage (as under Node). Run by `npm test`.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { TOP, addTime, applyResult, bucketFor, openStore, parseBucket, winRate } from '../minesweeper/records.js';

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
  assert.deepEqual(parseBucket('expert'), { difficulty: 'expert', noGuess: false });
  assert.deepEqual(parseBucket('beginner:ng'), { difficulty: 'beginner', noGuess: true });
  assert.deepEqual(parseBucket('custom:20x10x30:ng'), { difficulty: 'custom', noGuess: true, width: 20, height: 10, mines: 30 });
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
