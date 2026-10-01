/**
 * The daily challenge's boards: one per Europe/Oslo day per ranked level, the same for everyone, and impossible to
 * work out ahead of time without the server's secret.
 *
 * Each board comes from a seed, HMAC-SHA256(secret, "minesweeper-daily:<day>:<level>"), which keys an AES-256-CTR
 * keystream: a deterministic random stream with 256 bits of key, so the same day and level give the same board on
 * every start of the server, and nobody without the secret can search for it (a 32-bit seed, like mulberry32's, could
 * be found by trying them all against the opening everyone is shown). From that stream the server picks the opening
 * cell (never on the edge, so its 3 × 3 is whole) and lays a no-guess board around it with the page's own generator
 * (engine.js), whose limits count work, never time, so the board does not depend on the machine.
 *
 * The opening is what makes the board the same whatever you click first: a daily game's first open, wherever it
 * is, opens this cell, a zero, and its flood fill. The secret comes from DAILY_SECRET, or from the database
 * (store.dailySecret) when that is not set; see src/index.js.
 */
import { createCipheriv, createHmac } from 'node:crypto';
import { DIFFICULTIES, createGame, placeMinesNoGuess } from '../../minesweeper/engine.js';
import { RULES } from './rules.js';

/** The day's seed for one level: 32 bytes that only the holder of `secret` can compute. */
export function dailyKey(secret, day, difficulty) {
  return createHmac('sha256', String(secret)).update(`minesweeper-daily:${day}:${difficulty}`).digest();
}

/** In [0, 1) like Math.random, from the AES-256-CTR keystream of `key` (zero IV): the same numbers for the same key. */
export function keyedRandom(key) {
  const cipher = createCipheriv('aes-256-ctr', key, Buffer.alloc(16));
  const zeros = Buffer.alloc(4096);
  let block = cipher.update(zeros);
  let at = 0;
  return () => {
    if (at + 4 > block.length) {
      block = cipher.update(zeros);
      at = 0;
    }
    const v = block.readUInt32LE(at);
    at += 4;
    return v / 2 ** 32;
  };
}

/**
 * The board of `day` ('YYYY-MM-DD') for `difficulty`: `{ day, difficulty, start, mine, noGuess }`, `start` being the
 * opening's cell and `mine` one byte per cell. `noGuess` is false only if the generator gave up every try (never seen
 * on the three levels); the game is then an ordinary one, and says so like any other no-guess game that falls back.
 */
export function layDaily(secret, day, difficulty, rules = RULES) {
  const level = DIFFICULTIES[difficulty];
  const rng = keyedRandom(dailyKey(secret, day, difficulty));
  const x = 1 + Math.floor(rng() * (level.width - 2));
  const y = 1 + Math.floor(rng() * (level.height - 2));
  const start = y * level.width + x;
  const game = createGame({ ...level, noGuess: true });
  let noGuess = false;
  // Each try continues the same stream, so the outcome is as deterministic as the first try.
  for (let k = 0; k < rules.noGuessTries && !noGuess; k++) {
    game.noGuess = true;
    noGuess = placeMinesNoGuess(game, start, rng, rules.noGuessLimits).noGuess;
  }
  return { day, difficulty, start, mine: game.mine.slice(), noGuess };
}

/** The boards in use, laid once each: today's and yesterday's for each level are all a day ever needs. */
export class DailyBoards {
  constructor({ secret, rules = RULES, keep = 9 }) {
    if (!secret) throw new Error('a daily secret is required');
    this.secret = secret;
    this.rules = rules;
    this.keep = keep;
    this.cache = new Map();
  }

  get(day, difficulty) {
    const key = `${day}:${difficulty}`;
    let board = this.cache.get(key);
    if (!board) {
      board = layDaily(this.secret, day, difficulty, this.rules);
      this.cache.set(key, board);
      while (this.cache.size > this.keep) this.cache.delete(this.cache.keys().next().value);
    }
    return board;
  }
}
