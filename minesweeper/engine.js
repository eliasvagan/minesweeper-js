/**
 * Minesweeper rules, with no DOM and no storage: a game is a plain object, and every move is a function that
 * updates it and reports what changed. The page (app.js) only draws what these functions return, and the unit
 * tests (test/engine.test.mjs) drive the same functions directly.
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

export function createGame({ width, height, mines }) {
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
  const around = new Set([safeIndex, ...neighbours(game, safeIndex)]);
  const safe = game.cells - around.size >= game.mines ? around : new Set([safeIndex]);
  const pool = [];
  for (let i = 0; i < game.cells; i++) if (!safe.has(i)) pool.push(i);
  // Partial Fisher–Yates: the first `mines` entries of the pool are a uniform sample.
  for (let k = 0; k < game.mines; k++) {
    const j = k + Math.floor(rng() * (pool.length - k));
    [pool[k], pool[j]] = [pool[j], pool[k]];
    game.mine[pool[k]] = 1;
  }
  computeAdjacent(game);
  game.status = 'playing';
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
  if (game.status === 'ready') placeMines(game, index, rng);
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
const pack = (bytes) => Array.from(bytes).join('');

export function serialize(game) {
  return {
    width: game.width,
    height: game.height,
    mines: game.mines,
    status: game.status,
    mine: pack(game.mine),
    view: pack(game.view),
    exploded: [...game.exploded],
  };
}

export function deserialize(data) {
  const game = createGame({ width: data.width, height: data.height, mines: data.mines });
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
