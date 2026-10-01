/**
 * Unit tests of minesweeper/replay.js: the compact encoding of moves and mines, and the playback, against games
 * played here with engine.js the way app.js plays them. A local game replays to exactly the board the player saw
 * after every move; a ranked game replays the server's way (its flood fill ignores flags, a chord uses the flags
 * around its number), including one that loses the server midway and goes on locally. Run by `npm test`.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  DIFFICULTIES, FLAG, HIDDEN, OPEN, QUESTION, activate, analyze, canChord, chord, computeAdjacent, createGame,
  mulberry32, neighbours, reveal, toggleMark,
} from '../minesweeper/engine.js';
import {
  MOVE, Playback, decodeMoves, encodeMoves, goneOffline, makeReplay, packMines, replayHolds, unpackMines,
} from '../minesweeper/replay.js';

test('moves round-trip, to the hundredth of a second, and never go back in time', () => {
  const rng = mulberry32(3);
  const moves = [];
  let t = 0;
  for (let k = 0; k < 500; k++) {
    t += Math.floor(rng() * 40000);
    moves.push({ t, k: Math.floor(rng() * 6), i: Math.floor(rng() * 1600) });
  }
  const back = decodeMoves(encodeMoves(moves));
  assert.equal(back.length, moves.length);
  back.forEach((m, k) => {
    assert.equal(m.k, moves[k].k);
    assert.equal(m.i, moves[k].i);
    assert.ok(Math.abs(m.t - moves[k].t) <= 5, `${m.t} vs ${moves[k].t}`);
  });
  // A clock reading that goes back (a resumed game) is kept at the one before.
  assert.deepEqual(decodeMoves(encodeMoves([{ t: 500, k: 0, i: 1 }, { t: 300, k: 2, i: 2 }])).map((m) => m.t), [500, 500]);
  assert.deepEqual(decodeMoves(''), []);
  for (const bad of ['*', 'g', 'AAA']) assert.throws(() => decodeMoves(bad), TypeError, bad);
});

test('mines pack six cells to a character', () => {
  const rng = mulberry32(9);
  for (const cells of [81, 256, 480, 1600, 7]) {
    const mine = Uint8Array.from({ length: cells }, () => (rng() < 0.2 ? 1 : 0));
    const text = packMines(mine);
    assert.equal(text.length, Math.ceil(cells / 6));
    assert.deepEqual([...unpackMines(text, cells)], [...mine]);
  }
});

/** Covered safe cells that a hint would give, else any covered safe cell: a player who mostly plays by logic. */
function nextSafe(g, rng) {
  const a = analyze(g);
  const safe = a.safe.length ? a.safe : [...g.mine.keys()].filter((i) => !g.mine[i] && g.view[i] !== OPEN && g.view[i] !== FLAG);
  return safe[Math.floor(rng() * safe.length)];
}

/**
 * A local game as app.js plays it: first click, then by logic with flags on proven mines, a chord now and then, a
 * question mark, a wrong flag; every move logged with the clock's reading. Returns the game, the log and the view
 * after each logged move.
 */
function playLocal(d, seed, { lose = false } = {}) {
  const rng = mulberry32(seed);
  const g = createGame(d);
  const log = [];
  const views = [];
  let t = 0;
  const did = (k, i) => { t += 50 + Math.floor(rng() * 900); log.push({ t, k, i }); views.push(g.view.slice()); };
  const first = Math.floor(g.cells / 2);
  // A flag before the first click is allowed, and kept when the mines are laid.
  toggleMark(g, 0);
  did(MOVE.flag, 0);
  reveal(g, first, rng);
  did(MOVE.open, first);
  while (g.status === 'playing') {
    const a = analyze(g);
    const mine = a.mines.find((i) => g.view[i] !== FLAG);
    if (mine !== undefined && rng() < 0.5) {
      toggleMark(g, mine);
      did(MOVE.flag, mine);
      const number = neighbours(g, mine).find((j) => canChord(g, j));
      if (number !== undefined && rng() < 0.7) {
        chord(g, number);
        did(MOVE.chord, number);
      }
      continue;
    }
    if (lose && g.opened > g.cells / 3) {
      const boom = [...g.mine.keys()].find((i) => g.mine[i] && g.view[i] !== FLAG);
      activate(g, boom);
      did(MOVE.open, boom);
      break;
    }
    const i = nextSafe(g, rng);
    if (rng() < 0.05 && g.view[i] === HIDDEN) {
      toggleMark(g, i, { questionMarks: true });
      toggleMark(g, i, { questionMarks: true });
      did(MOVE.question, i);
      toggleMark(g, i, { questionMarks: true });
      did(MOVE.unmark, i);
    }
    if (g.view[i] === FLAG) {
      toggleMark(g, i);
      did(MOVE.unmark, i);
    }
    activate(g, i);
    did(MOVE.open, i);
  }
  return { g, log, views, ms: t };
}

test('a local game replays to the board the player saw, move by move, and to its end', () => {
  for (const [d, seed, lose] of [[DIFFICULTIES.beginner, 1, false], [DIFFICULTIES.intermediate, 2, false], [DIFFICULTIES.expert, 3, false], [DIFFICULTIES.expert, 4, true]]) {
    const { g, log, views, ms } = playLocal(d, seed, { lose });
    const rec = makeReplay(g, log, { ms, won: g.status === 'won', level: d.id });
    const back = JSON.parse(JSON.stringify(rec)); // as stored
    const p = new Playback(back);
    assert.equal(p.length, log.length);
    assert.deepEqual([...p.game.view].filter((v) => v !== HIDDEN), [], 'covered before the first move');
    for (let k = 0; k < log.length; k++) {
      const step = p.next();
      assert.equal(step.move.k, log[k].k);
      assert.deepEqual([...p.game.view], [...views[k]], `${d.id} seed ${seed}: move ${k + 1}`);
      assert.equal(p.timeAt(k + 1), Math.round(log[k].t / 10) * 10);
    }
    assert.equal(p.game.status, g.status);
    assert.equal(p.next(), null, 'nothing after the end');
    assert.equal(replayHolds(back), true);
    // Seeking back and forth gives the same boards as playing through, on the same game object (the page holds it).
    const drawn = p.game;
    for (const k of [log.length, 3, 0, Math.floor(log.length / 2)]) {
      p.seek(k);
      assert.equal(p.game, drawn);
      assert.deepEqual([...p.game.view], k ? [...views[k - 1]] : [...new Uint8Array(g.cells)], `seek ${k}`);
      assert.equal(p.game.status, k === log.length ? g.status : 'playing');
    }
    if (d.id === 'expert' && !lose) assert.ok(JSON.stringify(rec).length < 2600, `an Expert replay is ${JSON.stringify(rec).length} characters`);
  }
});

test('a ranked game replays the server\'s way, an offline switch included', () => {
  // The server's game keeps no flags; the page's mirror has them, and drops one where the server opens its cell.
  // Halfway through, the server is gone and the page plays on locally, on the same layout.
  let flagsOpened = 0; // flags the server's flood fill opened, which a local replay would have stopped at
  for (const seed of [11, 12, 13, 14, 15, 16]) {
    const rng = mulberry32(seed);
    const d = DIFFICULTIES.intermediate;
    const server = createGame(d);
    const page = createGame(d);
    page.status = 'playing';
    const log = [];
    const views = [];
    let t = 0;
    let local = false;
    const did = (k, i) => { t += 100 + Math.floor(rng() * 500); log.push({ t, k, i }); views.push(page.view.slice()); };
    const apply = (opened) => {
      for (const [i] of opened) {
        if (page.view[i] === FLAG) { page.flags--; flagsOpened++; }
        if (page.view[i] !== OPEN) { page.view[i] = OPEN; page.opened++; }
      }
    };
    const first = 8 * 16 + 8;
    const opening = reveal(server, first, rng);
    // The page learns each opened cell's number from the answers; here it simply has the layout's numbers.
    page.mine.set(server.mine);
    computeAdjacent(page);
    apply(opening.opened);
    did(MOVE.open, first);
    // A wrong flag on a covered safe cell next to the open area, which the server's flood fill may open later.
    const wrong = [...page.view.keys()].find((i) => page.view[i] === HIDDEN && !page.mine[i] && neighbours(page, i).some((j) => page.view[j] === OPEN));
    page.view[wrong] = FLAG;
    page.flags++;
    did(MOVE.flag, wrong);
    let moves = 0;
    while (page.status === 'playing' && page.opened < page.cells - page.mines) {
      if (!local && ++moves === 25) {
        local = true;
        did(MOVE.offline, 0);
        continue;
      }
      const a = analyze({ ...page, view: page.view.map((v) => (v === FLAG ? HIDDEN : v)) });
      const mine = a.mines.find((i) => page.view[i] !== FLAG);
      if (mine !== undefined && rng() < 0.4) {
        page.view[mine] = FLAG;
        page.flags++;
        did(MOVE.flag, mine);
        // Chord only where every flag is right: a wrong one would end the game, which is not what is tested here.
        const number = neighbours(page, mine).find((j) => canChord(page, j) && neighbours(page, j).every((f) => page.view[f] !== FLAG || page.mine[f]));
        if (number !== undefined) {
          if (local) chord(page, number);
          else {
            const flags = neighbours(page, number).filter((j) => page.view[j] === FLAG);
            for (const f of flags) server.view[f] = FLAG;
            server.flags += flags.length;
            const r = chord(server, number);
            for (const f of flags) if (server.view[f] === FLAG) server.view[f] = HIDDEN;
            server.flags -= flags.length;
            apply(r.opened);
          }
          did(MOVE.chord, number);
        }
        continue;
      }
      let i = a.safe.find((j) => page.view[j] !== FLAG);
      if (i === undefined) i = [...page.mine.keys()].find((j) => !page.mine[j] && page.view[j] !== OPEN);
      if (page.view[i] === FLAG) { // the wrong flag, still there: off it comes, then open
        page.view[i] = HIDDEN;
        page.flags--;
        did(MOVE.unmark, i);
      }
      if (local) reveal(page, i);
      else apply(reveal(server, i).opened);
      did(MOVE.open, i);
    }
    const won = page.opened === page.cells - page.mines;
    const p = new Playback(makeReplay(page, log, { ms: t, won, server: true }));
    for (let k = 0; k < log.length; k++) {
      p.next();
      // The engine flags every mine once won; the page's mirror shows that too (app.js), so compare up to the last move.
      if (k < log.length - 1 || !won) assert.deepEqual([...p.game.view], [...views[k]], `seed ${seed}: move ${k + 1} (${local ? 'mixed' : 'server'})`);
    }
    assert.equal(p.game.status, won ? 'won' : 'playing');
  }
  assert.ok(flagsOpened > 0, 'the case that tells the two ways apart came up');
});

test('a damaged or inconsistent replay is refused, not half played', () => {
  const { g, log, ms } = playLocal(DIFFICULTIES.beginner, 5);
  const rec = makeReplay(g, log, { ms, won: true });
  assert.equal(replayHolds(rec), true);
  assert.equal(replayHolds({ ...rec, moves: rec.moves.slice(0, -4) }), false, 'moves missing: it does not end in a win');
  assert.equal(replayHolds({ ...rec, won: false }), false);
  assert.equal(replayHolds({ ...rec, mines: 'A'.repeat(rec.mines.length) }), false, 'the wrong number of mines');
  assert.equal(replayHolds({ ...rec, moves: '%%' }), false);
  assert.equal(replayHolds({ ...rec, v: 99 }), false);
  assert.throws(() => new Playback(null), TypeError);
});

test('the timeline counts the safe cells open after each move', () => {
  const { g, log, ms } = playLocal(DIFFICULTIES.intermediate, 6);
  const line = new Playback(makeReplay(g, log, { ms, won: true })).timeline();
  assert.equal(line.length, log.length);
  assert.equal(line.at(-1)[1], g.cells - g.mines);
  for (let k = 1; k < line.length; k++) {
    assert.ok(line[k][0] >= line[k - 1][0]);
    assert.ok(line[k][1] >= line[k - 1][1]);
  }
  assert.equal(QUESTION, 3, 'the kinds map onto engine.js\'s marks');
});

test('going offline: unanswered moves replay where the page made them again, after the marks placed meanwhile', () => {
  // The review's case: mines in the last row (and one more, which walls off a safe cell, so that no flood fill wins
  // the game). A is answered by the server; B (a zero at the top, whose flood fill would reach C) is sent but never
  // answered; C is flagged while B waits. The server goes, and the page makes B again: its flood fill now stops at
  // the flag. The replay must show that, not B opening C.
  const live = createGame({ width: 9, height: 9, mines: 10 });
  for (let x = 0; x < 9; x++) live.mine[8 * 9 + x] = 1;
  live.mine[6 * 9 + 8] = 1;
  computeAdjacent(live);
  live.status = 'playing';
  const A = 7 * 9 + 4;
  const B = 0;
  const C = 2 * 9 + 4;
  let log = [];
  reveal(live, A);
  log.push({ t: 0, k: MOVE.open, i: A }); // answered
  log.push({ t: 100, k: MOVE.open, i: B }); // sent, never answered
  toggleMark(live, C);
  log.push({ t: 200, k: MOVE.flag, i: C }); // placed while B waited
  log = goneOffline(log, [1], 300); // the page takes over...
  assert.deepEqual(log.map((m) => m.k), [MOVE.open, MOVE.flag, MOVE.offline]);
  reveal(live, B);
  log.push({ t: 300, k: MOVE.open, i: B }); // ...and makes B again, logged where it happens
  assert.equal(live.view[C], FLAG, 'on screen, the flood stopped at the flag');
  reveal(live, 8 * 9);
  log.push({ t: 400, k: MOVE.open, i: 8 * 9 });
  assert.equal(live.status, 'lost');
  const rec = makeReplay(live, log, { ms: 400, won: false, server: true });
  const p = new Playback(rec);
  p.seek(p.length);
  assert.deepEqual([...p.game.view], [...live.view]);
  assert.equal(replayHolds(rec, live.view), true);
  // The order before the fix (the mark replayed after the open) ends the same way on another board: the end status
  // alone cannot tell, the final board can, and such a replay is not kept.
  const wrong = makeReplay(live, [
    { t: 0, k: MOVE.open, i: A }, { t: 100, k: MOVE.offline, i: 0 }, { t: 100, k: MOVE.open, i: B },
    { t: 200, k: MOVE.flag, i: C }, { t: 400, k: MOVE.open, i: 8 * 9 },
  ], { ms: 400, won: false, server: true });
  assert.equal(replayHolds(wrong), true);
  assert.equal(replayHolds(wrong, live.view), false);
  // The mark keeps its time; the offline move never goes back in time.
  assert.deepEqual(goneOffline([{ t: 500, k: MOVE.flag, i: 3 }], [], 400).map((m) => m.t), [500, 500]);
});
