/**
 * What a finished game shares: one line for an ordinary game, a few for the daily challenge. Pure (app.js hands it
 * the facts and does the sharing), tested in test/share.test.mjs.
 *
 *   Minesweeper · Expert (no guessing) · 57.4 s · 3BV/s 2.10 · #4 in 24 h · https://eliasv.com/minesweeper/
 *
 *   Minesweeper daily · 1 Oct 2026 · Expert
 *   57.4 s · 3BV/s 2.10 · #4 of 37
 *   🟩🟩🟩⬜⬜⬜⬜⬜⬜⬜
 *   🟩🟩🟩🟩🟩⬜⬜⬜⬜⬜
 *   🟩🟩🟩🟩🟩🟩⬜⬜⬜⬜
 *   🟩🟩🟩🟩🟩🟩🟩🟩⬜⬜
 *   🟩🟩🟩🟩🟩🟩🟩🟩🟩🟩
 *   https://eliasv.com/minesweeper/#daily
 *
 * The daily's grid is the game's pace, not its board: each row is a fifth of the time, filled to the share of the
 * safe cells open by then (in tenths), with 💥 where a loss ended it. Everyone has the same board that day, so
 * anything with positions in it (where the opening was, which cells went first, where the mine was) would tell the
 * next player about the board; counts at five moments tell them nothing about where anything is, and still show how
 * a game went: a quick opening, a slow middle, a fast finish.
 */
import { dayLabel } from './daily.js';

/** Seconds to the tenth, truncated, like the page: "9.4", "1:02.5". */
export function formatSeconds(ms) {
  const tenths = Math.floor(ms / 100);
  const s = Math.floor(tenths / 10);
  const t = tenths % 10;
  if (s < 60) return `${s}.${t}`;
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}.${t}`;
}

/**
 * The share of the safe cells open at the end of each fifth of the game (`rows` of them), from `timeline`
 * (`[[t, opened]]` in time order, Playback.timeline) and the game's time `ms`. The last row is the end of the game.
 */
export function progressOf(timeline, ms, safe, rows = 5) {
  const out = [];
  for (let k = 1; k <= rows; k++) {
    // Move times are the taps, kept to the hundredth; the last row takes everything, whatever the clock said.
    const until = k === rows ? Infinity : (ms * k) / rows + 10;
    let opened = 0;
    for (const [t, o] of timeline) {
      if (t > until) break;
      opened = o;
    }
    out.push(safe > 0 ? Math.min(1, opened / safe) : 0);
  }
  return out;
}

const CLEARED = '🟩';
const COVERED = '⬜';
const BOOM = '💥';

/** The grid: a row of ten per fraction in `progress`, and on a loss a 💥 just past the last row's progress. */
export function progressGrid(progress, { lost = false } = {}) {
  return progress.map((f, k) => {
    const n = Math.max(0, Math.min(10, Math.floor(f * 10 + 1e-9)));
    if (lost && k === progress.length - 1) {
      const before = Math.min(n, 9);
      return CLEARED.repeat(before) + BOOM + COVERED.repeat(9 - before);
    }
    return CLEARED.repeat(n) + COVERED.repeat(10 - n);
  }).join('\n');
}

/**
 * The text. `r` is
 *   level      'Beginner', 'Intermediate', 'Expert' or 'Custom'; `dims` ('20 × 12 · 40') for a custom board
 *   noGuess    a no-guess board
 *   won, ms    how it ended and the time; `hinted` for a win with a hint
 *   rate       3BV per second (wins)
 *   cleared    the share of the safe cells opened (losses)
 *   rank       a ranked win's place in the last 24 hours, or null
 *   daily      `{ day, counted, rank, n }` for the daily challenge (rank among the day's ranked wins, of n players)
 *   progress   for the daily: progressOf's fractions, for the grid
 *   url        the link at the end
 */
export function shareText(r) {
  const parts = [];
  const result = r.won
    ? `${formatSeconds(r.ms)} s${r.hinted ? ' with a hint' : ''}`
    : `mine hit, ${Math.floor((r.cleared || 0) * 100)}% cleared`;
  const rate = r.won && Number.isFinite(r.rate) && r.rate > 0 ? `3BV/s ${r.rate.toFixed(2)}` : null;
  if (r.daily) {
    const title = `Minesweeper daily · ${dayLabel(r.daily.day, { weekday: false, year: true })} · ${r.level}${r.daily.counted ? '' : ' (practice)'}`;
    const line = [r.won ? result : result[0].toUpperCase() + result.slice(1)];
    if (rate) line.push(rate);
    if (r.daily.counted && r.won && r.daily.rank) line.push(`#${r.daily.rank}${r.daily.n ? ` of ${r.daily.n}` : ''}`);
    parts.push(title, line.join(' · '));
    if (r.progress?.length) parts.push(progressGrid(r.progress, { lost: !r.won }));
    if (r.url) parts.push(r.url);
    return parts.join('\n');
  }
  const level = r.level === 'Custom' && r.dims ? `Custom ${r.dims}` : r.level;
  parts.push('Minesweeper', `${level}${r.noGuess ? ' (no guessing)' : ''}`, result);
  if (rate) parts.push(rate);
  if (r.won && !r.hinted && r.rank) parts.push(`#${r.rank} in 24 h`);
  if (r.url) parts.push(r.url);
  return parts.join(' · ');
}
