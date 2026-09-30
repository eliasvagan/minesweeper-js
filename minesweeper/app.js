/**
 * The page: draws the game from engine.js, turns mouse, touch and keys into moves, keeps the clock, and files
 * results with records.js. No framework; one element per cell, updated only where a move changed something.
 */
import {
  DIFFICULTIES, CUSTOM_LIMITS, FLAG, OPEN, QUESTION, activate, canChord, chordTargets, completeLayout, createGame,
  deserialize, indexOf, maxMinesFor, minesLeft, neighbours, sanitizeCustom, serialize, toggleMark,
} from './engine.js';
import { checkName, NAME_MAX } from './names.js';
import { RANKED_LEVELS, RemoteGame, apiBase, createApi, newToken } from './online.js';
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

// Ranked play. `remote` is the server-side game this board mirrors; `mode` is what the level line says.
const base = apiBase();
const api = base ? createApi(base) : null;
let remote = null;
let mode = 'local'; // local (custom, or no server) | connecting | ranked | offline
let restoring = false;
const pendingCells = new Set();
let lastGlobal = null; // { d, ms } of the latest ranked win, to open the board on it

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
  restoring = false;
  settings = store.updateSettings({ difficulty: id });
  level = levelFor(id);
  bucket = bucketFor(level.id, level);
  game = createGame(level);
  store.setCurrent(null);
  connect();
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
  if (saved.remote) return resumeRemote(saved);
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
  drawMode();
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
  if (remote) {
    if (game.status === 'playing' && remote.id) {
      const marks = (v) => [...game.view.keys()].filter((i) => game.view[i] === v);
      store.setCurrent({ difficulty: level.id, remote: { id: remote.id, seq: remote.seq }, flags: marks(FLAG), questions: marks(QUESTION) });
    }
    return;
  }
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
  if (over() || i < 0 || restoring) return false;
  if (game.view[i] === FLAG) return false;
  if (remote) return remotePrimary(i);
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
  if (over() || i < 0 || restoring || pendingCells.has(i)) return false;
  if (!toggleMark(game, i, { questionMarks: settings.questionMarks })) return false;
  paint(i);
  refreshChordable(i);
  drawCounter();
  persist();
  return true;
}

function finish(answer = null) {
  clockStop();
  const won = game.status === 'won';
  // A ranked game's time is the server's: it started the clock at the first click it received.
  if (answer && Number.isFinite(answer.ms)) clockReset(answer.ms);
  const ms = elapsed();
  const { rank, stats } = store.record(bucket, { won, ms });
  store.setCurrent(null);
  lastRecord = won && rank ? { bucket, rank } : null;
  app.classList.add('is-over');
  board.classList.add('is-over', won ? 'is-won' : 'is-lost');

  // Ripple the reveal outwards from where the game ended.
  const o = displayOf(won ? lastMove : game.exploded[0] ?? lastMove);
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
    const global = answer ? rankedText(answer) : null;
    if (global) {
      text = global.text;
      box.classList.toggle('is-record', global.board);
    } else if (mode === 'offline') {
      text += ' · offline, not ranked';
    }
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
  if (won && answer && answer.ranked) afterRankedWin(answer);
}

function buzz(pattern) {
  if (settings.haptics && canVibrate) {
    try { navigator.vibrate(pattern); } catch { /* ignored: some browsers throw without a user gesture */ }
  }
}

function announce(text) {
  $('announce').textContent = text;
}

// ---------- ranked play ----------
// The page never knows where the mines are in a ranked game. It sends each open and chord to the server and
// draws the cells that come back; until then the cell stays pressed. If the server stops answering, the game
// carries on offline on a layout consistent with everything already shown, and is no longer ranked.

function deviceToken() {
  let { token } = store.player;
  if (!token) token = store.updatePlayer({ token: newToken() }).token;
  return token;
}

function connect() {
  dropRemote();
  mode = 'local';
  if (!api || !RANKED_LEVELS.has(level.id)) return;
  mode = 'connecting';
  const r = new RemoteGame(api, deviceToken(), level.id, {
    onAnswer: (answer, batch) => { if (remote === r) applyAnswer(answer, batch); },
    onLost: (error, unanswered) => { if (remote === r) goOffline(unanswered); },
  });
  remote = r;
  r.created.then(
    () => { if (remote === r && mode === 'connecting') { mode = 'ranked'; drawMode(); } },
    () => {
      // Nothing sent yet: simply play this one locally. (With moves waiting, the queue reports it instead.)
      if (remote === r && !r.pending) goOffline([]);
    },
  );
}

function dropRemote() {
  if (remote) remote.dead = true;
  remote = null;
  clearPending();
}

function drawMode() {
  const el = $('level-mode');
  const text = { ranked: 'ranked', connecting: 'ranked', offline: 'offline' }[mode] || '';
  el.textContent = text ? `· ${text}` : '';
  el.classList.toggle('is-offline', mode === 'offline');
  el.title = mode === 'offline' ? 'The leaderboard server could not be reached; this game is not ranked.' : mode === 'local' ? '' : 'Timed and checked by the server for the global board.';
}

function markPending(list) {
  for (const i of list) {
    pendingCells.add(i);
    cells[i]?.classList.add('is-pending');
  }
}
function clearPending(list = [...pendingCells]) {
  for (const i of list) {
    pendingCells.delete(i);
    cells[i]?.classList.remove('is-pending');
  }
}

function remotePrimary(i) {
  if (pendingCells.has(i)) return false;
  lastMove = i;
  if (game.view[i] === OPEN) {
    if (!canChord(game, i)) {
      if (game.adjacent[i]) hint(i);
      return false;
    }
    const flags = neighbours(game, i).filter((j) => game.view[j] === FLAG);
    markPending(chordTargets(game, i));
    remote.send([1, i, flags]);
    return true;
  }
  if (game.status === 'ready') {
    game.status = 'playing'; // optimistic: the clock starts on the tap, not on the answer
    clockStart();
  }
  markPending([i]);
  remote.send([0, i]);
  return true;
}

function applyAnswer(answer, batch) {
  const targets = batch.map((m) => m[1]);
  const opened = [];
  const o = Array.isArray(answer.o) ? answer.o : [];
  for (let k = 0; k + 1 < o.length; k += 2) {
    const i = o[k];
    const n = o[k + 1];
    if (!Number.isInteger(i) || i < 0 || i >= game.cells) continue;
    if (n < 0) {
      game.mine[i] = 1;
      game.view[i] = OPEN;
      opened.push(i);
      continue;
    }
    if (game.view[i] !== OPEN) {
      if (game.view[i] === FLAG) game.flags--;
      game.view[i] = OPEN;
      game.adjacent[i] = n;
      game.opened++;
      opened.push(i);
    }
  }
  // Ripple from the cell that was pressed, like the local flood fill.
  const depth = (i) => {
    const p = displayOf(i);
    return Math.min(...targets.map((t) => {
      const q = displayOf(t);
      return Math.max(Math.abs(p.c - q.c), Math.abs(p.r - q.r));
    }));
  };
  const chordCells = batch.filter((m) => m[0] === 1).flatMap((m) => neighbours(game, m[1]));
  clearPending([...targets, ...opened, ...chordCells]);
  if (answer.st === 'won' || answer.st === 'lost') {
    game.mine.fill(0);
    for (const i of answer.mines || []) if (i >= 0 && i < game.cells) game.mine[i] = 1;
    if (answer.st === 'lost') {
      game.exploded = (answer.x || []).filter((i) => game.mine[i]);
      game.status = 'lost';
    } else {
      game.status = 'won';
      for (let i = 0; i < game.cells; i++) if (game.mine[i]) game.view[i] = FLAG;
      game.flags = game.mines;
    }
    clearPending();
    remote = null;
    paintOpened(opened.map((i) => [i, depth(i)]));
    finish(answer);
  } else {
    paintOpened(opened.map((i) => [i, depth(i)]));
    persist();
  }
  drawCounter();
}

/** The server is gone (or refused the game): carry on locally, unranked, without losing a tap. */
function goOffline(unanswered) {
  dropRemote();
  mode = 'offline';
  drawMode();
  if (game.status === 'playing' && game.opened === 0) {
    game.status = 'ready'; // the first click never got an answer: lay mines locally around it instead
  } else if (game.status === 'playing' && !completeLayout(game)) {
    announce('Connection lost, and this board cannot continue offline.');
    $('result-title').textContent = 'Connection lost';
    $('result-detail').textContent = 'This board cannot continue offline.';
    $('dock-play').hidden = true;
    $('result').hidden = false;
    clockStop();
    game.status = 'lost';
    store.setCurrent(null);
    return;
  }
  announce('The leaderboard cannot be reached. This game continues offline and is not ranked.');
  persist();
  for (const [, i] of unanswered) primary(i);
}

/** A ranked game saved before a reload: ask the server what is open, then carry on. */
function resumeRemote(saved) {
  if (!api || !RANKED_LEVELS.has(saved.difficulty) || !store.player.token) return false;
  level = levelFor(saved.difficulty);
  bucket = bucketFor(level.id, level);
  game = createGame(level);
  mode = 'connecting';
  restoring = true;
  cursor = indexOf(game, Math.floor(game.width / 2), Math.floor(game.height / 2));
  start();
  const { id, seq } = saved.remote;
  api.state(id, store.player.token).then((state) => {
    if (!restoring || state.st !== 'playing') throw new Error('not resumable');
    game.status = 'playing';
    for (let k = 0; k + 1 < state.o.length; k += 2) {
      const i = state.o[k];
      game.view[i] = OPEN;
      game.adjacent[i] = state.o[k + 1];
      game.opened++;
    }
    for (const i of saved.flags || []) if (game.view[i] !== OPEN) { game.view[i] = FLAG; game.flags++; }
    for (const i of saved.questions || []) if (game.view[i] !== OPEN) game.view[i] = QUESTION;
    const r = RemoteGame.resume(api, store.player.token, level.id, id, state.s ?? seq, {
      onAnswer: (answer, batch) => { if (remote === r) applyAnswer(answer, batch); },
      onLost: (error, unanswered) => { if (remote === r) goOffline(unanswered); },
    });
    remote = r;
    mode = 'ranked';
    restoring = false;
    clockReset(state.ms || 0);
    clockStart();
    start();
  }).catch(() => {
    if (!restoring) return;
    // Expired or unreachable: this one cannot be finished. It counts as walked away from.
    store.record(bucket, { won: false });
    store.setCurrent(null);
    game = null;
    newGame(level.id);
  });
  return true;
}

function rankedText(answer) {
  if (!answer.ranked) {
    const why = { 'too-fast': 'Too quick to rank', rate: 'Not ranked: too many wins from this network lately' }[answer.why];
    return { text: why || 'Not ranked', board: false };
  }
  const { rank, top = 20 } = answer;
  if (!rank) return null;
  const parts = [];
  if (rank.day <= top) parts.push(`#${rank.day} in 24 h`);
  if (rank.all <= top) parts.push(`#${rank.all} all time`);
  if (!parts.length) parts.push(`#${rank.all} worldwide`);
  return { text: parts.join(' · '), board: rank.day <= top || rank.week <= top || rank.all <= top };
}

function afterRankedWin(answer) {
  lastGlobal = { d: level.id, ms: answer.ms };
  boardCache.clear();
  if (answer.pid) store.updatePlayer({ pid: answer.pid });
  const player = store.player;
  if (answer.named) return;
  if (player.name) {
    // Named on this device but not on the server yet (saved while offline, say): send it quietly.
    api.setName(player.token, player.name).catch(() => {});
    return;
  }
  const { rank, top = 20 } = answer;
  const makesBoard = rank && Math.min(rank.day, rank.week, rank.all) <= top;
  if (makesBoard && !player.asked) setTimeout(() => askName(answer), 900);
}

// ---------- name ----------

function askName(answer) {
  const { rank } = answer;
  const where = rank.all <= (answer.top || 20) ? `#${rank.all} of all time` : rank.week <= (answer.top || 20) ? `#${rank.week} this week` : `#${rank.day} in the last 24 hours`;
  $('name-lead').textContent = `${formatTime(answer.ms)} s is ${where} on ${level.label}. Add a name to show next to it.`;
  $('name-input').value = '';
  $('name-error').textContent = '';
  openSheet('dlg-name');
  setTimeout(() => $('name-input').focus(), 50);
}

async function saveName(raw, errorEl) {
  const { name, error } = checkName(raw);
  if (!name) {
    errorEl.textContent = error;
    return false;
  }
  store.updatePlayer({ name, asked: true });
  errorEl.textContent = '';
  if (!api) return true;
  try {
    const r = await api.setName(deviceToken(), name);
    store.updatePlayer({ name: r.name, pid: r.pid });
    boardCache.clear();
    return true;
  } catch (e) {
    if (e.status === 422) {
      store.updatePlayer({ name: undefined });
      errorEl.textContent = e.data?.message || 'Pick another name';
      return false;
    }
    return true; // offline: kept here, sent with the next ranked win
  }
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
  const global = api && RANKED_LEVELS.has(scoreTab);
  panel.textContent = '';
  if (global) {
    const chips = document.createElement('div');
    chips.className = 'scopes';
    chips.setAttribute('aria-label', 'Show');
    for (const [id, label] of [['day', '24 h'], ['week', '7 days'], ['all', 'All time'], ['device', 'This device']]) {
      const b = document.createElement('button');
      b.type = 'button';
      b.className = id === 'device' ? 'scope scope-device' : 'scope';
      b.dataset.scope = id;
      b.setAttribute('aria-pressed', String(scoreScope === id));
      b.textContent = label;
      chips.appendChild(b);
    }
    panel.appendChild(chips);
    if (scoreScope !== 'device') return renderGlobal(panel, scoreTab, scoreScope);
  }
  renderDevice(panel);
}

const boardCache = new Map(); // "difficulty:period" → { at, data }
let scoreScope = 'all';
let boardRequest = 0;

async function renderGlobal(panel, d, p) {
  const list = document.createElement('div');
  list.className = 'board-list';
  list.setAttribute('aria-live', 'polite');
  panel.appendChild(list);
  const key = `${d}:${p}`;
  const cached = boardCache.get(key);
  const request = ++boardRequest;
  let data = cached && Date.now() - cached.at < 15e3 ? cached.data : null;
  if (!data) {
    list.innerHTML = '<p class="loading">Loading the global board…</p>';
    try {
      data = await api.board(d, p, store.player.pid);
      boardCache.set(key, { at: Date.now(), data });
    } catch {
      if (request !== boardRequest) return;
      list.innerHTML = '<p class="empty">The global board cannot be reached right now. Switch to This device for your own times.</p>';
      return;
    }
  }
  if (request !== boardRequest) return; // the tab changed while this was loading
  list.textContent = '';
  if (!data.e.length) {
    list.innerHTML = `<p class="empty">No ranked wins ${p === 'day' ? 'in the last 24 hours' : p === 'week' ? 'this week' : 'yet'}. Win a ${DIFFICULTIES[d].label} game to be first.</p>`;
  } else {
    const ol = document.createElement('ol');
    ol.className = 'times global';
    ol.setAttribute('aria-label', `Global best times, ${DIFFICULTIES[d].label}`);
    for (const e of data.e) {
      const li = document.createElement('li');
      if (e.me) li.className = 'is-me';
      const rank = document.createElement('span');
      rank.className = 'rank';
      rank.textContent = e.r;
      const who = document.createElement('span');
      who.className = e.n ? 'who' : 'who anon';
      who.textContent = e.n || 'Anonymous';
      if (e.me) who.insertAdjacentHTML('beforeend', '<span class="new-tag">you</span>');
      const time = document.createElement('span');
      time.className = 'time';
      time.innerHTML = `${formatTime(e.ms)}<span class="sr-only"> seconds</span>`;
      li.append(rank, who, time);
      ol.appendChild(li);
    }
    list.appendChild(ol);
  }
  const mine = data.me;
  const shown = data.e.some((e) => e.me);
  const note = document.createElement('p');
  note.className = 'scores-note';
  note.textContent = mine && !shown
    ? `Your best: #${mine.r}, ${formatTime(mine.ms)} s. Each player's best time, timed by the server.`
    : "Each player's best time, timed by the server.";
  list.appendChild(note);
}

function renderDevice(panel) {
  const s = store.stats(scoreTab);
  const times = store.times(scoreTab);
  const stat = (label, value) => `<div><dt>${label}</dt><dd>${value}</dd></div>`;
  panel.insertAdjacentHTML('beforeend', `<dl class="stats">${[
    stat('Played', s.played), stat('Won', s.won), stat('Win rate', s.played ? `${Math.round(winRate(s) * 100)}%` : '–'),
    stat('Streak', s.streak), stat('Best streak', s.bestStreak),
  ].join('')}</dl>`);
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
$('score-panel').addEventListener('click', (e) => {
  const b = e.target.closest('.scope');
  if (!b) return;
  scoreScope = b.dataset.scope;
  renderScores();
  document.querySelector(`.scope[data-scope="${scoreScope}"]`)?.focus();
});
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
  // Straight after a win, show where it landed: the global board for a ranked one, this device otherwise.
  if (lastRecord && !lastGlobal) scoreScope = 'device';
  if (lastGlobal && lastGlobal.d === scoreTab && scoreScope === 'device') scoreScope = 'all';
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
// Name on the global board
if (api) $('name-setting').hidden = false;
$('settings-name-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const msg = $('settings-name-msg');
  msg.classList.remove('is-error');
  const ok = await saveName($('settings-name').value, msg);
  if (ok) {
    $('settings-name').value = store.player.name || '';
    msg.textContent = 'Saved.';
  } else msg.classList.add('is-error');
});
$('name-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const msg = $('name-error');
  msg.classList.remove('is-error');
  if (await saveName($('name-input').value, msg)) {
    $('dlg-name').close();
    if ($('dlg-scores').open) renderScores();
  } else msg.classList.add('is-error');
});
$('dlg-name').addEventListener('close', () => store.updatePlayer({ asked: true }));
for (const id of ['name-input', 'settings-name']) $(id).maxLength = NAME_MAX;

$('btn-settings').addEventListener('click', () => {
  $('settings-name').value = store.player.name || '';
  $('settings-name-msg').classList.remove('is-error');
  $('settings-name-msg').textContent = 'Shown next to your ranked times. Changing it renames them all.';
  $('btn-reset').textContent = 'Reset best times and stats';
  openSheet('dlg-settings');
});
$('board-help').textContent = touchCapable
  ? 'Tap to open, long-press to flag.'
  : 'Right click flags. Click a number to clear around it. Arrows, Space and F work too.';

// ---------- visibility ----------

document.addEventListener('visibilitychange', () => {
  if (!game || game.status !== 'playing') return;
  if (remote) { // the server's clock does not stop, so this one does not either
    if (document.visibilityState === 'hidden') persist();
    return;
  }
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
  get mode() { return mode; },
  get pending() { return pendingCells.size + (remote?.pending ? 1 : 0); },
  latency: () => (api ? [...api.latency] : []),
  get lastGlobal() { return lastGlobal; },
};
