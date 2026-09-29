/**
 * The page: draws the game from engine.js, turns mouse, touch and keys into moves, keeps the clock, and files
 * results with records.js. No framework; one element per cell, updated only where a move changed something.
 */
import {
  DIFFICULTIES, CUSTOM_LIMITS, FLAG, OPEN, QUESTION, activate, canChord, chordTargets, createGame, deserialize,
  indexOf, maxMinesFor, minesLeft, sanitizeCustom, serialize, toggleMark,
} from './engine.js';
import { bucketFor, openStore, winRate } from './records.js';

const LONG_PRESS_MS = 350;
const MOVE_TOLERANCE = 10; // px a finger may drift before a press becomes a pan
const MIN_CELL = 20;
const MAX_CELL_FINE = 40;
const MAX_CELL_TOUCH = 52;

const $ = (id) => document.getElementById(id);
const app = $('app');
const board = $('board');
const area = $('board-area');
const store = openStore();
const touchCapable = matchMedia('(any-pointer: coarse)').matches || navigator.maxTouchPoints > 0;
const canVibrate = typeof navigator.vibrate === 'function';
const isMac = /Mac|iP(hone|ad|od)/.test(navigator.platform || navigator.userAgent);
const reducedMotion = matchMedia('(prefers-reduced-motion: reduce)');
if (touchCapable) document.documentElement.classList.add('touch');

let settings = store.settings;
let level; // { id, label, width, height, mines }
let bucket; // where this game's result is filed
let game;
let cells = []; // logical index → element
let layout = { transposed: false, cols: 0, rows: 0, cell: 0 };
let cursor = 0; // logical index of the keyboard cursor
let flagMode = false;
let lastRecord = null; // { bucket, rank } of the most recent win, for the scoreboard highlight
let lastMove = 0; // where the last opening happened: the win ripple starts there

// ---------- difficulty ----------

function levelFor(id) {
  if (id === 'custom') return { id, label: 'Custom', ...sanitizeCustom(settings.custom) };
  return DIFFICULTIES[id] || DIFFICULTIES.beginner;
}
const dims = (l) => `${l.width} × ${l.height} · ${l.mines}`;

// ---------- clock ----------
// Runs from the first reveal to the end, and pauses while the page is hidden (the board cannot be seen then).

const clock = { acc: 0, since: null, interval: 0 };
const elapsed = () => clock.acc + (clock.since === null ? 0 : performance.now() - clock.since);
function clockStart() {
  if (clock.since !== null) return;
  clock.since = performance.now();
  clearInterval(clock.interval);
  clock.interval = setInterval(drawClock, 250);
  drawClock();
}
function clockStop() {
  clock.acc = elapsed();
  clock.since = null;
  clearInterval(clock.interval);
  drawClock();
}
function clockReset(ms = 0) {
  clockStop();
  clock.acc = ms;
  drawClock();
}
const pad3 = (n) => (n < 0 ? `-${String(Math.min(99, -n)).padStart(2, '0')}` : String(Math.min(999, n)).padStart(3, '0'));
function drawClock() {
  $('timer').textContent = pad3(Math.floor(elapsed() / 1000));
}

function formatTime(ms) {
  const tenths = Math.floor(ms / 100);
  const s = Math.floor(tenths / 10);
  const t = tenths % 10;
  if (s < 60) return `${s}.${t}`;
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}.${t}`;
}
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const formatDate = (iso) => {
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? '' : `${d.getDate()} ${MONTHS[d.getMonth()]} ${d.getFullYear()}`;
};

// ---------- game lifecycle ----------

function newGame(id = settings.difficulty) {
  // Walking away from a started game counts as a game played and ends the streak, like the original.
  if (game && game.status === 'playing') store.record(bucket, { won: false });
  settings = store.updateSettings({ difficulty: id });
  level = levelFor(id);
  bucket = bucketFor(level.id, level);
  game = createGame(level);
  store.setCurrent(null);
  clockReset();
  lastRecord = null;
  cursor = indexOf(game, Math.floor(game.width / 2), Math.floor(game.height / 2));
  start();
  const icon = $('btn-restart');
  icon.classList.add('spin');
  requestAnimationFrame(() => requestAnimationFrame(() => icon.classList.remove('spin')));
}

/** Pick up a game saved by an earlier visit, if it is still in progress. */
function resume() {
  const saved = store.current;
  if (!saved || saved.difficulty !== settings.difficulty) return false;
  try {
    const restored = deserialize(saved.game);
    if (restored.status !== 'playing') return false;
    level = saved.difficulty === 'custom'
      ? { id: 'custom', label: 'Custom', width: restored.width, height: restored.height, mines: restored.mines }
      : levelFor(saved.difficulty);
    if (level.width !== restored.width || level.height !== restored.height) return false;
    bucket = bucketFor(level.id, level);
    game = restored;
    clockReset(Math.max(0, Number(saved.elapsed) || 0));
    cursor = indexOf(game, Math.floor(game.width / 2), Math.floor(game.height / 2));
    start();
    if (document.visibilityState === 'visible') clockStart();
    return true;
  } catch {
    store.setCurrent(null);
    return false;
  }
}

function start() {
  $('level-name').textContent = level.label;
  $('level-dims').textContent = dims(level);
  $('btn-level').setAttribute('aria-label', `Difficulty: ${level.label}, ${level.width} by ${level.height}, ${level.mines} mines. Change`);
  app.classList.remove('is-over');
  board.classList.remove('is-over', 'is-won', 'is-lost');
  $('result').hidden = true;
  $('dock-play').hidden = false;
  announce('');
  build();
  drawCounter();
}

function persist() {
  if (game.status === 'playing') {
    store.setCurrent({ difficulty: level.id, game: serialize(game), elapsed: Math.round(elapsed()) });
  } else if (store.current) {
    store.setCurrent(null);
  }
}

function drawCounter() {
  $('mines-left').textContent = pad3(minesLeft(game));
}

// ---------- moves ----------

const over = () => game.status === 'won' || game.status === 'lost';

/** Tap / left click: open a covered cell, or clear around a satisfied number. */
function primary(i) {
  if (over() || i < 0) return false;
  if (game.view[i] === FLAG) return false;
  const wasReady = game.status === 'ready';
  lastMove = i;
  const result = activate(game, i);
  if (!result.opened.length) {
    if (game.view[i] === OPEN && game.adjacent[i]) hint(i);
    return false;
  }
  if (wasReady) clockStart();
  paintOpened(result.opened);
  if (game.status === 'won' || game.status === 'lost') finish();
  else persist();
  drawCounter();
  return true;
}

/** Right click / long press: cycle the mark on a covered cell. */
function secondary(i) {
  if (over() || i < 0) return false;
  if (!toggleMark(game, i, { questionMarks: settings.questionMarks })) return false;
  paint(i);
  refreshChordable(i);
  drawCounter();
  persist();
  return true;
}

function finish() {
  clockStop();
  const won = game.status === 'won';
  const ms = elapsed();
  const { rank, stats } = store.record(bucket, { won, ms });
  store.setCurrent(null);
  lastRecord = won && rank ? { bucket, rank } : null;
  app.classList.add('is-over');
  board.classList.add('is-over', won ? 'is-won' : 'is-lost');

  // Ripple the reveal outwards from where the game ended.
  const o = displayOf(won ? lastMove : game.exploded[0]);
  for (let i = 0; i < game.cells; i++) {
    const p = displayOf(i);
    if (!cells[i].classList.contains('is-open')) cells[i]._static = false;
    const dist = Math.max(Math.abs(p.c - o.c), Math.abs(p.r - o.r));
    cells[i].style.setProperty('--d', `${Math.min(dist * 35, 700)}ms`);
    paint(i);
  }

  const title = $('result-title');
  const detail = $('result-detail');
  const box = $('result');
  box.classList.toggle('is-record', Boolean(rank));
  if (won) {
    title.textContent = `Cleared in ${formatTime(ms)} s`;
    const times = store.times(bucket);
    let text;
    if (rank === 1) text = times.length > 1 ? 'New best time' : 'Your first recorded time';
    else if (rank) text = `Number ${rank} on your best times`;
    else text = `Best ${formatTime(times[0].ms)} s`;
    if (stats.streak > 1) text += ` · ${stats.streak} wins in a row`;
    detail.textContent = text;
  } else {
    const safe = game.cells - game.mines;
    const pct = Math.floor((game.opened / safe) * 100);
    title.textContent = 'Mine hit';
    detail.textContent = `${pct}% cleared · ${formatTime(ms)} s`;
  }
  $('dock-play').hidden = true;
  box.hidden = false;
  announce(`${title.textContent}. ${detail.textContent}.`);
  if (!won) buzz([30, 60, 40]);
}

function buzz(pattern) {
  if (settings.haptics && canVibrate) {
    try { navigator.vibrate(pattern); } catch { /* ignored: some browsers throw without a user gesture */ }
  }
}

function announce(text) {
  $('announce').textContent = text;
}

// ---------- drawing ----------

const GLYPH_FLAG = '<svg aria-hidden="true"><use href="#g-flag"/></svg>';
const GLYPH_MINE = '<svg aria-hidden="true"><use href="#g-mine"/></svg>';
const GLYPH_WRONG = `${GLYPH_FLAG}<svg aria-hidden="true"><use href="#g-cross"/></svg>`;

function displayOf(i) {
  const x = i % game.width;
  const y = (i - x) / game.width;
  return layout.transposed ? { c: y, r: x } : { c: x, r: y };
}
function logicalOf(c, r) {
  return layout.transposed ? indexOf(game, r, c) : indexOf(game, c, r);
}

function paint(i) {
  const el = cells[i];
  const v = game.view[i];
  const lost = game.status === 'lost';
  let cls = 'cell';
  let html = '';
  let label;
  if (v === OPEN && game.mine[i]) {
    cls += ' is-open is-mine is-hit';
    html = GLYPH_MINE;
    label = 'mine, exploded';
  } else if (v === OPEN) {
    const n = game.adjacent[i];
    cls += n ? ` is-open n${n}` : ' is-open';
    if (n && canChord(game, i)) cls += ' can-chord';
    html = n ? String(n) : '';
    label = n ? `${n}` : 'empty';
  } else if (v === FLAG && lost && !game.mine[i]) {
    cls += ' is-flag is-wrong';
    html = GLYPH_WRONG;
    label = 'wrong flag';
  } else if (v === FLAG) {
    cls += ' is-flag';
    html = GLYPH_FLAG;
    label = 'flagged';
  } else if (lost && game.mine[i]) {
    cls += ' is-mine';
    html = GLYPH_MINE;
    label = 'mine';
  } else if (v === QUESTION) {
    cls += ' is-question';
    html = '?';
    label = 'question mark';
  } else {
    label = 'covered';
  }
  if (i === cursor) cls += ' is-cursor';
  if (el._static) cls += ' no-anim';
  if (el.className !== cls) el.className = cls;
  if (el._html !== html) {
    el.innerHTML = html;
    el._html = html;
  }
  const p = displayOf(i);
  const aria = `${label}, row ${p.r + 1}, column ${p.c + 1}`;
  if (el._aria !== aria) {
    el.setAttribute('aria-label', aria);
    el._aria = aria;
  }
}

function paintOpened(opened) {
  const animate = !reducedMotion.matches;
  const touched = new Set();
  for (const [i, depth] of opened) {
    cells[i]._static = false;
    cells[i].style.setProperty('--d', animate ? `${Math.min(depth * 16, 420)}ms` : '0ms');
    paint(i);
    touched.add(i);
  }
  // Numbers around the opened area may have become (un)chordable.
  for (const i of touched) refreshChordable(i);
}

function refreshChordable(i) {
  const x = i % game.width;
  const y = (i - x) / game.width;
  for (let dy = -1; dy <= 1; dy++) {
    for (let dx = -1; dx <= 1; dx++) {
      const nx = x + dx;
      const ny = y + dy;
      if (nx < 0 || ny < 0 || nx >= game.width || ny >= game.height) continue;
      const j = indexOf(game, nx, ny);
      if (game.view[j] === OPEN) paint(j);
    }
  }
}

function build() {
  measure();
  board.textContent = '';
  cells = new Array(game.cells);
  board.style.setProperty('--cols', layout.cols);
  board.setAttribute('aria-rowcount', layout.rows);
  board.setAttribute('aria-colcount', layout.cols);
  const frag = document.createDocumentFragment();
  for (let r = 0; r < layout.rows; r++) {
    const row = document.createElement('div');
    row.className = 'row';
    row.setAttribute('role', 'row');
    for (let c = 0; c < layout.cols; c++) {
      const i = logicalOf(c, r);
      const el = document.createElement('div');
      el.setAttribute('role', 'gridcell');
      el.id = `cell-${i}`;
      el.dataset.i = i;
      el.style.setProperty('--d', '0ms');
      el._static = true; // drawn as it already is: a restored game should not replay its openings
      cells[i] = el;
      row.appendChild(el);
    }
    frag.appendChild(row);
  }
  board.appendChild(frag);
  for (let i = 0; i < game.cells; i++) paint(i);
  board.setAttribute('aria-activedescendant', `cell-${cursor}`);
}

// ---------- sizing ----------
// The largest cell that fits the space left by the controls, between a usable minimum and a comfortable
// maximum. A board wider than the screen is tall (Expert on a portrait phone) is drawn transposed: 30 × 16
// becomes 16 × 30, which is the same game, since only adjacency matters.

const gapFor = (cell) => Math.max(2, Math.round(cell * 0.085));
const extent = (n, cell) => {
  const gap = gapFor(cell);
  return n * cell + (n - 1) * gap + 4 * gap;
};
function largestCell(cols, rows, w, h, max) {
  const fit = (n, room) => {
    for (let c = max; c > 1; c--) if (extent(n, c) <= room) return c;
    return 1;
  };
  const fitW = fit(cols, w);
  const fitH = fit(rows, h);
  // `raw` is what would fit with no minimum; it decides the orientation even when both need panning.
  const raw = Math.min(fitW, fitH);
  // When one direction has to pan anyway, size the cells by the other one: bigger targets, same amount of panning.
  const usable = [fitW, fitH].filter((f) => f >= MIN_CELL);
  const cell = raw >= MIN_CELL ? raw : usable.length ? Math.min(...usable) : MIN_CELL;
  return { cell, raw, fitW };
}

function available() {
  const vw = document.documentElement.clientWidth;
  const vh = window.visualViewport ? Math.min(window.innerHeight, window.visualViewport.height) : window.innerHeight;
  const cs = getComputedStyle(app);
  const padX = parseFloat(cs.paddingLeft) + parseFloat(cs.paddingRight);
  const padY = parseFloat(cs.paddingTop) + parseFloat(cs.paddingBottom);
  if (cs.display === 'grid') {
    // Landscape phone: the controls sit in a column to the left.
    const side = document.querySelector('.top').getBoundingClientRect().width;
    return { w: vw - padX - side - parseFloat(cs.columnGap || 0), h: vh - padY };
  }
  const gap = parseFloat(cs.rowGap || 10);
  const others = ['.top', '.status', '.dock'].reduce((s, sel) => s + document.querySelector(sel).offsetHeight, 0);
  // The board may use the page's side padding: the frame is its own margin.
  return { w: vw - Math.min(padX, 8), h: vh - padY - others - gap * 3 };
}

function measure() {
  const { w, h } = available();
  const max = touchCapable ? MAX_CELL_TOUCH : MAX_CELL_FINE;
  const straight = largestCell(game.width, game.height, w, h, max);
  let transposed = false;
  let pick = straight;
  if (game.width !== game.height) {
    const turned = largestCell(game.height, game.width, w, h, max);
    // Prefer the orientation with bigger cells; on a tie, the one that does not pan sideways.
    const better = turned.raw > straight.raw || (turned.raw === straight.raw && turned.fitW > straight.fitW);
    if (better) {
      transposed = true;
      pick = turned;
    }
  }
  const cols = transposed ? game.height : game.width;
  const rows = transposed ? game.width : game.height;
  const changed = transposed !== layout.transposed || cols !== layout.cols || rows !== layout.rows;
  layout = { transposed, cols, rows, cell: pick.cell };
  const gap = gapFor(pick.cell);
  const root = document.documentElement.style;
  root.setProperty('--cell', `${pick.cell}px`);
  root.setProperty('--gap', `${gap}px`);
  const boardWidth = extent(cols, pick.cell);
  root.setProperty('--col', `${Math.max(Math.min(boardWidth, w), 300)}px`);
  area.style.maxHeight = getComputedStyle(app).display === 'grid' ? '' : `${Math.max(h, pick.cell * 4)}px`;
  area.style.maxWidth = `${Math.floor(w)}px`;
  return changed;
}

let resizeQueued = false;
function onResize() {
  if (resizeQueued || !game) return;
  resizeQueued = true;
  requestAnimationFrame(() => {
    resizeQueued = false;
    const before = layout.transposed;
    measure();
    if (layout.transposed !== before) build();
  });
}
addEventListener('resize', onResize);
window.visualViewport?.addEventListener('resize', onResize);
addEventListener('orientationchange', onResize);

// ---------- pointer input ----------

const cellAt = (target) => {
  const el = target instanceof Element ? target.closest('.cell') : null;
  return el && board.contains(el) ? Number(el.dataset.i) : -1;
};

let pressed = [];
function setPressed(list) {
  for (const i of pressed) cells[i]?.classList.remove('is-pressed');
  pressed = list;
  for (const i of pressed) cells[i]?.classList.add('is-pressed');
}
function pressPreview(i, chording) {
  if (over() || i < 0) return setPressed([]);
  const v = game.view[i];
  if (v === OPEN) return setPressed(chordTargets(game, i));
  if (chording) return setPressed([i, ...chordTargets(game, i)]);
  return setPressed(v === FLAG ? [] : [i]);
}

/** A number tapped before its flags are all placed: its covered neighbours dip for a moment. */
function hint(i) {
  const targets = chordTargets(game, i);
  for (const j of targets) cells[j].classList.add('is-hint');
  setTimeout(() => targets.forEach((j) => cells[j]?.classList.remove('is-hint')), 160);
}

// Touch and pen: tap opens (or chords), a long press flags. Flag mode swaps the two.
let press = null;
let lastTouch = 0;

function endPress() {
  if (!press) return;
  clearTimeout(press.timer);
  press = null;
  setPressed([]);
}

board.addEventListener('pointerdown', (e) => {
  if (e.pointerType === 'mouse') return;
  lastTouch = Date.now();
  board.classList.remove('kbd');
  if (press) { // a second finger: this is a pinch or a pan, not a move
    endPress();
    return;
  }
  const i = cellAt(e.target);
  if (i < 0 || over()) return;
  press = {
    id: e.pointerId, i, x: e.clientX, y: e.clientY, fired: false,
    timer: setTimeout(() => {
      if (!press) return;
      press.fired = true;
      setPressed([]);
      const acted = flagMode ? primary(press.i) : longPressAction(press.i);
      if (acted) buzz(12);
    }, LONG_PRESS_MS),
  };
  pressPreview(i, false);
});
board.addEventListener('pointermove', (e) => {
  if (!press || e.pointerId !== press.id) return;
  if (Math.hypot(e.clientX - press.x, e.clientY - press.y) > MOVE_TOLERANCE) endPress();
});
board.addEventListener('pointerup', (e) => {
  if (!press || e.pointerId !== press.id) return;
  lastTouch = Date.now();
  const { i, fired } = press;
  endPress();
  if (fired) return;
  if (flagMode && game.view[i] !== OPEN) secondary(i);
  else primary(i);
});
board.addEventListener('pointercancel', endPress);

/** Long press on a covered cell flags it; on a number it chords, which is what a held finger there means. */
function longPressAction(i) {
  return game.view[i] === OPEN ? primary(i) : secondary(i);
}

// iOS still turns a quick second tap into a zoom and a held finger into a selection unless the touch's own
// default is cancelled at the end. Cancelling touchend does neither harm: scrolling is decided at touchstart.
board.addEventListener('touchend', (e) => { if (e.cancelable) e.preventDefault(); }, { passive: false });
board.addEventListener('contextmenu', (e) => e.preventDefault());
document.addEventListener('selectstart', (e) => { if (board.contains(e.target)) e.preventDefault(); });

// Mouse: left opens, right flags, left+right or middle chords, and so does a left click on a number.
const mouse = { chording: false, swallow: false };

board.addEventListener('mousedown', (e) => {
  if (Date.now() - lastTouch < 800) return; // compatibility events after a touch
  e.preventDefault(); // no text selection, no middle-click autoscroll
  board.focus({ preventScroll: true });
  board.classList.remove('kbd');
  const i = cellAt(e.target);
  const both = (e.buttons & 3) === 3;
  if (e.button === 1 || both) {
    mouse.chording = true;
    pressPreview(i, true);
    return;
  }
  if (e.button === 2 || (e.button === 0 && e.ctrlKey && isMac)) {
    secondary(i);
    return;
  }
  if (e.button === 0) pressPreview(i, false);
});
board.addEventListener('mouseover', (e) => {
  if (Date.now() - lastTouch < 800) return;
  if (mouse.chording) pressPreview(cellAt(e.target), true);
  else if (e.buttons & 1 && !mouse.swallow) pressPreview(cellAt(e.target), false);
});
board.addEventListener('mouseleave', () => setPressed([]));
addEventListener('mouseup', (e) => {
  if (Date.now() - lastTouch < 800) return;
  const i = board.contains(e.target) ? cellAt(e.target) : -1;
  setPressed([]);
  if (mouse.chording) {
    mouse.chording = false;
    mouse.swallow = e.buttons !== 0; // the other button's release must not open anything
    if (i >= 0 && game.view[i] === OPEN) primary(i);
    return;
  }
  if (mouse.swallow) {
    mouse.swallow = e.buttons !== 0;
    return;
  }
  if (e.button === 0 && !(e.ctrlKey && isMac)) primary(i);
});

// ---------- keyboard ----------

function moveCursor(dc, dr, absolute) {
  const p = displayOf(cursor);
  let c = absolute ? dc : p.c + dc;
  let r = absolute ? dr : p.r + dr;
  c = Math.max(0, Math.min(layout.cols - 1, c));
  r = Math.max(0, Math.min(layout.rows - 1, r));
  const prev = cursor;
  cursor = logicalOf(c, r);
  paint(prev);
  paint(cursor);
  board.setAttribute('aria-activedescendant', `cell-${cursor}`);
  cells[cursor].scrollIntoView({ block: 'nearest', inline: 'nearest' });
}

board.addEventListener('keydown', (e) => {
  if (e.altKey || e.metaKey || e.ctrlKey) return;
  const p = displayOf(cursor);
  const step = e.shiftKey ? 5 : 1;
  const keys = {
    ArrowLeft: () => moveCursor(-step, 0), ArrowRight: () => moveCursor(step, 0),
    ArrowUp: () => moveCursor(0, -step), ArrowDown: () => moveCursor(0, step),
    Home: () => moveCursor(0, p.r, true), End: () => moveCursor(layout.cols - 1, p.r, true),
    ' ': () => (over() ? newGame(level.id) : primary(cursor)),
    Enter: () => (over() ? newGame(level.id) : primary(cursor)),
    f: () => (game.view[cursor] === OPEN ? primary(cursor) : secondary(cursor)),
  };
  const run = keys[e.key.length === 1 ? e.key.toLowerCase() : e.key];
  if (!run) return;
  e.preventDefault();
  board.classList.add('kbd');
  run();
});
board.addEventListener('focus', () => paint(cursor));

document.addEventListener('keydown', (e) => {
  if (e.altKey || e.metaKey || e.ctrlKey || document.querySelector('dialog[open]')) return;
  if (e.target instanceof HTMLInputElement) return;
  if (e.key === 'F2' || e.key === 'n' || e.key === 'N') {
    e.preventDefault();
    newGame(level.id);
  }
});

// ---------- controls ----------

$('btn-restart').addEventListener('click', () => newGame(level.id));
$('btn-again').addEventListener('click', () => newGame(level.id));
$('btn-flag-mode').addEventListener('click', () => {
  flagMode = !flagMode;
  $('btn-flag-mode').setAttribute('aria-pressed', String(flagMode));
  board.classList.toggle('is-flagging', flagMode);
});

// Sheets: <dialog> gives focus trapping, Escape and a backdrop; a click on the backdrop closes too.
for (const dialog of document.querySelectorAll('dialog')) {
  dialog.addEventListener('click', (e) => {
    if (e.target === dialog || e.target.closest('[data-close]')) dialog.close();
  });
  dialog.addEventListener('close', () => board.focus({ preventScroll: true }));
}
function openSheet(id) {
  const d = $(id);
  if (!d.open) d.showModal();
}

// Difficulty
function renderLevels() {
  const host = $('levels');
  host.textContent = '';
  const options = [...Object.values(DIFFICULTIES), { id: 'custom', label: 'Custom', ...sanitizeCustom(settings.custom) }];
  for (const l of options) {
    const b = document.createElement('button');
    b.type = 'button';
    b.className = 'level-option';
    if (l.id === level.id) b.setAttribute('aria-current', 'true');
    if (l.id === 'custom') b.setAttribute('aria-expanded', String(level.id === 'custom'));
    b.dataset.level = l.id;
    const best = store.times(bucketFor(l.id, l))[0];
    b.innerHTML = `<svg class="icon icon-sm" aria-hidden="true"><use href="#i-check"/></svg>
      <span><span class="level-option-name"></span><span class="level-option-dims"></span></span>
      <span class="level-option-best"></span>`;
    b.querySelector('.level-option-name').textContent = l.label;
    b.querySelector('.level-option-dims').textContent = `${l.width} × ${l.height} · ${l.mines} mines`;
    b.querySelector('.level-option-best').textContent = best ? `best ${formatTime(best.ms)}` : '';
    host.appendChild(b);
  }
  fillCustom(settings.custom);
  $('custom-form').hidden = level.id !== 'custom';
}
function fillCustom(values) {
  const c = sanitizeCustom(values);
  $('custom-width').value = c.width;
  $('custom-height').value = c.height;
  $('custom-mines').value = c.mines;
  updateCustomHints();
}
function updateCustomHints() {
  const w = sanitizeCustom({ width: $('custom-width').value, height: 5, mines: 1 }).width;
  const h = sanitizeCustom({ width: 5, height: $('custom-height').value, mines: 1 }).height;
  for (const [id, min, max] of [['width', CUSTOM_LIMITS.minSize, CUSTOM_LIMITS.maxWidth], ['height', CUSTOM_LIMITS.minSize, CUSTOM_LIMITS.maxHeight], ['mines', CUSTOM_LIMITS.minMines, maxMinesFor(w, h)]]) {
    const input = $(`custom-${id}`);
    input.min = min;
    input.max = max;
    $(`custom-${id}-hint`).textContent = `${min}–${max}`;
  }
}
$('levels').addEventListener('click', (e) => {
  const b = e.target.closest('.level-option');
  if (!b) return;
  if (b.dataset.level === 'custom') {
    const form = $('custom-form');
    form.hidden = false;
    b.setAttribute('aria-expanded', 'true');
    $('custom-width').focus();
    return;
  }
  $('dlg-level').close();
  newGame(b.dataset.level);
});
$('custom-form').addEventListener('input', updateCustomHints);
$('custom-form').addEventListener('submit', (e) => {
  e.preventDefault();
  const custom = sanitizeCustom({ width: $('custom-width').value, height: $('custom-height').value, mines: $('custom-mines').value });
  settings = store.updateSettings({ custom });
  $('dlg-level').close();
  newGame('custom');
});
$('btn-level').addEventListener('click', () => {
  renderLevels();
  openSheet('dlg-level');
});

// Best times and stats
let scoreTab = null;
function scoreTabs() {
  const tabs = Object.values(DIFFICULTIES).map((d) => ({ bucket: d.id, label: d.label, title: d.label }));
  const customs = new Set(store.customBuckets());
  if (level.id === 'custom') customs.add(bucket);
  for (const b of customs) {
    const [w, h, m] = b.slice(7).split('x');
    tabs.push({ bucket: b, label: `${w}×${h}·${m}`, title: `Custom ${w} × ${h}, ${m} mines` });
  }
  return tabs;
}
function renderScores() {
  const tabs = scoreTabs();
  if (!tabs.some((t) => t.bucket === scoreTab)) scoreTab = bucket;
  const host = $('score-tabs');
  host.textContent = '';
  for (const t of tabs) {
    const b = document.createElement('button');
    b.type = 'button';
    b.className = 'tab';
    b.setAttribute('role', 'tab');
    b.id = `tab-${t.bucket}`;
    b.setAttribute('aria-selected', String(t.bucket === scoreTab));
    b.tabIndex = t.bucket === scoreTab ? 0 : -1;
    b.title = t.title;
    b.textContent = t.label;
    b.dataset.bucket = t.bucket;
    host.appendChild(b);
  }
  const panel = $('score-panel');
  panel.setAttribute('aria-labelledby', `tab-${scoreTab}`);
  const s = store.stats(scoreTab);
  const times = store.times(scoreTab);
  const stat = (label, value) => `<div><dt>${label}</dt><dd>${value}</dd></div>`;
  panel.innerHTML = `<dl class="stats">${[
    stat('Played', s.played), stat('Won', s.won), stat('Win rate', s.played ? `${Math.round(winRate(s) * 100)}%` : '–'),
    stat('Streak', s.streak), stat('Best streak', s.bestStreak),
  ].join('')}</dl>`;
  if (!times.length) {
    panel.insertAdjacentHTML('beforeend', '<p class="empty">No wins at this level yet.</p>');
  } else {
    const ol = document.createElement('ol');
    ol.className = 'times';
    ol.setAttribute('aria-label', 'Best times');
    times.forEach((t, k) => {
      const li = document.createElement('li');
      const isNew = lastRecord && lastRecord.bucket === scoreTab && lastRecord.rank === k + 1;
      if (isNew) li.className = 'is-new';
      li.innerHTML = `<span class="rank">${k + 1}</span><span class="time">${formatTime(t.ms)}<span class="sr-only"> seconds</span>${isNew ? '<span class="new-tag">new</span>' : ''}</span><span class="date">${formatDate(t.date)}</span>`;
      ol.appendChild(li);
    });
    panel.appendChild(ol);
  }
  panel.insertAdjacentHTML('beforeend', '<p class="scores-note">Times in seconds. Kept in this browser only.</p>');
}
$('score-tabs').addEventListener('click', (e) => {
  const b = e.target.closest('.tab');
  if (!b) return;
  scoreTab = b.dataset.bucket;
  renderScores();
  $(`tab-${scoreTab}`).focus();
});
$('score-tabs').addEventListener('keydown', (e) => {
  if (e.key !== 'ArrowLeft' && e.key !== 'ArrowRight') return;
  const tabs = scoreTabs();
  const at = tabs.findIndex((t) => t.bucket === scoreTab);
  scoreTab = tabs[(at + (e.key === 'ArrowRight' ? 1 : tabs.length - 1)) % tabs.length].bucket;
  renderScores();
  $(`tab-${scoreTab}`).focus();
});
function showScores() {
  scoreTab = bucket;
  renderScores();
  openSheet('dlg-scores');
  const fresh = document.querySelector('.times .is-new');
  if (fresh) fresh.scrollIntoView({ block: 'nearest' });
}
$('btn-scores').addEventListener('click', showScores);
$('result').addEventListener('click', (e) => {
  if (e.target.closest('.result-text') && game.status === 'won') showScores();
});

// Settings
const qm = $('set-question');
const hp = $('set-haptics');
qm.checked = settings.questionMarks;
hp.checked = settings.haptics && canVibrate;
hp.disabled = !canVibrate;
if (!canVibrate) $('haptics-note').textContent = 'This browser cannot vibrate.';
qm.addEventListener('change', () => { settings = store.updateSettings({ questionMarks: qm.checked }); });
hp.addEventListener('change', () => {
  settings = store.updateSettings({ haptics: hp.checked });
  if (hp.checked) buzz(12);
});
let resetArmed = 0;
$('btn-reset').addEventListener('click', () => {
  const b = $('btn-reset');
  if (!resetArmed) {
    b.textContent = 'Tap again to erase every time and stat';
    b.classList.add('is-armed');
    resetArmed = setTimeout(() => {
      resetArmed = 0;
      b.textContent = 'Reset best times and stats';
      b.classList.remove('is-armed');
    }, 4000);
    return;
  }
  clearTimeout(resetArmed);
  resetArmed = 0;
  store.resetRecords();
  lastRecord = null;
  b.textContent = 'Best times and stats erased';
  b.classList.remove('is-armed');
});
$('btn-settings').addEventListener('click', () => {
  $('btn-reset').textContent = 'Reset best times and stats';
  openSheet('dlg-settings');
});
$('board-help').textContent = touchCapable
  ? 'Tap to open, long-press to flag.'
  : 'Right click flags. Click a number to clear around it. Arrows, Space and F work too.';

// ---------- visibility ----------

document.addEventListener('visibilitychange', () => {
  if (!game || game.status !== 'playing') return;
  if (document.visibilityState === 'hidden') {
    clockStop();
    persist();
  } else {
    clockStart();
  }
});
addEventListener('pagehide', () => { if (game && game.status === 'playing') persist(); });

// ---------- boot ----------

if (!resume()) {
  level = levelFor(settings.difficulty);
  newGame(level.id);
}
// Web fonts change the controls' height a touch; size the board again once they are in.
document.fonts?.ready.then(onResize);

// For the end-to-end test: a read-only peek, nothing that changes the game.
window.__minesweeper = {
  get state() {
    return { status: game.status, width: game.width, height: game.height, mines: game.mines, flags: game.flags, opened: game.opened, layout: { ...layout }, level: level.id };
  },
  mineIndices: () => [...game.mine].flatMap((m, i) => (m ? [i] : [])),
};
