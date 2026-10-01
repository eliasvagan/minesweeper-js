/**
 * Unit tests of minesweeper/daily.js, the daily challenge's calendar shared by the page and the server: Oslo days
 * across both daylight-saving changes (and the fallback for runtimes without time zone data), day arithmetic, and
 * streaks. The server's own daily tests (server/test/daily.test.mjs) play it over HTTP. Run by `npm test`.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { addDays, dayLabel, dayOf, isDay, streakOf } from '../minesweeper/daily.js';

test('a day is the Oslo calendar day: midnight is 22:00 UTC in summer time and 23:00 UTC in winter', () => {
  assert.equal(dayOf(Date.parse('2026-10-01T21:59:59Z')), '2026-10-01');
  assert.equal(dayOf(Date.parse('2026-10-01T22:00:00Z')), '2026-10-02');
  // Summer time ends at 01:00 UTC on 25 October 2026, so the 25th runs from 22:00 UTC on the 24th to 23:00 UTC.
  assert.equal(dayOf(Date.parse('2026-10-24T22:00:00Z')), '2026-10-25');
  assert.equal(dayOf(Date.parse('2026-10-25T22:59:59Z')), '2026-10-25');
  assert.equal(dayOf(Date.parse('2026-10-25T23:00:00Z')), '2026-10-26');
  // And begins at 01:00 UTC on 29 March 2026: the 28th ends at 23:00 UTC, the 29th (23 hours long) at 22:00 UTC.
  assert.equal(dayOf(Date.parse('2026-03-28T22:59:59Z')), '2026-03-28');
  assert.equal(dayOf(Date.parse('2026-03-28T23:00:00Z')), '2026-03-29');
  assert.equal(dayOf(Date.parse('2026-03-29T21:59:59Z')), '2026-03-29');
  assert.equal(dayOf(Date.parse('2026-03-29T22:00:00Z')), '2026-03-30');
});

test('without time zone data, the EU rule gives the same days (checked every 15 minutes over three years)', () => {
  for (let t = Date.UTC(2025, 0, 1); t < Date.UTC(2028, 0, 1); t += 15 * 60e3) {
    if (dayOf(t) !== dayOf(t, { useIntl: false })) assert.fail(new Date(t).toISOString());
  }
});

test('day arithmetic is calendar arithmetic, and days are checked', () => {
  assert.equal(addDays('2026-03-01', -1), '2026-02-28');
  assert.equal(addDays('2028-03-01', -1), '2028-02-29');
  assert.equal(addDays('2026-12-31', 1), '2027-01-01');
  assert.equal(addDays('2026-10-25', 1), '2026-10-26', 'a 25-hour day is still one day');
  assert.equal(isDay('2026-10-01'), true);
  assert.equal(isDay('2026-02-29'), false);
  assert.equal(isDay('2026-1-1'), false);
  assert.equal(isDay(20261001), false);
  assert.equal(dayLabel('2026-10-01'), 'Thu 1 Oct');
  assert.equal(dayLabel('2026-10-01', { weekday: false, year: true }), '1 Oct 2026');
});

test('a streak is the run of days with a win ending today, or yesterday while today has none yet', () => {
  const won = ['2026-09-26', '2026-09-27', '2026-09-28', '2026-09-30', '2026-10-01'];
  assert.deepEqual(streakOf(won, '2026-10-01'), { now: 2, best: 3 });
  assert.deepEqual(streakOf(won, '2026-10-02'), { now: 2, best: 3 }, 'still alive on a day not played yet');
  assert.deepEqual(streakOf(won, '2026-10-03'), { now: 0, best: 3 }, 'a day went by without one');
  assert.deepEqual(streakOf([], '2026-10-01'), { now: 0, best: 0 });
  assert.deepEqual(streakOf(['2026-10-01', '2026-10-01'], '2026-10-01'), { now: 1, best: 1 }, 'two wins on a day are one day');
  // Across a month and a year, and around the 25-hour day.
  assert.deepEqual(streakOf(['2026-12-30', '2026-12-31', '2027-01-01'], '2027-01-01').now, 3);
  assert.deepEqual(streakOf(['2026-10-24', '2026-10-25', '2026-10-26'], '2026-10-26').now, 3);
});
