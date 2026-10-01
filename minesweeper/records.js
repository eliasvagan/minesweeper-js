/**
 * Best times, per-difficulty stats and settings, kept in localStorage, with the history of games and the replays of
 * the best ones beside them. The list and stat updates are pure functions (tested in test/records.test.mjs);
 * `openStore` wraps them around a storage backend that may be missing or full, in which case everything still
 * works for the session and simply is not remembered.
 *
 * No-guess boards are a different game from classic ones, so each level has a bucket per variant, and the daily
 * challenge a bucket of its own per level. A win that used a hint is filed honestly: a game played, not won, and no
 * best time (stats.assisted counts them). A daily played again after its first try is practice: it goes in the
 * history, marked so, and nowhere else, since its board was known.
 *
 * Three keys, so that the one written on every move stays small:
 *   minesweeper-js:v1        settings, best times, stats, the game in progress, the player, the daily log
 *   minesweeper-js:history   one compact row per finished game (the statistics sheet), written at the end of a game
 *   minesweeper-js:replays   the replays kept (replay.js), written at the end of a game
 * Saves from before the history and the replays simply have none yet: the totals and best times they kept still
 * show, and the history starts with the next game.
 */
import { streakOf } from './daily.js';

export const TOP = 10;
const KEY = 'minesweeper-js:v1';
const HISTORY_KEY = 'minesweeper-js:history';
const REPLAYS_KEY = 'minesweeper-js:replays';

/** Games kept in the history (the oldest go first): about 40 characters each, so some 40 KB at the most. */
export const HISTORY_MAX = 1000;
/**
 * Characters of replay data kept, all replays together. An Expert replay is 1 to 2 thousand, a Beginner one a few
 * hundred, so the ten best of every standard board fit with room to spare; past it, the lowest-ranked go first.
 */
export const REPLAY_BUDGET = 300000;
/** Days kept in the daily log, for the streak. */
export const DAILY_DAYS = 400;

export const DEFAULT_SETTINGS = Object.freeze({
  difficulty: 'beginner',
  custom: Object.freeze({ width: 20, height: 12, mines: 40 }),
  questionMarks: false,
  haptics: true,
  noGuess: false,
});

/**
 * The bucket a result belongs to: a named difficulty, or one exact custom board, with `:ng` after it for no-guess
 * boards and `:daily` for the daily challenge (always a no-guess board, on a ranked level). Classic buckets keep the
 * names they had before no-guess boards, so older saves still line up.
 */
export const bucketFor = (difficulty, { width, height, mines }, { noGuess = false, daily = false } = {}) => {
  if (daily) return `${difficulty}:daily`;
  return (difficulty === 'custom' ? `custom:${width}x${height}x${mines}` : difficulty) + (noGuess ? ':ng' : '');
};

/** bucketFor backwards: `{ difficulty, noGuess, daily }`, plus `width`, `height` and `mines` for a custom board. */
export function parseBucket(bucket) {
  if (bucket.endsWith(':daily')) return { difficulty: bucket.slice(0, -6), noGuess: true, daily: true };
  const noGuess = bucket.endsWith(':ng');
  const base = noGuess ? bucket.slice(0, -3) : bucket;
  if (!base.startsWith('custom:')) return { difficulty: base, noGuess, daily: false };
  const [width, height, mines] = base.slice(7).split('x').map(Number);
  return { difficulty: 'custom', noGuess, daily: false, width, height, mines };
}

/**
 * Insert a winning time into a best-times list. Returns the new list (at most TOP, fastest first; an equal
 * time ranks below the one already there) and the 1-based rank, or null when it did not make the list.
 */
export function addTime(list, entry, limit = TOP) {
  const next = [...(list || [])];
  let at = next.findIndex((e) => entry.ms < e.ms);
  if (at === -1) at = next.length;
  if (at >= limit) return { list: next.slice(0, limit), rank: null };
  next.splice(at, 0, entry);
  return { list: next.slice(0, limit), rank: at + 1 };
}

export const emptyStats = () => ({ played: 0, won: 0, streak: 0, bestStreak: 0, assisted: 0 });

/**
 * One finished (or abandoned) game. A win with a hint (`hinted`) is played but not won, and ends the streak: the win
 * rate and streaks count only wins without help. Otherwise a hint would be a way to keep a forced guess out of them.
 */
export function applyResult(stats, won, { hinted = false } = {}) {
  const s = { ...emptyStats(), ...(stats || {}) };
  s.played += 1;
  if (won && hinted) {
    s.assisted += 1;
    s.streak = 0;
  } else if (won) {
    s.won += 1;
    s.streak += 1;
    s.bestStreak = Math.max(s.bestStreak, s.streak);
  } else {
    s.streak = 0;
  }
  return s;
}

export const winRate = (stats) => (stats && stats.played ? stats.won / stats.played : 0);

// ---------- the history ----------
// One row per game, as an array to keep it small: [end (s since 1970), bucket, flags, ms, 3BV, clicks, % cleared,
// replay id or 0]. `flags` are the bits below. Rows older than this format are simply not there.

const FLAG_BITS = { won: 1, hinted: 2, practice: 4, ranked: 8, abandoned: 16 };

/** A history row from a game: `{ at (ms), bucket, won, hinted, practice, ranked, abandoned, ms, bbbv, clicks, cleared, replay }`. */
export function packGame(g) {
  let flags = 0;
  for (const [name, bit] of Object.entries(FLAG_BITS)) if (g[name]) flags |= bit;
  return [
    // A win's time is at least 1 ms, as on the best times: a board the first click clears takes no measurable time.
    Math.round((g.at ?? Date.now()) / 1000), g.bucket, flags, g.won ? Math.max(1, Math.round(g.ms || 0)) : Math.max(0, Math.round(g.ms || 0)), g.bbbv || 0, g.clicks || 0,
    Math.round(Math.min(1, Math.max(0, g.cleared ?? (g.won ? 1 : 0))) * 100), g.replay || 0,
  ];
}

/** packGame backwards, or null for a row that is not one (a damaged save). */
export function unpackGame(row) {
  if (!Array.isArray(row) || typeof row[1] !== 'string' || !Number.isFinite(row[0])) return null;
  const g = { at: row[0] * 1000, bucket: row[1] };
  for (const [name, bit] of Object.entries(FLAG_BITS)) g[name] = Boolean(row[2] & bit);
  Object.assign(g, { ms: row[3] || 0, bbbv: row[4] || 0, clicks: row[5] || 0, cleared: (row[6] || 0) / 100, replay: row[7] || null });
  return g;
}

/**
 * Everything saved under the main key, as one JSON document: settings; best times (`[{ ms, date, r }]`, `r` being
 * the replay's id while it is kept) and stats by bucket; `current`, the game in progress as app.js's persist()
 * writes it; `player`; and `daily`, this device's tries at the daily challenge by day and level:
 * `{ 'YYYY-MM-DD': { expert: { c, w, rk, ms, r } } }` (counted, won, ranked, time and rank, each as it became known).
 */
function freshState() {
  return { settings: { ...DEFAULT_SETTINGS, custom: { ...DEFAULT_SETTINGS.custom } }, times: {}, stats: {}, current: null, player: {}, daily: {} };
}
const freshReplays = () => ({ v: 1, last: null, items: {} });
const isObject = (v) => Boolean(v) && typeof v === 'object' && !Array.isArray(v);

function memoryBackend() {
  const m = new Map();
  return { getItem: (k) => (m.has(k) ? m.get(k) : null), setItem: (k, v) => m.set(k, String(v)), removeItem: (k) => m.delete(k) };
}

/** A new replay id: unique enough on one device (the time in base 36, and some randomness). */
const newReplayId = () => `${Date.now().toString(36)}${Math.floor(Math.random() * 36 ** 3).toString(36).padStart(3, '0')}`;

/** `backend` is anything with getItem/setItem/removeItem; left out, localStorage if it works, else memory. */
export function openStore(backend, { replayBudget = REPLAY_BUDGET, historyMax = HISTORY_MAX } = {}) {
  let storage = backend;
  if (storage === undefined) {
    // Probe with a write: where storage is blocked or refuses writes, this throws and the session runs in memory.
    try {
      storage = globalThis.localStorage;
      storage.setItem(`${KEY}:probe`, '1');
      storage.removeItem(`${KEY}:probe`);
    } catch {
      storage = memoryBackend();
    }
  }
  const read = (key) => {
    try {
      const raw = storage.getItem(key);
      return raw ? JSON.parse(raw) : null;
    } catch {
      return null; // unreadable: start that part clean rather than break the page
    }
  };
  let state = freshState();
  const saved = read(KEY);
  if (isObject(saved)) {
    // Defaults fill in whatever an older save lacks, settings.custom included.
    state = {
      settings: { ...state.settings, ...(saved.settings || {}), custom: { ...state.settings.custom, ...(saved.settings?.custom || {}) } },
      times: isObject(saved.times) ? saved.times : {},
      stats: isObject(saved.stats) ? saved.stats : {},
      current: saved.current || null,
      player: isObject(saved.player) ? saved.player : {},
      daily: isObject(saved.daily) ? saved.daily : {},
    };
  }
  const savedHistory = read(HISTORY_KEY);
  let history = Array.isArray(savedHistory?.games) ? savedHistory.games.filter((r) => unpackGame(r)) : [];
  const savedReplays = read(REPLAYS_KEY);
  let replays = isObject(savedReplays?.items) ? { ...freshReplays(), ...savedReplays } : freshReplays();

  const write = (key, value) => {
    try {
      storage.setItem(key, JSON.stringify(value));
      return true;
    } catch {
      return false; // quota or disabled storage: keep going in memory
    }
  };
  const save = () => write(KEY, state);
  const saveHistory = () => write(HISTORY_KEY, { v: 1, games: history });
  const saveReplays = () => {
    // Should the browser refuse even the budget, give up the oldest replays one by one rather than all of them.
    while (!write(REPLAYS_KEY, replays) && Object.keys(replays.items).length > 1) {
      const oldest = Object.keys(replays.items).filter((id) => id !== replays.last).sort((a, b) => (replays.items[a].at || 0) - (replays.items[b].at || 0))[0];
      if (!oldest) break;
      dropReplay(oldest);
    }
  };

  /** Forget a replay, and the best time's link to it. */
  function dropReplay(id) {
    delete replays.items[id];
    for (const list of Object.values(state.times)) for (const e of list) if (e.r === id) delete e.r;
  }

  /**
   * Keep the replays of the best times and of the last game, and nothing else; then, past the budget, drop those of
   * the lowest-ranked times first (a 10th place before a 9th), the oldest first among equals. The last game's replay
   * always stays.
   */
  function pruneReplays() {
    const rankOf = new Map();
    for (const list of Object.values(state.times)) {
      list.forEach((e, k) => { if (e.r) rankOf.set(e.r, Math.min(rankOf.get(e.r) ?? Infinity, k + 1)); });
    }
    if (replays.last) rankOf.set(replays.last, 0);
    for (const id of Object.keys(replays.items)) if (!rankOf.has(id)) dropReplay(id);
    let size = Object.values(replays.items).reduce((n, r) => n + JSON.stringify(r).length, 0);
    const drop = Object.keys(replays.items)
      .filter((id) => rankOf.get(id) > 0)
      .sort((a, b) => rankOf.get(b) - rankOf.get(a) || (replays.items[a].at || 0) - (replays.items[b].at || 0));
    for (const id of drop) {
      if (size <= replayBudget) break;
      size -= JSON.stringify(replays.items[id]).length;
      dropReplay(id);
    }
  }

  const dayEntries = (day) => (isObject(state.daily[day]) ? state.daily[day] : {});
  const statsOf = (bucket) => ({ ...emptyStats(), ...(state.stats[bucket] || {}) });

  return {
    get settings() {
      return state.settings;
    },
    updateSettings(patch) {
      state.settings = { ...state.settings, ...patch };
      save();
      return state.settings;
    },
    times: (bucket) => state.times[bucket] || [],
    stats: statsOf,
    /** Every custom bucket with a result: those with a best time first, by first win, then the rest, by first game. */
    customBuckets: () =>
      [...new Set([...Object.keys(state.times), ...Object.keys(state.stats)])].filter((b) => b.startsWith('custom:')),
    /**
     * File one finished (or abandoned) game. Returns the win's rank on the best times (or null), the bucket's stats,
     * and the id the game's replay is kept under (or null).
     *
     * A hinted win gets no time on the list (see applyResult). Practice (a daily played again) changes no stats and
     * no times: it is only in the history. `replay` (replay.js's makeReplay) is kept as the last game's, and for as
     * long as the time stays on the best times; `bbbv`, `clicks` and `cleared` (the share of safe cells opened) go
     * into the history, with `ranked` (verified by the server) and `abandoned` (walked away from).
     */
    record(bucket, { won, ms, hinted = false, practice = false, ranked = false, abandoned = false, bbbv = 0, clicks = 0, cleared, replay = null, date = new Date().toISOString() }) {
      if (!practice) state.stats[bucket] = applyResult(state.stats[bucket], won, { hinted });
      const id = replay ? newReplayId() : null;
      let rank = null;
      if (won && !hinted && !practice) {
        const entry = { ms: Math.max(1, Math.round(ms)), date };
        if (id) entry.r = id;
        const added = addTime(state.times[bucket], entry);
        state.times[bucket] = added.list;
        rank = added.rank;
      }
      history.push(packGame({ at: Date.parse(date) || Date.now(), bucket, won, hinted, practice, ranked, abandoned, ms, bbbv, clicks, cleared, replay: id }));
      if (history.length > historyMax) history = history.slice(-historyMax);
      if (id) {
        replays.items[id] = replay;
        replays.last = id;
      }
      pruneReplays();
      save();
      saveHistory();
      saveReplays();
      return { rank, stats: statsOf(bucket), replay: id && replays.items[id] ? id : null };
    },
    /** The games filed, oldest first, as unpackGame gives them; only those of `bucket` when it is given. */
    history(bucket) {
      const all = history.map(unpackGame).filter(Boolean);
      return bucket ? all.filter((g) => g.bucket === bucket) : all;
    },
    /** A kept replay by id, or null (never kept, or dropped since). */
    replay: (id) => (id && replays.items[id]) || null,
    /** The id of the last game's replay, or null. */
    get lastReplay() {
      return replays.last && replays.items[replays.last] ? replays.last : null;
    },
    get current() {
      return state.current;
    },
    setCurrent(current) {
      state.current = current;
      save();
    },
    /**
     * This device on the global board: `{ token, pid, name, synced }`. `synced` is the name the server last took
     * ('' for the default). The token is a secret: it goes only to the server, which keeps just a hash of it; in
     * public there is only `pid`, another hash of it.
     */
    get player() {
      return state.player;
    },
    updatePlayer(patch) {
      state.player = { ...state.player, ...patch };
      save();
      return state.player;
    },
    /** This device's try at the daily of `day` and `level`, or null: `{ c, w, rk, ms, r }` as far as it is known. */
    dailyTry: (day, level) => dayEntries(day)[level] || null,
    /** Whether any daily of `day` has been started on this device (the level picker's badge goes once it has). */
    dailyPlayed: (day) => Object.keys(dayEntries(day)).length > 0,
    /** Add what is known about a daily try (counted, won, ranked, time, rank); days past DAILY_DAYS are dropped. */
    noteDaily(day, level, patch) {
      state.daily[day] = { ...dayEntries(day), [level]: { ...(dayEntries(day)[level] || {}), ...patch } };
      const days = Object.keys(state.daily).sort();
      for (const d of days.slice(0, Math.max(0, days.length - DAILY_DAYS))) delete state.daily[d];
      save();
    },
    /** Days in a row with a ranked daily win, on this device: `{ now, best }` as of `today` (daily.js). */
    dailyStreak(today) {
      const won = Object.keys(state.daily).filter((d) => Object.values(dayEntries(d)).some((t) => t.c && t.w && t.rk));
      return streakOf(won, today);
    },
    /** Erase every time and stat: the best times, the stats, the history, the replays and the daily log. */
    resetRecords() {
      state.times = {};
      state.stats = {};
      state.daily = {};
      history = [];
      replays = freshReplays();
      save();
      saveHistory();
      saveReplays();
    },
  };
}
