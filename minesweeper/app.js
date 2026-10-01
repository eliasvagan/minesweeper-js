/**
 * The page: draws the game from engine.js, turns mouse, touch and keys into moves, keeps the clock, and files
 * results with records.js. No framework; one element per cell, updated only where a move changed something.
 *
 * Ranked levels are played through the leaderboard server (online.js): the page never holds the real mines there,
 * only what the server's answers have opened, and it carries on locally if the server drops. Also here: the
 * player's name in the header (rules in names.js), the level, scores and settings sheets, and the update hint
 * (pwa.js). `window.__minesweeper` at the end is the end-to-end tests' read-only view of the game.
 */
import {
  DIFFICULTIES, CUSTOM_LIMITS, FLAG, OPEN, QUESTION, activate, canChord, chordTargets, completeLayout, createGame,
  deserialize, indexOf, maxMinesFor, minesLeft, neighbours, sanitizeCustom, serialize, toggleMark,
} from './engine.js';
import { NAME_MAX, checkName, defaultName } from './names.js';
import { RANKED_LEVELS, RemoteGame, apiBase, createApi, newToken, publicIdOf } from './online.js';
import { bucketFor, openStore, winRate } from './records.js';
import { initPwa } from './pwa.js';

const LONG_PRESS_MS = 350;
const MOVE_TOLERANCE = 10; // px a finger may drift before a press becomes a pan
// Cell sizes in px: below MIN_CELL the board pans instead of shrinking; the maximum depends on the pointer.
const MIN_CELL = 20;
const MAX_CELL_FINE = 40;
const MAX_CELL_TOUCH = 52;

const $ = (id) => document.getElementById(id);
const app = $('app');
const board = $('board');
const area = $('board-area');
const frame = $('board-frame');
const store = openStore();
// Any touch screen, even beside a mouse: it brings the flag-mode button (.touch in the CSS), the touch help and
// the bigger maximum cell.
const touchCapable = matchMedia('(any-pointer: coarse)').matches || navigator.maxTouchPoints > 0;
const canVibrate = typeof navigator.vibrate === 'function';
const isMac = /Mac|iP(hone|ad|od)/.test(navigator.platform || navigator.userAgent); // where ctrl+click is a right click
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
let restoring = false; // a ranked game saved before a reload is being asked back from the server: no moves yet
const pendingCells = new Set(); // sent to the server, not answered yet: drawn pressed, and no taps or marks on them
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
// Three characters, like the original's counters: 000 to 999, and -01 to -99 when there are more flags than mines.
const pad3 = (n) => (n < 0 ? `-${String(Math.min(99, -n)).padStart(2, '0')}` : String(Math.min(999, n)).padStart(3, '0'));
function drawClock() {
  $('timer').textContent = pad3(Math.floor(elapsed() / 1000));
}

/** Seconds to the tenth, truncated: "9.4", and "1:02.5" from a minute up. */
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
  // One turn of the restart icon: .spin snaps it to -360° with no transition, and two frames later (once that has
  // been drawn) the class comes off and it eases back to 0.
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
  drawNet();
  $('btn-level').setAttribute('aria-label', `Difficulty: ${level.label}, ${level.width} by ${level.height}, ${level.mines} mines. Change`);
  app.classList.remove('is-over');
  board.classList.remove('is-over', 'is-won', 'is-lost');
  $('result').hidden = true;
  $('dock-play').hidden = false;
  announce('');
  build();
  drawCounter();
  pwa?.refresh();
}

/**
 * Save the game in progress so a reload can pick it up. A ranked game is only its server id, batch number and the
 * player's marks (resumeRemote asks the server for the rest); a local one is the whole game and its clock.
 */
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
  pwa?.refresh();

  // Ripple the reveal outwards from where the game ended.
  const o = displayOf(won ? lastMove : game.exploded[0] ?? lastMove);
  for (let i = 0; i < game.cells; i++) {
    const p = displayOf(i);
    // Mines and flags animate in, even on a restored board; what was already open stays still.
    if (!cells[i].classList.contains('is-open')) cells[i]._static = false;
    // 35 ms per ring of cells (Chebyshev distance) from there, at most 700 ms.
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
    if (answer && answer.ranked) {
      verifyWin(answer);
    } else {
      const why = answer ? unrankedReason(answer) : localReason();
      setVerify('bad', why);
      detail.textContent = `${why} · ${text}`;
      note('bad', `This win is not ranked: ${why.toLowerCase()}.`);
    }
  } else {
    setVerify(null);
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
  drawNet();
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
  netNote = null;
  if (!api || !RANKED_LEVELS.has(level.id)) return drawNet();
  mode = 'connecting';
  drawNet();
  // Every callback checks `remote === r`, so a game already replaced (a restart, another level) is ignored.
  const r = new RemoteGame(api, deviceToken(), level.id, {
    onAnswer: (answer, batch) => { if (remote === r) applyAnswer(answer, batch); },
    onLost: (error, unanswered) => { if (remote === r) goOffline(unanswered); },
  });
  remote = r;
  r.created.then(
    () => {
      if (remote === r && mode === 'connecting') { mode = 'ranked'; drawNet(); }
      syncName();
    },
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

// ---------- backend status: the icon next to the name, and the one on a win ----------
// busy (a request has been out for a moment), ok (connected, or the win was verified) and bad (offline, refused,
// or not ranked). A short-lived note (a saved name, a verified win) wins over the steady state until it expires.

const ICON = { busy: '#i-spinner', ok: '#i-check', bad: '#i-close' };
let netNote = null; // { state, text, until }
let netBusy = false;
let busyTimer = 0;
let noteTimer = 0;

function note(state, text, ms = 0) {
  netNote = { state, text, until: ms ? Date.now() + ms : Infinity };
  clearTimeout(noteTimer);
  if (ms) noteTimer = setTimeout(drawNet, ms + 20); // redraw just after it has expired
  drawNet();
}

function netState() {
  if (netBusy) return { state: 'busy', text: 'Talking to the leaderboard server…' };
  if (netNote && netNote.until > Date.now()) return netNote;
  if (!api) return { state: 'bad', text: 'No leaderboard server for this copy. Games are kept on this device.' };
  if (!RANKED_LEVELS.has(level.id)) return { state: 'bad', text: 'Custom boards are not ranked. They are kept on this device.' };
  if (mode === 'offline') return { state: 'bad', text: 'The leaderboard server cannot be reached. This game continues offline and is not ranked.' };
  if (mode === 'connecting') return { state: 'busy', text: 'Connecting to the leaderboard server…' };
  return { state: 'ok', text: 'Connected. This game is timed and verified by the server.' };
}

function drawNet() {
  const { state, text } = netState();
  const el = $('net');
  if (el.dataset.state !== state) {
    el.dataset.state = state;
    el.querySelector('use').setAttribute('href', ICON[state]);
  }
  el.setAttribute('aria-label', `Leaderboard: ${text}`);
  el.title = text;
  $('net-tip').textContent = text;
}

if (api) {
  // Only a request that takes a moment shows the spinner, so quick moves never make the icon flicker.
  api.watch((n) => {
    clearTimeout(busyTimer);
    if (n > 0 && !netBusy) {
      busyTimer = setTimeout(() => { netBusy = true; drawNet(); }, 180);
    } else if (n === 0 && netBusy) {
      netBusy = false;
      drawNet();
    }
  });
}

// On a phone there is no hover: a tap shows the explanation for a moment.
$('net').addEventListener('click', () => {
  const tip = $('net-tip');
  tip.classList.add('is-shown');
  clearTimeout(tip._t);
  tip._t = setTimeout(() => tip.classList.remove('is-shown'), 3200);
});

function setVerify(state, label = '') {
  const el = $('result-verify');
  el.hidden = !state;
  if (!state) return;
  el.dataset.state = state;
  el.querySelector('use').setAttribute('href', ICON[state]);
  el.setAttribute('role', 'img');
  el.setAttribute('aria-label', label);
  el.title = label;
}

function localReason() {
  if (!RANKED_LEVELS.has(level.id)) return 'Custom boards aren’t ranked';
  if (!api) return 'Not ranked here';
  return 'Offline, not ranked';
}

function unrankedReason(answer) {
  return {
    'too-fast': 'Too quick to verify as human',
    'too-slow': 'Over an hour, not ranked',
    rate: 'Too many wins from this network',
  }[answer.why] || 'Not ranked';
}

/**
 * A ranked win: the move answer already says it counted. Show a short "verifying" step while the all-time board is
 * fetched into the cache for the scores sheet, then the check and the rank (whether or not that fetch worked).
 */
function verifyWin(answer) {
  const detail = $('result-detail');
  const d = level.id;
  const settled = rankedText(answer) || { text: 'Verified', board: false };
  setVerify('busy', 'Verifying with the server');
  detail.textContent = 'Verifying with the server…';
  const shown = new Promise((r) => setTimeout(r, 350)); // long enough to read as a step, not a flicker
  const check = api.board(d, 'all', store.player.pid).then((data) => {
    boardCache.set(`${d}:all`, { at: Date.now(), data });
    return true;
  }, () => false);
  Promise.all([check, shown]).then(() => {
    if (level.id !== d || !$('result-verify').dataset.state) return;
    setVerify('ok', 'Verified by the server');
    detail.textContent = `Verified · ${settled.text}`;
    $('result').classList.toggle('is-record', settled.board);
    announce(`Verified by the server. ${settled.text}.`);
  });
  note('ok', `Win verified by the server: ${settled.text}.`);
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

/**
 * A tap in a ranked game: the move is queued for the server and its cells stay pressed until the answer. Moves are
 * `[0, i]` to open i and `[1, i, flags]` to chord it, with the flags around it, which the server checks.
 */
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

/**
 * Draw the server's answer to a batch of moves. `o` is flat pairs `[cell, number, …]`, -1 for a mine; once the game
 * is over the answer also has `mines` (every one) and, on a loss, `x` (the ones that went off).
 */
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
      // The server keeps no flags, so its flood fill may open a cell flagged here; the flag was wrong, and goes.
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
  drawNet();
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
  // Replay the moves the server never answered, on the local board now: an open and a chord both come down to
  // a primary press on their cell.
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
    // The server's batch number wins over the saved one: an answer may have been on its way when the page went.
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

/**
 * The rank line of a win: its place in the last 24 h and of all time where that is on the board (the top `top`),
 * else its place worldwide. `board` says whether it shows on any of the boards. Null when the answer has no rank.
 */
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
  syncName();
}

// ---------- name ----------
// Always in the header: the device's default (Player-XXXX, from its public id) until it is typed over. Saved
// here at once, and sent to the server under the device token, which renames every entry of this device.

const playerInput = $('player-name');
playerInput.maxLength = NAME_MAX;

const myDefault = () => defaultName(store.player.pid);
const myName = () => store.player.name || myDefault();

function drawName() {
  if (document.activeElement !== playerInput) playerInput.value = myName();
  fitName();
  playerInput.classList.toggle('is-default', !store.player.name);
}

/** Give this device a token and work out its public id here, so the default name shows before the server answers. */
async function ensureIdentity() {
  const token = deviceToken();
  if (!store.player.pid) {
    const pid = await publicIdOf(token);
    if (pid) store.updatePlayer({ pid });
  }
  drawName();
}

function commitName() {
  const raw = playerInput.value.replace(/\s+/g, ' ').trim();
  const previous = store.player.name || null;
  let name = null;
  if (raw && raw.toLowerCase() !== myDefault().toLowerCase()) {
    const checked = checkName(raw);
    if (!checked.name) {
      playerInput.value = myName();
      drawName();
      note('bad', `Name not saved: ${checked.error}.`, 5000);
      showTip();
      return;
    }
    name = checked.name;
  }
  if (name === previous) return drawName();
  store.updatePlayer({ name: name || undefined });
  drawName();
  syncName();
}

/** Send the name if the server has not got this one yet. Quiet unless something is wrong. */
async function syncName() {
  if (!api) return;
  const wanted = store.player.name || '';
  // Never named: the server already shows the default, so there is nothing to send.
  if (store.player.synced === wanted || (!wanted && store.player.synced === undefined)) return;
  try {
    const r = await api.setName(deviceToken(), wanted);
    store.updatePlayer({ synced: wanted, pid: r.pid });
    boardCache.clear();
    note('ok', wanted ? `Saved. Your entries on the global board now show ${r.name}.` : `Saved. Your entries show ${r.name}.`, 4000);
    if ($('dlg-scores').open) renderScores();
  } catch (e) {
    if (e.status === 422 || e.status === 400) {
      // Refused by the server: back to what it has.
      const fallback = store.player.synced || undefined;
      store.updatePlayer({ name: fallback });
      drawName();
      note('bad', `Name not saved: ${e.data?.message || 'pick another name'}.`, 6000);
      showTip();
    } else {
      note('bad', 'Name kept on this device. It goes to the global board when the server is reachable.', 6000);
    }
  }
}

function showTip() { $('net').click(); }

playerInput.addEventListener('focus', () => requestAnimationFrame(() => playerInput.select()));
// Monospace, so the field can hug its text exactly and the status icon stays right next to the name.
function fitName() {
  playerInput.style.width = `calc(${Math.max(6, Math.min(NAME_MAX, playerInput.value.length)) + 1}ch + 10px)`;
}
playerInput.addEventListener('input', fitName);
playerInput.addEventListener('keydown', (e) => {
  if (e.key === 'Enter') playerInput.blur();
  if (e.key === 'Escape') { playerInput.value = myName(); playerInput.blur(); }
  e.stopPropagation(); // the board's keyboard shortcuts (N, F, arrows) are not for this field
});
playerInput.addEventListener('blur', commitName);

// ---------- drawing ----------

const GLYPH_FLAG = '<svg aria-hidden="true"><use href="#g-flag"/></svg>';
const GLYPH_MINE = '<svg aria-hidden="true"><use href="#g-mine"/></svg>';
const GLYPH_WRONG = `${GLYPH_FLAG}<svg aria-hidden="true"><use href="#g-cross"/></svg>`;

// A cell's place on screen (column, row) and back. They differ from the game's (x, y) only on a transposed board.
function displayOf(i) {
  const x = i % game.width;
  const y = (i - x) / game.width;
  return layout.transposed ? { c: y, r: x } : { c: x, r: y };
}
function logicalOf(c, r) {
  return layout.transposed ? indexOf(game, r, c) : indexOf(game, c, r);
}

/**
 * Bring one cell's element in line with the game. The expandos on the element (`_html`, `_aria`) remember what
 * was last written, so an unchanged cell costs no DOM writes; `_static` draws it without its animation.
 */
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

/**
 * `opened` is `[[index, depth], …]`: each depth pops in 16 ms after the one before, up to 420 ms, or all at once
 * with reduced motion.
 */
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

/** Repaint the opened cells in the 3 × 3 around `i`, whose numbers may have become chordable or stopped being. */
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

/**
 * Create every cell element, in screen order. The rows are there for the ARIA grid only: they are display:
 * contents in the CSS, so the cells sit directly in the board's grid. A cell's id and data-i are its game index.
 */
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
  queueFades();
  board.setAttribute('aria-activedescendant', `cell-${cursor}`);
}

// ---------- sizing ----------
// The largest cell that fits the space left by the controls, between a usable minimum and a comfortable
// maximum. A board wider than the screen is tall (Expert on a portrait phone) is drawn transposed: 30 × 16
// becomes 16 × 30, which is the same game, since only adjacency matters.

const gapFor = (cell) => Math.max(2, Math.round(cell * 0.085));
// Pixels n cells take along one side: the cells, the gaps between them, and the board's padding of two gaps at
// each end (`.board` in style.css; the two must agree).
const extent = (n, cell) => {
  const gap = gapFor(cell);
  return n * cell + (n - 1) * gap + 4 * gap;
};
/** The cell size for a cols × rows board in w × h px: `cell` to draw with, plus `raw` and `fitW` to compare by. */
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

/**
 * The room left for the board, in px: below the controls, or beside them in the landscape-phone layout (which
 * style.css makes by turning .app into a grid; that is how it is recognised here).
 */
function available() {
  const vw = document.documentElement.clientWidth;
  // The visual viewport is the smaller one while pinch-zoomed or with the on-screen keyboard up.
  const vh = window.visualViewport ? Math.min(window.innerHeight, window.visualViewport.height) : window.innerHeight;
  const cs = getComputedStyle(app);
  const padX = parseFloat(cs.paddingLeft) + parseFloat(cs.paddingRight);
  const padY = parseFloat(cs.paddingTop) + parseFloat(cs.paddingBottom);
  if (cs.display === 'grid') {
    // Landscape phone: the controls sit in a column to the left.
    const side = document.querySelector('.top').getBoundingClientRect().width;
    return { w: vw - padX - side - parseFloat(cs.columnGap || 0), h: vh - padY };
  }
  // Three row gaps: between .top, .status, the board and .dock.
  const gap = parseFloat(cs.rowGap || 10);
  const others = ['.top', '.status', '.dock'].reduce((s, sel) => s + document.querySelector(sel).offsetHeight, 0);
  // The board may use the page's side padding: the frame is its own margin.
  return { w: vw - Math.min(padX, 8), h: vh - padY - others - gap * 3 };
}

/**
 * Pick the cell size and orientation for the current game and screen, and hand them to the CSS as custom
 * properties. Returns whether the grid's shape changed; the cells themselves are rebuilt by the caller.
 */
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
  // The controls above and below take the board's width (at least 300 px), so they line up with it.
  root.setProperty('--col', `${Math.max(Math.min(boardWidth, w), 300)}px`);
  area.style.maxHeight = getComputedStyle(app).display === 'grid' ? '' : `${Math.max(h, pick.cell * 4)}px`;
  area.style.maxWidth = `${Math.floor(w)}px`;
  frame.style.maxWidth = area.style.maxWidth; // the frame around it may use the page's side padding too
  return changed;
}

// At most once a frame. A new size is only custom properties; the cells are rebuilt only when the board turns.
let resizeQueued = false;
function onResize() {
  if (resizeQueued || !game) return;
  resizeQueued = true;
  requestAnimationFrame(() => {
    resizeQueued = false;
    const before = layout.transposed;
    measure();
    if (layout.transposed !== before) build();
    fades();
  });
}
addEventListener('resize', onResize);
window.visualViewport?.addEventListener('resize', onResize);
addEventListener('orientationchange', onResize);

// ---------- edge fades ----------
// When the board pans inside its frame, a soft fade on each side that has more board beyond it. The fades are
// overlays that take no taps (pointer-events: none) and no room; the page's CSS decides how they appear.

let fadeQueued = false;
function fades() {
  const { scrollLeft: x, scrollTop: y, scrollWidth: sw, scrollHeight: sh, clientWidth: cw, clientHeight: ch } = area;
  const d = frame.dataset;
  const set = (k, on) => { if ((d[k] === '1') !== on) d[k] = on ? '1' : '0'; };
  // A pixel of slack: fractional sizes and zoom leave a sub-pixel of "overflow" that is not worth a fade.
  set('fadeTop', y > 1);
  set('fadeBottom', y + ch < sh - 1);
  set('fadeLeft', x > 1);
  set('fadeRight', x + cw < sw - 1);
  // Keep the fades off a classic scrollbar, where there is one.
  frame.style.setProperty('--sb-x', `${area.offsetHeight - area.clientHeight}px`);
  frame.style.setProperty('--sb-y', `${area.offsetWidth - area.clientWidth}px`);
}
function queueFades() {
  if (fadeQueued) return;
  fadeQueued = true;
  requestAnimationFrame(() => { fadeQueued = false; fades(); });
}
area.addEventListener('scroll', queueFades, { passive: true });
if (typeof ResizeObserver === 'function') {
  const ro = new ResizeObserver(queueFades);
  ro.observe(area);
  ro.observe(board);
}

// ---------- pointer input ----------

// The game index of the cell an event landed on, or -1.
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
/** While a button or finger is down: press what letting go would open (the cell, or the cells a chord opens). */
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
let press = null; // the finger or pen that is down: { id, i, x, y, fired (the long press went off), timer }
let lastTouch = 0; // for 800 ms after it, mouse handlers ignore the mouse events a browser makes up from a touch

function endPress() {
  if (!press) return;
  clearTimeout(press.timer);
  press = null;
  setPressed([]);
}

board.addEventListener('pointerdown', (e) => {
  if (e.pointerType === 'mouse') return; // the mouse has its own handlers below
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
  const both = (e.buttons & 3) === 3; // left and right held together
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

// Cells never take focus: the board does, and aria-activedescendant points screen readers at the cursor's cell.
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
  board.classList.add('kbd'); // the cursor is drawn only once the keyboard is in use; a click or tap hides it
  run();
});
board.addEventListener('focus', () => paint(cursor));

// N or F2 starts again from anywhere on the page, but not in a sheet or a text field.
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
    const [w, h, m] = b.slice(7).split('x'); // custom:WxHxM (records.js bucketFor)
    tabs.push({ bucket: b, label: `${w}×${h}·${m}`, title: `Custom ${w} × ${h}, ${m} mines` });
  }
  return tabs;
}
/**
 * The scores sheet: a tab per level and per custom board played, then the global board (ranked levels, when there
 * is a server, unless "This device" is picked) or this device's times and stats.
 */
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

/**
 * The global board for difficulty `d` over period `p`, from the cache if it is under 15 s old. Entries are
 * `{ r: rank, n: name, d: 1 for a default name, ms, me: true for this device }` (server/src/store.js).
 */
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
      who.className = e.d || !e.n ? 'who is-default' : 'who';
      who.textContent = e.n || defaultName(null);
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
// Erasing takes two taps: the first arms the button for 4 s.
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

// ---------- installed app ----------
// The service worker and its updates (pwa.js). An update is only ever applied between games.

const updateBtn = $('btn-update');
const pwa = initPwa({
  busy: () => !!game && game.status === 'playing',
  onReady: (ready) => { updateBtn.hidden = !ready; },
});
updateBtn.addEventListener('click', () => pwa.apply());
// The first tap of a game makes it one in progress: the hint steps aside until it is over.
// (A timeout, so it runs after the move: a mouse's is made by the mouseup that follows this pointerup.)
board.addEventListener('pointerup', () => setTimeout(pwa.refresh), { passive: true });
board.addEventListener('keyup', () => setTimeout(pwa.refresh));

// No accidental zoom: iOS zooms into a focused field under 16 px (the header's name) unless the page is at its
// maximum scale, and it pinches the board around mid-game. Pinch zoom elsewhere stays, in the browser; the
// installed app behaves like an app and does not zoom at all (see display-mode: standalone in the CSS).
// An iPad says it is a Mac; only its touch points give it away.
const isIOS = /iP(hone|ad|od)/.test(navigator.platform) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
if (isIOS) {
  const vp = document.querySelector('meta[name="viewport"]');
  if (vp && !/maximum-scale/.test(vp.content)) vp.content += ', maximum-scale=1';
  const standalone = navigator.standalone === true || matchMedia('(display-mode: standalone)').matches;
  const guard = (e) => { if (standalone || area.contains(e.target)) e.preventDefault(); };
  for (const type of ['gesturestart', 'gesturechange']) document.addEventListener(type, guard, { passive: false });
}

// ---------- boot ----------

drawName();
ensureIdentity().then(syncName);

if (!resume()) {
  level = levelFor(settings.difficulty);
  newGame(level.id);
}
// Web fonts change the controls' height a touch; size the board again once they are in.
document.fonts?.ready.then(onResize);

// For the end-to-end test: a read-only peek, nothing that changes the game.
window.__minesweeper = {
  apiBase: base,
  get state() {
    return { status: game.status, width: game.width, height: game.height, mines: game.mines, flags: game.flags, opened: game.opened, layout: { ...layout }, level: level.id };
  },
  mineIndices: () => [...game.mine].flatMap((m, i) => (m ? [i] : [])),
  get mode() { return mode; },
  get pending() { return pendingCells.size + (remote?.pending ? 1 : 0); },
  latency: () => (api ? [...api.latency] : []),
  get lastGlobal() { return lastGlobal; },
};
