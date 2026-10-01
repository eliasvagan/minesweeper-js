/**
 * Replays: what a finished game needs to be watched again, kept compactly, and the playback that rebuilds it move by
 * move with the rules in engine.js. Pure (no DOM, no storage); records.js keeps them, app.js draws them, and
 * test/replay.test.mjs checks both directions.
 *
 * A replay is the final layout of mines and the player's moves, each with the clock's reading when it was made:
 * opens, chords and mark changes (flag, question mark, unmarked), as app.js logs them. Replaying the moves on the
 * layout gives back every opened cell and number, so they are not stored. For a ranked game the layout is the one the
 * server sent at the end, and the moves are played the server's way: its flood fill opens a cell the player had
 * flagged (it keeps no flags), and a chord uses only the flags around its number. A ranked game that lost the
 * server midway logs an `offline` move where the page took over, and plays on from there the local way.
 *
 * Encoding: numbers as variable-length groups of five bits, one base64url character each (the sixth bit says that
 * more follow). A move is two numbers: the time since the move before in hundredths of a second, and cell × 8 + kind.
 * A typical move takes four or five characters; the mines take one character per six cells.
 */
import { FLAG, HIDDEN, OPEN, QUESTION, chord, computeAdjacent, createGame, neighbours, reveal } from './engine.js';

export const REPLAY_FORMAT = 1;

/** Move kinds, as logged. */
export const MOVE = Object.freeze({ open: 0, chord: 1, flag: 2, question: 3, unmark: 4, offline: 5 });
const MARK_OF = { [MOVE.flag]: FLAG, [MOVE.question]: QUESTION, [MOVE.unmark]: HIDDEN };

const DIGITS = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_';
const VALUE = new Map([...DIGITS].map((c, k) => [c, k]));

function varint(n) {
  let out = '';
  let v = Math.max(0, Math.floor(n));
  do {
    const low = v & 31;
    v = Math.floor(v / 32);
    out += DIGITS[low | (v > 0 ? 32 : 0)];
  } while (v > 0);
  return out;
}

/** `[{ t (ms), k (MOVE), i (cell) }]` → string. Times are kept to the hundredth of a second, never going back. */
export function encodeMoves(moves) {
  let out = '';
  let prev = 0;
  for (const m of moves) {
    const cs = Math.max(prev, Math.round((m.t || 0) / 10));
    out += varint(cs - prev) + varint(m.i * 8 + m.k);
    prev = cs;
  }
  return out;
}

/** encodeMoves backwards. Throws on a string that is not one (a damaged save), which callers treat as no replay. */
export function decodeMoves(text) {
  const numbers = [];
  let v = 0;
  let scale = 1;
  for (const c of text || '') {
    const d = VALUE.get(c);
    if (d === undefined) throw new TypeError('bad replay');
    v += (d & 31) * scale;
    if (d & 32) {
      scale *= 32;
    } else {
      numbers.push(v);
      v = 0;
      scale = 1;
    }
  }
  if (scale !== 1 || numbers.length % 2) throw new TypeError('bad replay');
  const moves = [];
  let cs = 0;
  for (let k = 0; k < numbers.length; k += 2) {
    cs += numbers[k];
    const code = numbers[k + 1];
    const kind = code % 8;
    if (kind > MOVE.offline) throw new TypeError('bad replay');
    moves.push({ t: cs * 10, k: kind, i: (code - kind) / 8 });
  }
  return moves;
}

/** The mines, one bit per cell, six to a character. */
export function packMines(mine) {
  let out = '';
  for (let i = 0; i < mine.length; i += 6) {
    let v = 0;
    for (let b = 0; b < 6 && i + b < mine.length; b++) if (mine[i + b]) v |= 1 << b;
    out += DIGITS[v];
  }
  return out;
}

export function unpackMines(text, cells) {
  const mine = new Uint8Array(cells);
  for (let i = 0; i < cells; i++) {
    const d = VALUE.get(text[Math.floor(i / 6)]);
    if (d === undefined) throw new TypeError('bad replay');
    mine[i] = (d >> (i % 6)) & 1;
  }
  return mine;
}

/**
 * A replay of a finished game: its board, the layout (`game.mine`), the logged moves and how it ended. `meta` is
 * kept as it is, for whoever shows it (app.js: the level, the variant, the day of a daily).
 */
export function makeReplay(game, moves, { ms, won, server = false, at = Date.now(), ...meta }) {
  return {
    v: REPLAY_FORMAT, w: game.width, h: game.height, m: game.mines, mines: packMines(game.mine), moves: encodeMoves(moves),
    ms: Math.max(0, Math.round(ms)), won: Boolean(won), server: Boolean(server), at, ...meta,
  };
}

/**
 * A replay played back on a game of its own. `game` is what to draw: an engine-shaped game (width, height, mine,
 * adjacent, view, status, flags, exploded) updated in place by each move, and the same object for the playback's
 * whole life, seeks back included, so a page can hold on to it. `frame` is how many moves have been played. Throws on
 * a replay that does not decode.
 */
export class Playback {
  constructor(record) {
    if (!record || record.v !== REPLAY_FORMAT) throw new TypeError('bad replay');
    this.record = record;
    this.moves = decodeMoves(record.moves);
    this.layout = unpackMines(record.mines, record.w * record.h);
    if (this.layout.reduce((a, b) => a + b, 0) !== record.m) throw new TypeError('bad replay');
    this.reset();
  }

  get length() {
    return this.moves.length;
  }

  /** The clock's reading after `k` moves (0 before the first). */
  timeAt(k) {
    return k <= 0 ? 0 : this.moves[Math.min(k, this.moves.length) - 1].t;
  }

  /** Back to before the first move. */
  reset() {
    const { w, h, m } = this.record;
    const engine = createGame({ width: w, height: h, mines: m });
    engine.mine.set(this.layout);
    computeAdjacent(engine);
    engine.status = 'playing';
    this.engine = engine;
    this.server = Boolean(this.record.server);
    this.marks = new Uint8Array(engine.cells); // the player's marks, while the server's way is followed
    this.game ??= { width: w, height: h, mines: m, cells: engine.cells, view: new Uint8Array(engine.cells), noGuess: false };
    Object.assign(this.game, { mine: engine.mine, adjacent: engine.adjacent, status: 'playing', opened: 0, flags: 0, exploded: [] });
    this.frame = 0;
    this.sync();
  }

  /** Play up to move `k` (0 to length), from the start: cheap, since a whole game is a few thousand cell updates. */
  seek(k) {
    const target = Math.max(0, Math.min(this.moves.length, k));
    if (target < this.frame) this.reset();
    while (this.frame < target) this.next();
  }

  /**
   * Play the next move. Returns `{ move, opened, marked }`: the move, the cells it opened as `[cell, depth]` (for
   * the page's ripple), and the cell whose mark changed (or -1); null when there are no moves left.
   */
  next() {
    if (this.frame >= this.moves.length) return null;
    const move = this.moves[this.frame++];
    const g = this.engine;
    let opened = [];
    let marked = -1;
    if (move.i >= 0 && move.i < g.cells) {
      if (move.k === MOVE.open) {
        opened = reveal(g, move.i).opened;
      } else if (move.k === MOVE.chord) {
        opened = this.server ? this.serverChord(move.i) : chord(g, move.i).opened;
      } else if (move.k in MARK_OF) {
        if (g.status === 'playing' && g.view[move.i] !== OPEN) {
          if (this.server) this.marks[move.i] = MARK_OF[move.k];
          else setMark(g, move.i, MARK_OF[move.k]);
          marked = move.i;
        }
      } else if (move.k === MOVE.offline && this.server) {
        // The page took over: its own flood fill from here, which stops at flags, so the marks move onto the board.
        for (let i = 0; i < g.cells; i++) if (this.marks[i]) setMark(g, i, this.marks[i]);
        this.marks.fill(0);
        this.server = false;
      }
    }
    this.sync();
    return { move, opened, marked };
  }

  /** A chord the server's way: the flags around the number go down for the chord only, and come back up after. */
  serverChord(i) {
    const g = this.engine;
    const flags = neighbours(g, i).filter((j) => this.marks[j] === FLAG && g.view[j] !== OPEN);
    for (const f of flags) g.view[f] = FLAG;
    g.flags += flags.length;
    const result = chord(g, i);
    if (g.status !== 'won') {
      for (const f of flags) if (g.view[f] === FLAG) g.view[f] = HIDDEN;
      g.flags -= flags.length;
    }
    return result.opened;
  }

  /** Bring `game` in line with the engine (and, the server's way, with the player's marks on top of it). */
  sync() {
    const g = this.engine;
    const d = this.game;
    let flags = 0;
    for (let i = 0; i < g.cells; i++) {
      let v = g.view[i];
      if (this.server && v !== OPEN && v !== FLAG) v = this.marks[i] || HIDDEN;
      if (this.server && v === OPEN) this.marks[i] = 0; // a mark the server's flood fill opened goes
      d.view[i] = v;
      if (v === FLAG) flags++;
    }
    d.flags = flags;
    d.status = g.status;
    d.opened = g.opened;
    d.exploded = g.exploded;
  }

  /** `[[t, opened safe cells]]` after each move: how the board cleared over time (share.js's pattern). */
  timeline() {
    this.reset();
    const out = [];
    while (this.frame < this.moves.length) {
      const { move } = this.next();
      out.push([move.t, this.engine.opened]);
    }
    return out;
  }
}

/** A cell's mark set directly (the replay knows what it became, so the question-marks setting does not matter). */
function setMark(g, i, mark) {
  if (g.status !== 'playing' || g.view[i] === OPEN) return;
  if (g.view[i] === FLAG) g.flags--;
  if (mark === FLAG) g.flags++;
  g.view[i] = mark;
}

/**
 * The log of a ranked game at the moment the page takes over from a server that stopped answering. The moves it
 * never answered (`lost`, their places in the log) did not happen as logged: the page makes them again itself, after
 * every mark made while they waited, so they go, and an `offline` move is added at `t`. The page then logs those
 * moves again as it makes them. Played back, a mark placed while an open was waiting then stands in the way of that
 * open's flood fill, as it did on screen.
 */
export function goneOffline(log, lost, t) {
  const gone = new Set(lost);
  const kept = log.filter((_, k) => !gone.has(k));
  const at = Math.max(t, kept.length ? kept[kept.length - 1].t : 0);
  kept.push({ t: at, k: MOVE.offline, i: 0 });
  return kept;
}

/**
 * Whether a replay plays back to the end its record says (won or lost) and, given the game's own final `view`, to
 * exactly that board: a check before keeping it, so that a replay that would show a different game is not kept.
 */
export function replayHolds(record, view = null) {
  try {
    const p = new Playback(record);
    p.seek(p.length);
    if (p.game.status !== (record.won ? 'won' : 'lost')) return false;
    return !view || (view.length === p.game.view.length && p.game.view.every((v, i) => v === view[i]));
  } catch {
    return false;
  }
}
