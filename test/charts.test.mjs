/**
 * Unit tests of minesweeper/charts.js's scale: the statistics sheet's hairlines sit on clean numbers (steps of 1, 2
 * or 5 times a power of ten) that hold every value, so their labels show them exactly. The charts themselves are
 * drawn and read in a browser by test/e2e.mjs. Run by `npm test`.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { niceRange } from '../minesweeper/charts.js';

test('the scale holds every value, on clean numbers, without float noise', () => {
  assert.deepEqual(niceRange([0.65, 1.7]), [0.6, 1.8]);
  assert.deepEqual(niceRange([7.9, 20.4]), [6, 22]);
  assert.deepEqual(niceRange([64, 100]), [60, 100]);
  assert.deepEqual(niceRange([1.21, 2.4]), [1.2, 2.4]);
  assert.deepEqual(niceRange([87.46, 140.2, 101]), [80, 150]);
  assert.deepEqual(niceRange([5, 5]), [4, 6], 'one value still gets a range');
  for (const values of [[0.01, 0.02], [123, 4567], [9.99, 10.01], [33, 34, 35]]) {
    const [lo, hi] = niceRange(values);
    assert.ok(lo <= Math.min(...values) && hi >= Math.max(...values), JSON.stringify(values));
    assert.equal(String(lo).length < 12 && String(hi).length < 12, true, `${lo} ${hi}`);
  }
});
