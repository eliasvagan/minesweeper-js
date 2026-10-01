# Minesweeper

Classic Minesweeper for the browser, made for phones first and still quick with a mouse. Plain static files
with no build step and no dependencies.

**Play:** [eliasvagan.github.io/minesweeper-js](https://eliasvagan.github.io/minesweeper-js/) · [eliasv.com/minesweeper](https://eliasv.com/minesweeper/)

## Controls

| | Touch | Mouse | Keyboard |
| --- | --- | --- | --- |
| Open a cell | Tap | Left click | <kbd>Space</kbd> / <kbd>Enter</kbd> |
| Flag a cell | Long-press (about 0.35 s, with a short buzz where supported) | Right click (<kbd>Ctrl</kbd>-click on a Mac) | <kbd>F</kbd> |
| Clear around a number | Tap a number whose flags are all placed | Click it, press left and right together, or middle click | <kbd>Space</kbd> on it |
| Move | | | Arrow keys (<kbd>Shift</kbd> moves 5), <kbd>Home</kbd> / <kbd>End</kbd> |
| Hint (local games) | *Hint*, beside *Flag mode* | *Hint*, beside the help line | <kbd>H</kbd> (the cursor jumps to the cell) |
| Details of a finished game | The chevron after the result | The chevron after the result | <kbd>D</kbd>, <kbd>Escape</kbd> closes |
| New game | The round button | The round button | <kbd>N</kbd> or <kbd>F2</kbd> |

- **Flag mode** (the button under the board on touch screens) swaps the two: a tap flags and a long-press opens.
  Numbers still clear around themselves on a tap.
- **Question marks** are off by default. Turn them on in Settings and a second right click or long-press marks
  a flag as `?`. Question marks don't protect a cell, and they don't count as flags.
- A number whose flags aren't all placed yet dips its covered neighbours for a moment instead of doing nothing.

## Rules and details

- **The first click is always safe.** Mines are laid after it, never in the cell you clicked or its eight
  neighbours, so the first click always opens an area. Zeros flood-fill outwards.
- **Difficulties:** Beginner 9 × 9 with 10 mines, Intermediate 16 × 16 with 40, Expert 30 × 16 with 99, and
  Custom (width and height 5 to 40, mines 1 to width × height − 9).
- **Screen fit:** cells are sized to fill the space you have. On a portrait phone Expert turns into
  16 × 30, which is the same game, since only adjacency matters. When a board can't fit at a usable cell size
  (20 px or more), the board pans inside its frame, but the page itself never scrolls sideways. A soft fade
  on each edge with more board beyond it shows which way there is more; the fades take no taps.
  Landscape phones put the controls in a column beside the board.
- **The clock** starts on the first reveal and pauses while the page is hidden (not in ranked games: the
  server's clock keeps running). **The mine counter** is mines
  minus flags, and it goes negative if you over-flag.
- **End of game:** a loss shows every mine, crosses out wrong flags and marks the mine that went off in red.
  A win flags every mine. Either way, one tap on the round button (or *Play again*) starts over.
- **Best times and stats** are kept in `localStorage` for each difficulty, and for each exact custom board:
  the top 10 times with dates, plus games played, won, win rate, and current and best streak. A new entry is
  highlighted after a win. Starting a new game partway through counts as a game played and ends the streak.
  A game in progress survives a reload. Classic and no-guess boards are kept apart (the scores sheet switches
  between them), and a win with a hint counts as played, not won (see below).
- The chosen difficulty, the custom size and the settings are remembered.

### No guessing, hints and the look back

- **No guessing** (Settings) deals boards that logic alone clears from the first click: whatever you have opened,
  as long as you only opened cells that were provably safe, there is always another one. The first click and its
  neighbours stay clear as usual. A small *No guessing* tag under the level says which kind of board is in play.
  The setting applies at once if the current game hasn't started, otherwise from the next game. It works for local
  and ranked games, and ranked no-guess wins have boards of their own.
- **"Logic" here** is exactly what the solver in `engine.js` can prove from the screen: the single-cell rule, the
  pair (and subset) rule, the mine total, and exact counting of every layout that fits the numbers. It never reads
  flags, which may be wrong. The hint, the look back and the generator all use it, so they agree.
- **Hint** (local games only) rings one cell that is safe for sure, the one nearest your cursor or last move. With
  none to give it says that this is a guess and rings the safest cell, with its chance of a mine. Before the first
  click it only says that the first click is safe, and the game isn't marked. In a ranked game the button is dimmed,
  and a tap on it says why. A game that used a hint shows a dot on the button and, if won, says *With a hint, so
  no best time*: it keeps no time, counts as played but not won, and ends the streak (the scores sheet counts these
  wins apart). A reload doesn't clear the mark.
- **After a loss** the result says whether the fatal click was **avoidable** (a provably safe cell existed when you
  made it: one is ringed on the final board, nearest the mine) or a **forced guess** (no cell was safe for sure).
  This is judged on the board as it was when you tapped, not as it was when the server answered. The chevron after
  the result (or <kbd>D</kbd>) shows the chance of a mine the cell you opened had, and the safest cell's.
- **After a win** the same chevron shows 3BV (the fewest clicks the board needs, without chording), 3BV per
  second, your clicks (opens, chords, and flags placed or taken off, wasted ones included) and efficiency (3BV over
  clicks, above 100% only with chording).

## Install it

The game is an installable web app: *Add to Home Screen* on iOS, *Install app* in Chrome and Edge. It opens
standalone (no browser bar), clear of the notch and the home indicator, without pull-to-refresh, bounce or
zoom, and it launches and plays offline (unranked, like any game without the server).

- **Icon:** the mine that went off, as the board shows it after a loss (`favicon.svg`, `icons/`, drawn from the
  page's own `#g-mine` glyph and colours by `npm run icons`). `manifest.webmanifest` is relative, so it works
  wherever the directory is served (`/minesweeper/` on eliasv.com).
- **Service worker (`sw.js`):** the app shell (page, styles, modules, icons, manifest) is precached in a cache
  named after `VERSION`, a hash of the shell (`npm run sw:version` stamps it; a unit test fails if it is stale),
  and served cache-first. Navigations in the scope get the game; offline, any other address in it goes to the
  game. The API (`api/`) is never intercepted or cached, and nothing but GET is. The web font is cached as it
  is first used. Activation deletes the older versions' caches.
- **Updates** download in the background and wait. With no game in progress they are applied at launch; later,
  a quiet download icon in the header ("update ready") appears between games only, and a tap reloads into the
  new version. A game in progress is never interrupted.
- nginx serves `index.html`, `sw.js` and the manifest with `Cache-Control: no-cache` (see
  `server/deploy/nginx-minesweeper-api.conf`), so a new version is seen on the next launch.

## Global board

Beginner, Intermediate and Expert games on eliasv.com are **ranked**: the game is played against a small server
that keeps the board. Custom games stay on the device.

The header's top right holds your **name and the server status** as one unit. The name is always there and
editable in place (tap it, type, Enter): a default `Player-XXXX` derived from the device's public id until you type
over it, saved in `localStorage` and synced under the device token, so every entry of this device is renamed.
Clearing the field goes back to the default. Next to it, a line icon: a spinner while a request has been out for a
moment, a muted green check when the server is connected or has verified a win, and a muted red cross when it is
offline, a name was refused, or the game is not ranked (custom board, too quick, no server). Hover or tap it for
the reason. A win shows the same verification in the result line: a spinner, then a check with the rank, or a
cross with the reason.

- **The server holds the mines.** It creates the game, lays the mines after the first click (keeping that click
  and its neighbours safe, like the local game) and answers each open or chord with just the cells it reveals.
  For a no-guess game it lays them with the same generator as the page; should that fail (it never has on the
  three levels in testing), the game says so and goes on, ranked as classic.
  The mine positions reach the browser only when the game is over. Flags stay in the browser; a chord sends
  the flags around the number it clears, and the server refuses a chord unless the number is open and exactly
  that many covered neighbours are flagged.
- **The server keeps the time**, from its answer to the first click to its answer to the last one, and records a
  win only when it has revealed every safe cell itself. Moves carry a sequence number: a repeated request gets the
  same answer, and nothing is accepted after the game ends, so a finished game can't be replayed or submitted twice.
- **Plausibility:** wins faster than a floor (1 s, 5 s, 20 s) or faster than 12 cleared 3BV per second are kept
  out of the board, as are games over an hour. No-guess boards are held to the same limits: they take the luck
  away, not the clicking. Requests are rate limited per IP (games started, moves, wins, name
  changes, reads), each IP can hold 8 live games, and games expire (15 min unstarted, 30 min idle, 3 h in all).
- **Players** are an anonymous random token kept on the device; the board shows a short public id derived from it
  so your own rows are highlighted. Names are 2 to 16 letters, numbers, spaces and `. _ ' -`; no links, a small
  word filter, and nobody can take a `Player-XXXX` default name. Entries without a name show the default name.
  The board lists each player's best time over the last 24 hours, 7 days or all time, for classic and no-guess
  boards apart.
- **Offline:** if the server can't be reached, the game is simply local and marked with the red cross. If it drops in the
  middle of a game, the browser lays out mines consistent with everything already shown and play goes on,
  unranked. Nothing is lost locally either way. A no-guess game that drops midway can no longer promise that
  (those mines only agree with the screen), so it says so and is filed as classic.
- Moves are small (`[0, i]` for an open) and queued, so taps never wait for each other: the cell looks pressed at
  once and fills in when the answer arrives, typically one round trip later.

What this can't stop, honestly: a program that plays the real game at human speed, or a person using a solver
alongside, looks the same as a good player. The solver is right there in `engine.js`; switching the hint off in
ranked games keeps honest players honest, nothing more. Starting many games and abandoning the bad boards is only slowed down
by the rate limits. Network latency counts towards the time (the server can't see the tap itself), and a ranked
clock doesn't pause when you leave the page.

### Server

```
server/src/rules.js       limits, expiry, plausibility floors, rate buckets
server/src/sessions.js    live games in memory: layout, moves, chords, timing, win check
server/src/store.js       SQLite (better-sqlite3): players and wins, ranked per day, week and all time
server/src/http.js        node:http routes, CORS for eliasv.com and eliasvagan.github.io, rate limits
server/admin.js           counts | purge-player <pid> | backup <dir> [days]
server/deploy/            deploy.sh + remote.sh, systemd units (API, nightly backup), nginx snippet
```

API (under `https://eliasv.com/minesweeper/api/`): `POST /games {d, t, v}`, `POST /games/:id/moves {t, s, m}`,
`POST /games/:id/state {t}`, `POST /player {t, n}`, `GET /scores?d=&p=day|week|all&v=&me=`, `GET /health`.

`v` is the variant: `classic`, or `ng` for no guessing. Left out it is classic, so older clients get exactly what
they had. `POST /games` answers with the `v` it created; a moves answer carries `v: "classic"` once, if a no-guess
game had to fall back; `state` answers with the current `v`; `scores` answers say which board they are (`v`), so a
page talking to a server from before variants (which ignores `v` and sends its classic board) shows no classic
times as no-guess ones. Scores carry a `variant` column (an older database
gains it on start, with every existing score classic), and each board and rank is per difficulty and variant.

On the droplet it runs as `minesweeper-api.service` (user `minesweeper`, 127.0.0.1:3890, 96 MB cap) with the
database in `/var/lib/minesweeper/scores.db` and nightly copies kept for 14 days in `/var/backups/minesweeper`.
nginx proxies `/minesweeper/api/` to it and returns 404 for `/minesweeper/server/`. Deploy (repeatable, with a
health check and rollback) from a checkout: `npm run deploy:api`. Maintenance there: `minesweeper-admin counts`.

## Development

```
minesweeper/engine.js    rules as a pure module: generation, safe first click, flood fill, chording, win/loss, the
                         solver (analyze) and no-guess boards (placeMinesNoGuess)
minesweeper/records.js   best times, stats, settings and the device's player token (localStorage)
minesweeper/online.js    the API client and the queued, retrying ranked game
minesweeper/names.js     player-name rules, shared by the page and the server
minesweeper/app.js       the page: drawing, input, sizing, edge fades, clock, panels
minesweeper/pwa.js       service worker registration and the between-games update
sw.js                    the service worker (precached shell, network-only API)
manifest.webmanifest     the installable app; favicon.svg and icons/ are its icons
scripts/                 icons.mjs (draws the icons with puppeteer), sw-version.mjs (stamps sw.js VERSION)
minesweeper/style.css
index.html               the game
minesweeper/index.html   the old address, which forwards to the root
server/                  the leaderboard API (see above)
test/                    unit tests (node:test; solver.test.mjs for the logic), a local end-to-end smoke test and a
                         live ranked one (puppeteer)
.githooks/               pre-commit: refuses a commit that doesn't raise the version of each package it changes
```

Every commit raises the `version` of each package it changes: `package.json` for the game, `server/package.json`
for the API (`npm version patch --no-git-tag-version` in that directory); Markdown files and the hooks themselves need
no bump. `.githooks/pre-commit` enforces it, and `.githooks/pre-push` runs the unit tests of the game and the server
(when its dependencies are installed) before a push, once a clone has run `git config core.hooksPath .githooks`.

```bash
(cd server && npm ci) && npm test                     # unit tests for the game and the server, Node 20+
PUPPETEER=/path/to/node_modules/puppeteer npm run e2e # desktop, iPhone touch (long-press), landscape, overflow, console errors
SHOTS=/tmp/shots PUPPETEER=… npm run e2e              # also save screenshots
npm run serve                                         # http://localhost:8080
PUPPETEER=… npm run e2e:pwa                           # installability, service worker, offline reload and play, update flow
PUPPETEER=… npm run icons                             # redraw favicon.svg and icons/*.png
npm run sw:version                                    # after changing any shell file: new VERSION for sw.js
PUPPETEER=… npm run e2e:live                          # wins a ranked game on eliasv.com, prints latency and pid
```

### The solver and the generator (for code building on them)

```js
import { analyze, placeMinesNoGuess, solvesByLogic, mulberry32 } from './minesweeper/engine.js';

analyze(game, { budget })        // → { safe, mines, probability, safest, exact, consistent }
placeMinesNoGuess(game, first, rng, limits)  // → { noGuess, layouts, repairs, work }; game.noGuess says the outcome
solvesByLogic(game, first)       // a laid board: does logic alone clear it from `first`?
```

- `analyze` reads `width`, `height`, `mines`, `view` and the numbers of open cells, never `mine` or flags, so it
  can be asked about any moment of a game (`{ ...game, view: earlier }`). It runs the cheap rules first, then
  counts the layouts of each independent group of cells next to numbers (cells that touch the same numbers are
  counted together), weighted by the ways the far cells can take the rest of the mines. `budget` (default 200 000
  steps) caps the counting; past it the certainties still hold but `exact` is false and probabilities are estimates.
  On Expert positions it takes 0.04 ms median and 12 ms at worst (7 800 positions measured; 6 ran over).
- `placeMinesNoGuess` lays a random board, plays it by logic, and where logic gets stuck moves a few mines among
  the cells it knows nothing about so that one number at the edge becomes decisive, then plays again from the
  start. Its limits count work, never time, so a seed and a first click give the same board everywhere (Node and
  Chrome agree, board for board). Over 1 000 seeds each, median / worst, in ms: Beginner 0.01 / 1.1, Intermediate
  0.05 / 1.0, Expert 0.23 / 11 in Node; in Chrome Expert 0.2 / 12, and 1.0 / 44 with the CPU slowed 4×. No
  fallbacks. Dense custom boards (30% of the cells and up) can be out of its reach: it gives up after its work cap
  (about 0.3 s in Node on a 40 × 40 board) and lays an ordinary board, and the page says so.

The live test plays against production and names its player `E2E test`; remove it afterwards on the droplet with
`minesweeper-admin purge-player <pid>`. For a local run, start the server with
`EXTRA_ORIGINS=http://127.0.0.1:8080 DB_PATH=/tmp/ms.db node server/src/index.js` and pass
`URL=http://127.0.0.1:8080/ API=http://127.0.0.1:3890`.

The end-to-end test starts its own static server. Puppeteer isn't a dependency, so point `PUPPETEER` at any
installed copy (or run `npm i --no-save puppeteer` first).
