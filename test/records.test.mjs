/**
 * Unit tests of minesweeper/records.js: best-time lists, stats and buckets, and the store on a working storage, a
 * broken one, and the default when there is no usable localStorage (as under Node). Run by `npm test`.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { TOP, addTime, applyResult, bucketFor, openStore, winRate } from '../minesweeper/records.js';

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
  assert.deepEqual(s, { played: 7, won: 5, streak: 0, bestStreak: 3 });
  assert.equal(Math.round(winRate(s) * 100), 71);
  assert.equal(winRate(undefined), 0);
});

test('custom boards get their own bucket', () => {
  assert.equal(bucketFor('expert', { width: 30, height: 16, mines: 99 }), 'expert');
  assert.equal(bucketFor('custom', { width: 20, height: 10, mines: 30 }), 'custom:20x10x30');
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
  assert.equal(b.times('expert')[0].ms, 81234);
  assert.deepEqual(b.stats('expert'), { played: 2, won: 1, streak: 0, bestStreak: 1 });
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
