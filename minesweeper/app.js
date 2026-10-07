/**
 * The page: draws the game from engine.js, turns mouse, touch and keys into moves, keeps the clock, and files
 * results with records.js. No framework; one element per cell, updated only where a move changed something.
 *
 * Ranked levels are played through the leaderboard server (online.js): the page never holds the real mines there,
 * only what the server's answers have opened, and it carries on locally if the server drops. Also here: the
 * player's name in the header (rules in names.js), the level, scores, statistics and settings sheets, and the update
 * hint (pwa.js). The logic in engine.js (analyze) drives the hint button in local games and the look back at the end
 * of every game: on a loss, whether the fatal click was a forced guess; on a win, 3BV, speed and efficiency.
 *
 * The daily challenge (daily.js, server/src/daily.js) is a ranked game on the day's board: chosen in the level sheet,
 * its first tap opens the day's opening wherever it lands, and only the first try a day counts. Every game logs its
 * moves for a replay (replay.js), kept for the best times and the last game, and played back on the board itself by
 * the viewer below; a finished game can be shared (share.js), and the statistics sheet charts the history (charts.js).
 * `window.__minesweeper` at the end is the end-to-end tests' read-only view of the game.
 */
import {
  DIFFICULTIES, CUSTOM_LIMITS, FLAG, OPEN, QUESTION, activate, analyze, bbbv, canChord, chordTargets, completeLayout,
  createGame, deserialize, indexOf, maxMinesFor, minesLeft, neighbours, sanitizeCustom, serialize, toggleMark,
} from './engine.js';
import { dayLabel, dayOf } from './daily.js';
import { NAME_MAX, checkName, defaultName } from './names.js';
import { RANKED_LEVELS, RemoteGame, apiBase, createApi, newToken, publicIdOf } from './online.js';
import { bucketFor, openStore, parseBucket, winRate } from './records.js';
import { MOVE, Playback, decodeMoves, encodeMoves, goneOffline, makeReplay, replayHolds } from './replay.js';
import { progressOf, shareText } from './share.js';
import { trendFigure } from './charts.js';
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
// WebKit (every browser on iPhone) has never shipped the Vibration API, so canVibrate is false there. A soft
// Web Audio click is the feedback that still works; only offered on a touch device, where the setting matters.
const AudioCtx = window.AudioContext || window.webkitAudioContext;
const canAudioTick = !canVibrate && touchCapable && typeof AudioCtx === 'function';
const canBuzz = canVibrate || canAudioTick;
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

// Hints and the look back. A game that used a hint is kept out of best times (records.js), and stays marked as
// such through a reload. `clicks` counts opens, chords and mark changes, for the efficiency of a win. `taps` keeps
// the board as it was at each recent tap: the loss analysis judges the fatal click by what was on screen when it
// was made, which in a ranked game may be less than what was open by the time the server answered. So it also keeps
// the cells already tapped and still waiting for that answer: proven safe or not, those were no longer there to tap.
let hinted = false;
let clicks = 0;
let taps = []; // [{ i, chord, view, pending }], the last 64
let clue = null; // { i, safe } the cell a hint points at, until the next move
let safeMark = -1; // after an avoidable loss: one cell that was provably safe, marked on the final board
let analysis = null; // the finished game's look back: what the details panel shows

// The replay log: every move of this game with the clock's reading, as replay.js encodes it. `loggedAt` remembers
// where each ranked move sent sits in the log, so that going offline can mark where the page took over; `served` says
// the game's moves went to the server (its flood fill ignores flags), and `logComplete` is false for a game resumed
// from a save that had no log, which then gets no replay. `lastReplay` is the finished game's, `shared` what its
// Share button sends.
let moveLog = [];
let loggedAt = new WeakMap();
let served = false;
let logComplete = true;
let lastReplay = null;
let shared = null;

// The daily challenge, for a daily game (null for any other): `{ day, start, first, why, counted, blocked, kept,
// elsewhere }`. `start` is the opening's cell (-1 until the server has said), `first` and `why` what the server
// expects of this try, `counted` what it decided at the first open (null before), and `blocked` why it cannot be
// played at all. While blocked, `kept` is the game whose first open went unanswered (Try again asks again), and
// `elsewhere` the id of this player's counted game still under way in another tab (Continue here picks it up).
// `practiceLeft` remembers that a practice daily went on offline as an ordinary game: it is still filed as practice.
let daily = null;
let practiceLeft = false;

// The replay viewer while it is open (see "replays" below), else null.
let replay = null;

// Ranked play. `remote` is the server-side game this board mirrors; `mode` is what the level line says. `closing` is
// the request closing the game just walked away from: the next game is asked for once it has landed.
const base = apiBase();
const api = base ? createApi(base) : null;
let remote = null;
let closing = null;
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
/**
 * This game's results bucket: its level, and whether its board is a no-guess one (which can change, see fellBack)
 * or the daily's.
 */
const bucketOf = () => bucketFor(level.id, level, { noGuess: game.noGuess, daily: Boolean(daily) });
/** A daily that is practice: its try was used before, by this game's own answer or the server's word beforehand. */
const isPractice = () => practiceLeft || Boolean(daily && (daily.counted === false || (daily.counted === null && daily.first === false)));

/**
 * The level line: name, size, and a small tag under it: No guessing on a no-guess board, the day on the daily (and
 * practice, when it is), and Replay while the viewer is open.
 */
function drawLevel() {
  $('level-name').textContent = level.label;
  $('level-dims').textContent = dims(level);
  let tag = game.noGuess ? 'No guessing' : '';
  let title = 'Logic alone clears this board from the first click (Settings)';
  let spoken = game.noGuess ? ', no guessing' : '';
  if (replay) {
    const r = replay.record;
    tag = `Replay · ${r.won ? `${formatTime(r.ms)} s` : 'mine hit'} · ${formatDate(new Date(r.at).toISOString())}`;
    title = 'A replay of a finished game: read-only';
    spoken = `, a replay of ${r.won ? `a ${formatTime(r.ms)} second win` : 'a loss'}`;
  } else if (daily) {
    tag = `Daily · ${dayLabel(daily.day)}${isPractice() ? ' · practice' : ''}`;
    title = isPractice()
      ? 'Today’s daily, played again: practice. Only the first try counts.'
      : 'Today’s daily challenge: the same no-guess board for everyone. Only your first try counts.';
    spoken = `, the daily challenge of ${dayLabel(daily.day)}${isPractice() ? ', practice' : ''}`;
  }
  const el = $('level-variant');
  el.textContent = tag;
  el.title = title;
  el.hidden = !tag;
  app.classList.toggle('has-variant', Boolean(tag)); // the landscape layout makes room for the tag's row (style.css)
  drawDailyBadge();
  const badge = $('daily-badge').hidden ? '' : ' Today’s daily challenge is ready.';
  $('btn-level').setAttribute('aria-label', `Difficulty: ${level.label}, ${level.width} by ${level.height}, ${level.mines} mines${spoken}. Change.${badge}`);
}

/**
 * The quiet dot on the level button: today's daily is there and has not been played on this device. It goes once the
 * level sheet has been opened that day (it has been seen), or once a daily has been started.
 */
function drawDailyBadge() {
  const today = dayOf();
  $('daily-badge').hidden = !api || replay !== null || store.dailyPlayed(today) || settings.dailySeen === today;
}

/**
 * A no-guess game that turned out not to be one: the generator gave up (a custom board too dense for it), the server
 * did, the server is too old to know the variant, or the game went offline midway onto a layout that only agrees
 * with the screen. From here it is filed as classic, which is what it is.
 *
 * It goes by the bucket, not by game.noGuess: when the local generator gives up it has already cleared that flag
 * itself (engine.js), and the game is still filed, labelled and saved as a no-guess one until this runs.
 */
function fellBack(why) {
  if (!parseBucket(bucket).noGuess) return;
  game.noGuess = false;
  bucket = bucketOf();
  drawLevel();
  persist();
  note('bad', why, 6000);
  announce(why);
}

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

/**
 * A new game at level `id`; with `daily`, today's daily challenge at that level (ranked levels only). Restarting a
 * daily, or playing again after it, starts an ordinary game: the daily is only ever chosen in the level sheet.
 */
function newGame(id = settings.difficulty, { daily: asDaily = false } = {}) {
  if (replay) closeReplay({ restore: false });
  // Walking away from a started game counts as a game played and ends the streak, like the original. A ranked one is
  // closed on the server too: a counted daily's try ends there, so practice can follow at once.
  if (game && game.status === 'playing') {
    if (remote?.id) closing = api.close(remote.id, deviceToken()).catch(() => {});
    store.record(bucket, { won: false, abandoned: true, practice: isPractice(), clicks, cleared: clearedShare() });
  }
  restoring = false;
  settings = store.updateSettings({ difficulty: id });
  level = levelFor(id);
  daily = asDaily && RANKED_LEVELS.has(id) ? { day: dayOf(), start: -1, first: null, why: null, counted: null, blocked: null } : null;
  game = createGame({ ...level, noGuess: daily ? true : settings.noGuess });
  bucket = bucketOf();
  resetAids();
  store.setCurrent(null);
  $('btn-again').textContent = 'Play again';
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
    game = restored;
    daily = null;
    bucket = bucketOf();
    resetAids(saved);
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
  drawLevel();
  drawNet();
  app.classList.remove('is-over');
  board.classList.remove('is-over', 'is-won', 'is-lost');
  $('result').hidden = true;
  $('dock-replay').hidden = true;
  hideTip();
  fillDetails(); // empty: the analysis is the finished game's
  showDetails(false);
  $('dock-play').hidden = false;
  drawHint();
  announce('');
  build();
  drawCounter();
  pwa?.refresh();
}

/**
 * A fresh game has used no hint, made no clicks and logged no moves; a resumed one carries what its save says (a
 * save from before replays has no log, and that game gets no replay).
 */
function resetAids(saved = {}) {
  hinted = saved.hinted === true;
  clicks = Math.max(0, Number(saved.clicks) || 0);
  taps = [];
  clue = null;
  safeMark = -1;
  analysis = null;
  loggedAt = new WeakMap();
  lastReplay = null;
  shared = null;
  practiceLeft = false;
  served = saved.served === true;
  try {
    moveLog = decodeMoves(saved.log || '');
    // A game picked up from another tab (`partial`) has its earlier moves there.
    logComplete = !saved.partial && !(clicks > 0 && typeof saved.log !== 'string');
  } catch {
    moveLog = [];
    logComplete = false;
  }
}

/** Log a move for the replay, with the clock's reading; `sent` is the ranked move it went to the server as. */
function logMove(kind, i, sent = null) {
  if (sent) loggedAt.set(sent, moveLog.length);
  moveLog.push({ t: Math.round(elapsed()), k: kind, i });
}

/** The share of the safe cells open, 0 to 1. */
const clearedShare = () => game.opened / Math.max(1, game.cells - game.mines);

/**
 * Save the game in progress so a reload can pick it up. A ranked game is only its server id, batch number and the
 * player's marks (resumeRemote asks the server for the rest); a local one is the whole game and its clock.
 */
function persist() {
  if (replay) return; // the viewer's game is not the one in play
  const log = encodeMoves(moveLog);
  if (remote) {
    if (game.status === 'playing' && remote.id) {
      const marks = (v) => [...game.view.keys()].filter((i) => game.view[i] === v);
      store.setCurrent({
        difficulty: level.id, remote: { id: remote.id, seq: remote.seq, v: game.noGuess ? 'ng' : 'classic' },
        flags: marks(FLAG), questions: marks(QUESTION), clicks, log, served,
        daily: daily && { day: daily.day, start: daily.start, counted: daily.counted },
      });
    }
    return;
  }
  if (game.status === 'playing') {
    store.setCurrent({ difficulty: level.id, game: serialize(game), elapsed: Math.round(elapsed()), hinted, clicks, log, served });
  } else if (store.current) {
    store.setCurrent(null);
  }
}

function drawCounter() {
  $('mines-left').textContent = pad3(minesLeft(game));
}

// ---------- moves ----------

const over = () => game.status === 'won' || game.status === 'lost';

/**
 * Tap / left click: open a covered cell, or clear around a satisfied number. `again` is a move already counted and
 * remembered once (a ranked move the server never answered, made again offline); it is logged now, where it happens
 * (see goOffline).
 *
 * On the daily, the first tap opens the day's opening wherever it lands (the ring shows where), and nothing else can
 * be tapped until it is open.
 */
function primary(i, { again = false } = {}) {
  if (replay || over() || i < 0 || restoring) return false;
  if (daily) {
    if (daily.blocked) return false;
    if (daily.start < 0) {
      hintTip('Getting today’s board…', true);
      return false;
    }
    if (game.status === 'ready') {
      i = daily.start;
      hideTip(); // "tap anywhere to open": done
    } else if (game.opened === 0) return false; // the opening is on its way
  }
  if (game.view[i] === FLAG || pendingCells.has(i)) return false;
  if (!again) {
    clicks++;
    remember(i);
  }
  dropClue();
  if (remote) return remotePrimary(i);
  const wasReady = game.status === 'ready';
  const wasOpen = game.view[i] === OPEN;
  const wanted = game.noGuess;
  lastMove = i;
  const result = activate(game, i);
  if (!result.opened.length) {
    if (game.view[i] === OPEN && game.adjacent[i]) hint(i);
    return false;
  }
  logMove(wasOpen ? MOVE.chord : MOVE.open, i);
  if (wasReady) {
    clockStart();
    if (wanted && !game.noGuess) fellBack('No no-guess board could be made at this size and density. This one may need a guess.');
  }
  paintOpened(result.opened);
  if (game.status === 'won' || game.status === 'lost') finish();
  else persist();
  drawCounter();
  return true;
}

/**
 * The screen as it is now, kept with the move about to change it (see `taps`). A tap on a number that cannot chord
 * makes no move, so it is not kept: the loss analysis looks for the move that set the mine off.
 */
function remember(i) {
  const chord = game.view[i] === OPEN;
  if (chord && !canChord(game, i)) return;
  taps.push({ i, chord, view: game.view.slice(), pending: [...pendingCells] });
  if (taps.length > 64) taps.shift();
}

/**
 * Right click / long press: cycle the mark on a covered cell. Not on the daily before its opening: there is nothing
 * to mark yet, and a flag on the ringed cell would stand in the way of the first tap.
 */
function secondary(i) {
  if (replay || over() || i < 0 || restoring || pendingCells.has(i)) return false;
  if (daily && (daily.blocked || game.opened === 0)) return false;
  if (!toggleMark(game, i, { questionMarks: settings.questionMarks })) return false;
  const v = game.view[i];
  logMove(v === FLAG ? MOVE.flag : v === QUESTION ? MOVE.question : MOVE.unmark, i);
  clicks++;
  dropClue();
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
  const practice = isPractice();
  dropClue();
  hideTip(); // whatever it said was about the game in play
  analysis = won ? winStats(ms, answer) : lookBack();
  safeMark = analysis?.mark ?? -1;
  const record = replayOf(ms, won, practice);
  const { rank, stats, replay: kept } = store.record(bucket, {
    won, ms, hinted, practice, ranked: Boolean(answer?.ranked), bbbv: won ? analysis.bbbv : 0, clicks,
    cleared: clearedShare(), replay: record,
  });
  lastReplay = kept;
  if (daily && daily.counted) store.noteDaily(daily.day, level.id, { c: 1, w: won ? 1 : 0, ms: won ? Math.round(ms) : undefined });
  shared = shareFacts(ms, won, answer, record);
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
    title.textContent = `Cleared in ${formatTime(ms)}\u00a0s`;
    const times = store.times(bucket);
    let text;
    if (practice) text = 'Practice: only the first try of the day counts';
    else if (hinted) text = 'With a hint, so no best time';
    else if (rank === 1) text = times.length > 1 ? 'New best time' : 'Your first recorded time';
    else if (rank) text = `Number ${rank} on your best times`;
    else text = times.length ? `Best ${formatTime(times[0].ms)}\u00a0s` : 'No best time yet';
    if (stats.streak > 1 && !practice) text += ` · ${stats.streak} wins in a row`;
    setDetail(text);
    if (answer && answer.ranked) {
      if (daily) verifyDaily(answer);
      else verifyWin(answer);
    } else if (practice) {
      setVerify(null);
    } else {
      const why = answer ? unrankedReason(answer) : localReason();
      setVerify('bad', why);
      setDetail(`${why} · ${text}`);
      note('bad', `This win is not ranked: ${why.toLowerCase()}.`);
    }
  } else {
    setVerify(null);
    const safe = game.cells - game.mines;
    const pct = Math.floor((game.opened / safe) * 100);
    title.textContent = 'Mine hit';
    // The verdict leads: it is what the look back adds, and the details say why (and the time, to keep this short).
    setDetail(analysis
      ? `${analysis.verdict} · ${pct}%\u00a0cleared`
      : `${pct}%\u00a0cleared · ${formatTime(ms)}\u00a0s`);
    if (analysis) analysis.time = `${formatTime(ms)} s`;
  }
  fillDetails();
  $('dock-play').hidden = true;
  box.hidden = false;
  announce(`${title.textContent}. ${detail.textContent}.${analysis?.spoken ? ` ${analysis.spoken}` : ''}`);
  if (!won) buzz([30, 60, 40]);
  if (won && answer && answer.ranked) afterRankedWin(answer);
  drawNet();
}

/**
 * The finished game's replay, if there is a whole one: a log from the first move, a full layout of mines (a ranked
 * game has it from the server's last answer), and a playback that ends the way the game did. Otherwise null.
 */
function replayOf(ms, won, practice) {
  if (!logComplete || !moveLog.length) return null;
  if (game.mine.reduce((a, b) => a + b, 0) !== game.mines) return null;
  const record = makeReplay(game, moveLog, {
    ms, won, server: served, level: level.id, label: level.label, ng: game.noGuess, daily: daily?.day ?? null,
    practice, hinted,
  });
  return replayHolds(record, game.view) ? record : null;
}

/** What the Share button sends for this game (share.js). The daily's pace grid comes from its replay. */
function shareFacts(ms, won, answer, record) {
  const safe = game.cells - game.mines;
  let progress = null;
  if (daily && record) {
    try {
      progress = progressOf(new Playback(record).timeline(), ms, safe);
    } catch { /* no grid then */ }
  }
  return {
    level: level.label, dims: level.id === 'custom' ? dims(level) : null, noGuess: game.noGuess, won, ms, hinted,
    rate: won ? analysis?.rate : null, cleared: clearedShare(), rank: answer?.ranked && answer.rank ? answer.rank.day : null,
    daily: daily && { day: daily.day, counted: Boolean(daily.counted), rank: answer?.daily?.rank ?? null, n: answer?.daily?.n ?? null },
    progress,
  };
}

/**
 * The result's second line. A short landscape phone keeps it to one line (style.css cuts it off there), so the
 * details panel repeats it whole at its top (`.panel-detail`, shown in that layout only), and so does its title.
 */
function setDetail(text) {
  const el = $('result-detail');
  el.textContent = text;
  el.title = text;
  const copy = $('result-panel').querySelector('.panel-detail');
  if (copy) copy.textContent = text;
}

/**
 * Short feedback when a long press flags (and a longer pulse on a loss). Android uses the Vibration API.
 * iPhone Safari and Brave never expose navigator.vibrate (WebKit never shipped it and opposes the API), so
 * there a soft Web Audio click plays instead — same gesture, no fake vibrate polyfill. AudioContext must have
 * been resumed from a user gesture first; pointerdown on the board does that.
 */
let tickCtx = null;
function resumeTickAudio() {
  if (!canAudioTick) return;
  try {
    tickCtx ??= new AudioCtx();
    if (tickCtx.state !== 'running') tickCtx.resume();
  } catch { /* private mode, or autoplay still blocked */ }
}

function tick(pattern) {
  if (!canAudioTick) return;
  try {
    resumeTickAudio();
    if (!tickCtx || tickCtx.state !== 'running') return;
    // Match the Vibration API pattern shape: values alternate pulse, pause, pulse, …
    const steps = Array.isArray(pattern) ? pattern : [pattern];
    let t = tickCtx.currentTime;
    for (let i = 0; i < steps.length; i += 1) {
      const ms = Math.max(0, Number(steps[i]) || 0);
      if (i % 2 === 1) { t += ms / 1000; continue; }
      const dur = Math.min(ms, 48) / 1000;
      if (dur <= 0) continue;
      const osc = tickCtx.createOscillator();
      const gain = tickCtx.createGain();
      osc.type = 'sine';
      osc.frequency.value = 180;
      // Near-silent: felt as a click through the speaker/earpiece more than heard as a tone.
      gain.gain.setValueAtTime(0.0001, t);
      gain.gain.exponentialRampToValueAtTime(0.035, t + 0.004);
      gain.gain.exponentialRampToValueAtTime(0.0001, t + dur);
      osc.connect(gain);
      gain.connect(tickCtx.destination);
      osc.start(t);
      osc.stop(t + dur + 0.02);
      t += dur;
    }
  } catch { /* ignored */ }
}

function buzz(pattern) {
  if (!settings.haptics || !canBuzz) return;
  if (canVibrate) {
    try { navigator.vibrate(pattern); } catch { /* some browsers throw without a user gesture */ }
    return;
  }
  tick(pattern);
}

function announce(text) {
  $('announce').textContent = text;
}

// ---------- hints and the look back ----------
// Both ask engine.js's analyze() what the screen proves, and both pass it only what the screen shows: in a ranked
// game the page has no mines to peek at, and in a local one a hint that peeked would be a cheat, not a deduction.

const HINTS_OFF = 'Hints are off in ranked games: those are timed and verified by the server.';

/** Why the hint button cannot be used now (a ranked game, or one being restored), or null when it can. */
const hintBlocked = () => (remote || restoring ? HINTS_OFF : null);

/** The hint button: dimmed with its reason in a ranked game, and marked once this game has used a hint. */
function drawHint() {
  const b = $('btn-hint');
  const blocked = hintBlocked();
  b.setAttribute('aria-disabled', String(Boolean(blocked)));
  b.classList.toggle('is-used', hinted);
  if (blocked) {
    b.setAttribute('aria-label', `Hint. ${blocked}`);
    b.title = blocked;
  } else if (hinted) {
    b.setAttribute('aria-label', 'Hint: show a safe cell. This game has used a hint, so it keeps no best time.');
    b.title = 'Hint (H). Used in this game: it keeps no best time.';
  } else {
    b.setAttribute('aria-label', 'Hint: show a safe cell');
    b.title = 'Hint (H)';
  }
}

/**
 * A short line over the dock for a moment. It is hidden from screen readers, which hear the live region instead:
 * the same words (`spoken` true) or a longer version announced by the caller.
 */
function hintTip(text, spoken = false) {
  if (spoken) announce(text);
  const tip = $('hint-tip');
  tip.textContent = text;
  tip.classList.add('is-shown');
  clearTimeout(tip._t);
  tip._t = setTimeout(() => tip.classList.remove('is-shown'), 2800);
}
/** Put the tip away now: what it said was about the game before. */
function hideTip() {
  const tip = $('hint-tip');
  clearTimeout(tip._t);
  tip.classList.remove('is-shown');
}

/** "row 3, column 5": where a cell is on screen, as the cells' own labels say it. */
function where(i) {
  const p = displayOf(i);
  return `row ${p.r + 1}, column ${p.c + 1}`;
}

/** Of `list`, the cell nearest `from` (rings of cells around it); the first such on a tie, so it is repeatable. */
function nearest(list, from) {
  const fx = from % game.width;
  const fy = (from - fx) / game.width;
  let best = list[0];
  let bestD = Infinity;
  for (const i of list) {
    const x = i % game.width;
    const d = Math.max(Math.abs(x - fx), Math.abs((i - x) / game.width - fy));
    if (d < bestD) { best = i; bestD = d; }
  }
  return best;
}

/** A mine probability for people: "33%", "under 1%", and "about 33%" where the count ran out of budget. */
function chance(p, exact = true) {
  const text = p < 0.01 ? 'under 1%' : p > 0.99 ? 'over 99%' : `${Math.round(p * 100)}%`;
  return exact ? text : `about ${text}`;
}

/** Only what a player sees of the game: analyze() reads no more, but this way it cannot. */
const screenOf = (view = game.view) => ({
  width: game.width, height: game.height, mines: game.mines, cells: game.cells, view, adjacent: game.adjacent,
});

/**
 * The hint: one cell that is safe for sure (the one nearest the cursor or the last move), or, when there is none,
 * the safest guess with its chance of a mine. Using it marks the game (see `hinted`).
 */
function giveHint() {
  if (over() || replay) return;
  const blocked = hintBlocked();
  if (blocked) return hintTip(blocked, true);
  if (game.status === 'ready') return hintTip('The first click is always safe.', true);
  const a = analyze(screenOf());
  if (!a.consistent || !a.safest.length) return hintTip('No hint for this board.', true);
  hinted = true;
  const keyboard = board.classList.contains('kbd');
  const safe = a.safe.length > 0;
  const i = nearest(safe ? a.safe : a.safest, keyboard ? cursor : lastMove);
  dropClue();
  clue = { i, safe };
  if (keyboard) {
    const p = displayOf(i);
    moveCursor(p.c, p.r, true); // so that Space opens it
  } else {
    paint(i);
    cells[i].scrollIntoView({ block: 'nearest', inline: 'nearest' });
  }
  const odds = chance(a.probability[i], a.exact);
  hintTip(safe ? 'Safe for sure: marked on the board' : `A guess: ${odds} chance of a mine`);
  announce(safe
    ? `Hint: the cell at ${where(i)} is safe.`
    : `Hint: no cell is safe for sure, so this is a guess. The safest is at ${where(i)}: ${odds} chance of a mine.`);
  drawHint();
  persist();
}

/** The hint's mark goes with the next move. */
function dropClue() {
  if (!clue) return;
  const { i } = clue;
  clue = null;
  paint(i);
}

/**
 * After a loss: was the fatal click a forced guess, or was a safe cell there to be had? Judged on the screen as it was
 * when that tap was made (see `taps`), and on the cells that could still be tapped then: a proven cell already on
 * its way to the server does not count, since tapping it again would have done nothing. Returns what the result
 * line and the details show, and `mark`, one provably safe cell still covered on the final board (the nearest to the
 * mine), or null when there is nothing to say.
 */
function lookBack() {
  const hit = game.exploded[0];
  if (hit === undefined) return null;
  const went = (j) => game.exploded.includes(j);
  const touched = (t) => went(t.i) || (t.chord && neighbours(game, t.i).some(went));
  const tap = [...taps].reverse().find(touched);
  if (!tap) return null;
  const a = analyze(screenOf(tap.view));
  if (!a.consistent) return null;
  const p = a.probability[hit];
  const waiting = new Set(tap.pending);
  const free = (i) => tap.view[i] !== OPEN && !waiting.has(i); // covered, and not already tapped
  const tappable = a.safe.filter(free);
  let lowest = p;
  for (let i = 0; i < game.cells; i++) if (free(i) && a.probability[i] < lowest) lowest = a.probability[i];
  const avoidable = tappable.length > 0;
  const still = tappable.filter((i) => game.view[i] !== OPEN);
  const mark = avoidable && still.length ? nearest(still, hit) : -1;
  const odds = chance(p, a.exact);
  const opened = tap.chord ? 'The cell your chord opened' : 'The cell you opened';
  const yours = p > 0.999 ? `${opened} was a mine for sure.` : `${opened}: ${odds} chance of a mine.`;
  let text;
  let spoken;
  if (avoidable) {
    const there = mark >= 0 ? 'A cell was safe for sure: it is marked on the board.' : 'A cell was safe for sure.';
    text = `${tap.chord ? 'The chord trusted a wrong flag. ' : ''}${there} ${yours}`;
    spoken = mark >= 0 ? `The cell at ${where(mark)} was safe for sure.` : 'A cell was safe for sure.';
  } else {
    const best = lowest < p - 0.005 ? ` The safest: ${chance(lowest, a.exact)}.` : ' None was safer.';
    const none = a.safe.length
      ? 'Every cell that was safe for sure had been tapped already and was still opening, so a guess was forced.'
      : 'No cell was safe for sure, so a guess was forced.';
    text = `${none} ${yours}${best}`;
    spoken = `It was a forced guess: ${odds} chance of a mine.`;
  }
  const verdict = avoidable ? 'Avoidable' : 'Forced guess';
  return { won: false, avoidable, chord: tap.chord, p, lowest, exact: a.exact, mark, verdict, text, spoken };
}

/**
 * After a win: 3BV (the fewest clicks the board needs without chording), 3BV per second, the clicks made, and
 * efficiency, 3BV over clicks (above 100% takes chording).
 */
function winStats(ms, answer) {
  const b = Number.isInteger(answer?.bbbv) ? answer.bbbv : bbbv(game);
  return { won: true, bbbv: b, rate: ms > 0 ? b / (ms / 1000) : 0, clicks, efficiency: clicks ? b / clicks : 0, mark: -1 };
}

/**
 * The details panel, from `analysis`, with the game's two extras at the bottom: its replay (when it was kept) and
 * Share. No analysis (a game cut short by the connection), no button.
 */
function fillDetails() {
  const panel = $('result-panel');
  $('btn-details').hidden = !analysis;
  panel.textContent = '';
  if (!analysis) return;
  if (analysis.won) {
    const fact = (label, value) => `<div><dt>${label}</dt><dd>${value}</dd></div>`;
    panel.innerHTML = `<p class="panel-detail"></p><dl class="facts">${[
      fact('3BV', analysis.bbbv),
      fact('3BV/s', analysis.rate.toFixed(2)),
      fact('Clicks', analysis.clicks),
      fact('Efficiency', analysis.clicks ? `${Math.round(analysis.efficiency * 100)}%` : '–'),
    ].join('')}</dl><p class="facts-note">3BV: the fewest clicks this board needs. Efficiency: 3BV over your clicks.</p>`;
  } else {
    const whole = document.createElement('p');
    whole.className = 'panel-detail';
    const p = document.createElement('p');
    p.textContent = analysis.text;
    const time = document.createElement('p');
    time.className = 'facts-note';
    time.textContent = `Time: ${analysis.time}.`;
    panel.append(whole, p, time);
  }
  panel.querySelector('.panel-detail').textContent = $('result-detail').textContent;
  const actions = document.createElement('div');
  actions.className = 'panel-actions';
  const action = (id, icon, text) => {
    const b = document.createElement('button');
    b.type = 'button';
    b.className = 'text-btn';
    b.id = id;
    b.innerHTML = `<svg class="icon icon-sm" aria-hidden="true"><use href="#${icon}"/></svg><span>${text}</span>`;
    actions.appendChild(b);
  };
  if (lastReplay) action('btn-watch', 'i-play', 'Watch the replay');
  if (shared) action('btn-share', 'i-share', touchCapable && typeof navigator.share === 'function' ? 'Share' : 'Copy to share');
  if (actions.childElementCount) panel.appendChild(actions);
}

let detailsOpen = false;
function showDetails(open) {
  detailsOpen = open && !$('btn-details').hidden;
  $('result-panel').hidden = !detailsOpen;
  $('btn-details').setAttribute('aria-expanded', String(detailsOpen));
  $('result').classList.toggle('is-detailed', detailsOpen);
  fitDetails();
}
/**
 * The details float above the result. On a short screen (a landscape phone) they could rise past its top, so they
 * are never taller than the room above the result, and scroll inside themselves when they need more.
 */
function fitDetails() {
  const panel = $('result-panel');
  if (panel.hidden) return;
  panel.style.maxHeight = '';
  const room = $('result').getBoundingClientRect().top - 16; // 8 px between them, 8 px from the top of the screen
  panel.style.maxHeight = `${Math.max(96, Math.floor(room))}px`;
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
  if (daily) return connectDaily();
  if (!api || !RANKED_LEVELS.has(level.id)) return drawNet();
  mode = 'connecting';
  drawNet();
  // Every callback checks `remote === r`, so a game already replaced (a restart, another level) is ignored.
  const after = closing;
  closing = null;
  const r = new RemoteGame(api, deviceToken(), level.id, {
    variant: game.noGuess ? 'ng' : 'classic',
    after,
    onAnswer: (answer, batch) => { if (remote === r) applyAnswer(answer, batch); },
    onLost: (error, unanswered) => { if (remote === r) goOffline(unanswered); },
  });
  remote = r;
  drawHint(); // off from the start: this game is ranked unless the server turns out to be away
  r.created.then(
    () => {
      if (remote === r && mode === 'connecting') { mode = 'ranked'; drawNet(); }
      if (remote === r && game.noGuess && r.variant !== 'ng') {
        fellBack('The leaderboard server cannot deal no-guess boards yet. This game is classic.');
      }
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
  drawHint();
}

// ---------- the daily challenge ----------
// Played like any ranked game, through the server, which holds the day's board. There is no offline daily: without
// the server the page says so and offers to try again, rather than deal a board that is not the day's.

// Why the daily cannot be played: a line short enough for the result line of a 568 × 320 phone, and the whole
// reason, for the live region and the status tip.
const DAILY_NO_SERVER = 'The daily challenge is played on the leaderboard server, which this copy of the game does not have.';
const DAILY_OFFLINE = ['The server cannot be reached.', 'The daily challenge is played on the leaderboard server, which cannot be reached right now. Try again once you are online.'];
const DAILY_OLD = ['The server has no daily yet.', 'The leaderboard server does not have the daily challenge yet.'];
const DAILY_OVER = ['It closed at midnight.', 'That daily closed at midnight, Oslo time. Try again for today’s.'];
const DAILY_NONE = ['No server in this copy.', DAILY_NO_SERVER];
const DAILY_EXPIRED = ['This board timed out.', 'The board was left untouched until it timed out. Your try is still unused: Try again deals it again.'];
const DAILY_NO_ANSWER = ['No answer to your first tap.', 'The server did not answer your first tap, so your try may have started. Try again picks it up where it is.'];
const DAILY_ELSEWHERE = ['Your try is open elsewhere.', 'Your counted try at this level is still under way in another game, in another tab or one whose answer went missing. Continue here picks it up.'];

/** Ask the server for today's daily game: its day, the opening's cell, and whether this try will count. */
function connectDaily() {
  if (!api) return dailyUnavailable(DAILY_NONE);
  mode = 'connecting';
  drawNet();
  const after = closing;
  closing = null;
  const r = new RemoteGame(api, deviceToken(), level.id, {
    daily: true,
    after,
    onAnswer: (answer, batch) => { if (remote === r) applyAnswer(answer, batch); },
    onLost: (error, unanswered) => { if (remote === r) dailyLost(error, unanswered); },
  });
  remote = r;
  drawHint();
  r.created.then(
    () => {
      if (remote !== r) return;
      if (!r.daily) {
        dailyUnavailable(DAILY_OLD);
        return;
      }
      Object.assign(daily, { day: r.daily.day, start: r.daily.start, first: r.daily.first !== false, why: r.daily.why || null });
      // The server already has a try of this device's here: so does the daily log (the level sheet says Played).
      if (!daily.first && !store.dailyTry(daily.day, level.id)) store.noteDaily(daily.day, level.id, { c: 0 });
      mode = 'ranked';
      drawNet();
      drawLevel();
      paint(daily.start);
      const lead = isPractice() ? 'Practice: today’s try at this level is used. ' : '';
      hintTip(`${lead}Tap anywhere to open today’s board: the clock starts then.`);
      announce(`${lead}Today’s daily challenge, ${level.label}. The opening is at ${where(daily.start)}. Any tap or Space opens it and starts the clock.`);
      syncName();
    },
    (e) => {
      if (remote !== r || r.pending) return;
      if (e?.code === 'daily-in-progress') dailyElsewhere(e.data?.id);
      else dailyUnavailable(DAILY_OFFLINE);
    },
  );
}

/** This player's counted try at the level is under way in another game: offer to continue it here. */
function dailyElsewhere(id) {
  dailyUnavailable(DAILY_ELSEWHERE);
  if (!id) return;
  daily.elsewhere = id;
  $('btn-again').textContent = 'Continue here';
}

/**
 * Try again after an unanswered first open: the same batch, with the same number, goes to the same game. The server
 * answers it as it did if it got it the first time (the try was filed then), or takes it now.
 */
function askAgain() {
  const { id, seq, at } = daily.kept;
  Object.assign(daily, { kept: null, blocked: null });
  $('result').hidden = true;
  $('dock-play').hidden = false;
  $('btn-again').textContent = 'Play again';
  mode = 'connecting';
  netNote = null;
  drawNet();
  const r = RemoteGame.resume(api, deviceToken(), level.id, id, seq, {
    onAnswer: (answer, batch) => {
      if (remote !== r) return;
      mode = 'ranked';
      drawNet();
      applyAnswer(answer, batch);
    },
    onLost: (error, unanswered) => { if (remote === r) dailyLost(error, unanswered); },
  }, game.noGuess ? 'ng' : 'classic', { day: daily.day, start: daily.start });
  remote = r;
  drawHint();
  game.status = 'playing';
  clockReset(at);
  clockStart();
  markPending([daily.start]);
  r.send([0, daily.start]); // logged when it was first tapped
}

/** Continue here: the counted game under way elsewhere, picked up like a game saved before a reload. */
function pickUpDaily() {
  resumeRemote({
    difficulty: level.id, remote: { id: daily.elsewhere, seq: 0, v: 'ng' }, daily: { day: daily.day, start: daily.start, counted: true }, partial: true,
  });
}

/**
 * The daily cannot be played: no server here, none reachable, one without the daily, or a day that ended before the
 * first tap. The board stays covered and inert, and the result line says why (`[short, whole]`), with Try again.
 */
function dailyUnavailable([why, whole]) {
  dropRemote();
  mode = 'offline';
  hideTip();
  note('bad', `Daily unavailable. ${whole}`);
  Object.assign(daily, { blocked: why, kept: null, elsewhere: null });
  game.status = 'ready';
  clockReset();
  paint(Math.max(0, daily.start));
  analysis = null;
  shared = null;
  fillDetails();
  setVerify(null);
  $('result').classList.remove('is-record');
  $('result-title').textContent = 'Daily unavailable';
  setDetail(why);
  $('btn-again').textContent = 'Try again';
  $('dock-play').hidden = true;
  $('result').hidden = false;
  announce(`Daily unavailable. ${whole}`);
}

/**
 * The server stopped answering a daily game. Before its opening, the daily is simply unavailable (or the day turned
 * over: its first tap came after midnight). After it, the try is used either way, so the game goes on offline like
 * any ranked game, on mines that agree with the screen, but it is no longer the day's board: it is filed as an
 * ordinary unranked game, and the page says so.
 */
function dailyLost(error, unanswered) {
  if (error?.code === 'day-over') return dailyUnavailable(DAILY_OVER);
  if (error?.code === 'daily-in-progress') return dailyElsewhere(error.data?.id);
  if (game.opened === 0) {
    // Untouched until it timed out (410), or gone with a restart (404): nothing was used, deal it again.
    if (error?.status === 404 || error?.status === 410) return dailyUnavailable(DAILY_EXPIRED);
    // The opening went out but no answer came back: the server may have filed the try. Keep the game for Try again.
    const kept = remote?.id && unanswered.some((m) => m[0] === 0) ? { id: remote.id, seq: remote.seq, at: Math.round(elapsed()) } : null;
    dailyUnavailable(kept ? DAILY_NO_ANSWER : DAILY_OFFLINE);
    daily.kept = kept;
    return;
  }
  const message = 'The connection dropped, so this goes on offline and unranked, no longer as the daily. Today’s try at this level is used.';
  // Practice stays practice (it is still filed only in the history, in its daily bucket); a counted try becomes an
  // ordinary game, as any ranked game that loses the server does.
  practiceLeft = isPractice();
  daily = null;
  game.noGuess = false;
  if (!practiceLeft) bucket = bucketOf();
  drawLevel();
  note('bad', message, 8000);
  goOffline(unanswered, message);
}

/** What the server said about this try: whether it counts (at the first open). Kept in the daily log too. */
function dailyAnswer(info) {
  if (typeof info.counted !== 'boolean' || daily.counted !== null) return;
  daily.counted = info.counted;
  if (info.counted) store.noteDaily(daily.day, level.id, { c: 1 });
  else if (!store.dailyTry(daily.day, level.id)) store.noteDaily(daily.day, level.id, { c: 0 });
  if (!info.counted && daily.first) {
    // The server expected a first try at creation, so another game took it meanwhile (a second tab, say).
    const why = info.why === 'network'
      ? 'Practice: this network has had its first tries at today’s daily.'
      : 'Practice: today’s try at this level was taken by another game.';
    note('bad', why, 6000);
    announce(why);
  }
  bucket = bucketOf();
  drawLevel();
  persist();
}

/**
 * A counted, ranked daily win: its place on today's board, after the same short "verifying" step as other ranked
 * wins, while the day's board is fetched for the scores sheet.
 */
function verifyDaily(answer) {
  const detail = $('result-detail');
  const d = level.id;
  const info = answer.daily || {};
  const place = info.rank ? `#${info.rank} today${info.n ? ` of ${info.n}` : ''}` : 'Verified';
  const streak = info.streak?.now > 1 ? ` · ${info.streak.now}-day streak` : '';
  store.noteDaily(daily.day, d, { c: 1, w: 1, rk: 1, ms: answer.ms, r: info.rank ?? undefined });
  setVerify('busy', 'Verifying with the server');
  setDetail('Verifying with the server…');
  const shown = new Promise((r) => setTimeout(r, 350));
  const check = api.daily(d, 'today', store.player.pid).then((data) => {
    boardCache.set(`daily:${d}:today`, { at: Date.now(), data });
  }, () => {});
  Promise.all([check, shown]).then(() => {
    if (level.id !== d || !$('result-verify').dataset.state || replay) return;
    setVerify('ok', 'Verified by the server');
    setDetail(`Verified · ${place}${streak}`);
    $('result').classList.toggle('is-record', Boolean(info.rank && info.rank <= (answer.top || 20)));
    announce(`Verified by the server. ${place}${streak}.`);
  });
  note('ok', `Daily win verified by the server: ${place}.`);
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
    practice: 'Practice, not ranked',
  }[answer.why] || 'Not ranked';
}

/**
 * A ranked win: the move answer already says it counted. Show a short "verifying" step while the all-time board is
 * fetched into the cache for the scores sheet, then the check and the rank (whether or not that fetch worked).
 */
function verifyWin(answer) {
  const detail = $('result-detail');
  const d = level.id;
  const v = game.noGuess ? 'ng' : 'classic';
  const settled = rankedText(answer) || { text: 'Verified', board: false };
  setVerify('busy', 'Verifying with the server');
  setDetail('Verifying with the server…');
  const shown = new Promise((r) => setTimeout(r, 350)); // long enough to read as a step, not a flicker
  const check = api.board(d, 'all', store.player.pid, v).then((data) => {
    boardCache.set(`${d}:${v}:all`, { at: Date.now(), data });
    return true;
  }, () => false);
  Promise.all([check, shown]).then(() => {
    if (level.id !== d || !$('result-verify').dataset.state) return;
    setVerify('ok', 'Verified by the server');
    setDetail(`Verified · ${settled.text}`);
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
  lastMove = i;
  if (game.view[i] === OPEN) {
    if (!canChord(game, i)) {
      if (game.adjacent[i]) hint(i);
      return false;
    }
    const flags = neighbours(game, i).filter((j) => game.view[j] === FLAG);
    markPending(chordTargets(game, i));
    const move = [1, i, flags];
    served = true;
    logMove(MOVE.chord, i, move);
    remote.send(move);
    return true;
  }
  if (game.status === 'ready') {
    game.status = 'playing'; // optimistic: the clock starts on the tap, not on the answer
    clockStart();
  }
  markPending([i]);
  const move = [0, i];
  served = true;
  logMove(MOVE.open, i, move);
  remote.send(move);
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
  if (answer.v === 'classic') fellBack('The server could not make a no-guess board this time. This game is classic.');
  if (daily && answer.daily) dailyAnswer(answer.daily);
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

/**
 * The server is gone (or refused the game): carry on locally, unranked, without losing a tap. In the replay log the
 * moves it never answered make way for an `offline` mark (replay.js's goneOffline), and are logged again below as
 * the page makes them, after any marks placed while they waited, which is the order they really took effect in.
 */
function goOffline(unanswered, why = null) {
  dropRemote();
  mode = 'offline';
  drawNet();
  moveLog = goneOffline(moveLog, unanswered.map((m) => loggedAt.get(m)).filter((k) => k !== undefined), Math.round(elapsed()));
  let message = why || 'The leaderboard cannot be reached. This game continues offline and is not ranked.';
  if (game.status === 'playing' && game.opened === 0) {
    game.status = 'ready'; // the first click never got an answer: lay mines locally around it instead
  } else if (game.status === 'playing') {
    if (!completeLayout(game)) {
      announce('Connection lost, and this board cannot continue offline.');
      $('result-title').textContent = 'Connection lost';
      setDetail('It cannot go on offline.');
      $('dock-play').hidden = true;
      $('result').hidden = false;
      clockStop();
      game.status = 'lost';
      store.setCurrent(null);
      return;
    }
    if (game.noGuess) {
      // Mines that agree with the screen, but nothing more: no longer a promise that logic sees it through.
      message = 'The leaderboard cannot be reached. This game continues offline, unranked, and may need a guess.';
      fellBack(message);
    }
  }
  announce(message);
  persist();
  // Replay the moves the server never answered, on the local board now: an open and a chord both come down to
  // a primary press on their cell.
  for (const [, i] of unanswered) primary(i, { again: true });
}

/**
 * A ranked game saved before a reload (a daily one too): ask the server what is open, then carry on. Also how a
 * counted daily under way in another tab is picked up (`saved.partial`: its moves so far are not in this page's log).
 */
function resumeRemote(saved) {
  if (!api || !RANKED_LEVELS.has(saved.difficulty) || !store.player.token) return false;
  level = levelFor(saved.difficulty);
  game = createGame({ ...level, noGuess: saved.remote.v === 'ng' });
  const d = saved.daily;
  daily = d && typeof d.day === 'string' && Number.isInteger(d.start)
    ? { day: d.day, start: d.start, first: d.counted !== false, why: null, counted: typeof d.counted === 'boolean' ? d.counted : null, blocked: null }
    : null;
  bucket = bucketOf();
  resetAids(saved);
  mode = 'connecting';
  restoring = true;
  cursor = indexOf(game, Math.floor(game.width / 2), Math.floor(game.height / 2));
  start();
  const { id, seq } = saved.remote;
  api.state(id, store.player.token).then((state) => {
    if (restoring && daily && state.st === 'ready') {
      // A daily whose first tap never reached the server: nothing was used, so it is simply dealt again.
      restoring = false;
      store.setCurrent(null);
      newGame(level.id, { daily: true });
      return;
    }
    if (!restoring || state.st !== 'playing') throw new Error('not resumable');
    game.status = 'playing';
    if (daily && state.daily) Object.assign(daily, { day: state.daily.day, start: state.daily.start });
    if (state.v === 'classic' && game.noGuess) { game.noGuess = false; bucket = bucketOf(); } // it fell back earlier
    for (let k = 0; k + 1 < state.o.length; k += 2) {
      const i = state.o[k];
      game.view[i] = OPEN;
      game.adjacent[i] = state.o[k + 1];
      game.opened++;
    }
    for (const i of saved.flags || []) if (game.view[i] !== OPEN) { game.view[i] = FLAG; game.flags++; }
    for (const i of saved.questions || []) if (game.view[i] !== OPEN) game.view[i] = QUESTION;
    // The server's batch number wins over the saved one: an answer may have been on its way when the page went.
    if (daily && typeof state.daily?.counted === 'boolean') daily.counted = state.daily.counted;
    const r = RemoteGame.resume(api, store.player.token, level.id, id, state.s ?? seq, {
      onAnswer: (answer, batch) => { if (remote === r) applyAnswer(answer, batch); },
      onLost: (error, unanswered) => {
        if (remote !== r) return;
        if (daily) dailyLost(error, unanswered);
        else goOffline(unanswered);
      },
    }, game.noGuess ? 'ng' : 'classic', daily && { day: daily.day, start: daily.start });
    remote = r;
    mode = 'ranked';
    restoring = false;
    clockReset(state.ms || 0);
    clockStart();
    start();
  }).catch(() => {
    if (!restoring) return;
    restoring = false;
    store.setCurrent(null);
    if (saved.partial) {
      // The game under way elsewhere ended or went meanwhile: this tab never played it. Deal today's daily again.
      newGame(level.id, { daily: true });
      return;
    }
    // Expired or unreachable: this one cannot be finished. It counts as walked away from.
    store.record(bucket, { won: false, abandoned: true, practice: isPractice(), clicks });
    game = null;
    daily = null;
    newGame(level.id);
  });
  return true;
}

/**
 * The rank line of a ranked win (verifyWin, its only caller, sees no other kind): its place in the last 24 h and of
 * all time where that is on the board (the top `top`), else its place worldwide. `board` says whether it shows on any
 * of the boards. Null when the answer has no rank.
 */
function rankedText(answer) {
  const { rank, top = 20 } = answer;
  if (!rank) return null;
  const parts = [];
  if (rank.day <= top) parts.push(`#${rank.day} in 24 h`);
  if (rank.all <= top) parts.push(`#${rank.all} all time`);
  if (!parts.length) parts.push(`#${rank.all} worldwide`);
  return { text: parts.join(' · '), board: rank.day <= top || rank.week <= top || rank.all <= top };
}

function afterRankedWin(answer) {
  lastGlobal = { d: level.id, v: daily ? 'daily' : game.noGuess ? 'ng' : 'classic', ms: answer.ms };
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
  // A hint's cell, after an avoidable loss the safe cell there was, and before the daily's first tap its opening: the
  // same ring, so they read as one idea (this cell is safe).
  if (clue && i === clue.i) {
    cls += clue.safe ? ' is-clue' : ' is-clue is-guess';
    label += clue.safe ? ', hint: safe' : ', hint: the safest guess';
  } else if (i === safeMark) {
    cls += ' is-clue is-mark';
    label += ', was safe';
  } else if (daily && !replay && !daily.blocked && game.status === 'ready' && i === daily.start) {
    cls += ' is-clue is-start';
    label += ', today’s opening: any tap opens it';
  }
  if (i === cursor) cls += ' is-cursor';
  if (el._static && !(clue && i === clue.i)) cls += ' no-anim'; // a hint's ring pulses even on a restored board
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
    fitDetails();
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
  if (replay || over() || i < 0) return setPressed([]);
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
  resumeTickAudio(); // unlock the iPhone click before a long-press timer would need it
  lastTouch = Date.now();
  board.classList.remove('kbd');
  if (press) { // a second finger: this is a pinch or a pan, not a move
    endPress();
    return;
  }
  const i = cellAt(e.target);
  if (i < 0 || over() || replay) return;
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
  if (e.altKey || e.metaKey || e.ctrlKey || replay) return; // the viewer's keys are the page's, below
  const p = displayOf(cursor);
  const step = e.shiftKey ? 5 : 1;
  const keys = {
    ArrowLeft: () => moveCursor(-step, 0), ArrowRight: () => moveCursor(step, 0),
    ArrowUp: () => moveCursor(0, -step), ArrowDown: () => moveCursor(0, step),
    Home: () => moveCursor(0, p.r, true), End: () => moveCursor(layout.cols - 1, p.r, true),
    ' ': () => (over() ? again() : primary(cursor)),
    Enter: () => (over() ? again() : primary(cursor)),
    f: () => (game.view[cursor] === OPEN ? primary(cursor) : secondary(cursor)),
  };
  const run = keys[e.key.length === 1 ? e.key.toLowerCase() : e.key];
  if (!run) return;
  e.preventDefault();
  board.classList.add('kbd'); // the cursor is drawn only once the keyboard is in use; a click or tap hides it
  run();
});
board.addEventListener('focus', () => paint(cursor));

// From anywhere on the page, but not in a sheet or a text field: N or F2 starts again, H asks for a hint, D opens
// or closes the details of a finished game, S the statistics, and Escape closes the details. While a replay is
// open, its own keys (replayKey) come first.
document.addEventListener('keydown', (e) => {
  if (e.altKey || e.metaKey || e.ctrlKey || document.querySelector('dialog[open]')) return;
  const key = e.key.length === 1 ? e.key.toLowerCase() : e.key;
  if (replay && (replayKey(e) || !['n', 'F2', 's'].includes(key))) return;
  if (e.target instanceof HTMLInputElement) return;
  if (key === 'F2' || key === 'n') {
    e.preventDefault();
    restart();
  } else if (key === 's') {
    e.preventDefault();
    showStats();
  } else if (key === 'h') {
    e.preventDefault();
    giveHint();
  } else if (key === 'd' && over()) {
    e.preventDefault();
    showDetails(!detailsOpen);
  } else if (key === 'Escape' && detailsOpen) {
    showDetails(false);
  }
});

// ---------- controls ----------

/**
 * Giving up a counted daily under way (a new game, another level, the daily again) takes a second tap on the same
 * control within 3 s, like erasing the records: the first only says what the second would do, through `say`, since
 * there is no other try today. Returns whether the action may go ahead now.
 */
const GIVE_UP = 'Tap again to give up today’s daily: there is no other try today.';
let giveUpArmed = null; // { key, timer }
function mayGiveUp(key, say) {
  if (replay || !daily || isPractice() || game.status !== 'playing') return true;
  if (giveUpArmed?.key === key) {
    clearTimeout(giveUpArmed.timer);
    giveUpArmed = null;
    return true;
  }
  clearTimeout(giveUpArmed?.timer);
  giveUpArmed = { key, timer: setTimeout(() => { giveUpArmed = null; say(null); }, 3000) };
  say(GIVE_UP);
  return false;
}

/** The round button, N and F2: a new game. */
function restart() {
  if (mayGiveUp('restart', (text) => { if (text) hintTip(text, true); })) newGame(level.id);
}
/** The level sheet's line for the same: under its title, announced (role="status"). */
function levelNote(text) {
  const el = $('level-note');
  el.textContent = text || '';
  el.hidden = !text;
}
/**
 * Play again (and Space or Enter on a finished board): an ordinary game. Where the daily could not start: Try again
 * (the same unanswered game asked again, or a new daily game), or Continue here (the try under way elsewhere).
 */
function again() {
  if (daily?.kept) askAgain();
  else if (daily?.elsewhere) pickUpDaily();
  else if (daily?.blocked) newGame(level.id, { daily: true });
  else newGame(level.id);
}

$('btn-restart').addEventListener('click', restart);
$('btn-again').addEventListener('click', again);
$('btn-hint').addEventListener('click', giveHint);
$('btn-details').addEventListener('click', () => showDetails(!detailsOpen));
$('result-panel').addEventListener('click', (e) => {
  if (e.target.closest('#btn-watch') && lastReplay) openReplay(lastReplay);
  else if (e.target.closest('#btn-share')) shareResult();
});
// The details float over the board: a tap anywhere else puts them away.
document.addEventListener('pointerdown', (e) => {
  if (detailsOpen && !$('result').contains(e.target)) showDetails(false);
});
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

// Difficulty, and the daily challenge as the sheet's last row: it opens like Custom does, onto today's three boards.
let dailyOpen = false;
function renderLevels() {
  const host = $('levels');
  host.textContent = '';
  const options = [...Object.values(DIFFICULTIES), { id: 'custom', label: 'Custom', ...sanitizeCustom(settings.custom) }];
  for (const l of options) {
    const b = document.createElement('button');
    b.type = 'button';
    b.className = 'level-option';
    if (l.id === level.id && !daily) b.setAttribute('aria-current', 'true'); // a daily is ticked on its own row
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
  $('custom-form').hidden = level.id !== 'custom' || Boolean(daily);
  renderDaily();
}

/** The daily row and, when it is open, today's three boards with how this device has done on them. */
function renderDaily() {
  const today = dayOf();
  const row = $('daily-row');
  const unplayed = !store.dailyPlayed(today);
  row.setAttribute('aria-expanded', String(dailyOpen));
  if (daily) row.setAttribute('aria-current', 'true');
  else row.removeAttribute('aria-current');
  row.querySelector('.level-option-dims').textContent = `${dayLabel(today)} · one board for everyone`;
  row.querySelector('.dot').hidden = !api || !unplayed;
  const streak = store.dailyStreak(today).now;
  row.querySelector('.level-option-best').textContent = streak ? `${streak}-day streak` : '';
  const group = $('daily-levels');
  group.hidden = !dailyOpen;
  if (!dailyOpen) return;
  const list = $('daily-list');
  list.textContent = '';
  $('daily-note').hidden = !api;
  if (!api) {
    const p = document.createElement('p');
    p.className = 'daily-note';
    p.textContent = DAILY_NO_SERVER;
    list.appendChild(p);
    return;
  }
  for (const l of Object.values(DIFFICULTIES)) {
    const b = document.createElement('button');
    b.type = 'button';
    b.className = 'daily-level';
    b.dataset.daily = l.id;
    if (daily && level.id === l.id) b.setAttribute('aria-current', 'true');
    const t = store.dailyTry(today, l.id);
    let state = 'Not played yet';
    if (t?.c && t.w && t.rk) state = `${formatTime(t.ms)} s${t.r ? ` · #${t.r}` : ''}`;
    else if (t?.c && t.w) state = 'Won, not ranked';
    else if (t?.c && t.w === 0) state = 'Mine hit';
    else if (t) state = 'Played';
    b.innerHTML = `<svg class="icon icon-sm" aria-hidden="true"><use href="#i-check"/></svg>
      <span class="daily-level-name"></span><span class="daily-level-state"></span>`;
    b.querySelector('.daily-level-name').textContent = l.label;
    const st = b.querySelector('.daily-level-state');
    st.textContent = t ? `${state} · again for practice` : state;
    if (!t) st.insertAdjacentHTML('afterbegin', '<span class="dot" aria-hidden="true"></span>');
    b.setAttribute('aria-label', `Daily, ${l.label}: ${t ? `${state}. Play again for practice` : 'not played yet. Your first try counts'}`);
    list.appendChild(b);
  }
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
  if (!mayGiveUp(`level:${b.dataset.level}`, levelNote)) return;
  $('dlg-level').close();
  newGame(b.dataset.level);
});
$('custom-form').addEventListener('input', updateCustomHints);
$('custom-form').addEventListener('submit', (e) => {
  e.preventDefault();
  if (!mayGiveUp('custom', levelNote)) return;
  const custom = sanitizeCustom({ width: $('custom-width').value, height: $('custom-height').value, mines: $('custom-mines').value });
  settings = store.updateSettings({ custom });
  $('dlg-level').close();
  newGame('custom');
});
$('daily-row').addEventListener('click', () => {
  dailyOpen = !dailyOpen;
  renderDaily();
  if (dailyOpen) $('daily-levels').querySelector('button')?.focus();
});
$('daily-levels').addEventListener('click', (e) => {
  const b = e.target.closest('[data-daily]');
  if (b) {
    if (!mayGiveUp(`daily:${b.dataset.daily}`, levelNote)) return;
    $('dlg-level').close();
    newGame(b.dataset.daily, { daily: true });
  } else if (e.target.closest('#daily-board')) {
    $('dlg-level').close();
    showScores({ variant: 'daily' });
  }
});
/** The level sheet; `focusDaily` opens it on the daily (a shared daily link, #daily). Seeing it puts the badge away. */
function showLevels({ focusDaily = false } = {}) {
  if (focusDaily || daily) dailyOpen = true;
  levelNote(null);
  renderLevels();
  openSheet('dlg-level');
  settings = store.updateSettings({ dailySeen: dayOf() });
  drawLevel();
  if (focusDaily) $('daily-row').focus();
}
$('btn-level').addEventListener('click', () => showLevels());

// Best times and stats
let scoreTab = null;
let scoreVariant = 'classic'; // which boards the sheet shows: 'classic', 'ng' (no guessing) or 'daily', each with its tabs

/** The game the sheets talk about: the one in play, or the one put aside while a replay is open. */
const liveGame = () => (replay ? replay.stash : { game, level, bucket, daily });
/** The kind of board a bucket is: 'classic', 'ng' or 'daily'. */
const variantOf = (b) => { const p = parseBucket(b); return p.daily ? 'daily' : p.noGuess ? 'ng' : 'classic'; };
/** The same level's bucket on another kind of board (the daily has only the three levels: a custom one goes to Beginner). */
function sameLevelIn(b, variant) {
  const { difficulty, width, height, mines } = parseBucket(b);
  if (variant === 'daily' && !RANKED_LEVELS.has(difficulty)) return bucketFor('beginner', DIFFICULTIES.beginner, { daily: true });
  return bucketFor(difficulty, { width, height, mines }, { noGuess: variant === 'ng', daily: variant === 'daily' });
}

/**
 * The tabs of one kind of board, for the scores and the statistics sheets: a tab per level, and per custom board
 * played (the daily has the three levels only).
 */
function tabsFor(variant) {
  const noGuess = variant === 'ng';
  const isDaily = variant === 'daily';
  const tabs = Object.values(DIFFICULTIES).map((d) => ({ bucket: bucketFor(d.id, d, { noGuess, daily: isDaily }), label: d.label, title: d.label }));
  if (isDaily) return tabs;
  const customs = new Set(store.customBuckets().filter((b) => parseBucket(b).noGuess === noGuess));
  const live = liveGame();
  if (live.level.id === 'custom' && !live.daily && live.game.noGuess === noGuess) customs.add(live.bucket);
  for (const b of customs) {
    const { width: w, height: h, mines: m } = parseBucket(b);
    tabs.push({ bucket: b, label: `${w}×${h}·${m}`, title: `Custom ${w} × ${h}, ${m} mines` });
  }
  return tabs;
}

/** A tab bar for `tabs` in `host`, `selected` chosen; each tab's id is `prefix-bucket`. */
function drawTabs(host, tabs, selected, prefix) {
  host.textContent = '';
  for (const t of tabs) {
    const b = document.createElement('button');
    b.type = 'button';
    b.className = 'tab';
    b.setAttribute('role', 'tab');
    b.id = `${prefix}-${t.bucket}`;
    b.setAttribute('aria-selected', String(t.bucket === selected));
    b.tabIndex = t.bucket === selected ? 0 : -1;
    b.title = t.title;
    b.textContent = t.label;
    b.dataset.bucket = t.bucket;
    host.appendChild(b);
  }
}
const pressVariant = (host, variant) => {
  for (const b of host.querySelectorAll('[data-variant]')) b.setAttribute('aria-pressed', String(b.dataset.variant === variant));
};

// The periods of the global boards: the ordinary ones, and the daily's two days (Oslo time).
const SCOPES = {
  board: [['day', '24 h'], ['week', '7 days'], ['all', 'All time'], ['device', 'This device']],
  daily: [['today', 'Today'], ['yesterday', 'Yesterday'], ['device', 'This device']],
};

/**
 * The scores sheet: a tab per level and per custom board played, then the global board (ranked levels, when there
 * is a server, unless "This device" is picked), the daily board of today or yesterday, or this device's times and
 * stats.
 */
function renderScores() {
  const tabs = tabsFor(scoreVariant);
  if (!tabs.some((t) => t.bucket === scoreTab)) scoreTab = tabs.some((t) => t.bucket === bucket) ? bucket : tabs[0].bucket;
  pressVariant($('score-variant'), scoreVariant);
  drawTabs($('score-tabs'), tabs, scoreTab, 'tab');
  const panel = $('score-panel');
  panel.setAttribute('aria-labelledby', `tab-${scoreTab}`);
  const { difficulty } = parseBucket(scoreTab);
  const isDaily = scoreVariant === 'daily';
  const scopes = isDaily ? SCOPES.daily : SCOPES.board;
  if (!scopes.some(([id]) => id === scoreScope)) scoreScope = isDaily ? 'today' : 'all';
  const global = api && RANKED_LEVELS.has(difficulty);
  panel.textContent = '';
  if (global) {
    const chips = document.createElement('div');
    chips.className = 'scopes';
    chips.setAttribute('aria-label', 'Show');
    for (const [id, label] of scopes) {
      const b = document.createElement('button');
      b.type = 'button';
      b.className = id === 'device' ? 'scope scope-device' : 'scope';
      b.dataset.scope = id;
      b.setAttribute('aria-pressed', String(scoreScope === id));
      b.textContent = label;
      chips.appendChild(b);
    }
    panel.appendChild(chips);
    if (scoreScope !== 'device') {
      return isDaily ? renderDailyBoard(panel, difficulty, scoreScope) : renderGlobal(panel, difficulty, scoreScope, scoreVariant);
    }
  }
  renderDevice(panel);
}

const boardCache = new Map(); // "difficulty:variant:period" (and "daily:difficulty:day") → { at, data }
let scoreScope = 'all';
let boardRequest = 0;

/** A global board's entries as a list: `{ r: rank, n: name, d: 1 for a default name, ms, me: true for this device }`. */
function entriesList(entries, label) {
  const ol = document.createElement('ol');
  ol.className = 'times global';
  ol.setAttribute('aria-label', label);
  for (const e of entries) {
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
  return ol;
}

/** A board answer from the cache if it is under 15 s old, else from `load()`, kept under `key`. */
async function cachedBoard(key, load) {
  const cached = boardCache.get(key);
  if (cached && Date.now() - cached.at < 15e3) return cached.data;
  const data = await load();
  boardCache.set(key, { at: Date.now(), data });
  return data;
}

/**
 * The global board for difficulty `d`, variant `v` and period `p` (server/src/store.js); the answer's own `v` says
 * which board it is.
 */
async function renderGlobal(panel, d, p, v) {
  const list = document.createElement('div');
  list.className = 'board-list';
  list.setAttribute('aria-live', 'polite');
  panel.appendChild(list);
  const request = ++boardRequest;
  const key = `${d}:${v}:${p}`;
  if (!boardCache.has(key)) list.innerHTML = '<p class="loading">Loading the global board…</p>';
  let data;
  try {
    data = await cachedBoard(key, () => api.board(d, p, store.player.pid, v));
  } catch {
    if (request !== boardRequest) return;
    list.innerHTML = '<p class="empty">The global board cannot be reached right now. Switch to This device for your own times.</p>';
    return;
  }
  if (request !== boardRequest) return; // the tab changed while this was loading
  list.textContent = '';
  // A server from before no-guess boards ignores v and sends its classic board, without a v: not this one.
  if (v === 'ng' && data.v !== 'ng') {
    list.innerHTML = '<p class="empty">The leaderboard server has no no-guess boards yet. Switch to Classic, or to This device for your own times.</p>';
    return;
  }
  if (!data.e.length) {
    const when = p === 'day' ? 'in the last 24 hours' : p === 'week' ? 'this week' : 'yet';
    const how = v === 'ng' ? ' with No guessing on' : '';
    const kind = v === 'ng' ? 'no-guess ' : '';
    list.innerHTML = `<p class="empty">No ranked ${kind}wins ${when}. Win a ${DIFFICULTIES[d].label} game${how} to be first.</p>`;
  } else {
    list.appendChild(entriesList(data.e, `Global best times, ${DIFFICULTIES[d].label}${v === 'ng' ? ', no guessing' : ''}`));
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

/**
 * The daily board of difficulty `d` for `p` ('today' or 'yesterday'): the first tries' wins, timed by the server, with
 * this device's own try and its daily streak beneath.
 */
async function renderDailyBoard(panel, d, p) {
  const list = document.createElement('div');
  list.className = 'board-list';
  list.setAttribute('aria-live', 'polite');
  panel.appendChild(list);
  const request = ++boardRequest;
  const key = `daily:${d}:${p}`;
  if (!boardCache.has(key)) list.innerHTML = '<p class="loading">Loading the daily board…</p>';
  let data;
  try {
    data = await cachedBoard(key, () => api.daily(d, p, store.player.pid));
  } catch (e) {
    if (request !== boardRequest) return;
    const why = e?.status === 404 ? DAILY_OLD[1] : 'The daily board cannot be reached right now.';
    list.innerHTML = `<p class="empty">${why} Switch to This device for your own daily times.</p>`;
    return;
  }
  if (request !== boardRequest) return;
  list.textContent = '';
  const label = DIFFICULTIES[d].label;
  if (!data.e.length) {
    list.innerHTML = p === 'today'
      ? `<p class="empty">No daily wins at ${label} yet today. Be the first: Daily challenge, in the level picker.</p>`
      : `<p class="empty">Nobody won yesterday’s ${label} daily.</p>`;
  } else {
    list.appendChild(entriesList(data.e, `Daily board of ${dayLabel(data.day)}, ${label}`));
  }
  const parts = [`${dayLabel(data.day)}, Oslo time. Each player's first try only, timed by the server.`];
  if (data.n) parts.push(`${data.n} ${data.n === 1 ? 'player has' : 'players have'} played it.`);
  const mine = data.me;
  if (mine && !data.e.some((e) => e.me)) parts.push(mine.won && mine.r ? `Yours: #${mine.r}, ${formatTime(mine.ms)} s.` : mine.won ? 'Yours: won, not ranked.' : 'Yours: not won.');
  if (data.streak) parts.push(`Your daily streak: ${data.streak.now} ${data.streak.now === 1 ? 'day' : 'days'}, best ${data.streak.best}.`);
  const note = document.createElement('p');
  note.className = 'scores-note';
  note.textContent = parts.join(' ');
  list.appendChild(note);
}

/** A small play button for a kept replay, in a list row. */
function replayButton(id, label) {
  const b = document.createElement('button');
  b.type = 'button';
  b.className = 'row-btn';
  b.dataset.replay = id;
  b.setAttribute('aria-label', label);
  b.title = 'Watch the replay';
  b.innerHTML = '<svg class="icon icon-sm" aria-hidden="true"><use href="#i-play"/></svg>';
  return b;
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
      // A kept replay: watch it from here (replays of the best times are kept; records.js).
      if (t.r && store.replay(t.r)) li.appendChild(replayButton(t.r, `Watch the replay of ${formatTime(t.ms)} seconds, ${formatDate(t.date)}`));
      else li.insertAdjacentHTML('beforeend', '<span class="row-btn-space" aria-hidden="true"></span>');
      ol.appendChild(li);
    });
    panel.appendChild(ol);
  }
  // Wins with a hint count as played, not won (records.js): say so, or the numbers would look wrong.
  const helped = s.assisted ? ` ${s.assisted} ${s.assisted === 1 ? 'win' : 'wins'} with a hint counted as played, not won.` : '';
  panel.insertAdjacentHTML('beforeend', `<p class="scores-note">Times in seconds. Kept in this browser only.${helped}</p>`);
}
$('score-panel').addEventListener('click', (e) => {
  const r = e.target.closest('[data-replay]');
  if (r) return openReplay(r.dataset.replay);
  const b = e.target.closest('.scope');
  if (!b) return;
  scoreScope = b.dataset.scope;
  renderScores();
  document.querySelector(`.scope[data-scope="${scoreScope}"]`)?.focus();
});
$('score-variant').addEventListener('click', (e) => {
  const b = e.target.closest('[data-variant]');
  if (!b || b.dataset.variant === scoreVariant) return;
  scoreVariant = b.dataset.variant;
  scoreTab = sameLevelIn(scoreTab, scoreVariant); // the same level on the other kind of board
  renderScores();
  b.focus();
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
  const tabs = tabsFor(scoreVariant);
  const at = tabs.findIndex((t) => t.bucket === scoreTab);
  scoreTab = tabs[(at + (e.key === 'ArrowRight' ? 1 : tabs.length - 1)) % tabs.length].bucket;
  renderScores();
  $(`tab-${scoreTab}`).focus();
});
/** The scores sheet on this game's board (or `variant`'s, for the same level). */
function showScores({ variant = null } = {}) {
  const live = liveGame();
  scoreTab = live.bucket;
  scoreVariant = variantOf(scoreTab);
  if (variant && variant !== scoreVariant) {
    scoreVariant = variant;
    scoreTab = sameLevelIn(scoreTab, variant);
  }
  // Straight after a win, show where it landed: the global board for a ranked one, this device otherwise.
  if (lastRecord && !lastGlobal) scoreScope = 'device';
  if (lastGlobal && lastGlobal.d === live.level.id && lastGlobal.v === scoreVariant && scoreScope === 'device') scoreScope = scoreVariant === 'daily' ? 'today' : 'all';
  renderScores();
  openSheet('dlg-scores');
  const fresh = document.querySelector('.times .is-new');
  if (fresh) fresh.scrollIntoView({ block: 'nearest' });
}
$('btn-scores').addEventListener('click', () => showScores());
$('btn-stats').addEventListener('click', () => showStats(scoreTab));
// S opens the statistics from the scores sheet too, as its button says (elsewhere the page's own keys do it).
$('dlg-scores').addEventListener('keydown', (e) => {
  if (e.altKey || e.metaKey || e.ctrlKey || e.target instanceof HTMLInputElement || e.key.toLowerCase() !== 's') return;
  e.preventDefault();
  showStats(scoreTab);
});

// Statistics: this device's history per level and kind of board, from records.js: the totals, best and average,
// the trends of the last wins (charts.js) and the recent games, with their replays where kept.
let statsTab = null;
let statsVariant = 'classic';

/** The statistics sheet, on `on` (a bucket; this game's when left out). */
function showStats(on = liveGame().bucket) {
  statsTab = on;
  statsVariant = variantOf(on);
  for (const d of document.querySelectorAll('dialog[open]')) if (d.id !== 'dlg-stats') d.close();
  openSheet('dlg-stats');
  renderStats();
}

const MONTH_NAMES = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
/** "1 Oct, 14:02", in this device's time. */
function formatWhen(ms) {
  const d = new Date(ms);
  return `${d.getDate()} ${MONTH_NAMES[d.getMonth()]}, ${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
}
const mean = (list) => list.reduce((a, b) => a + b, 0) / list.length;
// 3BV per second only for a win of a tenth of a second or more (the page's own resolution): a board the first click
// clears in no time has no speed worth charting.
const rateOf = (g) => (g.bbbv && g.ms >= 100 ? g.bbbv / (g.ms / 1000) : null);
const efficiencyOf = (g) => (g.bbbv && g.clicks ? g.bbbv / g.clicks : null);

function renderStats() {
  const tabs = tabsFor(statsVariant);
  if (!tabs.some((t) => t.bucket === statsTab)) statsTab = tabs[0].bucket;
  pressVariant($('stats-variant'), statsVariant);
  drawTabs($('stats-tabs'), tabs, statsTab, 'stab');
  const panel = $('stats-panel');
  panel.setAttribute('aria-labelledby', `stab-${statsTab}`);
  panel.textContent = '';
  const isDaily = statsVariant === 'daily';
  const s = store.stats(statsTab);
  const games = store.history(statsTab);
  const counted = games.filter((g) => !g.practice);
  const wins = counted.filter((g) => g.won && g.ms > 0);
  const clean = wins.filter((g) => !g.hinted);
  const best = store.times(statsTab)[0]?.ms;
  const rates = clean.map(rateOf).filter((v) => v !== null);
  const effs = clean.map(efficiencyOf).filter((v) => v !== null);
  const days = isDaily ? store.dailyStreak(dayOf()) : null;
  const stat = (label, value) => `<div><dt>${label}</dt><dd>${value}</dd></div>`;
  panel.insertAdjacentHTML('beforeend', `<dl class="stats">${[
    stat('Played', s.played), stat('Won', s.won), stat('Win rate', s.played ? `${Math.round(winRate(s) * 100)}%` : '–'),
    stat('Streak', isDaily ? days.now : s.streak), stat('Best streak', isDaily ? days.best : s.bestStreak),
  ].join('')}</dl><dl class="stats stats-4">${[
    stat('Best time', best ? formatTime(best) : '–'),
    stat('Average', clean.length ? formatTime(mean(clean.map((g) => g.ms))) : '–'),
    stat('3BV/s', rates.length ? mean(rates).toFixed(2) : '–'),
    stat('Efficiency', effs.length ? `${Math.round(mean(effs) * 100)}%` : '–'),
  ].join('')}</dl>`);

  const trends = document.createElement('h3');
  trends.textContent = 'Over time';
  panel.appendChild(trends);
  const points = wins.filter((g) => rateOf(g) !== null && g.clicks > 0).slice(-24);
  if (points.length >= 2) {
    const describe = (title, fmt) => ({ best: b, avg, first, last, n }) => (b === null
      ? `${title} of your last ${n} wins, all with a hint: from ${fmt(first)} to ${fmt(last)}.`
      : `${title} of your last ${n} wins, oldest to newest: from ${fmt(first)} to ${fmt(last)}; best ${fmt(b)}, average ${fmt(avg)}.`);
    const seconds = (v) => `${formatTime(v * 1000)} s`; // truncated to the tenth, like every time on the page
    const rate = (v) => v.toFixed(2);
    const pct = (v) => `${Math.round(v)}%`;
    panel.appendChild(trendFigure(document, {
      width: panel.clientWidth || 320,
      caption: `Your last ${points.length} wins here, oldest on the left.`,
      games: points.map((g) => ({ when: formatWhen(g.at), hinted: g.hinted })),
      metrics: [
        { title: 'Time', values: points.map((g) => g.ms / 1000), format: seconds, better: 'low', describe: describe('Time', seconds) },
        { title: '3BV/s', values: points.map(rateOf), format: rate, better: 'high', describe: describe('3BV per second', rate) },
        { title: 'Efficiency', values: points.map((g) => efficiencyOf(g) * 100), format: pct, better: 'high', describe: describe('Efficiency', pct) },
      ],
    }));
  } else {
    panel.insertAdjacentHTML('beforeend', `<p class="empty">${points.length
      ? 'One more win here and the trends begin: time, 3BV/s and efficiency.'
      : 'Win a game here and the trends begin: time, 3BV/s and efficiency.'}</p>`);
  }

  const recent = document.createElement('h3');
  recent.textContent = 'Recent games';
  panel.appendChild(recent);
  if (!games.length) {
    panel.insertAdjacentHTML('beforeend', '<p class="empty">No games here yet.</p>');
  } else {
    const ol = document.createElement('ol');
    ol.className = 'games';
    ol.setAttribute('aria-label', 'Recent games, newest first');
    for (const g of games.slice(-10).reverse()) {
      const li = document.createElement('li');
      const main = document.createElement('span');
      main.className = 'game-main';
      const result = document.createElement('span');
      result.className = 'game-result';
      result.textContent = g.abandoned ? 'Walked away' : g.won ? `Won · ${formatTime(g.ms)} s` : 'Mine hit';
      for (const tag of [g.practice && 'practice', g.hinted && 'hint', g.ranked && 'verified'].filter(Boolean)) {
        const t = document.createElement('span');
        t.className = 'tag';
        t.textContent = tag;
        result.appendChild(t);
      }
      const when = document.createElement('span');
      when.className = 'game-when';
      when.textContent = formatWhen(g.at);
      main.append(result, when);
      const facts = document.createElement('span');
      facts.className = 'game-facts';
      const rate = rateOf(g);
      facts.textContent = g.won && g.bbbv
        ? `3BV ${g.bbbv} · ${rate === null ? '–' : rate.toFixed(2)} 3BV/s · ${g.clicks ? `${Math.round(efficiencyOf(g) * 100)}%` : '–'} · ${g.clicks} clicks`
        : `${Math.floor(g.cleared * 100)}% cleared`;
      li.append(main, facts);
      if (g.replay && store.replay(g.replay)) li.appendChild(replayButton(g.replay, `Watch the replay of this game, ${formatWhen(g.at)}`));
      ol.appendChild(li);
    }
    panel.appendChild(ol);
  }
  const older = s.played - counted.length;
  const helped = s.assisted ? ` Wins with a hint count as played, not won, and are left out of the best and averages.` : '';
  const before = older > 0
    ? ` ${older} older ${older === 1 ? 'game counts' : 'games count'} in the totals, from before the history began${games.length ? ` (${formatDate(new Date(games[0].at).toISOString())})` : ''}.`
    : '';
  const practice = isDaily ? ' Daily streaks are days in a row with a ranked daily win, at any level. Practice tries are in the recent games only.' : '';
  panel.insertAdjacentHTML('beforeend', `<p class="scores-note">Kept in this browser only.${before}${helped}${practice}</p>`);
}
$('stats-panel').addEventListener('click', (e) => {
  const r = e.target.closest('[data-replay]');
  if (r) openReplay(r.dataset.replay);
});
$('stats-variant').addEventListener('click', (e) => {
  const b = e.target.closest('[data-variant]');
  if (!b || b.dataset.variant === statsVariant) return;
  statsVariant = b.dataset.variant;
  statsTab = sameLevelIn(statsTab, statsVariant);
  renderStats();
  b.focus();
});
$('stats-tabs').addEventListener('click', (e) => {
  const b = e.target.closest('.tab');
  if (!b) return;
  statsTab = b.dataset.bucket;
  renderStats();
  $(`stab-${statsTab}`).focus();
});
$('stats-tabs').addEventListener('keydown', (e) => {
  if (e.key !== 'ArrowLeft' && e.key !== 'ArrowRight') return;
  const tabs = tabsFor(statsVariant);
  const at = tabs.findIndex((t) => t.bucket === statsTab);
  statsTab = tabs[(at + (e.key === 'ArrowRight' ? 1 : tabs.length - 1)) % tabs.length].bucket;
  renderStats();
  $(`stab-${statsTab}`).focus();
});
// The charts are drawn to the sheet's width: again when that changes.
addEventListener('resize', () => { if ($('dlg-stats').open) requestAnimationFrame(renderStats); });
$('result').addEventListener('click', (e) => {
  if (e.target.closest('#btn-details')) return; // it has a job of its own
  if (e.target.closest('.result-text') && game.status === 'won') showScores();
});

// ---------- sharing ----------
// A phone shares through the system's sheet (navigator.share); anything else copies the text. Either way the words
// are share.js's, and nothing in them says where anything is on the board.

async function shareResult() {
  if (!shared) return;
  const url = `${location.origin}${location.pathname}${shared.daily ? '#daily' : ''}`;
  const text = shareText({ ...shared, url });
  if (touchCapable && typeof navigator.share === 'function') {
    try {
      await navigator.share({ text });
      return;
    } catch (e) {
      if (e?.name === 'AbortError') return; // closed without sharing
    }
  }
  if (await copyText(text)) hintTip('Copied to the clipboard', true);
  else hintTip('Could not copy: this browser keeps the clipboard to itself.', true);
}

/** The clipboard API where it is allowed, else the old way through a selected, off-screen text field. */
async function copyText(text) {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    const field = document.createElement('textarea');
    field.value = text;
    field.setAttribute('readonly', '');
    field.style.cssText = 'position:fixed;top:0;left:-9999px;opacity:0;-webkit-user-select:text;user-select:text';
    document.body.appendChild(field);
    field.select();
    let ok = false;
    try { ok = document.execCommand('copy'); } catch { /* not allowed either */ }
    field.remove();
    return ok;
  }
}

// ---------- replays ----------
// A kept game plays again on the board itself, read-only, with the clock showing its time: play and pause, a speed,
// and a scrubber that steps move by move. The game in play is put aside meanwhile and comes back as it was: a
// finished one with its result, a local one in progress with its clock (stopped while the replay is open), and one
// not started yet is simply dealt again. A ranked game in progress keeps the board: its clock is the server's.
// While the viewer is open, `game` is the playback's game (replay.js), which is what paint() and the rest draw.

const SPEEDS = [1, 2, 4, 0.5];

function openReplay(id) {
  const record = store.replay(id);
  if (!record) return hintTip('That replay is no longer kept.', true);
  const live = replay ? replay.stash.game : game;
  if (live.status === 'playing' && remote) return hintTip('Replays open between ranked games: this one’s clock is the server’s.', true);
  let pb;
  try {
    pb = new Playback(record);
  } catch {
    return hintTip('That replay cannot be read.', true);
  }
  for (const d of document.querySelectorAll('dialog[open]')) d.close();
  if (replay) closeReplay({ restore: false, keep: true });
  else {
    showDetails(false);
    if (game.status === 'playing') {
      clockStop();
      persist();
    } else if (game.status === 'ready') {
      dropRemote(); // dealt again on closing: nothing about it is lost
    }
    replay = { stash: {
      game, level, bucket, daily, analysis, safeMark, clue, cursor, elapsed: elapsed(),
      result: $('result').hidden, dock: $('dock-play').hidden, boardClass: board.className, over: app.classList.contains('is-over'),
    } };
  }
  Object.assign(replay, { pb, record, playing: false, speed: 1, t: 0, raf: 0, last: 0 });
  game = pb.game;
  level = record.level === 'custom' || !DIFFICULTIES[record.level]
    ? { id: 'custom', label: 'Custom', width: record.w, height: record.h, mines: record.m }
    : DIFFICULTIES[record.level];
  clue = null;
  safeMark = -1;
  cursor = indexOf(game, Math.floor(game.width / 2), Math.floor(game.height / 2));
  app.classList.add('is-replay');
  app.classList.remove('is-over');
  board.classList.remove('is-over', 'is-won', 'is-lost');
  $('result').hidden = true;
  $('dock-play').hidden = true;
  $('dock-replay').hidden = false;
  $('replay-range').max = String(pb.length);
  build();
  drawLevel();
  drawCounter();
  drawReplay();
  $('replay-play').focus({ preventScroll: true });
  announce(`Replay of ${record.label || level.label}, ${record.won ? `won in ${formatTime(record.ms)} seconds` : 'lost'}: ${pb.length} moves. Space plays and pauses, the arrow keys step, Escape closes.`);
}

/**
 * Close the viewer and bring back the game put aside (`restore`), or leave that to the caller (a new game is coming).
 * `keep` keeps the stash, for one replay opened straight after another.
 */
function closeReplay({ restore = true, keep = false } = {}) {
  if (!replay) return;
  cancelAnimationFrame(replay.raf);
  const { stash } = replay;
  if (keep) return;
  replay = null;
  app.classList.remove('is-replay');
  $('dock-replay').hidden = true;
  ({ game, level, bucket, daily, analysis, safeMark, clue, cursor } = stash);
  if (!restore) return;
  if (game.status === 'ready') {
    newGame(level.id, { daily: Boolean(daily) });
    return;
  }
  board.className = stash.boardClass;
  app.classList.toggle('is-over', stash.over);
  $('result').hidden = stash.result;
  $('dock-play').hidden = stash.dock;
  clockReset(stash.elapsed);
  if (game.status === 'playing' && document.visibilityState === 'visible') clockStart();
  build();
  drawLevel();
  drawCounter();
  drawHint();
  board.focus({ preventScroll: true });
  announce('Replay closed.');
}

/** The viewer's controls and clock, from where the playback is. */
function drawReplay() {
  const r = replay;
  if (!r) return;
  const { pb } = r;
  const atEnd = pb.frame >= pb.length;
  const t = atEnd ? r.record.ms : r.t;
  $('timer').textContent = pad3(Math.floor(t / 1000));
  const range = $('replay-range');
  range.value = String(pb.frame);
  range.setAttribute('aria-valuetext', `Move ${pb.frame} of ${pb.length}, ${formatTime(t)} seconds`);
  $('replay-step').textContent = `${pb.frame}/${pb.length}`;
  const play = $('replay-play');
  play.querySelector('use').setAttribute('href', r.playing ? '#i-pause' : '#i-play');
  play.setAttribute('aria-label', r.playing ? 'Pause' : atEnd ? 'Play again from the start' : 'Play');
  $('replay-speed').textContent = `${r.speed}×`;
  $('replay-speed').setAttribute('aria-label', `Speed: ${r.speed} times`);
}

/** The board's look at an end (every mine shown, the win's flags), or none mid-game, after a jump. */
function drawReplayEnd() {
  const st = game.status;
  board.classList.toggle('is-over', st === 'won' || st === 'lost');
  board.classList.toggle('is-won', st === 'won');
  board.classList.toggle('is-lost', st === 'lost');
}

/** One move forward, drawn the way the game drew it: an opening ripples, a mark plants. */
function stepReplay() {
  const res = replay.pb.next();
  if (!res) return;
  if (res.opened.length) paintOpened(res.opened);
  if (res.marked >= 0) {
    cells[res.marked]._static = false;
    paint(res.marked);
    refreshChordable(res.marked);
  }
  if (game.status !== 'playing') {
    drawReplayEnd();
    for (let i = 0; i < game.cells; i++) paint(i); // every mine, and any wrong flag, at the end
  }
  drawCounter();
}

/** Jump to move `k`: the board drawn as it then was, without animation. */
function seekReplay(k) {
  const r = replay;
  r.pb.seek(k);
  r.t = r.pb.timeAt(r.pb.frame);
  for (let i = 0; i < game.cells; i++) {
    cells[i]._static = true;
    paint(i);
  }
  drawReplayEnd();
  drawCounter();
  drawReplay();
}

function playReplay(on) {
  const r = replay;
  if (!r) return;
  if (on && r.pb.frame >= r.pb.length) seekReplay(0); // from the end, play from the start
  r.playing = on;
  r.last = 0;
  cancelAnimationFrame(r.raf);
  if (on) r.raf = requestAnimationFrame(tickReplay);
  drawReplay();
}

/** A frame of playback: the replay's clock runs at the chosen speed, and every move whose time has come is made. */
function tickReplay(now) {
  const r = replay;
  if (!r || !r.playing) return;
  r.t += r.last ? (now - r.last) * r.speed : 0;
  r.last = now;
  while (r.pb.frame < r.pb.length && r.pb.timeAt(r.pb.frame + 1) <= r.t) stepReplay();
  if (r.pb.frame >= r.pb.length) {
    r.playing = false;
    announce(`End of the replay: ${r.record.won ? `won in ${formatTime(r.record.ms)} seconds` : 'mine hit'}.`);
  } else {
    r.raf = requestAnimationFrame(tickReplay);
  }
  drawReplay();
}

/** The viewer's keys; true when the key was the viewer's. Arrows on the scrubber are its own (an input event). */
function replayKey(e) {
  const key = e.key.length === 1 ? e.key.toLowerCase() : e.key;
  const onRange = e.target === $('replay-range');
  const onButton = e.target instanceof HTMLButtonElement;
  const r = replay;
  const act = {
    ' ': onButton ? null : () => playReplay(!r.playing),
    k: () => playReplay(!r.playing),
    ArrowRight: onRange ? null : () => { playReplay(false); stepReplay(); r.t = r.pb.timeAt(r.pb.frame); drawReplay(); },
    ArrowLeft: onRange ? null : () => { playReplay(false); seekReplay(r.pb.frame - 1); },
    Home: onRange ? null : () => { playReplay(false); seekReplay(0); },
    End: onRange ? null : () => { playReplay(false); seekReplay(r.pb.length); },
    Escape: () => closeReplay(),
  }[key];
  if (!act) return key === ' ' || key.startsWith('Arrow') || key === 'Home' || key === 'End'; // the control's own
  e.preventDefault();
  act();
  return true;
}

$('replay-play').addEventListener('click', () => playReplay(!replay?.playing));
$('replay-close').addEventListener('click', () => closeReplay());
$('replay-speed').addEventListener('click', () => {
  const r = replay;
  if (!r) return;
  r.speed = SPEEDS[(SPEEDS.indexOf(r.speed) + 1) % SPEEDS.length];
  drawReplay();
});
$('replay-range').addEventListener('input', (e) => {
  if (!replay) return;
  const k = Number(e.target.value); // before pausing, which draws the range at the current move again
  playReplay(false);
  seekReplay(k);
});

// Settings
const qm = $('set-question');
const hp = $('set-haptics');
const ng = $('set-noguess');
const NOGUESS_NOTE = $('noguess-note').textContent;
ng.checked = settings.noGuess;
ng.addEventListener('change', () => {
  settings = store.updateSettings({ noGuess: ng.checked });
  // Nothing played yet: deal the other kind of board at once. A game under way keeps its own; the next one changes.
  if (game.status === 'ready' && !restoring) newGame(level.id);
  else $('noguess-note').textContent = `${NOGUESS_NOTE} From your next game.`;
});
qm.checked = settings.questionMarks;
hp.checked = settings.haptics && canBuzz;
hp.disabled = !canBuzz;
if (!canBuzz) {
  $('haptics-note').textContent = 'This browser cannot vibrate.';
} else if (!canVibrate) {
  // Honest about the platform: WebKit has no Vibration API; the click is the substitute, not a fake vibrate().
  $('haptics-note').textContent = 'A soft click when a long press places a flag. iPhone browsers have no Vibration API (WebKit never shipped it).';
}
qm.addEventListener('change', () => { settings = store.updateSettings({ questionMarks: qm.checked }); });
hp.addEventListener('change', () => {
  settings = store.updateSettings({ haptics: hp.checked });
  if (hp.checked) {
    resumeTickAudio();
    buzz(12);
  }
});
// Erasing takes two taps: the first arms the button for 4 s.
let resetArmed = 0;
$('btn-reset').addEventListener('click', () => {
  const b = $('btn-reset');
  if (!resetArmed) {
    b.textContent = 'Tap again to erase every time, stat and replay';
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
  lastReplay = null;
  b.textContent = 'Best times, stats and replays erased';
  b.classList.remove('is-armed');
});
$('btn-settings').addEventListener('click', () => {
  $('btn-reset').textContent = 'Reset best times and stats';
  $('noguess-note').textContent = NOGUESS_NOTE;
  openSheet('dlg-settings');
});
$('board-help').textContent = touchCapable
  ? 'Tap to open, long-press to flag.'
  : 'Right click flags. Click a number to clear around it. Arrows, Space, F and H work too.';

// ---------- visibility ----------

document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'visible' && game) drawDailyBadge(); // a new day may have begun
  if (!game || replay || game.status !== 'playing') return; // a replay's game is not one in play (its own is paused)
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
addEventListener('pagehide', () => { if (game && !replay && game.status === 'playing') persist(); });

// ---------- installed app ----------
// The service worker and its updates (pwa.js). An update applies itself on a fresh board, never mid-game.

const updateBtn = $('btn-update');
const pwa = initPwa({
  // A replay being watched counts as busy for a self-applied reload (it would close the viewer).
  status: () => (replay ? 'replay' : game ? game.status : undefined),
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
// A shared daily result links to #daily: the level sheet, open on the daily (nothing starts by itself).
if (location.hash === '#daily') {
  history.replaceState(null, '', location.pathname + location.search);
  showLevels({ focusDaily: true });
}

// For the end-to-end test: a read-only peek, nothing that changes the game.
window.__minesweeper = {
  apiBase: base,
  get state() {
    return { status: game.status, width: game.width, height: game.height, mines: game.mines, flags: game.flags, opened: game.opened, layout: { ...layout }, level: level.id };
  },
  mineIndices: () => [...game.mine].flatMap((m, i) => (m ? [i] : [])),
  get mode() { return mode; },
  get pending() { return pendingCells.size + (remote?.pending ? 1 : 0); },
  get noGuess() { return game.noGuess; },
  get hinted() { return hinted; },
  get clicks() { return clicks; },
  get clue() { return clue && { ...clue }; },
  get analysis() { return analysis && { ...analysis }; },
  latency: () => (api ? [...api.latency] : []),
  get lastGlobal() { return lastGlobal; },
  get daily() { return daily && { ...daily }; },
  get moves() { return moveLog.length; },
  get lastReplay() { return lastReplay; },
  get replay() { return replay && { frame: replay.pb.frame, length: replay.pb.length, playing: replay.playing, speed: replay.speed, t: replay.t }; },
};
