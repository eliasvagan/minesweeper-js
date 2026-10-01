/**
 * Unit tests of the logic in minesweeper/engine.js: analyze() on positions whose answers are known (the single-cell
 * rule, subsets and pairs, the mine total, weighted probabilities), checked against brute force on many small boards,
 * and the no-guess generator (solvable from the first click by logic alone, the same board for the same seed, and
 * fast). Run with the other unit tests by `npm test`. Random boards use mulberry32 with fixed seeds.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  DIFFICULTIES, FLAG, OPEN, analyze, createGame, deserialize, indexOf, mulberry32, neighbours, placeMines,
  placeMinesNoGuess, reveal, serialize, solvesByLogic,
} from '../minesweeper/engine.js';

/**
 * A position from a picture: `*` a covered mine, `#` a covered safe cell, `.` an open cell (its number worked out
 * from the mines), `F` a flagged safe cell (a wrong flag). The mine total is the number of `*`.
 */
function position(rows) {
  const lines = rows.trim().split('\n').map((r) => r.trim());
  const flat = lines.join('');
  const g = createGame({ width: lines[0].length, height: lines.length, mines: [...flat].filter((c) => c === '*').length });
  [...flat].forEach((c, i) => {
    if (c === '*') g.mine[i] = 1;
    if (c === '.') g.view[i] = OPEN;
    if (c === 'F') { g.view[i] = FLAG; g.flags++; }
  });
  for (let i = 0; i < g.cells; i++) g.adjacent[i] = neighbours(g, i).reduce((n, j) => n + g.mine[j], 0);
  g.status = 'playing';
  return g;
}
/** What a player sees of a game, and no more: reading `mine` throws, so the solver provably never does. */
const screen = (g) => ({
  width: g.width, height: g.height, mines: g.mines, cells: g.cells, view: g.view, adjacent: g.adjacent,
  get mine() { throw new Error('the solver read the mines'); },
});
const near = (a, b) => Math.abs(a - b) < 1e-9;

test('the single-cell rule: a satisfied number clears its neighbours, a full one marks them', () => {
  const g = position(`
    ###
    *..
    ...
  `);
  // (1,1) shows 1 and sees five covered cells; (2,1) shows 0, so the top right pair is clear, and (0,2)'s 1 has
  // only (0,1) left: a mine. That satisfies (1,1), which clears the rest.
  const a = analyze(screen(g));
  assert.deepEqual(a.mines, [3]);
  assert.deepEqual(a.safe, [0, 1, 2]);
  assert.equal(a.exact, true);
});

test('subsets: 1-1 against a wall clears the third cell, from both ends', () => {
  const g = position(`
    *##*
    ....
    ....
  `);
  // (0,1)=1 sees {a,b}; (1,1)=1 sees {a,b,c}: c is safe. Mirrored, b is safe; then a and d are the mines.
  const a = analyze(screen(g));
  assert.deepEqual(a.safe, [1, 2]);
  assert.deepEqual(a.mines, [0, 3]);
});

test('pairs: 1-2-1 and 1-2 along a wall', () => {
  const oneTwoOne = analyze(screen(position(`
    *#*
    ...
    ...
  `)));
  assert.deepEqual(oneTwoOne.mines, [0, 2]);
  assert.deepEqual(oneTwoOne.safe, [1]);
  // The 2 at (2,1) sees {b,c,d} and the 1 at (1,1) sees {a,b,c}: d holds the extra mine and a is clear.
  const oneTwo = analyze(screen(position(`
    #*#*#
    .....
  `)));
  assert.deepEqual(oneTwo.mines, [1, 3]);
  assert.deepEqual(oneTwo.safe, [0, 2, 4]);
});

test('the mine total settles what the numbers alone cannot', () => {
  // A 1 between a and c, another between c and e: either c alone, or a and e together. With one mine in all, it is c,
  // and the cells away from every number (f to i) are clear too.
  const one = analyze(screen(position('#.*.#####')));
  assert.deepEqual(one.mines, [2]);
  assert.deepEqual(one.safe, [0, 4, 5, 6, 7, 8]);
  // With two mines both readings stay possible: no certainty anywhere.
  const two = analyze(screen(position('#.*.#*###')));
  assert.deepEqual([two.safe, two.mines], [[], []]);
});

test('probabilities are weighted by the ways the rest of the board can hold the remaining mines', () => {
  // Same numbers, two mines. "c alone" leaves one mine for the 4 far cells (4 ways); "a and e" leaves none (1 way).
  // So c is a mine 4 times in 5, a and e once in 5, and each far cell holds 4/5 of a mine among 4: 1/5.
  const a = analyze(screen(position('#.*.#*###')));
  assert.ok(near(a.probability[2], 0.8), `c: ${a.probability[2]}`);
  for (const i of [0, 4]) assert.ok(near(a.probability[i], 0.2), `${i}: ${a.probability[i]}`);
  for (const i of [5, 6, 7, 8]) assert.ok(near(a.probability[i], 0.2), `${i}: ${a.probability[i]}`);
  assert.equal(a.probability[1], 0, 'an open cell is no mine');
  assert.deepEqual(a.safest, [0, 4, 5, 6, 7, 8]);
  // A true 50/50: nothing safe, both halves equally likely.
  const coin = analyze(screen(position('#.*')));
  assert.deepEqual([coin.safe, coin.mines], [[], []]);
  assert.ok(near(coin.probability[0], 0.5) && near(coin.probability[2], 0.5));
  assert.deepEqual(coin.safest, [0, 2]);
});

test('flags are ignored: a wrong flag changes nothing', () => {
  const clean = analyze(screen(position(`
    *##*
    ....
    ....
  `)));
  const flagged = analyze(screen(position(`
    *#F*
    ....
    ....
  `)));
  assert.deepEqual(flagged.safe, clean.safe);
  assert.deepEqual(flagged.mines, clean.mines);
});

test('a view no layout fits is reported, not trusted', () => {
  const g = createGame({ width: 3, height: 1, mines: 2 });
  g.view[1] = OPEN; // shows 0, yet the two mines must fit in its two neighbours
  assert.equal(analyze(g).consistent, false);
});

/** Every layout of the covered cells that agrees with the screen, counted: the ground truth for small boards. */
function bruteForce(g) {
  const covered = [...g.view.keys()].filter((i) => g.view[i] !== OPEN);
  const numbers = [...g.view.keys()].filter((i) => g.view[i] === OPEN);
  const mine = new Uint8Array(g.cells);
  const hits = new Float64Array(g.cells);
  let total = 0;
  const walk = (k, placed) => {
    if (placed > g.mines || covered.length - k < g.mines - placed) return;
    if (k === covered.length) {
      for (const c of numbers) if (neighbours(g, c).reduce((n, j) => n + mine[j], 0) !== g.adjacent[c]) return;
      total++;
      for (const c of covered) hits[c] += mine[c];
      return;
    }
    walk(k + 1, placed);
    mine[covered[k]] = 1;
    walk(k + 1, placed + 1);
    mine[covered[k]] = 0;
  };
  walk(0, 0);
  return { covered, p: Array.from(hits, (h) => h / total) };
}

/** Small random games part way through: a first click and a few more safe cells opened. */
function smallPositions(count) {
  const out = [];
  for (let seed = 1; out.length < count; seed++) {
    const rng = mulberry32(seed);
    const g = createGame({ width: 4 + Math.floor(rng() * 3), height: 4 + Math.floor(rng() * 2), mines: 3 + Math.floor(rng() * 5) });
    reveal(g, Math.floor(rng() * g.cells), rng);
    for (let e = Math.floor(rng() * 4); e > 0 && g.status === 'playing'; e--) {
      const safe = [...g.mine.keys()].filter((i) => !g.mine[i] && g.view[i] !== OPEN);
      reveal(g, safe[Math.floor(rng() * safe.length)], rng);
    }
    // Brute force walks 2^covered layouts: keep it to boards it finishes in a blink.
    if (g.status === 'playing' && g.view.filter((v) => v !== OPEN).length <= 20) out.push({ g, seed });
  }
  return out;
}

test('analyze agrees exactly with brute force on 250 small positions', () => {
  let n = 0;
  for (const { g, seed } of smallPositions(250)) {
    const truth = bruteForce(g);
    const a = analyze(screen(g));
    assert.equal(a.exact, true, `seed ${seed}`);
    for (const c of truth.covered) {
      assert.ok(near(a.probability[c], truth.p[c]), `seed ${seed} cell ${c}: ${a.probability[c]} vs ${truth.p[c]}`);
      assert.equal(a.safe.includes(c), truth.p[c] === 0, `seed ${seed} cell ${c} safe`);
      assert.equal(a.mines.includes(c), truth.p[c] === 1, `seed ${seed} cell ${c} mine`);
    }
    n++;
  }
  assert.equal(n, 250);
});

test('past its budget, analyze still proves only what is true and keeps probabilities in range', () => {
  let estimates = 0;
  for (const { g, seed } of smallPositions(150)) {
    const truth = bruteForce(g);
    const a = analyze(screen(g), { budget: 3 });
    if (!a.exact) estimates++;
    for (const c of a.safe) assert.equal(truth.p[c], 0, `seed ${seed}: ${c} called safe`);
    for (const c of a.mines) assert.equal(truth.p[c], 1, `seed ${seed}: ${c} called a mine`);
    for (const c of truth.covered) assert.ok(a.probability[c] >= 0 && a.probability[c] <= 1, `seed ${seed} cell ${c}`);
  }
  assert.ok(estimates > 20, 'the tiny budget did run out');
});

/** Clear a laid board the way a player using only hints would: open whatever analyze() proves safe, until stuck. */
function clearsByHints(g) {
  for (;;) {
    if (g.status === 'won') return true;
    const { safe } = analyze(screen(g));
    if (!safe.length) return false;
    for (const s of safe) {
      assert.equal(g.mine[s], 0, 'a proven cell is never a mine');
      reveal(g, s);
    }
  }
}
const middle = (d) => indexOf(d, Math.floor(d.width / 2), Math.floor(d.height / 2));
const quantile = (sorted, q) => sorted[Math.min(sorted.length - 1, Math.floor(q * sorted.length))];

for (const [key, d] of Object.entries(DIFFICULTIES)) {
  test(`no-guess ${key}: 150 seeds, each cleared from the first click by logic alone`, (t) => {
    const times = [];
    for (let seed = 1; seed <= 150; seed++) {
      const g = createGame({ ...d, noGuess: true });
      const first = middle(d);
      const t0 = performance.now();
      const made = placeMinesNoGuess(g, first, mulberry32(seed));
      times.push(performance.now() - t0);
      assert.equal(made.noGuess, true, `seed ${seed} fell back`);
      assert.equal(g.noGuess, true);
      assert.equal(g.mine.reduce((a, b) => a + b, 0), d.mines);
      for (const j of [first, ...neighbours(g, first)]) assert.equal(g.mine[j], 0, `seed ${seed}: the first click's area is clear`);
      for (let i = 0; i < g.cells; i++) assert.equal(g.adjacent[i], neighbours(g, i).reduce((n, j) => n + g.mine[j], 0));
      assert.equal(solvesByLogic(g, first), true);
      reveal(g, first);
      assert.equal(clearsByHints(g), true, `seed ${seed}: stuck without a guess`);
    }
    times.sort((a, b) => a - b);
    t.diagnostic(`${key}: median ${quantile(times, 0.5).toFixed(2)} ms, p99 ${quantile(times, 0.99).toFixed(2)} ms, max ${times.at(-1).toFixed(2)} ms`);
    // Generous bounds, to catch a regression without failing on a slow machine.
    assert.ok(quantile(times, 0.5) < 25, `median ${quantile(times, 0.5)} ms`);
    assert.ok(times.at(-1) < 400, `worst ${times.at(-1)} ms`);
  });
}

test('no-guess boards are deterministic: the same seed and first click give the same board', () => {
  for (const d of Object.values(DIFFICULTIES)) {
    for (const seed of [1, 7, 99, 12345]) {
      const a = createGame({ ...d, noGuess: true });
      const b = createGame({ ...d, noGuess: true });
      placeMinesNoGuess(a, middle(d), mulberry32(seed));
      placeMinesNoGuess(b, middle(d), mulberry32(seed));
      assert.deepEqual([...a.mine], [...b.mine], `${d.id} seed ${seed}`);
    }
    const one = createGame({ ...d, noGuess: true });
    const other = createGame({ ...d, noGuess: true });
    placeMinesNoGuess(one, middle(d), mulberry32(1));
    placeMinesNoGuess(other, middle(d), mulberry32(2));
    assert.notDeepEqual([...one.mine], [...other.mine], 'different seeds, different boards');
  }
});

test('the first reveal of a no-guess game lays a no-guess board; saves keep the variant', () => {
  const g = createGame({ ...DIFFICULTIES.expert, noGuess: true });
  reveal(g, 200, mulberry32(5));
  assert.equal(g.noGuess, true);
  assert.equal(solvesByLogic(g, 200), true);
  const copy = deserialize(JSON.parse(JSON.stringify(serialize(g))));
  assert.equal(copy.noGuess, true);
  const old = serialize(g);
  delete old.noGuess; // a save from before no-guess boards
  assert.equal(deserialize(old).noGuess, false);
});

test('when no no-guess board turns up within the limits, an ordinary one is laid and says so', () => {
  // Half the cells mines: no-guess is out of reach here.
  const g = createGame({ width: 9, height: 9, mines: 40, noGuess: true });
  const made = placeMinesNoGuess(g, 40, mulberry32(3), { layouts: 2, repairs: 5 });
  assert.equal(made.noGuess, false);
  assert.equal(g.noGuess, false);
  assert.equal(g.status, 'playing');
  assert.equal(g.mine.reduce((a, b) => a + b, 0), 40);
  for (const j of [40, ...neighbours(g, 40)]) assert.equal(g.mine[j], 0);
  // The work cap stops a hopeless big board quickly, in work rather than time (so it is the same everywhere).
  const big = createGame({ width: 40, height: 40, mines: 800, noGuess: true });
  const t0 = performance.now();
  assert.equal(placeMinesNoGuess(big, 820, mulberry32(1)).noGuess, false);
  assert.ok(performance.now() - t0 < 2000);
});

test('classic boards are untouched by all this: same layout as before for the same seed', () => {
  const a = createGame(DIFFICULTIES.expert);
  const b = createGame(DIFFICULTIES.expert);
  placeMines(a, 100, mulberry32(42));
  reveal(b, 100, mulberry32(42));
  assert.deepEqual([...a.mine], [...b.mine]);
  assert.equal(b.noGuess, false);
});
