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
  (20 px or more), the board pans inside its frame, but the page itself never scrolls sideways.
  Landscape phones put the controls in a column beside the board.
- **The clock** starts on the first reveal and pauses while the page is hidden. **The mine counter** is mines
  minus flags, and it goes negative if you over-flag.
- **End of game:** a loss shows every mine, crosses out wrong flags and marks the mine that went off in red.
  A win flags every mine. Either way, one tap on the round button (or *Play again*) starts over.
- **Best times and stats** are kept in `localStorage` for each difficulty, and for each exact custom board:
  the top 10 times with dates, plus games played, won, win rate, and current and best streak. A new entry is
  highlighted after a win. Starting a new game partway through counts as a game played and ends the streak.
  A game in progress survives a reload.
- The chosen difficulty, the custom size and the settings are remembered.

## Development

```
minesweeper/engine.js    rules as a pure module: generation, safe first click, flood fill, chording, win/loss
minesweeper/records.js   best times, stats and settings (localStorage, with a memory fallback)
minesweeper/app.js       the page: drawing, input, sizing, clock, panels
minesweeper/style.css
index.html               the game
minesweeper/index.html   the old address, which forwards to the root
test/                    unit tests (node:test) and an end-to-end smoke test (puppeteer)
```

```bash
npm test                                              # unit tests, Node 18+
PUPPETEER=/path/to/node_modules/puppeteer npm run e2e # desktop, iPhone touch (long-press), landscape, overflow, console errors
SHOTS=/tmp/shots PUPPETEER=… npm run e2e              # also save screenshots
npm run serve                                         # http://localhost:8080
```

The end-to-end test starts its own static server. Puppeteer isn't a dependency, so point `PUPPETEER` at any
installed copy (or run `npm i --no-save puppeteer` first).
