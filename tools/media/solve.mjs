/**
 * A seeded no guess board and a quick logic solve of it, as a replay record (replay.js) for the media banner.
 * Every move is one the solver proved, so the same seed always gives the same game.
 */
import { DIFFICULTIES, FLAG, OPEN, activate, analyze, coordsOf, createGame, indexOf, mulberry32, toggleMark } from '../../minesweeper/engine.js';
import { MOVE, makeReplay } from '../../minesweeper/replay.js';

export function solveReplay({ level = 'intermediate', seed = 7, step = 220 } = {}) {
  const { width, height, mines } = DIFFICULTIES[level];
  const game = createGame({ width, height, mines, noGuess: true });
  const rng = mulberry32(seed);
  const moves = [];
  let t = 400;
  let at = indexOf(game, Math.floor(width / 2), Math.floor(height / 2));
  activate(game, at, rng);
  moves.push({ t, k: MOVE.open, i: at });
  const dist = (a, b) => {
    const p = coordsOf(game, a), q = coordsOf(game, b);
    return Math.hypot(p.x - q.x, p.y - q.y);
  };
  while (game.status === 'playing') {
    const { safe, mines: known } = analyze(game);
    const todo = [
      ...known.filter((i) => game.view[i] !== FLAG).map((i) => ({ i, k: MOVE.flag })),
      ...safe.filter((i) => game.view[i] !== OPEN).map((i) => ({ i, k: MOVE.open })),
    ];
    if (!todo.length) throw new Error(`seed ${seed} needs a guess`);
    // Work outward from wherever the last move was, like a player does.
    todo.sort((a, b) => dist(at, a.i) - dist(at, b.i));
    const next = todo[0];
    t += step;
    if (next.k === MOVE.flag) toggleMark(game, next.i);
    else activate(game, next.i, rng);
    moves.push({ t, ...next });
    at = next.i;
  }
  if (game.status !== 'won') throw new Error(`seed ${seed} ended ${game.status}`);
  return makeReplay(game, moves, { ms: t, won: true, at: Date.UTC(2026, 9, 15), level, label: DIFFICULTIES[level].label });
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const r = solveReplay({ seed: Number(process.argv[2] || 7) });
  console.log(r.w, r.h, r.m, r.moves.length, r.ms);
}
