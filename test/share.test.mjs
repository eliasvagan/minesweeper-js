/**
 * Unit tests of minesweeper/share.js: the text a finished game shares, ordinary and daily, and the daily's pattern
 * of pace, which must say how a game went without saying anything about where things are. Run by `npm test`.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { formatSeconds, progressGrid, progressOf, shareText } from '../minesweeper/share.js';

const URL_ = 'https://eliasv.com/minesweeper/';

test('an ordinary game: level, variant, time, speed, rank and the link, on one line', () => {
  assert.equal(
    shareText({ level: 'Expert', noGuess: true, won: true, ms: 57460, rate: 2.104, rank: 4, url: URL_ }),
    'Minesweeper · Expert (no guessing) · 57.4 s · 3BV/s 2.10 · #4 in 24 h · https://eliasv.com/minesweeper/',
  );
  assert.equal(shareText({ level: 'Beginner', won: true, ms: 9400, rate: 1.8, rank: null, url: URL_ }), `Minesweeper · Beginner · 9.4 s · 3BV/s 1.80 · ${URL_}`);
  assert.equal(shareText({ level: 'Custom', dims: '20 × 12 · 40', won: true, ms: 62500, rate: 1.1, url: URL_ }), `Minesweeper · Custom 20 × 12 · 40 · 1:02.5 s · 3BV/s 1.10 · ${URL_}`);
  // A hint is said, and keeps a rank out; a loss says how far it got.
  assert.equal(shareText({ level: 'Beginner', won: true, hinted: true, ms: 12000, rate: 1.5, rank: 3, url: URL_ }), `Minesweeper · Beginner · 12.0 s with a hint · 3BV/s 1.50 · ${URL_}`);
  assert.equal(shareText({ level: 'Intermediate', won: false, ms: 30000, cleared: 0.637, url: URL_ }), `Minesweeper · Intermediate · mine hit, 63% cleared · ${URL_}`);
});

test('the daily: the day, the level, the result, the pace grid and the link to the daily', () => {
  const text = shareText({
    level: 'Expert', won: true, ms: 57460, rate: 2.104, url: `${URL_}#daily`,
    daily: { day: '2026-10-01', counted: true, rank: 4, n: 37 }, progress: [0.31, 0.5, 0.62, 0.86, 1],
  });
  assert.equal(text, [
    'Minesweeper daily · 1 Oct 2026 · Expert',
    '57.4 s · 3BV/s 2.10 · #4 of 37',
    '🟩🟩🟩⬜⬜⬜⬜⬜⬜⬜',
    '🟩🟩🟩🟩🟩⬜⬜⬜⬜⬜',
    '🟩🟩🟩🟩🟩🟩⬜⬜⬜⬜',
    '🟩🟩🟩🟩🟩🟩🟩🟩⬜⬜',
    '🟩🟩🟩🟩🟩🟩🟩🟩🟩🟩',
    'https://eliasv.com/minesweeper/#daily',
  ].join('\n'));
  // Practice says so and has no rank; a loss ends its grid on 💥.
  const practice = shareText({ level: 'Beginner', won: true, ms: 9000, rate: 2, daily: { day: '2026-10-01', counted: false }, progress: [1, 1, 1, 1, 1] });
  assert.match(practice, /^Minesweeper daily · 1 Oct 2026 · Beginner \(practice\)\n9\.0 s · 3BV\/s 2\.00\n/);
  const lost = shareText({ level: 'Expert', won: false, ms: 40000, cleared: 0.42, daily: { day: '2026-10-01', counted: true, rank: null, n: 9 }, progress: [0.2, 0.25, 0.3, 0.38, 0.42] });
  assert.equal(lost.split('\n')[1], 'Mine hit, 42% cleared');
  assert.equal(lost.split('\n').at(-1), '🟩🟩🟩🟩💥⬜⬜⬜⬜⬜');
});

test('the grid is pace only: the same pace on different boards shares the same pattern', () => {
  // Two games on different boards (a 9 × 9 and a 30 × 16), with the same share opened at the same moments.
  const a = progressOf([[0, 14], [3000, 30], [6000, 50], [9000, 71]], 9000, 71);
  const b = progressOf([[0, 76], [3000, 163], [6000, 272], [9000, 381]], 9000, 381);
  assert.equal(progressGrid(a), progressGrid(b));
  for (const line of progressGrid(a).split('\n')) assert.match(line, /^(🟩|⬜)+$/u);
  assert.equal([...progressGrid(a).split('\n')[0]].length, 10);
});

test('progress samples the end of each fifth of the time, and the last row is the end of the game', () => {
  const line = [[0, 10], [1000, 20], [2500, 40], [4000, 60], [5000, 80], [9990, 100]];
  assert.deepEqual(progressOf(line, 10000, 100), [0.2, 0.6, 0.8, 0.8, 1]);
  assert.deepEqual(progressOf([], 10000, 100), [0, 0, 0, 0, 0]);
  assert.deepEqual(progressGrid([0, 0.05, 0.99, 1, 1]).split('\n').map((l) => [...l].filter((c) => c === '🟩').length), [0, 0, 9, 10, 10]);
  assert.equal(formatSeconds(9449), '9.4');
  assert.equal(formatSeconds(62500), '1:02.5');
});
