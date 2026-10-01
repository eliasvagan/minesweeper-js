/**
 * The daily challenge's calendar, shared by the page and the server (like names.js): which day a moment belongs to,
 * day arithmetic, and the streak of days in a row with a win. Pure functions, tested in test/daily.test.mjs.
 *
 * A "day" is a calendar day in Europe/Oslo, written 'YYYY-MM-DD': one board per day for everyone, wherever they
 * are, so the boundary is one fixed place's midnight (22:00 UTC in summer, 23:00 UTC in winter). The server decides
 * which day a game is (server/src/daily.js); the page only uses this to label things and to know whether today's
 * daily has been played on this device.
 */

export const DAILY_ZONE = 'Europe/Oslo';

let zoneFormat = null;
try {
  zoneFormat = new Intl.DateTimeFormat('en-GB', { timeZone: DAILY_ZONE, year: 'numeric', month: '2-digit', day: '2-digit' });
} catch {
  /* no time zone data (a stripped-down runtime): the EU rule below gives the same answer */
}

/**
 * Oslo's offset from UTC at `ms`, by the EU rule Norway follows: summer time (UTC+2) from 01:00 UTC on the last
 * Sunday of March to 01:00 UTC on the last Sunday of October, UTC+1 the rest of the year. Only a fallback for
 * runtimes without time zone data; Intl's tz database stays right should the rule ever change.
 */
function osloOffsetHours(ms) {
  const year = new Date(ms).getUTCFullYear();
  const lastSunday = (month) => {
    const end = new Date(Date.UTC(year, month + 1, 0)); // the month's last day
    return Date.UTC(year, month, end.getUTCDate() - end.getUTCDay(), 1);
  };
  return ms >= lastSunday(2) && ms < lastSunday(9) ? 2 : 1;
}

/** The Oslo calendar day of the moment `ms` (epoch milliseconds), as 'YYYY-MM-DD'. */
export function dayOf(ms = Date.now(), { useIntl = true } = {}) {
  if (zoneFormat && useIntl) {
    const p = Object.fromEntries(zoneFormat.formatToParts(ms).map((x) => [x.type, x.value]));
    return `${p.year}-${p.month}-${p.day}`;
  }
  return new Date(ms + osloOffsetHours(ms) * 3600e3).toISOString().slice(0, 10);
}

/** A 'YYYY-MM-DD' string, checked: the year, a month 01–12 and a day that exists in it. */
export function isDay(day) {
  if (typeof day !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(day)) return false;
  const [y, m, d] = day.split('-').map(Number);
  const t = new Date(Date.UTC(y, m - 1, d));
  return t.getUTCFullYear() === y && t.getUTCMonth() === m - 1 && t.getUTCDate() === d;
}

/** `day` moved by `n` calendar days (negative for earlier). Calendar arithmetic, so DST changes don't matter. */
export function addDays(day, n) {
  const [y, m, d] = day.split('-').map(Number);
  return new Date(Date.UTC(y, m - 1, d + n)).toISOString().slice(0, 10);
}

/**
 * Days in a row with a win. `days` are the days (any order, repeats allowed) with at least one win; `today` is the
 * current day. `now` is the run that ends today, or yesterday when today has no win yet: a streak stays alive until
 * the day is over without one. `best` is the longest run there has been. Days after `today` (a clock that was wrong)
 * count only towards `best`.
 */
export function streakOf(days, today) {
  const set = new Set(days);
  let now = 0;
  for (let d = set.has(today) ? today : addDays(today, -1); set.has(d); d = addDays(d, -1)) now++;
  let best = 0;
  let run = 0;
  let previous = null;
  for (const d of [...set].sort()) {
    run = previous !== null && addDays(previous, 1) === d ? run + 1 : 1;
    best = Math.max(best, run);
    previous = d;
  }
  return { now, best: Math.max(best, now) };
}

const WEEKDAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

/** "Thu 1 Oct" for a day ('YYYY-MM-DD'), or "1 Oct 2026" with `{ year: true, weekday: false }`. */
export function dayLabel(day, { weekday = true, year = false } = {}) {
  const [y, m, d] = day.split('-').map(Number);
  const w = new Date(Date.UTC(y, m - 1, d)).getUTCDay();
  return `${weekday ? `${WEEKDAYS[w]} ` : ''}${d} ${MONTHS[m - 1]}${year ? ` ${y}` : ''}`;
}
