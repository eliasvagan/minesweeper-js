import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  DIFFICULTIES, FLAG, HIDDEN, OPEN, QUESTION, activate, canChord, chord, createGame, deserialize, indexOf,
  maxMinesFor, minesLeft, mulberry32, neighbours, reveal, sanitizeCustom, serialize, toggleMark, wrongFlags,
} from '../minesweeper/engine.js';

/** A board with mines exactly where the picture says: `*` mine, `.` safe. Starts in play. */
function fromPicture(rows) {
  const lines = rows.trim().split('\n').map((r) => r.trim());
  const game = createGame({ width: lines[0].length, height: lines.length, mines: [...lines.join('')].filter((c) => c === '*').length });
  lines.forEach((line, y) => [...line].forEach((c, x) => { if (c === '*') game.mine[indexOf(game, x, y)] = 1; }));
  for (let i = 0; i < game.cells; i++) game.adjacent[i] = neighbours(game, i).reduce((n, j) => n + game.mine[j], 0);
  game.status = 'playing';
  return game;
}
const count = (arr, v) => arr.reduce((n, x) => n + (x === v), 0);

test('difficulties match the classic presets', () => {
  assert.deepEqual([DIFFICULTIES.beginner.width, DIFFICULTIES.beginner.height, DIFFICULTIES.beginner.mines], [9, 9, 10]);
  assert.deepEqual([DIFFICULTIES.intermediate.width, DIFFICULTIES.intermediate.height, DIFFICULTIES.intermediate.mines], [16, 16, 40]);
  assert.deepEqual([DIFFICULTIES.expert.width, DIFFICULTIES.expert.height, DIFFICULTIES.expert.mines], [30, 16, 99]);
});

test('custom boards are clamped to sane limits', () => {
  assert.deepEqual(sanitizeCustom({ width: 2, height: 999, mines: 5 }), { width: 5, height: 40, mines: 5 });
  assert.deepEqual(sanitizeCustom({ width: 5, height: 5, mines: 1000 }), { width: 5, height: 5, mines: 16 });
  assert.deepEqual(sanitizeCustom({ width: '12.6', height: 'abc', mines: 0 }), { width: 13, height: 20, mines: 1 });
  assert.equal(maxMinesFor(9, 9), 72);
});

test('createGame rejects impossible boards', () => {
  assert.throws(() => createGame({ width: 0, height: 5, mines: 1 }), RangeError);
  assert.throws(() => createGame({ width: 3, height: 3, mines: 9 }), RangeError);
});

test('neighbours respect edges and corners', () => {
  const g = createGame({ width: 4, height: 3, mines: 1 });
  assert.equal(neighbours(g, 0).length, 3);
  assert.equal(neighbours(g, indexOf(g, 1, 0)).length, 5);
  assert.equal(neighbours(g, indexOf(g, 1, 1)).length, 8);
  assert.deepEqual(neighbours(g, indexOf(g, 3, 2)).sort((a, b) => a - b), [6, 7, 10]);
});

test('generation lays exactly the requested mines with correct counts', () => {
  for (const [key, d] of Object.entries(DIFFICULTIES)) {
    for (let seed = 1; seed <= 25; seed++) {
      const g = createGame(d);
      reveal(g, indexOf(g, 4, 4), mulberry32(seed));
      assert.equal(count(g.mine, 1), d.mines, `${key} seed ${seed}`);
      for (let i = 0; i < g.cells; i++) {
        assert.equal(g.adjacent[i], neighbours(g, i).reduce((n, j) => n + g.mine[j], 0));
      }
    }
  }
});

test('the first click is always safe and opens an area, even on dense boards', () => {
  for (let seed = 1; seed <= 300; seed++) {
    const rng = mulberry32(seed);
    const g = createGame({ width: 9, height: 9, mines: 72 }); // maximum density
    const first = Math.floor(rng() * g.cells);
    const r = reveal(g, first, rng);
    assert.equal(r.exploded, false);
    assert.equal(g.mine[first], 0);
    for (const j of neighbours(g, first)) assert.equal(g.mine[j], 0, `seed ${seed}`);
    assert.equal(g.adjacent[first], 0);
    assert.ok(r.opened.length >= 4, 'a zero opens its neighbours');
  }
});

test('mines are spread over the whole board (no positional bias)', () => {
  const hits = new Array(81).fill(0);
  const rng = mulberry32(7);
  for (let n = 0; n < 2000; n++) {
    const g = createGame(DIFFICULTIES.beginner);
    reveal(g, 0, rng);
    g.mine.forEach((m, i) => { hits[i] += m; });
  }
  const eligible = hits.filter((_, i) => ![0, 1, 9, 10].includes(i));
  const mean = eligible.reduce((a, b) => a + b, 0) / eligible.length;
  for (const h of eligible) assert.ok(Math.abs(h - mean) < mean * 0.35, `${h} vs ${mean}`);
  assert.equal(hits[0] + hits[1] + hits[9] + hits[10], 0);
});

test('flood fill opens zeros and their numbered border, breadth first', () => {
  const g = fromPicture(`
    .....
    .....
    .....
    ....*
  `);
  const r = reveal(g, 0);
  const opened = new Set(r.opened.map(([i]) => i));
  assert.equal(opened.size, g.cells - 1, 'everything but the mine opens');
  assert.equal(g.status, 'won');
  assert.equal(r.opened[0][1], 0);
  const depths = r.opened.map(([, d]) => d);
  assert.deepEqual(depths, [...depths].sort((a, b) => a - b), 'depths never decrease');
  assert.ok(!opened.has(indexOf(g, 4, 3)));
});

test('flood fill does not reach numbers that border no zero', () => {
  const g = fromPicture(`
    .....
    .....
    ...*.
    .....
  `);
  const r = reveal(g, 0);
  const opened = new Set(r.opened.map(([i]) => i));
  assert.equal(opened.size, 16);
  for (const [x, y] of [[4, 2], [4, 3], [3, 3]]) assert.ok(!opened.has(indexOf(g, x, y)));
  assert.equal(g.status, 'playing');
});

test('flood fill stops at numbers and never opens flags', () => {
  const g = fromPicture(`
    ..*..
    ..*..
    ..*..
  `);
  toggleMark(g, indexOf(g, 0, 2));
  const r = reveal(g, 0);
  const opened = new Set(r.opened.map(([i]) => i));
  assert.ok(opened.has(indexOf(g, 1, 0)) && opened.has(indexOf(g, 1, 1)));
  assert.ok(!opened.has(indexOf(g, 3, 0)), 'does not cross the wall');
  assert.equal(g.view[indexOf(g, 0, 2)], FLAG);
  assert.equal(g.status, 'playing');
});

test('revealing a flag or an opened cell does nothing', () => {
  const g = fromPicture(`
    *..
    ...
  `);
  toggleMark(g, 0);
  assert.equal(reveal(g, 0).opened.length, 0);
  reveal(g, 2);
  assert.equal(reveal(g, 2).opened.length, 0);
});

test('chord opens the remaining neighbours when flags match', () => {
  const g = fromPicture(`
    *...
    ....
    ....
    ...*
  `);
  const one = indexOf(g, 1, 1);
  reveal(g, one);
  assert.equal(g.view[one], OPEN);
  assert.equal(canChord(g, one), false, 'no flags yet');
  assert.equal(chord(g, one).opened.length, 0);
  toggleMark(g, 0);
  assert.equal(canChord(g, one), true);
  const r = activate(g, one);
  assert.equal(r.exploded, false);
  for (const j of neighbours(g, one)) if (j !== 0) assert.equal(g.view[j], OPEN);
  assert.equal(canChord(g, one), false, 'nothing left to open');
});

test('chord treats question marks as covered cells', () => {
  const g = fromPicture(`
    *..
    ...
  `);
  const one = indexOf(g, 1, 1);
  reveal(g, one);
  toggleMark(g, 0);
  toggleMark(g, 2, { questionMarks: true });
  toggleMark(g, 2, { questionMarks: true });
  assert.equal(g.view[2], QUESTION);
  chord(g, one);
  assert.equal(g.view[2], OPEN);
});

test('a chord with a wrong flag loses and reports every mine it hit', () => {
  const g = fromPicture(`
    *.*
    ...
    ...
  `);
  const two = indexOf(g, 1, 1);
  reveal(g, two);
  toggleMark(g, indexOf(g, 0, 1)); // wrong
  toggleMark(g, indexOf(g, 1, 2)); // wrong
  const r = chord(g, two);
  assert.equal(r.exploded, true);
  assert.equal(g.status, 'lost');
  assert.deepEqual([...g.exploded].sort(), [0, 2]);
  assert.deepEqual(wrongFlags(g).sort(), [3, 7]);
});

test('clicking a mine loses; nothing moves afterwards', () => {
  const g = fromPicture(`
    *.
    ..
  `);
  const r = reveal(g, 0);
  assert.equal(r.exploded, true);
  assert.equal(g.status, 'lost');
  assert.deepEqual(g.exploded, [0]);
  assert.equal(reveal(g, 3).opened.length, 0);
  assert.equal(toggleMark(g, 3), false);
});

test('win when every safe cell is open; remaining mines get flagged', () => {
  const g = fromPicture(`
    *..
    ...
    ..*
  `);
  for (const i of [1, 3, 5, 7]) reveal(g, i);
  assert.equal(g.status, 'playing');
  reveal(g, 2);
  assert.equal(g.status, 'playing');
  const r = reveal(g, 6);
  assert.equal(r.status, 'won');
  assert.equal(g.view[0], FLAG);
  assert.equal(minesLeft(g), 0);
  reveal(g, 4);
  assert.equal(g.status, 'won');
});

test('a win does not require flags, and flags can be wrong-free at the end', () => {
  const g = fromPicture(`
    .*
    ..
  `);
  toggleMark(g, 3);
  toggleMark(g, 3);
  reveal(g, 0); reveal(g, 2); reveal(g, 3);
  assert.equal(g.status, 'won');
  assert.deepEqual(wrongFlags(g), []);
});

test('flag cycling, with and without question marks, keeps the counter honest', () => {
  const g = createGame({ width: 3, height: 3, mines: 2 });
  assert.equal(toggleMark(g, 0), true);
  assert.equal(g.view[0], FLAG);
  assert.equal(minesLeft(g), 1);
  toggleMark(g, 0);
  assert.equal(g.view[0], HIDDEN);
  toggleMark(g, 0, { questionMarks: true });
  toggleMark(g, 0, { questionMarks: true });
  assert.equal(g.view[0], QUESTION);
  assert.equal(minesLeft(g), 2);
  toggleMark(g, 0, { questionMarks: true });
  assert.equal(g.view[0], HIDDEN);
  for (let i = 0; i < 5; i++) toggleMark(g, i);
  assert.equal(minesLeft(g), -3, 'over-flagging goes negative, like the original');
});

test('flags placed before the first click survive mine placement', () => {
  const g = createGame(DIFFICULTIES.beginner);
  toggleMark(g, 80);
  reveal(g, 0, mulberry32(3));
  assert.equal(g.view[80], FLAG);
  assert.equal(g.flags, 1);
});

test('serialize → deserialize round-trips a game in progress', () => {
  const g = createGame(DIFFICULTIES.intermediate);
  reveal(g, 100, mulberry32(11));
  toggleMark(g, g.mine.indexOf(1));
  const copy = deserialize(JSON.parse(JSON.stringify(serialize(g))));
  assert.deepEqual([...copy.mine], [...g.mine]);
  assert.deepEqual([...copy.view], [...g.view]);
  assert.deepEqual([...copy.adjacent], [...g.adjacent]);
  assert.equal(copy.opened, g.opened);
  assert.equal(copy.flags, g.flags);
  assert.equal(copy.status, 'playing');
  assert.throws(() => deserialize({ ...serialize(g), view: '0' }));
});
