# To do

Found while commenting the code base (October 2026). Nothing here has been changed yet.

- [ ] **Unused CSS from the old name dialog.** `minesweeper/style.css` still has `.name-lead`, `.name-form`,
      `.field-note`, `.name-error-on` and `.pill-sm`, which nothing in `index.html` or the scripts uses.
- [ ] **Unreachable branch.** `rankedText`'s `!answer.ranked` case in `minesweeper/app.js` can't be reached from
      its only caller, `verifyWin`.

## Logic, no-guess boards, hints and the look back (October 2026, wave 1)

Done:

- [x] **Solver** in `engine.js` (`analyze`): single-cell and pair/subset rules, the mine total, exact counting per
      component (cells grouped into boxes) weighted by the far cells' share of the mines; budgeted, flags ignored,
      `mine` never read. Checked against brute force on 250 small positions (`test/solver.test.mjs`).
- [x] **No-guess generator** (`placeMinesNoGuess`, `solvesByLogic`): random layout, play by logic, repair where
      stuck, replay from the start; deterministic per rng (Node and Chrome agree), budgets in work, honest fallback.
- [x] **No guessing** setting for local and ranked games; ranked no-guess games laid by the server (`v: 'ng'`) and
      ranked on their own boards, with a migration adding `scores.variant`; the scores sheet switches between them.
- [x] **Hint** in local games (safe cell, or the safest guess with its chance); off in ranked games with the reason;
      a hinted win keeps no time and counts as played, not won (`stats.assisted`).
- [x] **Look back**: avoidable or forced guess on a loss (with the safe cell ringed and the clicked cell's chance),
      3BV, 3BV/s, clicks and efficiency on a win, behind a disclosure.
- [x] `server/package.json`'s test script: `node --test test/` fails on Node 22 (a bare directory is taken as a
      file there); it is `node --test test/*.test.mjs` now, which both 20 and 22 run.
- [x] `test/e2e.mjs`'s "none again once it fits" read the edge fades before the frame that updates them; it waits
      for that frame now, like the scroll checks before it.

- [x] **Review fixes** (each with a test that fails without it):
      a local generator that gives up now relabels and files the game as classic, with a notice (`fellBack` went by
      `game.noGuess`, which the engine had already cleared); a ranked loss counts only proven cells that could still
      be tapped, not ones already on their way to the server; the No guessing tag no longer pushes a finished game
      past a 568 × 320 landscape screen; and `scores` answers carry `v`, so a server from before variants (which
      ignores it) is not shown as a no-guess board.

Left for later, on purpose:

- [ ] **Offline completion of a no-guess game.** When a ranked no-guess game loses the server midway, the page lays
      mines with `completeLayout`, which only agrees with the screen, and the game is filed as classic. A no-guess
      completion (the generator, restricted to the unknown cells) would keep it a no-guess game. Rare enough (a
      dropped connection mid-game) that the honest relabel is enough for now.
- [ ] **`completeLayout` and the solver** both search layouts that fit the numbers. The solver counts every layout
      by boxes; `completeLayout` wants one random layout, cell by cell. It could sample uniformly from the solver's
      component weights instead (it is not uniform today), but nothing depends on that yet, so it was left alone.
- [ ] **The level line is full on phones.** On a 390 px phone the Intermediate line already clipped its chevron
      before this change, which is why the *No guessing* tag sits on a row of its own. A shorter level line (or the
      name field taking less room) would let the tag sit beside the level.
- [ ] **A worker for the generator.** It runs on the main thread at the first click: well under a frame on the
      standard levels, but up to about 0.3 s in Node (more on a slow phone) on a big, dense custom board before it
      gives up. A module worker would keep that off the main thread, at the cost of another shell file and async
      first clicks; not worth it for custom boards that dense.
- [ ] **`test/e2e-live.mjs` plays classic only.** It runs against production, and a no-guess run would put a test
      win on the new board as well; the no-guess path was checked against a local server instead (the server tests,
      and the fake-API step in `test/e2e.mjs`).
- [ ] **Deploy**: the scores table gains its `variant` column on the first start of the new server; `server/deploy/`
      was not touched (deployment is handled elsewhere), so check the migration there on the next deploy.
