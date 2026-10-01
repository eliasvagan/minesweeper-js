/**
 * Ranked games, held in memory. The server lays the mines (after the first click, which stays safe), answers
 * every open and chord with the cells it uncovers, and keeps the clock. It never sends a mine position before
 * the game is over, so the only way to a win is to open every safe cell through these answers.
 *
 * A game is classic or no-guess (`variant` 'ng'): for the latter the server lays a board that logic alone clears
 * from the first click, with the same generator as the page (engine.js), and the win is ranked on its own board.
 *
 * A daily game (`daily`) is the day's board (src/daily.js), laid when the game is created: its first open, wherever
 * it is, opens the day's fixed opening, so everyone plays the same board from the same start. Which tries count is
 * the store's business (http.js asks it at the first open); here a daily game is only told apart by its board.
 */
import { createHash, randomBytes, randomInt } from 'node:crypto';
import {
  DIFFICULTIES, FLAG, HIDDEN, OPEN, bbbv, chord, computeAdjacent, createGame, neighbours, placeMinesNoGuess, reveal,
} from '../../minesweeper/engine.js';
import { dayOf } from '../../minesweeper/daily.js';
import { RULES } from './rules.js';

/** An answer other than 200: `status`, `code` (the body's `error`), and `data`, more fields for the body. */
export class HttpError extends Error {
  constructor(status, code, data = null) {
    super(code);
    this.status = status;
    this.code = code;
    this.data = data;
  }
}

/** In [0, 1) like Math.random, but from node:crypto, so nobody can work out a layout from earlier ones. */
export const cryptoRandom = () => randomInt(0, 2 ** 32) / 2 ** 32;
export const validToken = (t) => typeof t === 'string' && /^[A-Za-z0-9_-]{16,64}$/.test(t);
/** What the server keeps of a token (never the token). Its prefix is not publicId's, so the hashes are unrelated. */
export const hashToken = (t) => createHash('sha256').update(`minesweeper-token:${t}`).digest('hex');
/** What a player's entries carry in public: derived from the token, but no way back to it. */
export const publicId = (t) => createHash('sha256').update(`minesweeper-public:${t}`).digest('hex').slice(0, 16);

const OPEN_MOVE = 0;
const CHORD_MOVE = 1;

/**
 * The live games, by id. A session is `{ id, difficulty, variant, ip, token (its hash), game, createdAt, lastAt,
 * startedAt (the first open), endedAt, seq (the last batch number), last (its answer, for a retry), moves }`, and
 * for a daily game `daily: { day, start, counted }` (counted is set by http.js at the first open).
 *
 * `dailyBoards` (a DailyBoards, src/daily.js) lays the daily boards; createApp gives the sessions one if they have
 * none, from the server's secret. `onDailyStart(session, token)`, also set by createApp, files a daily game's try at
 * its first open, before anything is opened: it sets `daily.counted`, or throws to refuse the open.
 */
export class Sessions {
  constructor({ now = Date.now, random = cryptoRandom, rules = RULES, dailyBoards = null } = {}) {
    this.now = now;
    this.random = random;
    this.rules = rules;
    this.dailyBoards = dailyBoards;
    this.onDailyStart = null;
    this.games = new Map();
  }

  /** A daily game under way that is the player's counted try: never evicted to make room (see create). */
  static countedUnderWay(s) {
    return Boolean(s.daily?.counted) && s.startedAt !== null && s.endedAt === null;
  }

  /** Whether game `id` is still live: there, not expired, and not over. */
  live(id) {
    const s = this.games.get(id);
    return Boolean(s) && s.endedAt === null && !this.expired(s);
  }

  /**
   * A new game for a device. `variant` is 'classic' (also when left out, as older clients do) or 'ng'. Returns
   * `{ id, w, h, m, v, exp }`: the size, the variant, and when it expires if never clicked.
   *
   * With `daily`, it is today's daily board for the level (any `variant` is ignored: the daily is a no-guess board),
   * and the answer adds `daily: { day, start }`, the day and the opening's cell (a zero, so the page can ring it).
   * The mines are laid now, but nothing about them leaves the server before the end: not even the opening's numbers,
   * which come with the answer to the first open, the one that starts the clock.
   */
  create({ difficulty, token, ip, variant, daily = false }) {
    const level = DIFFICULTIES[difficulty];
    if (!level || !Object.hasOwn(DIFFICULTIES, difficulty)) throw new HttpError(400, 'difficulty');
    if (!validToken(token)) throw new HttpError(400, 'token');
    let v = variant === undefined || variant === null ? 'classic' : variant;
    if (!daily && !this.rules.variants.includes(v)) throw new HttpError(400, 'variant');
    if (daily && !this.dailyBoards) throw new HttpError(503, 'no-daily');
    this.sweep();
    // One client may hold a handful of games at once (tabs, restarts); the oldest go first. A counted daily under way
    // is never one of them: an address is shared (a household, a mobile network), and evicting it would take that
    // player's only try of the day. There are at most a few of those per address (rules.dailyPerIp per level).
    const mine = [...this.games.values()].filter((s) => s.ip === ip && !Sessions.countedUnderWay(s)).sort((a, b) => a.lastAt - b.lastAt);
    while (mine.length >= this.rules.maxGamesPerIp) this.games.delete(mine.shift().id);
    if (this.games.size >= this.rules.maxGames) throw new HttpError(503, 'busy');
    const id = randomBytes(12).toString('base64url');
    const t = this.now();
    let game;
    let dailyInfo = null;
    if (daily) {
      const board = this.dailyBoards.get(dayOf(t), difficulty);
      v = board.noGuess ? 'ng' : 'classic';
      game = createGame({ ...level, noGuess: board.noGuess });
      game.mine.set(board.mine);
      computeAdjacent(game);
      game.status = 'playing'; // laid; startedAt (still null) says that nothing has been opened yet
      dailyInfo = { day: board.day, start: board.start, counted: null };
    } else {
      game = createGame({ ...level, noGuess: v === 'ng' });
    }
    const session = {
      id, difficulty, variant: v, ip, token: hashToken(token), game, daily: dailyInfo,
      createdAt: t, lastAt: t, startedAt: null, endedAt: null, seq: 0, last: null, moves: 0,
    };
    this.games.set(id, session);
    const answer = { id, w: level.width, h: level.height, m: level.mines, v, exp: t + this.rules.readyMs };
    if (dailyInfo) answer.daily = { day: dailyInfo.day, start: dailyInfo.start };
    return answer;
  }

  /**
   * Lay a no-guess board around the first open, retrying with fresh randomness. Should every try fall back, the
   * game goes on as a classic one (the layout the last try fell back to) and is ranked as classic. Returns whether
   * the board is no-guess.
   */
  layNoGuess(s, first) {
    const g = s.game;
    for (let k = 0; k < this.rules.noGuessTries; k++) {
      g.noGuess = true;
      if (placeMinesNoGuess(g, first, this.random, this.rules.noGuessLimits).noGuess) return true;
    }
    s.variant = 'classic';
    return false;
  }

  /** The live session `id`, for its own device only: 404 unknown, 410 expired (and dropped), 403 someone else's. */
  get(id, token) {
    const s = typeof id === 'string' ? this.games.get(id) : undefined;
    if (!s) throw new HttpError(404, 'unknown-game');
    if (this.expired(s)) {
      this.games.delete(id);
      throw new HttpError(410, 'expired');
    }
    if (!validToken(token) || hashToken(token) !== s.token) throw new HttpError(403, 'not-yours');
    return s;
  }

  expired(s) {
    const t = this.now();
    if (s.endedAt !== null) return t - s.endedAt > this.rules.finishedMs;
    if (s.startedAt === null) return t - s.createdAt > this.rules.readyMs;
    return t - s.lastAt > this.rules.idleMs || t - s.createdAt > this.rules.lifeMs;
  }

  /**
   * Apply a batch of moves, in order: `[0, i]` opens cell i, `[1, i, [f…]]` chords number i with the cells the
   * player has flagged around it. Batches are numbered; the same number again returns the same answer (a retry
   * after a lost response), anything else out of order is refused, and a finished game takes no more moves.
   *
   * Returns `{ response, win, repeat, started, session }`: `win` describes a win for the caller to rank, `repeat`
   * marks an answer given again (any win in it was dealt with the first time), `started` says that this batch made
   * the game's first open, and `session` is the game. The response is `{ s, o, st }`, `o` being flat pairs
   * `[cell, number, …]` with -1 for a mine, plus `r` (indexes of refused moves), `v: 'classic'` when a no-guess game
   * had to fall back to an ordinary layout, and, once the game is over, `mines`, `x` (the mines that went off),
   * `ms`, and for a win `bbbv`, `ranked` and `why`.
   *
   * A daily game's first open opens the day's opening whatever cell it names, and only on the board's own day: a
   * daily created before midnight and first clicked after it is refused (409 day-over), since yesterday's board may
   * be known by then. Once started, it may finish after midnight and is filed under its own day.
   */
  move(id, { token, seq, moves }) {
    const s = this.get(id, token);
    if (!Number.isInteger(seq)) throw new HttpError(400, 'seq');
    if (seq === s.seq && s.last) return { response: s.last, win: null, repeat: true, started: false, session: s };
    if (s.endedAt !== null) throw new HttpError(409, 'finished');
    if (seq !== s.seq + 1) throw new HttpError(409, 'seq');
    if (!Array.isArray(moves) || moves.length < 1 || moves.length > this.rules.maxMovesPerBatch) throw new HttpError(400, 'moves');

    const g = s.game;
    const t = this.now();
    const opened = [];
    const refused = [];
    let fellBack = false;
    let started = false;
    // Moves after the one that ends the game are dropped, not refused.
    for (let k = 0; k < moves.length && (g.status === 'ready' || g.status === 'playing'); k++) {
      const m = moves[k];
      const kind = Array.isArray(m) ? m[0] : null;
      let i = Array.isArray(m) ? m[1] : null;
      if (!Number.isInteger(i) || i < 0 || i >= g.cells || (kind !== OPEN_MOVE && kind !== CHORD_MOVE)) {
        refused.push(k);
        continue;
      }
      let result;
      if (kind === OPEN_MOVE) {
        if (s.startedAt === null) {
          if (s.daily) {
            if (dayOf(t) !== s.daily.day) throw new HttpError(409, 'day-over');
            // Filed (or refused) before anything opens, so a refused try learns nothing about the board.
            if (this.onDailyStart) this.onDailyStart(s, token);
            i = s.daily.start;
          } else if (s.variant === 'ng') {
            fellBack = !this.layNoGuess(s, i);
          }
          s.startedAt = t; // the clock starts at the first open the server receives
          started = true;
        }
        result = reveal(g, i, this.random);
      } else {
        result = this.chord(g, i, m[2]);
        if (!result) {
          refused.push(k);
          continue;
        }
      }
      s.moves++;
      for (const [j] of result.opened) opened.push(j, g.mine[j] ? -1 : g.adjacent[j]);
    }

    const response = { s: seq, o: opened, st: g.status };
    if (refused.length) response.r = refused;
    if (fellBack) response.v = 'classic';
    let win = null;
    if (g.status === 'won' || g.status === 'lost') {
      s.endedAt = t;
      response.mines = [...g.mine.keys()].filter((j) => g.mine[j]);
      if (g.status === 'lost') response.x = [...g.exploded];
      response.ms = t - s.startedAt;
      if (g.status === 'won') {
        const b = bbbv(g);
        response.bbbv = b;
        const why = this.implausible(s.difficulty, response.ms, b);
        win = {
          ranked: !why, why, ms: response.ms, bbbv: b, moves: s.moves, difficulty: s.difficulty, variant: s.variant,
          id: s.id, token: s.token, ip: s.ip,
        };
        response.ranked = !why;
        if (why) response.why = why;
      }
    }
    s.seq = seq;
    s.last = response;
    s.lastAt = t;
    return { response, win, repeat: false, started, session: s };
  }

  /**
   * A chord is honoured only if it would be legal on the player's own screen: an opened number, flags that are
   * all among its covered neighbours, as many flags as the number says. Wrong flags are allowed and lose the game, as
   * they would locally. Returns null for an illegal chord.
   */
  chord(g, i, flags) {
    if (g.view[i] !== OPEN || g.adjacent[i] === 0 || !Array.isArray(flags)) return null;
    if (flags.length !== g.adjacent[i] || new Set(flags).size !== flags.length) return null;
    const around = new Set(neighbours(g, i));
    for (const f of flags) if (!Number.isInteger(f) || !around.has(f) || g.view[f] === OPEN) return null;
    for (const f of flags) g.view[f] = FLAG;
    g.flags += flags.length;
    const result = chord(g, i);
    // The server keeps no flags of its own: take these back down (a win re-flags every mine anyway).
    if (g.status !== 'won') for (const f of flags) if (g.view[f] === FLAG) g.view[f] = HIDDEN;
    if (g.status !== 'won') g.flags -= flags.length;
    return result.opened.length ? result : null;
  }

  /** Why a win of `ms` with 3BV `b` cannot be ranked (see RULES), or null when it can. */
  implausible(difficulty, ms, b) {
    if (!Object.hasOwn(this.rules.floorMs, difficulty)) return 'unranked-level';
    if (ms < this.rules.floorMs[difficulty]) return 'too-fast';
    if (b / (ms / 1000) > this.rules.maxBbbvPerSecond) return 'too-fast';
    if (ms > this.rules.maxRankedMs) return 'too-slow';
    return null;
  }

  /**
   * The player walks away from a game (a new one, another level): it ends here, as a loss, with nothing revealed,
   * and frees its place. Returns the session, for the caller to file a daily try that ends this way.
   */
  close(id, { token }) {
    const s = this.get(id, token);
    if (s.endedAt === null) {
      s.endedAt = this.now();
      s.game.status = 'lost';
      s.last = null; // no answer to repeat: a move after this is refused as finished
    }
    return s;
  }

  /**
   * Everything opened so far (and the variant, which a fallback may have changed), for a page reloaded mid-game. A
   * game nothing has been opened in is 'ready', a daily one included (its mines are laid, but that is not news to
   * share). A daily game also says its day, opening and whether it counts.
   */
  state(id, { token }) {
    const s = this.get(id, token);
    const g = s.game;
    const o = [];
    for (let i = 0; i < g.cells; i++) if (g.view[i] === OPEN && !g.mine[i]) o.push(i, g.adjacent[i]);
    const answer = {
      s: s.seq, o, st: s.startedAt === null ? 'ready' : g.status, v: s.variant,
      ms: s.startedAt === null ? 0 : (s.endedAt ?? this.now()) - s.startedAt,
    };
    if (s.daily) answer.daily = { day: s.daily.day, start: s.daily.start, counted: s.daily.counted };
    return answer;
  }

  sweep() {
    for (const [id, s] of this.games) if (this.expired(s)) this.games.delete(id);
  }
}
