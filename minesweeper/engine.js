/**
 * Minesweeper rules, with no DOM and no storage: a game is a plain object, and every move is a function that
 * updates it and reports what changed. The page (app.js) only draws what these functions return, and the unit
 * tests (test/engine.test.mjs) drive the same functions directly.
 *
 * Also here, in the second half: the logic solver (analyze), which reads only what a player can see, and the
 * no-guess generator built on it (placeMinesNoGuess, solvesByLogic), tested in test/solver.test.mjs. The server
 * (server/src/sessions.js) imports this same module, so ranked games follow exactly these rules.
 */

export const HIDDEN = 0;
export const OPEN = 1;
export const FLAG = 2;
export const QUESTION = 3;

export const DIFFICULTIES = Object.freeze({
  beginner: Object.freeze({ id: 'beginner', label: 'Beginner', width: 9, height: 9, mines: 10 }),
  intermediate: Object.freeze({ id: 'intermediate', label: 'Intermediate', width: 16, height: 16, mines: 40 }),
  expert: Object.freeze({ id: 'expert', label: 'Expert', width: 30, height: 16, mines: 99 }),
});

/** Custom boards: small enough to stay playable on a phone, and always leaving room for a safe 3×3 opening. */
export const CUSTOM_LIMITS = Object.freeze({ minSize: 5, maxWidth: 40, maxHeight: 40, minMines: 1 });

export const maxMinesFor = (width, height) => Math.max(CUSTOM_LIMITS.minMines, width * height - 9);

const clampInt = (value, min, max, fallback) => {
  const n = Math.round(Number(value));
  if (!Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, n));
};

/** Whatever was typed, a board that can be played: integers, inside the limits, mines leaving a safe opening. */
export function sanitizeCustom({ width, height, mines } = {}) {
  const w = clampInt(width, CUSTOM_LIMITS.minSize, CUSTOM_LIMITS.maxWidth, 20);
  const h = clampInt(height, CUSTOM_LIMITS.minSize, CUSTOM_LIMITS.maxHeight, 20);
  const m = clampInt(mines, CUSTOM_LIMITS.minMines, maxMinesFor(w, h), Math.round(w * h * 0.15));
  return { width: w, height: h, mines: m };
}

/** Small, fast, seedable PRNG, so a test can replay the exact same board. */
export function mulberry32(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/**
 * A new game with no mines laid yet (the first reveal lays them). Cells are numbered `y * width + x`; `mine`,
 * `adjacent` and `view` (HIDDEN / OPEN / FLAG / QUESTION) hold one byte per cell.
 *
 * `noGuess` asks for a board that logic alone clears from the first click (placeMinesNoGuess). It stays true only
 * if the generator managed that; after a fallback to an ordinary layout it is false, so it always describes the
 * board actually laid.
 */
export function createGame({ width, height, mines, noGuess = false }) {
  if (!Number.isInteger(width) || !Number.isInteger(height) || width < 1 || height < 1) {
    throw new RangeError(`bad board size ${width}×${height}`);
  }
  const cells = width * height;
  if (!Number.isInteger(mines) || mines < 0 || mines > cells - 1) {
    throw new RangeError(`bad mine count ${mines} for ${cells} cells`);
  }
  return {
    width,
    height,
    mines,
    cells,
    mine: new Uint8Array(cells),
    adjacent: new Uint8Array(cells),
    view: new Uint8Array(cells),
    /** ready → playing (first reveal places the mines) → won | lost */
    status: 'ready',
    opened: 0,
    flags: 0,
    /** Mines that went off: the one clicked, or every mine a wrong chord uncovered. */
    exploded: [],
    noGuess: Boolean(noGuess),
  };
}

export const indexOf = (game, x, y) => y * game.width + x;
export const coordsOf = (game, i) => ({ x: i % game.width, y: Math.floor(i / game.width) });

export function neighbours(game, i) {
  const { width, height } = game;
  const x = i % width;
  const y = (i - x) / width;
  const out = [];
  for (let dy = -1; dy <= 1; dy++) {
    const ny = y + dy;
    if (ny < 0 || ny >= height) continue;
    for (let dx = -1; dx <= 1; dx++) {
      const nx = x + dx;
      if ((dx === 0 && dy === 0) || nx < 0 || nx >= width) continue;
      out.push(ny * width + nx);
    }
  }
  return out;
}

/**
 * Lay the mines, keeping the first cell *and its neighbours* clear so the first click always opens an area.
 * When the board is too full for that (only reachable with a hand-built game), keep just the cell itself clear.
 */
export function placeMines(game, safeIndex, rng = Math.random) {
  scatter(game, safeAreaOf(game, safeIndex), rng);
  computeAdjacent(game);
  game.status = 'playing';
}

/** The cells the first click keeps clear: itself and its neighbours, or only itself on a board too full for that. */
function safeAreaOf(game, safeIndex) {
  const around = new Set([safeIndex, ...neighbours(game, safeIndex)]);
  return game.cells - around.size >= game.mines ? around : new Set([safeIndex]);
}

/** A uniformly random layout of `game.mines` mines outside `safe` (adjacent numbers not updated). */
function scatter(game, safe, rng) {
  game.mine.fill(0);
  const pool = [];
  for (let i = 0; i < game.cells; i++) if (!safe.has(i)) pool.push(i);
  // Partial Fisher–Yates: the first `mines` entries of the pool are a uniform sample.
  for (let k = 0; k < game.mines; k++) {
    const j = k + Math.floor(rng() * (pool.length - k));
    [pool[k], pool[j]] = [pool[j], pool[k]];
    game.mine[pool[k]] = 1;
  }
}

export function computeAdjacent(game) {
  for (let i = 0; i < game.cells; i++) {
    let n = 0;
    for (const j of neighbours(game, i)) n += game.mine[j];
    game.adjacent[i] = n;
  }
}

const isOver = (game) => game.status === 'won' || game.status === 'lost';

/**
 * Open one cell. Zeros flood-fill outwards (breadth first, so `opened` comes back ring by ring with its depth,
 * which the page uses to ripple the animation). Flagged cells are never opened; question marks are.
 *
 * Returns `{ opened: [[index, depth], …], exploded: boolean, status }`.
 */
export function reveal(game, index, rng = Math.random) {
  const result = { opened: [], exploded: false, status: game.status };
  if (isOver(game) || index < 0 || index >= game.cells) return result;
  if (game.view[index] === OPEN || game.view[index] === FLAG) return result;
  if (game.status === 'ready') {
    if (game.noGuess) placeMinesNoGuess(game, index, rng);
    else placeMines(game, index, rng);
  }
  openFrom(game, [index], result);
  result.status = game.status;
  return result;
}

function openFrom(game, starts, result) {
  const queue = [];
  for (const s of starts) {
    if (game.view[s] === OPEN || game.view[s] === FLAG) continue;
    if (game.mine[s]) {
      game.view[s] = OPEN;
      game.exploded.push(s);
      result.opened.push([s, 0]);
      result.exploded = true;
      continue;
    }
    queue.push([s, 0]);
    open(game, s);
    result.opened.push([s, 0]);
  }
  if (result.exploded) {
    game.status = 'lost';
    return;
  }
  for (let q = 0; q < queue.length; q++) {
    const [i, depth] = queue[q];
    if (game.adjacent[i] !== 0) continue;
    for (const j of neighbours(game, i)) {
      if (game.view[j] === OPEN || game.view[j] === FLAG || game.mine[j]) continue;
      open(game, j);
      queue.push([j, depth + 1]);
      result.opened.push([j, depth + 1]);
    }
  }
  if (game.opened === game.cells - game.mines) win(game);
}

function open(game, i) {
  game.view[i] = OPEN;
  game.opened++;
}

function win(game) {
  game.status = 'won';
  // A cleared board shows every mine as flagged, and the counter reaches zero.
  for (let i = 0; i < game.cells; i++) {
    if (game.mine[i] && game.view[i] !== FLAG) game.view[i] = FLAG;
  }
  game.flags = game.mines;
}

export const flagsAround = (game, i) => neighbours(game, i).reduce((n, j) => n + (game.view[j] === FLAG), 0);

/** An opened number whose flags already match it: chording it would open something. */
export function canChord(game, i) {
  if (game.status !== 'playing' || game.view[i] !== OPEN || game.adjacent[i] === 0) return false;
  if (flagsAround(game, i) !== game.adjacent[i]) return false;
  return neighbours(game, i).some((j) => game.view[j] === HIDDEN || game.view[j] === QUESTION);
}

/** Neighbours a chord on `i` would open (for the pressed-down preview), satisfied or not. */
export function chordTargets(game, i) {
  if (game.view[i] !== OPEN) return [];
  return neighbours(game, i).filter((j) => game.view[j] === HIDDEN || game.view[j] === QUESTION);
}

/**
 * Chord: on an opened number whose adjacent flags equal it, open every other neighbour at once. A wrong flag
 * means one of them is a mine, and the game is lost — exactly as in the original.
 */
export function chord(game, index) {
  const result = { opened: [], exploded: false, status: game.status };
  if (!canChord(game, index)) return result;
  openFrom(game, chordTargets(game, index), result);
  result.status = game.status;
  return result;
}

/** What a left click or a tap means: open a covered cell, or chord an opened number. */
export function activate(game, index, rng = Math.random) {
  return game.view[index] === OPEN ? chord(game, index) : reveal(game, index, rng);
}

/**
 * Right click / long press: hidden → flag → (question →) hidden. Returns whether anything changed.
 * Flags can be placed before the first reveal; they are kept when the mines are laid.
 */
export function toggleMark(game, index, { questionMarks = false } = {}) {
  if (isOver(game) || index < 0 || index >= game.cells) return false;
  const v = game.view[index];
  if (v === OPEN) return false;
  if (v === HIDDEN) {
    game.view[index] = FLAG;
    game.flags++;
  } else if (v === FLAG) {
    game.flags--;
    game.view[index] = questionMarks ? QUESTION : HIDDEN;
  } else {
    game.view[index] = HIDDEN;
  }
  return true;
}

export const minesLeft = (game) => game.mines - game.flags;

/** Flags on cells that turned out to be safe, for the end-of-game picture. */
export const wrongFlags = (game) => {
  const out = [];
  for (let i = 0; i < game.cells; i++) if (game.view[i] === FLAG && !game.mine[i]) out.push(i);
  return out;
};

// Save / restore, so a phone that kills the tab does not cost the game in progress.
const pack = (bytes) => Array.from(bytes).join(''); // one digit per cell, every value being under 10

export function serialize(game) {
  return {
    width: game.width,
    height: game.height,
    mines: game.mines,
    status: game.status,
    mine: pack(game.mine),
    view: pack(game.view),
    exploded: [...game.exploded],
    noGuess: game.noGuess,
  };
}

/** The game `serialize` saved. Throws on a save that does not add up, which the page then simply drops. */
export function deserialize(data) {
  // Saves from before no-guess boards have no `noGuess`: they were all ordinary.
  const game = createGame({ width: data.width, height: data.height, mines: data.mines, noGuess: data.noGuess === true });
  if (typeof data.mine !== 'string' || typeof data.view !== 'string') throw new TypeError('bad save');
  if (data.mine.length !== game.cells || data.view.length !== game.cells) throw new TypeError('bad save');
  let mines = 0;
  for (let i = 0; i < game.cells; i++) {
    game.mine[i] = data.mine[i] === '1' ? 1 : 0;
    const v = Number(data.view[i]);
    game.view[i] = v >= 0 && v <= 3 ? v : HIDDEN;
    mines += game.mine[i];
    if (game.view[i] === OPEN && !game.mine[i]) game.opened++;
    if (game.view[i] === FLAG) game.flags++;
  }
  if (!['ready', 'playing', 'won', 'lost'].includes(data.status)) throw new TypeError('bad save');
  if (data.status !== 'ready' && mines !== game.mines) throw new TypeError('bad save');
  game.status = data.status;
  game.exploded = Array.isArray(data.exploded) ? data.exploded.filter((i) => game.mine[i]) : [];
  if (game.status !== 'ready') computeAdjacent(game);
  return game;
}

/**
 * 3BV: the fewest clicks that clear the board without chording — one per opening (connected zeros, which
 * open their border with them) plus one per safe number not on any opening's border. The server uses it
 * to sanity-check how fast a win could possibly have been.
 */
export function bbbv(game) {
  const seen = new Uint8Array(game.cells);
  let count = 0;
  for (let i = 0; i < game.cells; i++) {
    if (seen[i] || game.mine[i] || game.adjacent[i] !== 0) continue;
    count++;
    const stack = [i];
    seen[i] = 1;
    while (stack.length) {
      const j = stack.pop();
      for (const k of neighbours(game, j)) {
        if (seen[k] || game.mine[k]) continue;
        seen[k] = 1;
        if (game.adjacent[k] === 0) stack.push(k);
      }
    }
  }
  for (let i = 0; i < game.cells; i++) if (!seen[i] && !game.mine[i]) count++;
  return count;
}

/**
 * Lay mines that agree with everything already on screen: every opened cell safe and showing its number,
 * and the right total. Used when a ranked game loses its connection halfway: the client never had the real
 * layout, so it continues (unranked) on one that is indistinguishable from what it has seen.
 *
 * Backtracks over the covered cells that touch a number; the rest take the leftover mines at random.
 * Returns false if no layout was found within the step budget, leaving the game untouched.
 */
export function completeLayout(game, rng = Math.random, budget = 200000) {
  const covered = (i) => game.view[i] !== OPEN;
  const numbers = [];
  const isFrontier = new Uint8Array(game.cells);
  for (let i = 0; i < game.cells; i++) {
    if (game.view[i] !== OPEN) continue;
    numbers.push(i);
    for (const j of neighbours(game, i)) if (covered(j)) isFrontier[j] = 1;
  }
  // Order the frontier so that neighbours are assigned close together, which makes pruning bite early.
  const frontier = [];
  const placed = new Uint8Array(game.cells);
  for (let s = 0; s < game.cells; s++) {
    if (!isFrontier[s] || placed[s]) continue;
    const queue = [s];
    placed[s] = 1;
    for (let q = 0; q < queue.length; q++) {
      const i = queue[q];
      frontier.push(i);
      for (const j of neighbours(game, i)) {
        if (isFrontier[j] && !placed[j]) { placed[j] = 1; queue.push(j); }
      }
      for (const n of neighbours(game, i)) {
        if (game.view[n] !== OPEN) continue;
        for (const j of neighbours(game, n)) if (isFrontier[j] && !placed[j]) { placed[j] = 1; queue.push(j); }
      }
    }
  }
  const interior = [];
  for (let i = 0; i < game.cells; i++) if (covered(i) && !isFrontier[i]) interior.push(i);

  // For each number: how many mines it still needs, and how many of its covered neighbours are unassigned.
  const need = new Map();
  const open = new Map();
  for (const n of numbers) {
    need.set(n, game.adjacent[n]);
    open.set(n, neighbours(game, n).filter(covered).length);
  }
  const numbersOf = frontier.map((i) => neighbours(game, i).filter((n) => game.view[n] === OPEN));
  const value = new Int8Array(frontier.length).fill(-1);
  let mines = 0;
  let steps = 0;

  const fits = (k, v) => {
    for (const n of numbersOf[k]) {
      const left = need.get(n) - v;
      if (left < 0 || left > open.get(n) - 1) return false;
    }
    return true;
  };
  const set = (k, v, sign) => {
    for (const n of numbersOf[k]) {
      need.set(n, need.get(n) - sign * v);
      open.set(n, open.get(n) - sign);
    }
    mines += sign * v;
  };
  const solve = (k) => {
    if (++steps > budget) return false;
    if (k === frontier.length) {
      const rest = game.mines - mines;
      return rest >= 0 && rest <= interior.length;
    }
    const order = rng() < 0.5 ? [0, 1] : [1, 0];
    for (const v of order) {
      if (v === 1 && mines + 1 > game.mines) continue;
      if (!fits(k, v)) continue;
      value[k] = v;
      set(k, v, 1);
      if (solve(k + 1)) return true;
      set(k, v, -1);
      value[k] = -1;
    }
    return false;
  };
  if (!solve(0)) return false;

  game.mine.fill(0);
  frontier.forEach((i, k) => { game.mine[i] = value[k]; });
  let rest = game.mines - mines;
  for (let k = 0; k < rest; k++) {
    const j = k + Math.floor(rng() * (interior.length - k));
    [interior[k], interior[j]] = [interior[j], interior[k]];
    game.mine[interior[k]] = 1;
  }
  const shown = numbers.map((n) => game.adjacent[n]);
  computeAdjacent(game);
  // Belt and braces: the numbers on screen must not change.
  if (numbers.some((n, k) => game.adjacent[n] !== shown[k] || game.mine[n])) throw new Error('inconsistent layout');
  if (game.status === 'ready') game.status = 'playing';
  return true;
}

// ---------- logic: what the numbers on screen prove ----------
//
// The solver reads only what a player can see: which cells are open, the numbers on them, and the total of mines.
// It never reads `mine`, and it ignores flags, which are the player's own claims and may be wrong. So it answers
// the same on a ranked client (which holds no mines) as on a local game, and the hint, the post-game analysis and
// the no-guess generator all mean the same thing by "provably safe".
//
// It works in three steps, cheapest first, each run only when the one before has nothing more to say:
//   1. The single-cell rule. A number whose mines are all found clears the rest of its covered neighbours; one with
//      exactly as many covered neighbours as mines still missing has them all as mines.
//   2. The pair rule (the subset rule is the case where one number's cells all lie inside the other's). Two numbers
//      A and B that share covered cells: if A needs exactly as many more mines than B as A has cells B cannot see,
//      those cells are all mines and B's own cells are all safe. And the mine total: once every mine is found the
//      rest is safe, and once the covered cells are as many as the mines left they are all mines.
//   3. Counting. The covered cells next to a number fall into components, linked by the numbers they share. Each
//      component's layouts that agree with its numbers are enumerated exactly (cells that touch the same numbers are
//      taken together as one "box", whose mine count matters but not which of its cells hold them). Components only
//      interact through the mine total, so their counts are combined with the number of ways the covered cells away
//      from every number can take the mines left over. A cell that is a mine in no consistent layout is safe, in all
//      of them a mine, and its weighted share is its probability. Counting is budgeted (steps of the search); a
//      component that runs over keeps only what steps 1 and 2 proved, and its probabilities are estimates.

/**
 * Steps of the counting search one analysis may take. Plenty for real boards (on Expert, 6 positions in 7 800 ran
 * over), and about 12 ms in Node at worst, a few times that on a slow phone.
 */
export const SOLVER_BUDGET = 200000;

const geometries = new Map();
/**
 * Neighbour lists for a board size, built once and shared: cell i's neighbours are `list[start[i]]` up to
 * `list[start[i + 1] - 1]`, in ascending order. The solver runs these loops thousands of times per board, where
 * neighbours()'s fresh arrays would dominate.
 */
function geometry(width, height) {
  const key = `${width}x${height}`;
  let g = geometries.get(key);
  if (g) return g;
  const cells = width * height;
  const start = new Int32Array(cells + 1);
  const list = new Int32Array(cells * 8);
  let n = 0;
  for (let i = 0; i < cells; i++) {
    start[i] = n;
    const x = i % width;
    const y = (i - x) / width;
    for (let dy = -1; dy <= 1; dy++) {
      const ny = y + dy;
      if (ny < 0 || ny >= height) continue;
      for (let dx = -1; dx <= 1; dx++) {
        const nx = x + dx;
        if ((dx === 0 && dy === 0) || nx < 0 || nx >= width) continue;
        list[n++] = ny * width + nx;
      }
    }
  }
  start[cells] = n;
  g = { start, list };
  geometries.set(key, g);
  return g;
}

// C(n, k) for the boxes (a box is at most the 8 neighbours of one number), and log n! for the cells away from
// the numbers, whose C(R, m) can pass 1e300 on a big custom board.
const BINOM = Array.from({ length: 9 }, (_, n) => {
  const row = [1];
  for (let k = 1; k <= n; k++) row.push((row[k - 1] * (n - k + 1)) / k);
  return row;
});
let logFactorials = new Float64Array([0]);
function logChoose(n, k) {
  if (logFactorials.length <= n) {
    const next = new Float64Array(n + 1);
    next.set(logFactorials);
    for (let i = logFactorials.length; i <= n; i++) next[i] = next[i - 1] + Math.log(i);
    logFactorials = next;
  }
  return logFactorials[n] - logFactorials[k] - logFactorials[n - k];
}

/** a ⊛ b: the distribution of the sum of two independent counts (index = count). */
function convolve(a, b) {
  const out = new Float64Array(a.length + b.length - 1);
  for (let i = 0; i < a.length; i++) {
    if (!a[i]) continue;
    for (let j = 0; j < b.length; j++) out[i + j] += a[i] * b[j];
  }
  // Only ratios matter, so rescale to keep long products of large counts inside a double.
  let max = 0;
  for (const v of out) if (v > max) max = v;
  if (max > 0 && (max > 1e100 || max < 1e-100)) for (let i = 0; i < out.length; i++) out[i] /= max;
  return out;
}
/** Which sums are possible at all: the same convolution in booleans, which never underflows. */
function convolveReach(a, b) {
  const out = new Uint8Array(a.length + b.length - 1);
  for (let i = 0; i < a.length; i++) {
    if (!a[i]) continue;
    for (let j = 0; j < b.length; j++) if (b[j]) out[i + j] = 1;
  }
  return out;
}

// What the solver knows about a cell.
const K_UNKNOWN = 0;
const K_OPEN = 1;
const K_MINE = 2;
const K_SAFE = 3; // proven safe, still covered

/**
 * The solver's state of knowledge, built up one opened cell at a time. For every open cell it keeps `need` (mines
 * still to be placed among its unknown neighbours) and `free` (how many unknown neighbours it has), updated as
 * cells are opened or proven. Changed numbers go on a queue for the single-cell rule and on a dirty list for the
 * pair rule, so after the first pass each rule only looks at what changed. Internal: analyze() and the generator
 * are the ways in.
 */
class Knowledge {
  constructor(width, height, mines) {
    const cells = width * height;
    this.width = width;
    this.height = height;
    this.cells = cells;
    this.mines = mines;
    const g = geometry(width, height);
    this.nbStart = g.start;
    this.nbList = g.list;
    this.state = new Uint8Array(cells);
    this.need = new Int8Array(cells);
    this.free = new Int8Array(cells);
    this.queued = new Uint8Array(cells);
    this.queue = [];
    this.dirty = new Uint8Array(cells);
    this.dirtyList = [];
    this.found = []; // cells proven safe and not opened yet, for the generator to open
    this.minesKnown = 0;
    this.unknown = cells;
    this.opened = 0;
    this.broken = false; // what was shown cannot happen: no layout agrees with it
    this.steps = 0; // counting steps used, over every enumerate()
  }

  touch(c) {
    if (!this.queued[c]) { this.queued[c] = 1; this.queue.push(c); }
    if (!this.dirty[c]) { this.dirty[c] = 1; this.dirtyList.push(c); }
  }

  /** Cell i is open and shows n. */
  open(i, n) {
    const { state, nbStart, nbList, free } = this;
    const was = state[i];
    if (was === K_OPEN) return;
    if (was === K_MINE) { this.broken = true; return; }
    state[i] = K_OPEN;
    this.opened++;
    if (was === K_UNKNOWN) this.unknown--;
    let mines = 0;
    let unknown = 0;
    for (let p = nbStart[i]; p < nbStart[i + 1]; p++) {
      const j = nbList[p];
      const s = state[j];
      if (s === K_UNKNOWN) unknown++;
      else if (s === K_MINE) mines++;
      // A proven-safe cell was already taken off its neighbours' counts when it was proven.
      else if (s === K_OPEN && was === K_UNKNOWN) { free[j]--; this.touch(j); }
    }
    this.need[i] = n - mines;
    free[i] = unknown;
    this.touch(i);
  }

  markMine(i) {
    const { nbStart, nbList, state } = this;
    state[i] = K_MINE;
    this.unknown--;
    this.minesKnown++;
    for (let p = nbStart[i]; p < nbStart[i + 1]; p++) {
      const j = nbList[p];
      if (state[j] === K_OPEN) { this.need[j]--; this.free[j]--; this.touch(j); }
    }
  }

  markSafe(i) {
    const { nbStart, nbList, state } = this;
    state[i] = K_SAFE;
    this.unknown--;
    this.found.push(i);
    for (let p = nbStart[i]; p < nbStart[i + 1]; p++) {
      const j = nbList[p];
      if (state[j] === K_OPEN) { this.free[j]--; this.touch(j); }
    }
  }

  /** Mark every unknown neighbour of c (as a mine or as safe). */
  settleAround(c, mine) {
    const { nbStart, nbList, state } = this;
    for (let p = nbStart[c]; p < nbStart[c + 1]; p++) {
      const j = nbList[p];
      if (state[j] === K_UNKNOWN) {
        if (mine) this.markMine(j);
        else this.markSafe(j);
      }
    }
  }

  /** The single-cell rule over every number that changed. */
  single() {
    const { queue, queued, state, need, free } = this;
    let progress = false;
    while (queue.length) {
      const c = queue.pop();
      queued[c] = 0;
      if (state[c] !== K_OPEN) continue;
      const n = need[c];
      const f = free[c];
      if (n < 0 || n > f) { this.broken = true; continue; }
      if (f === 0) continue;
      if (n === 0 || n === f) {
        this.settleAround(c, n !== 0);
        progress = true;
      }
    }
    return progress;
  }

  /**
   * The pair rule, for every number that changed since the last pass against every number near it. Two numbers
   * can only share a covered cell when they are at most two cells apart, so a 5 × 5 window is enough.
   */
  pairs() {
    const list = this.dirtyList;
    if (!list.length) return false;
    this.dirtyList = [];
    for (const a of list) this.dirty[a] = 0;
    const { width, height, state, free } = this;
    let progress = false;
    for (const a of list) {
      if (state[a] !== K_OPEN || free[a] === 0) continue;
      const ax = a % width;
      const ay = (a - ax) / width;
      for (let by = Math.max(0, ay - 2); by <= Math.min(height - 1, ay + 2); by++) {
        for (let bx = Math.max(0, ax - 2); bx <= Math.min(width - 1, ax + 2); bx++) {
          const b = by * width + bx;
          if (b === a || state[b] !== K_OPEN || free[b] === 0) continue;
          if (this.pair(a, b)) progress = true;
          if (free[a] === 0) break;
        }
        if (free[a] === 0) break;
      }
    }
    return progress;
  }

  /**
   * A needs need[a] mines among its own cells (onlyA) and the shared ones; B likewise. need[a] - need[b] counts
   * mines in onlyA minus mines in onlyB, so when it equals |onlyA| every onlyA cell is a mine and onlyB is clear
   * (and the mirror image the other way round).
   */
  pair(a, b) {
    const { width, nbStart, nbList, state, need, free } = this;
    const bx = b % width;
    const by = (b - bx) / width;
    const near = (j) => {
      const jx = j % width;
      return Math.abs(jx - bx) <= 1 && Math.abs((j - jx) / width - by) <= 1;
    };
    let onlyA = 0;
    let shared = 0;
    for (let p = nbStart[a]; p < nbStart[a + 1]; p++) {
      const j = nbList[p];
      if (state[j] !== K_UNKNOWN) continue;
      if (near(j)) shared++;
      else onlyA++;
    }
    if (!shared) return false;
    const onlyB = free[b] - shared;
    if (!onlyA && !onlyB) return false;
    const d = need[a] - need[b];
    let mineSide;
    if (d === onlyA) mineSide = a;
    else if (-d === onlyB) mineSide = b;
    else return false;
    // Cells of `of` that the other cannot see: collected first, since marking changes the states being read.
    const own = (of, other) => {
      const ox = other % width;
      const oy = (other - ox) / width;
      const out = [];
      for (let p = nbStart[of]; p < nbStart[of + 1]; p++) {
        const j = nbList[p];
        if (state[j] !== K_UNKNOWN) continue;
        const jx = j % width;
        if (Math.abs(jx - ox) > 1 || Math.abs((j - jx) / width - oy) > 1) out.push(j);
      }
      return out;
    };
    const safeSide = mineSide === a ? b : a;
    const mines = own(mineSide, safeSide);
    const clear = own(safeSide, mineSide);
    for (const j of mines) this.markMine(j);
    for (const j of clear) this.markSafe(j);
    return true;
  }

  /** The mine total: all found leaves the rest safe; as many covered cells as mines left makes them all mines. */
  count() {
    const left = this.mines - this.minesKnown;
    if (left < 0 || left > this.unknown) { this.broken = true; return false; }
    if (!this.unknown || (left !== 0 && left !== this.unknown)) return false;
    for (let i = 0; i < this.cells; i++) {
      if (this.state[i] !== K_UNKNOWN) continue;
      if (left === 0) this.markSafe(i);
      else this.markMine(i);
    }
    return true;
  }

  /** Steps 1 and 2 until neither has anything more to say. */
  propagate() {
    for (;;) {
      if (this.broken) return;
      this.single();
      if (this.pairs()) continue;
      if (this.count()) continue;
      if (!this.queue.length) return;
    }
  }

  /**
   * Step 3: count the layouts of what is still unknown. Settles every cell the count proves (marking it) and
   * returns `{ exact, probability, settled }`: exact is false when some component ran over the budget, probability
   * (only filled when `withProbabilities`) holds each unknown cell's mine probability, and settled is how many
   * cells were proven here.
   */
  enumerate(budget = SOLVER_BUDGET, withProbabilities = true) {
    const { cells, state, nbStart, nbList, need, free } = this;
    const probability = withProbabilities ? new Float64Array(cells) : null;
    const M = this.mines - this.minesKnown; // mines not found yet
    // Components: union-find over the unknown cells, joining the unknown neighbours of each number.
    const parent = new Int32Array(cells);
    for (let i = 0; i < cells; i++) parent[i] = i;
    const find = (x) => {
      while (parent[x] !== x) { parent[x] = parent[parent[x]]; x = parent[x]; }
      return x;
    };
    const frontier = new Uint8Array(cells);
    for (let c = 0; c < cells; c++) {
      if (state[c] !== K_OPEN || free[c] === 0) continue;
      let first = -1;
      for (let p = nbStart[c]; p < nbStart[c + 1]; p++) {
        const j = nbList[p];
        if (state[j] !== K_UNKNOWN) continue;
        frontier[j] = 1;
        if (first < 0) first = j;
        else {
          const ra = find(first);
          const rb = find(j);
          if (ra !== rb) parent[rb] = ra;
        }
      }
    }
    const byRoot = new Map();
    const interior = [];
    for (let i = 0; i < cells; i++) {
      if (state[i] !== K_UNKNOWN) continue;
      if (!frontier[i]) { interior.push(i); continue; }
      const r = find(i);
      let list = byRoot.get(r);
      if (!list) byRoot.set(r, (list = []));
      list.push(i);
    }
    const R = interior.length;

    // Each component: its boxes, its numbers, and an exhaustive search over how many mines each box holds.
    const comps = [];
    for (const compCells of byRoot.values()) {
      const boxOf = new Map();
      const boxes = [];
      for (const i of compCells) {
        const opens = [];
        for (let p = nbStart[i]; p < nbStart[i + 1]; p++) if (state[nbList[p]] === K_OPEN) opens.push(nbList[p]);
        const key = opens.join(',');
        let box = boxOf.get(key);
        if (!box) { boxOf.set(key, (box = { cells: [], opens, cons: [] })); boxes.push(box); }
        box.cells.push(i);
      }
      const consOf = new Map();
      const consBoxes = [];
      const rem = [];
      for (let b = 0; b < boxes.length; b++) {
        for (const c of boxes[b].opens) {
          let k = consOf.get(c);
          if (k === undefined) { k = consBoxes.length; consOf.set(c, k); consBoxes.push([]); rem.push(need[c]); }
          consBoxes[k].push(b);
          boxes[b].cons.push(k);
        }
      }
      comps.push({ cells: compCells, boxes, consBoxes, rem, size: compCells.length });
    }
    // Small components first, so that one huge component cannot starve the rest of the budget.
    comps.sort((a, b) => a.boxes.length - b.boxes.length || a.cells[0] - b.cells[0]);

    let left = budget;
    for (const comp of comps) {
      const { boxes, consBoxes, rem, size } = comp;
      const nb = boxes.length;
      // Visit boxes breadth first through shared numbers: a number is then filled in soon after it is first touched,
      // which is what lets the bounds below prune.
      const order = [];
      const seenBox = new Uint8Array(nb);
      const seenCons = new Uint8Array(consBoxes.length);
      for (let s = 0; s < nb; s++) {
        if (seenBox[s]) continue;
        seenBox[s] = 1;
        order.push(s);
        for (let q = order.length - 1; q < order.length; q++) {
          for (const k of boxes[order[q]].cons) {
            if (seenCons[k]) continue;
            seenCons[k] = 1;
            for (const b of consBoxes[k]) if (!seenBox[b]) { seenBox[b] = 1; order.push(b); }
          }
        }
      }
      const sizeOf = boxes.map((b) => b.cells.length);
      const cap = consBoxes.map((list) => list.reduce((n, b) => n + sizeOf[b], 0));
      const K = size + 1;
      const W = new Float64Array(K); // weight of the layouts with k mines in this component
      const BM = withProbabilities ? new Float64Array(nb * K) : null; // their weight times the mines in each box
      const seen = new Uint8Array(nb * K); // bit 1: box b holds a mine in some layout with k mines; bit 2: a safe cell
      const t = new Int32Array(nb);
      let steps = 0;
      let exact = true;
      const leaf = (k, w) => {
        W[k] += w;
        for (let b = 0; b < nb; b++) {
          const v = t[b];
          if (BM) BM[b * K + k] += w * v;
          seen[b * K + k] |= (v > 0 ? 1 : 0) | (v < sizeOf[b] ? 2 : 0);
        }
      };
      const search = (d, k, w) => {
        if (++steps > left) { exact = false; return; }
        if (d === nb) { leaf(k, w); return; }
        const b = order[d];
        const s = sizeOf[b];
        // Each of the box's numbers bounds it: after it, the number's other boxes must still be able to hold the rest.
        let lo = 0;
        let hi = Math.min(s, M - k);
        for (const c of boxes[b].cons) {
          lo = Math.max(lo, rem[c] - (cap[c] - s));
          hi = Math.min(hi, rem[c]);
        }
        if (lo > hi) return;
        for (const c of boxes[b].cons) cap[c] -= s;
        for (let v = lo; v <= hi && exact; v++) {
          for (const c of boxes[b].cons) rem[c] -= v;
          t[b] = v;
          search(d + 1, k + v, w * BINOM[s][v]);
          for (const c of boxes[b].cons) rem[c] += v;
        }
        for (const c of boxes[b].cons) cap[c] += s;
      };
      search(0, 0, 1);
      left -= Math.min(steps, left);
      this.steps += steps;
      if (exact && !W.every(Number.isFinite)) exact = false; // a weight past a double: treat like a timeout
      Object.assign(comp, { exact, W, BM, seen, sizeOf, K });
    }

    // What an inexact component contributes. For certainty, its mine count is anything from none to all of its cells,
    // so a proof must hold whatever it is. For probabilities, a best guess at the count; and should those guesses
    // not add up with the mine total, every count weighted as if its cells were coin flips, which always does.
    const n = comps.length;
    const reach = comps.map((c) => (c.exact ? Uint8Array.from(c.W, (w) => (w > 0 ? 1 : 0)) : new Uint8Array(c.size + 1).fill(1)));
    const pointGuess = (c) => {
      let sum = 0;
      for (const i of c.cells) sum += this.localDensity(i);
      const d = new Float64Array(c.size + 1);
      d[Math.max(0, Math.min(c.size, Math.round(sum)))] = 1;
      return d;
    };
    const wideGuess = (c) => {
      const mid = logChoose(c.size, c.size >> 1);
      return Float64Array.from({ length: c.size + 1 }, (_, k) => Math.exp(logChoose(c.size, k) - mid));
    };
    // Prefix and suffix combinations, so each component can be weighed against all the others.
    const combine = (guess) => {
      const dist = comps.map((c) => (c.exact ? c.W : guess(c)));
      const pre = [Float64Array.of(1)];
      for (let j = 0; j < n; j++) pre.push(convolve(pre[j], dist[j]));
      const suf = new Array(n + 1);
      suf[n] = Float64Array.of(1);
      for (let j = n - 1; j >= 0; j--) suf[j] = convolve(dist[j], suf[j + 1]);
      return { pre, suf };
    };
    const preR = [Uint8Array.of(1)];
    for (let j = 0; j < n; j++) preR.push(convolveReach(preR[j], reach[j]));
    const sufR = new Array(n + 1);
    sufR[n] = Uint8Array.of(1);
    for (let j = n - 1; j >= 0; j--) sufR[j] = convolveReach(reach[j], sufR[j + 1]);
    // Ways for the cells away from every number to hold the rest: C(R, M - F) for F mines on the frontier,
    // relative to the largest, in logs first (C(381, 99) is about 1e93, and custom boards go further).
    const maxF = preR[n].length - 1;
    const restOk = (f) => M - f >= 0 && M - f <= R;
    const logRest = new Float64Array(maxF + 1).fill(-Infinity);
    let top = -Infinity;
    for (let f = 0; f <= maxF; f++) if (restOk(f)) { logRest[f] = logChoose(R, M - f); top = Math.max(top, logRest[f]); }
    const rest = Float64Array.from(logRest, (v) => (v === -Infinity ? 0 : Math.exp(v - top)));
    let { pre: preD, suf: sufD } = combine(pointGuess);
    if (comps.some((c) => !c.exact) && !preD[n].some((w, f) => w > 0 && rest[f] > 0)) ({ pre: preD, suf: sufD } = combine(wideGuess));

    let settled = 0;
    let allExact = true;
    const settle = (i, mine) => {
      if (state[i] !== K_UNKNOWN) return;
      if (mine) this.markMine(i);
      else this.markSafe(i);
      settled++;
    };
    const proofs = []; // [cell, isMine], applied after every component has been read
    for (let j = 0; j < n; j++) {
      const comp = comps[j];
      if (!comp.exact) {
        allExact = false;
        if (probability) for (const i of comp.cells) probability[i] = this.localDensity(i);
        continue;
      }
      const others = convolve(preD[j], sufD[j + 1]);
      const othersReach = convolveReach(preR[j], sufR[j + 1]);
      const { W, BM, seen, sizeOf, K, boxes } = comp;
      // For each count k here: the weight of everything else that completes it (wk) and whether anything can (ok).
      const wk = new Float64Array(K);
      const ok = new Uint8Array(K);
      for (let k = 0; k < K; k++) {
        if (!W[k]) continue;
        for (let o = 0; o < others.length; o++) {
          if (!restOk(k + o)) continue;
          wk[k] += others[o] * rest[k + o];
          if (othersReach[o]) ok[k] = 1;
        }
      }
      if (!ok.some(Boolean)) { this.broken = true; return { exact: false, probability, settled }; }
      let total = 0;
      for (let k = 0; k < K; k++) total += W[k] * wk[k];
      for (let b = 0; b < boxes.length; b++) {
        let everMine = false;
        let everSafe = false;
        let weight = 0;
        for (let k = 0; k < K; k++) {
          if (!ok[k]) continue;
          const f = seen[b * K + k];
          if (f & 1) everMine = true;
          if (f & 2) everSafe = true;
          if (BM) weight += BM[b * K + k] * wk[k];
        }
        if (!everMine || !everSafe) for (const i of boxes[b].cells) proofs.push([i, everMine]);
        if (probability) {
          const p = everMine ? (everSafe ? (total > 0 ? Math.min(1, weight / (sizeOf[b] * total)) : 0.5) : 1) : 0;
          for (const i of boxes[b].cells) probability[i] = p;
        }
      }
    }
    // The cells away from every number share the leftover mines evenly.
    if (R > 0) {
      let everMine = false;
      let everSafe = false;
      let weight = 0;
      let total = 0;
      for (let f = 0; f <= maxF; f++) {
        if (!restOk(f)) continue;
        if (preR[n][f]) { if (M - f > 0) everMine = true; if (M - f < R) everSafe = true; }
        const w = preD[n][f] * rest[f];
        weight += w * ((M - f) / R);
        total += w;
      }
      if (!everMine && !everSafe) { this.broken = true; return { exact: false, probability, settled }; }
      if (!everMine || !everSafe) for (const i of interior) proofs.push([i, everMine]);
      if (probability) {
        const p = everMine ? (everSafe ? (total > 0 ? Math.min(1, weight / total) : Math.min(1, M / R)) : 1) : 0;
        for (const i of interior) probability[i] = p;
      }
    }
    for (const [i, mine] of proofs) settle(i, mine);
    if (probability) for (let i = 0; i < cells; i++) if (state[i] === K_MINE) probability[i] = 1;
    return { exact: allExact, probability, settled };
  }

  /** A rough mine probability for a cell the count could not finish: the average share its numbers ask for. */
  localDensity(i) {
    const { nbStart, nbList, state, need, free } = this;
    let sum = 0;
    let n = 0;
    for (let p = nbStart[i]; p < nbStart[i + 1]; p++) {
      const c = nbList[p];
      if (state[c] === K_OPEN && free[c] > 0) { sum += need[c] / free[c]; n++; }
    }
    if (n) return sum / n;
    return this.unknown ? (this.mines - this.minesKnown) / this.unknown : 0;
  }
}

/**
 * Everything the screen proves about `game`, for a hint or a post-game look back.
 *
 * Reads `width`, `height`, `mines`, `view` and the `adjacent` numbers of OPEN cells, and nothing else: never
 * `mine`, and flags and question marks count as covered. (So a caller can pass `{ ...game, view: earlier }` to ask
 * about an earlier moment of the same game.) Every OPEN cell must be a safe one.
 *
 * Returns
 *   safe         covered cells that are safe in every layout that agrees with the screen, ascending
 *   mines        covered cells that are mines in every such layout, ascending
 *   probability  Float64Array, each cell's chance of being a mine (0 for open and safe cells, 1 for certain mines)
 *   safest       the covered cells that are not certain mines with the lowest probability (all of `safe`, if any)
 *   exact        false when counting ran over `budget` somewhere: the certainties still hold, but some
 *                probabilities are estimates
 *   consistent   false when no layout at all agrees with the screen (a corrupt or hand-made view)
 */
export function analyze(game, { budget = SOLVER_BUDGET } = {}) {
  const k = new Knowledge(game.width, game.height, game.mines);
  for (let i = 0; i < k.cells; i++) if (game.view[i] === OPEN) k.open(i, game.adjacent[i]);
  k.propagate();
  let counted = k.enumerate(budget);
  // An exact count settles everything at once; a partial one may have unlocked more for the rules, so go once more.
  if (!counted.exact && counted.settled && !k.broken) {
    k.propagate();
    counted = k.enumerate(budget);
  }
  const safe = [];
  const mines = [];
  for (let i = 0; i < k.cells; i++) {
    if (k.state[i] === K_SAFE) safe.push(i);
    else if (k.state[i] === K_MINE) mines.push(i);
  }
  const probability = counted.probability;
  let low = Infinity;
  for (let i = 0; i < k.cells; i++) if (k.state[i] !== K_OPEN && k.state[i] !== K_MINE) low = Math.min(low, probability[i]);
  // Within a rounding error of the lowest: the same share worked out two ways (a box, the far cells) can differ in
  // the last bit.
  const safest = [];
  for (let i = 0; i < k.cells; i++) if (k.state[i] !== K_OPEN && k.state[i] !== K_MINE && probability[i] <= low + 1e-12) safest.push(i);
  return { safe, mines, probability, safest, exact: counted.exact, consistent: !k.broken };
}

// ---------- no-guess boards ----------
//
// A board is "no guess" when the solver above, starting from the first click, can always prove some covered cell
// safe until the board is clear. Knowledge only grows as cells open, and a cell proven safe stays provably safe, so
// a player who opens only proven cells is never left without one, whatever order they take them in.
//
// Generating one: lay mines at random (first click and its neighbours clear, as always), then play the board by
// logic alone. Where logic gets stuck, change the layout among the cells it knows nothing about, so that one number
// on the edge of the open area becomes decisive: either every covered cell around it is emptied (its mines moved
// away) or every one is filled (mines moved in), whichever moves fewer mines. Mines are traded with covered cells
// that touch no open number when there are any, since a mine moved there changes no number already seen. Then play
// again from the first click, because the moved mines may have changed numbers that earlier deductions used: a
// board is only accepted after a clean run from the start. This is the idea of Simon Tatham's Mines, simplified.
//
// Budgets are counted in work (layouts, repairs, counting steps), never in time, so a seed lays the same board on
// every machine.

/**
 * Limits for placeMinesNoGuess, per board: fresh layouts, repairs per layout, counting steps per stuck point, and
 * `work`, the cells opened plus counting steps over every trial run, which caps the worst case on big dense custom
 * boards where no-guess may be impossible (about 0.3 s in Node before the fallback). The standard levels use a few
 * hundredths of that (see test/solver.test.mjs).
 */
export const NO_GUESS_LIMITS = Object.freeze({ layouts: 12, repairs: 120, budget: 20000, work: 1000000 });

/**
 * Play a laid board from `first` with logic only: open what the solver proves safe (learning each opened cell's
 * number from the real layout, as a player would) and repeat. Returns the solver's knowledge where it ended, with
 * `solved` set when every safe cell was opened.
 */
function playByLogic(game, first, budget) {
  const k = new Knowledge(game.width, game.height, game.mines);
  const { nbStart, nbList, state } = k;
  const stack = [];
  const openFrom = (s) => {
    stack.push(s);
    while (stack.length) {
      const c = stack.pop();
      if (state[c] === K_OPEN) continue;
      if (game.mine[c]) throw new Error('the solver opened a mine'); // a bug in the solver, never a board
      k.open(c, game.adjacent[c]);
      // Zeros flood-fill, as in the game; the solver would prove the same cells safe one by one.
      if (game.adjacent[c] === 0) for (let p = nbStart[c]; p < nbStart[c + 1]; p++) if (state[nbList[p]] !== K_OPEN) stack.push(nbList[p]);
    }
  };
  openFrom(first);
  const target = game.cells - game.mines;
  while (k.opened < target && !k.broken) {
    k.propagate();
    if (!k.found.length) k.enumerate(budget, false);
    if (!k.found.length) break;
    const found = k.found;
    k.found = [];
    for (const s of found) if (state[s] === K_SAFE) openFrom(s);
  }
  k.solved = k.opened === target;
  return k;
}

/** Whether logic alone clears this laid board from `first` (the same test placeMinesNoGuess passes its boards by). */
export function solvesByLogic(game, first, { budget = NO_GUESS_LIMITS.budget } = {}) {
  return playByLogic(game, first, budget).solved;
}

function moveMine(game, from, to) {
  const { start, list } = geometry(game.width, game.height);
  game.mine[from] = 0;
  game.mine[to] = 1;
  for (let p = start[from]; p < start[from + 1]; p++) game.adjacent[list[p]]--;
  for (let p = start[to]; p < start[to + 1]; p++) game.adjacent[list[p]]++;
}

/** `count` cells drawn from `pool` without replacement (shuffling the front of `pool` in place). */
function draw(pool, count, rng) {
  for (let k = 0; k < count; k++) {
    const j = k + Math.floor(rng() * (pool.length - k));
    [pool[k], pool[j]] = [pool[j], pool[k]];
  }
  return pool.slice(0, count);
}

/**
 * Logic is stuck at `k`: make one number on the edge of the open area decisive (see above). Returns false when
 * there is nothing left to trade with, and the generator starts again from a fresh layout.
 */
function repair(game, k, rng, keepClear) {
  const { cells } = game;
  const { state, free, nbStart, nbList } = k;
  const unknownAround = (c) => {
    const out = [];
    for (let p = nbStart[c]; p < nbStart[c + 1]; p++) if (state[nbList[p]] === K_UNKNOWN) out.push(nbList[p]);
    return out;
  };
  const edge = [];
  for (let c = 0; c < cells; c++) if (state[c] === K_OPEN && free[c] > 0) edge.push(c);
  let target;
  if (edge.length) {
    target = unknownAround(edge[Math.floor(rng() * edge.length)]);
  } else {
    // Nothing open touches the unknown cells (they sit behind mines already found): open a way into them.
    const unknown = [];
    for (let c = 0; c < cells; c++) if (state[c] === K_UNKNOWN) unknown.push(c);
    if (!unknown.length) return false;
    const u = unknown[Math.floor(rng() * unknown.length)];
    target = [u, ...unknownAround(u)];
  }
  const inTarget = new Uint8Array(cells);
  for (const c of target) inTarget[c] = 1;
  // Cells to trade with, least disruptive first: unknown cells touching no open number, unknown cells next to one,
  // and last (the endgame, where a final 50/50 has no unknown cells left to trade with) cells already settled.
  const far = [];
  const near = [];
  const settled = [];
  for (let c = 0; c < cells; c++) {
    if (inTarget[c] || keepClear.has(c)) continue;
    if (state[c] !== K_UNKNOWN) { settled.push(c); continue; }
    let touches = false;
    for (let p = nbStart[c]; p < nbStart[c + 1] && !touches; p++) touches = state[nbList[p]] === K_OPEN;
    (touches ? near : far).push(c);
  }
  const minesIn = target.filter((c) => game.mine[c]);
  const clearIn = target.filter((c) => !game.mine[c]);
  for (const pool of [far, near, settled]) {
    const poolClear = pool.filter((c) => !game.mine[c]);
    const poolMines = pool.filter((c) => game.mine[c]);
    const canEmpty = minesIn.length <= poolClear.length;
    const canFill = clearIn.length <= poolMines.length;
    if (!canEmpty && !canFill) continue;
    const empty = canEmpty && (!canFill || minesIn.length < clearIn.length || (minesIn.length === clearIn.length && rng() < 0.5));
    if (empty) {
      const to = draw(poolClear, minesIn.length, rng);
      minesIn.forEach((c, n) => moveMine(game, c, to[n]));
    } else {
      const from = draw(poolMines, clearIn.length, rng);
      clearIn.forEach((c, n) => moveMine(game, from[n], c));
    }
    return true;
  }
  return false;
}

/**
 * Lay mines like placeMines (the first cell and its neighbours clear), so that logic alone clears the board from
 * `safeIndex`. All randomness comes from `rng`, so the same seeded rng and first click give the same board.
 *
 * If no such board turns up within `limits` (dense custom boards can make it impossible), the board is laid the
 * ordinary way instead and `game.noGuess` is set to false. Returns `{ noGuess, layouts, repairs, steps }`: whether
 * it succeeded, and the work it took.
 */
export function placeMinesNoGuess(game, safeIndex, rng = Math.random, limits = {}) {
  const { layouts, repairs, budget, work } = { ...NO_GUESS_LIMITS, ...limits };
  const keepClear = safeAreaOf(game, safeIndex);
  let used = 0;
  let spent = 0;
  let l = 0;
  while (l < layouts && spent < work) {
    l++;
    scatter(game, keepClear, rng);
    computeAdjacent(game);
    for (let r = 0; r <= repairs && spent < work; r++) {
      const k = playByLogic(game, safeIndex, budget);
      spent += k.opened + k.steps;
      if (k.solved) {
        game.status = 'playing';
        return { noGuess: true, layouts: l, repairs: used, work: spent };
      }
      if (r === repairs || !repair(game, k, rng, keepClear)) break;
      used++;
    }
  }
  scatter(game, keepClear, rng);
  computeAdjacent(game);
  game.status = 'playing';
  game.noGuess = false;
  return { noGuess: false, layouts: l, repairs: used, work: spent };
}
