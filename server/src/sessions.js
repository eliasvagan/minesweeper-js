/**
 * Ranked games, held in memory. The server lays the mines (after the first click, which stays safe), answers
 * every open and chord with the cells it uncovers, and keeps the clock. It never sends a mine position before
 * the game is over, so the only way to a win is to open every safe cell through these answers.
 */
import { createHash, randomBytes, randomInt } from 'node:crypto';
import { DIFFICULTIES, FLAG, HIDDEN, OPEN, bbbv, chord, createGame, neighbours, reveal } from '../../minesweeper/engine.js';
import { RULES } from './rules.js';

export class HttpError extends Error {
  constructor(status, code) {
    super(code);
    this.status = status;
    this.code = code;
  }
}

export const cryptoRandom = () => randomInt(0, 2 ** 32) / 2 ** 32;
export const validToken = (t) => typeof t === 'string' && /^[A-Za-z0-9_-]{16,64}$/.test(t);
export const hashToken = (t) => createHash('sha256').update(`minesweeper-token:${t}`).digest('hex');
/** What a player's entries carry in public: derived from the token, but no way back to it. */
export const publicId = (t) => createHash('sha256').update(`minesweeper-public:${t}`).digest('hex').slice(0, 16);

const OPEN_MOVE = 0;
const CHORD_MOVE = 1;

export class Sessions {
  constructor({ now = Date.now, random = cryptoRandom, rules = RULES } = {}) {
    this.now = now;
    this.random = random;
    this.rules = rules;
    this.games = new Map();
  }

  create({ difficulty, token, ip }) {
    const level = DIFFICULTIES[difficulty];
    if (!level || !Object.hasOwn(DIFFICULTIES, difficulty)) throw new HttpError(400, 'difficulty');
    if (!validToken(token)) throw new HttpError(400, 'token');
    this.sweep();
    // One client may hold a handful of games at once (tabs, restarts); the oldest go first.
    const mine = [...this.games.values()].filter((s) => s.ip === ip).sort((a, b) => a.lastAt - b.lastAt);
    while (mine.length >= this.rules.maxGamesPerIp) this.games.delete(mine.shift().id);
    if (this.games.size >= this.rules.maxGames) throw new HttpError(503, 'busy');
    const id = randomBytes(12).toString('base64url');
    const t = this.now();
    const session = {
      id, difficulty, ip, token: hashToken(token), game: createGame(level),
      createdAt: t, lastAt: t, startedAt: null, endedAt: null, seq: 0, last: null, moves: 0,
    };
    this.games.set(id, session);
    return { id, w: level.width, h: level.height, m: level.mines, exp: t + this.rules.readyMs };
  }

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
   * Returns `{ response, win }`, where `win` describes a win for the caller to rank.
   */
  move(id, { token, seq, moves }) {
    const s = this.get(id, token);
    if (!Number.isInteger(seq)) throw new HttpError(400, 'seq');
    if (seq === s.seq && s.last) return { response: s.last, win: null, repeat: true };
    if (s.endedAt !== null) throw new HttpError(409, 'finished');
    if (seq !== s.seq + 1) throw new HttpError(409, 'seq');
    if (!Array.isArray(moves) || moves.length < 1 || moves.length > this.rules.maxMovesPerBatch) throw new HttpError(400, 'moves');

    const g = s.game;
    const t = this.now();
    const opened = [];
    const refused = [];
    for (let k = 0; k < moves.length && (g.status === 'ready' || g.status === 'playing'); k++) {
      const m = moves[k];
      const kind = Array.isArray(m) ? m[0] : null;
      const i = Array.isArray(m) ? m[1] : null;
      if (!Number.isInteger(i) || i < 0 || i >= g.cells || (kind !== OPEN_MOVE && kind !== CHORD_MOVE)) {
        refused.push(k);
        continue;
      }
      let result;
      if (kind === OPEN_MOVE) {
        if (g.status === 'ready') s.startedAt = t;
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
        win = { ranked: !why, why, ms: response.ms, bbbv: b, moves: s.moves, difficulty: s.difficulty, id: s.id, token: s.token, ip: s.ip };
        response.ranked = !why;
        if (why) response.why = why;
      }
    }
    s.seq = seq;
    s.last = response;
    s.lastAt = t;
    return { response, win };
  }

  /**
   * A chord is honoured only if it would be legal on the player's own screen: an opened number, flags that are
   * all its covered neighbours, as many flags as the number says. Wrong flags are allowed and lose the game, as
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

  implausible(difficulty, ms, b) {
    if (!Object.hasOwn(this.rules.floorMs, difficulty)) return 'unranked-level';
    if (ms < this.rules.floorMs[difficulty]) return 'too-fast';
    if (b / (ms / 1000) > this.rules.maxBbbvPerSecond) return 'too-fast';
    if (ms > this.rules.maxRankedMs) return 'too-slow';
    return null;
  }

  /** Everything opened so far, for a page that was reloaded mid-game. */
  state(id, { token }) {
    const s = this.get(id, token);
    const g = s.game;
    const o = [];
    for (let i = 0; i < g.cells; i++) if (g.view[i] === OPEN && !g.mine[i]) o.push(i, g.adjacent[i]);
    return { s: s.seq, o, st: g.status, ms: s.startedAt === null ? 0 : (s.endedAt ?? this.now()) - s.startedAt };
  }

  sweep() {
    for (const [id, s] of this.games) if (this.expired(s)) this.games.delete(id);
  }
}
