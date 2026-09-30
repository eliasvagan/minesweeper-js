/** Every number the server judges a game by, in one place. */
export const RULES = Object.freeze({
  // Lifetimes. A game nobody touches for half an hour is gone; so is any game after three hours.
  readyMs: 15 * 60e3, // created but never clicked
  idleMs: 30 * 60e3,
  lifeMs: 3 * 3600e3,
  finishedMs: 10 * 60e3, // kept after the end so a lost response can be fetched again
  maxGames: 4000,
  maxGamesPerIp: 8,
  maxMovesPerBatch: 64,

  // A win is ranked only if it is humanly plausible: never under the floor for its level, and never faster
  // than 12 3BV per second (the fewest clicks the board needs, divided by the time; world records sit below 10).
  floorMs: Object.freeze({ beginner: 1000, intermediate: 5000, expert: 20000 }),
  maxBbbvPerSecond: 12,
  maxRankedMs: 3600e3,

  boardSize: 20, // entries per leaderboard page
  periods: Object.freeze({ day: 24 * 3600e3, week: 7 * 24 * 3600e3, all: Infinity }),
});

/** Token buckets per client IP: `rate` tokens per second, up to `burst`. */
export const LIMITS = Object.freeze({
  create: { rate: 20 / 60, burst: 12 },
  move: { rate: 25, burst: 60 },
  read: { rate: 2, burst: 20 },
  name: { rate: 10 / 600, burst: 6 },
  win: { rate: 30 / 3600, burst: 12 },
});
