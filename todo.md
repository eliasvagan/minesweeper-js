# To do

## Game

- [ ] **Offline completion of a no-guess game.** When a ranked no-guess game loses the server midway, the page lays
      mines with `completeLayout`, which only agrees with the screen, and the game is filed as classic. A no-guess
      completion (the generator, restricted to the unknown cells) would keep it a no-guess game. Rare enough (a
      dropped connection mid-game) that the honest relabel is enough for now.
- [ ] **`completeLayout` and the solver** both search layouts that fit the numbers. The solver counts every layout
      by boxes; `completeLayout` wants one random layout, cell by cell. It could sample uniformly from the solver's
      component weights instead (it is not uniform today), but nothing depends on that yet.
- [ ] **The level line is full on phones.** On a 390 px phone the Intermediate line clips its chevron, which is why
      the *No guessing* tag sits on a row of its own. A shorter level line (or the name field taking less room) would
      let the tag sit beside the level.
- [ ] **A worker for the generator.** It runs on the main thread at the first click: well under a frame on the
      standard levels, but up to about 0.3 s in Node (more on a slow phone) on a big, dense custom board before it
      gives up. A module worker would keep that off the main thread, at the cost of another shell file and async
      first clicks; not worth it for custom boards that dense.
- [ ] **The history keeps the last 1 000 games** and the trends show the last 24 wins of a board. Long-term trends
      (by month, say) would want an aggregate kept beside the history rather than a longer list.
- [ ] **Replays of ranked games cut short with no layout** ("this board cannot continue offline") are not kept.

## Daily and ranked play

- [ ] **Live two-player races.** Two players on one board at once needs a realtime channel (WebSockets or
      server-sent events through nginx, held open per game), a shared clock and countdown, matchmaking or invite
      links, and new abuse handling: a race is a game two clients can grief (stalling, disconnecting to deny a loss,
      a second device feeding the board to the first). That is a new server and a new trust model; the daily covers
      "the same board as everyone else" without any of it.
- [ ] **A board shared after playing it.** Anyone who has finished today's daily has seen its mines and can pass them
      on; a new device token is a new player with a first try of its own (the per-address cap only slows that). An
      account system would close the second gap, not the first.
- [ ] **"Yesterday" is final only once its last games end**: a daily started before midnight may be won up to an
      hour after it (the plausibility cap), so yesterday's board can still change a little after midnight.

## Tests

- [ ] **`test/e2e.mjs` is flaky about once in eight runs**: one run failed on an assertion `0 !== 3` and another
      on puppeteer's "Navigating frame was detached", each passing on every rerun. Run it a few times with the
      failing step logged to find which wait is racing.
- [ ] **`test/e2e-live.mjs` plays classic games only**, no no-guess game and no daily: a live run would put a test win
      on the no-guess board and use up the test player's daily try on production. Both are covered against a local
      server instead (the server tests, `test/e2e-pwa.mjs`, and the fake-API steps in `test/e2e.mjs`).
