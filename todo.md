# To do

Found while commenting the code base (October 2026), and done in wave 2:

- [x] **Unused CSS from the old name dialog.** `.name-lead`, `.name-form`, `.field-note`, `.name-error-on` and
      `.pill-sm` are gone from `minesweeper/style.css` (nothing in `index.html`, the scripts or the tests used them).
- [x] **Unreachable branch.** `rankedText`'s `!answer.ranked` case is gone: `verifyWin`, its only caller, runs for
      ranked answers only, and the comment says so.

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

## The daily challenge, statistics, sharing and replays (October 2026, wave 2)

Done:

- [x] **Daily challenge** (`minesweeper/daily.js`, `server/src/daily.js`): one no-guess board per Europe/Oslo day and
      ranked level, seeded with HMAC-SHA256 under `DAILY_SECRET` (else a random secret kept in the database) into an
      AES-256-CTR stream, with a fixed opening that any first tap opens. First try per player, day and level counts
      (filed at the first open, in one transaction; at most 6 per address); later ones are practice, said before and
      after. A `daily` table and `GET /daily` (today, yesterday) with the streak; a daily created before midnight can't
      start after it. No offline daily: the page says it is unavailable. The level sheet's last row, a quiet dot on
      the level button, two taps to give up a counted daily.
- [x] **Statistics sheet** from a new per-game history in `records.js` (its own key, written at the end of a game):
      totals, best and average, 3BV/s and efficiency, small-multiple trends (`charts.js`) with words, a readout and a
      table, recent games; hinted wins tagged, hollow and left out of best and averages. Older saves load as they
      were and the sheet says where the history begins.
- [x] **Share** (`share.js`): one line for an ordinary game, the day, level and a pace grid for the daily (counts at
      five moments, never positions); the system share sheet on phones, the clipboard elsewhere.
- [x] **Replays** (`replay.js`): every move logged with the clock (also through a reload), kept for the best times and
      the last game within a 300 000-character budget; ranked games played back the server's way; a viewer on the
      board with play and pause, speed, a move-by-move scrubber and the clock.
- [x] **Server: a clock that steps back** (an NTP correction) no longer drains every rate-limit bucket until it has
      caught up (`ratelimit.js`), found by the daily's day-boundary tests.

- [x] **Review fixes** (eleven, each with a test or a 568 × 320 check):
      no practice daily while the player's counted one is live (409 `daily-in-progress`, at creation and at the first
      open, the counted game named so another tab can continue it), and an uncounted row for practice at a capped
      address, so a board seen can never be counted later; a lost answer to the first open is asked again on the same
      game (same batch number) instead of dealing practice; a counted daily under way is never evicted by its address's
      other games; walking away closes a ranked game on the server (`POST /games/:id/close`); the details panel stays
      on screen (no taller than the room above the result) and every result line fits a 568 × 320 screen in one line,
      the whole of it in the details; a 0 ms win no longer breaks the statistics (at least 1 ms kept, no 3BV/s under
      0.1 s); practice that goes offline stays practice; an untouched board that timed out says so; marks made while a
      move waited replay in the order they took effect (`goneOffline`), and a replay is kept only if it ends on the
      game's own board; the give-up guard covers the level sheet too; S works from the scores sheet.

Left for later, on purpose:

- [ ] **Live two-player races.** Two players on one board at once needs a realtime channel (WebSockets or
      server-sent events through nginx, held open per game), a shared clock and countdown, matchmaking or invite
      links, and new abuse handling: a race is a game two clients can grief (stalling, disconnecting to deny a loss,
      a second device feeding the board to the first). That is a new server and a new trust model, too large for this
      round; the daily covers "the same board as everyone else" without any of it.
- [ ] **Deploy: set `DAILY_SECRET`** in `/etc/minesweeper-api.env` (any long random string). Without it the server
      uses the random secret it keeps in the database, which is safe, but the env var survives a database restore.
      The `daily` and `meta` tables are created on the first start of the new server; `server/deploy/` was not
      touched (deployment is handled elsewhere).
- [ ] **A board shared after playing it.** Anyone who has finished today's daily has seen its mines and can pass them
      on; a new device token is a new player with a first try of its own (the per-address cap only slows that). An
      account system would close the second gap, not the first.
- [ ] **"Yesterday" is final only once its last games end**: a daily started before midnight may be won up to an
      hour after it (the plausibility cap), so yesterday's board can still change a little after midnight.
- [ ] **The history keeps the last 1 000 games** and the trends show the last 24 wins of a board. Long-term trends
      (by month, say) would want an aggregate kept beside the history rather than a longer list.
- [ ] **Replays of games from before this version** do not exist (their moves were not logged), and neither do those
      of ranked games cut short with no layout ("this board cannot continue offline").
- [ ] **`test/e2e-live.mjs` plays no daily.** A live run would use up the test player's try for the day on
      production; the daily was checked against the real server in `test/e2e-pwa.mjs` and a fake one in `test/e2e.mjs`.
- [ ] **`test/e2e.mjs` is flaky about once in eight runs**: one run failed on an assertion `0 !== 3` and another
      on puppeteer's "Navigating frame was detached", each passing on every rerun (37 checks, six clean runs in a
      row). Run it a few times with the failing step logged to find which wait is racing.
