/** Every number the server judges a game by, in one place. */
export const RULES = Object.freeze({
  // Lifetimes. A game nobody touches for half an hour is gone; so is any game after three hours.
  readyMs: 15 * 60e3, // created but never clicked
  idleMs: 30 * 60e3,
  lifeMs: 3 * 3600e3,
  finishedMs: 10 * 60e3, // kept after the end so a lost response can be fetched again
  maxGames: 4000, // live games in all; past it, new ones are refused (503) until some expire
  maxGamesPerIp: 8, // a ninth from the same address replaces its least recently played
  maxMovesPerBatch: 64,

  // A win is ranked only if it is humanly plausible: never under the floor for its level, and never faster
  // than 12 3BV per second (the fewest clicks the board needs, divided by the time; world records sit below 10).
  // The same limits hold for no-guess boards: they take away the luck, not the clicking, and their 3BV is that
  // of an ordinary board (the speed check reads each board's own).
  floorMs: Object.freeze({ beginner: 1000, intermediate: 5000, expert: 20000 }),
  maxBbbvPerSecond: 12,
  maxRankedMs: 3600e3,

  // Board variants, each ranked on its own board: classic (any layout) and ng (no guessing: logic alone clears it
  // from the first click). Old clients send none, which is classic.
  variants: Object.freeze(['classic', 'ng']),
  // A no-guess layout is tried this many times (fresh randomness each) before the game falls back to classic and
  // says so. The standard levels have never needed a second try in testing; `noGuessLimits` goes to the generator.
  noGuessTries: 3,
  noGuessLimits: Object.freeze({}),

  boardSize: 20, // entries per leaderboard page
  periods: Object.freeze({ day: 24 * 3600e3, week: 7 * 24 * 3600e3, all: Infinity }),

  // The daily challenge (src/daily.js): one no-guess board per Oslo day and level, and only a player's first try at
  // it counts. A device token is a player, so a cleared browser is a new one; to make farming first tries with fresh
  // tokens slower, one address gets this many counted first tries per level and day, and the rest are practice.
  // Generous, because a household or a mobile network shares one address.
  dailyPerIp: 6,
  dailyPeriods: Object.freeze(['today', 'yesterday']), // the daily boards GET /daily serves
});

/** Token buckets per client IP: `rate` tokens per second, up to `burst`. */
export const LIMITS = Object.freeze({
  create: { rate: 20 / 60, burst: 12 },
  move: { rate: 25, burst: 60 },
  read: { rate: 2, burst: 20 },
  name: { rate: 30 / 600, burst: 10 }, // renames from the header field, on blur or Enter
  win: { rate: 30 / 3600, burst: 12 },
});
