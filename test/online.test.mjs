/**
 * What ranked play needs from the shared modules: 3BV (the server's speed check) and completeLayout (carrying on
 * offline after the connection drops) from engine.js, and the name rules from names.js. online.js itself is driven
 * end to end by test/e2e-live.mjs and test/e2e-pwa.mjs. Run by `npm test`.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DIFFICULTIES, OPEN, bbbv, completeLayout, createGame, indexOf, mulberry32, neighbours, reveal } from '../minesweeper/engine.js';
import { checkName } from '../minesweeper/names.js';

/** A board with mines exactly where the picture says: `*` mine, `.` safe. Starts in play. */
function fromPicture(rows) {
  const lines = rows.trim().split('\n').map((r) => r.trim());
  const g = createGame({ width: lines[0].length, height: lines.length, mines: [...lines.join('')].filter((c) => c === '*').length });
  lines.forEach((line, y) => [...line].forEach((c, x) => { if (c === '*') g.mine[indexOf(g, x, y)] = 1; }));
  for (let i = 0; i < g.cells; i++) g.adjacent[i] = neighbours(g, i).reduce((n, j) => n + g.mine[j], 0);
  g.status = 'playing';
  return g;
}

test('3BV counts openings plus isolated numbers', () => {
  assert.equal(bbbv(fromPicture(`
    .....
    .....
    .....
    ....*
  `)), 1, 'one opening clears it all');
  assert.equal(bbbv(fromPicture(`
    *.*
    ...
    *.*
  `)), 5, 'no zeros: every safe cell is a click');
  assert.equal(bbbv(fromPicture(`
    ...*.
    ...*.
  `)), 3, 'an opening, plus the two cells walled off behind the mines');
});

test('completeLayout reproduces everything already revealed, with the right mine count', () => {
  for (const d of Object.values(DIFFICULTIES)) {
    for (let seed = 1; seed <= 30; seed++) {
      const rng = mulberry32(seed);
      const real = createGame(d);
      reveal(real, Math.floor(rng() * real.cells), rng);
      // open a few more safe cells, like a player would
      for (let k = 0; k < 6; k++) {
        const safe = [...real.mine.keys()].filter((i) => !real.mine[i] && real.view[i] !== OPEN);
        if (!safe.length) break;
        reveal(real, safe[Math.floor(rng() * safe.length)], rng);
      }
      if (real.status !== 'playing') continue;
      // What a ranked client knows: the view and the numbers it was sent. No mines.
      const mirror = createGame(d);
      mirror.status = 'playing';
      for (let i = 0; i < real.cells; i++) if (real.view[i] === OPEN) { mirror.view[i] = OPEN; mirror.adjacent[i] = real.adjacent[i]; mirror.opened++; }
      assert.equal(completeLayout(mirror, rng), true, `${d.id} seed ${seed}`);
      assert.equal(mirror.mine.reduce((a, b) => a + b, 0), d.mines);
      for (let i = 0; i < real.cells; i++) {
        if (real.view[i] !== OPEN) continue;
        assert.equal(mirror.mine[i], 0);
        assert.equal(mirror.adjacent[i], real.adjacent[i]);
      }
    }
  }
});

test('completeLayout reports failure instead of inventing an impossible board', () => {
  const g = createGame({ width: 3, height: 1, mines: 2 });
  g.status = 'playing';
  g.view[1] = OPEN; g.adjacent[1] = 0; // says "no mines near me", yet two mines must fit in the other two cells
  assert.equal(completeLayout(g), false);
});

test('names: trimmed, limited, printable, and a few refused', () => {
  assert.equal(checkName('  Elias   V ').name, 'Elias V');
  assert.equal(checkName('Åse-Marie').name, 'Åse-Marie');
  assert.equal(checkName('Dickens').name, 'Dickens');
  assert.equal(checkName('a').name, null);
  assert.equal(checkName('x'.repeat(17)).name, null);
  assert.equal(checkName('ab\u200Bcd').name, 'abcd', 'zero-width characters stripped');
  assert.equal(checkName('<script>').name, null);
  assert.equal(checkName('www.spam.com').name, null, 'no links');
  assert.equal(checkName('spam.io').name, null);
  assert.equal(checkName('J. Doe').name, 'J. Doe');
  assert.equal(checkName('f.u.c.k').name, null);
  assert.equal(checkName('FUCK3R').name, null);
  assert.equal(checkName('admin').name, null);
  assert.equal(checkName('---').name, null);
  assert.equal(checkName(42).name, null);
});
