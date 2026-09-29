/**
 * Best times, per-difficulty stats and settings, kept in localStorage. The list and stat updates are pure
 * functions (tested in test/records.test.mjs); `openStore` wraps them around a storage backend that may be
 * missing or full, in which case everything still works for the session and simply is not remembered.
 */

export const TOP = 10;
const KEY = 'minesweeper-js:v1';

export const DEFAULT_SETTINGS = Object.freeze({
  difficulty: 'beginner',
  custom: Object.freeze({ width: 20, height: 12, mines: 40 }),
  questionMarks: false,
  haptics: true,
});

/** The bucket a result belongs to: a named difficulty, or one exact custom board. */
export const bucketFor = (difficulty, { width, height, mines }) =>
  difficulty === 'custom' ? `custom:${width}x${height}x${mines}` : difficulty;

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

export const emptyStats = () => ({ played: 0, won: 0, streak: 0, bestStreak: 0 });

/** One finished (or abandoned) game. */
export function applyResult(stats, won) {
  const s = { ...emptyStats(), ...(stats || {}) };
  s.played += 1;
  if (won) {
    s.won += 1;
    s.streak += 1;
    s.bestStreak = Math.max(s.bestStreak, s.streak);
  } else {
    s.streak = 0;
  }
  return s;
}

export const winRate = (stats) => (stats && stats.played ? stats.won / stats.played : 0);

function freshState() {
  return { settings: { ...DEFAULT_SETTINGS, custom: { ...DEFAULT_SETTINGS.custom } }, times: {}, stats: {}, current: null };
}

function memoryBackend() {
  const m = new Map();
  return { getItem: (k) => (m.has(k) ? m.get(k) : null), setItem: (k, v) => m.set(k, String(v)), removeItem: (k) => m.delete(k) };
}

export function openStore(backend) {
  let storage = backend;
  if (storage === undefined) {
    try {
      storage = globalThis.localStorage;
      storage.setItem(`${KEY}:probe`, '1');
      storage.removeItem(`${KEY}:probe`);
    } catch {
      storage = memoryBackend();
    }
  }
  let state = freshState();
  try {
    const raw = storage.getItem(KEY);
    if (raw) {
      const saved = JSON.parse(raw);
      state = {
        settings: { ...state.settings, ...(saved.settings || {}), custom: { ...state.settings.custom, ...(saved.settings?.custom || {}) } },
        times: saved.times && typeof saved.times === 'object' ? saved.times : {},
        stats: saved.stats && typeof saved.stats === 'object' ? saved.stats : {},
        current: saved.current || null,
      };
    }
  } catch {
    /* unreadable save: start clean rather than break the page */
  }

  const save = () => {
    try {
      storage.setItem(KEY, JSON.stringify(state));
    } catch {
      /* quota or disabled storage: keep going in memory */
    }
  };

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
    stats: (bucket) => ({ ...emptyStats(), ...(state.stats[bucket] || {}) }),
    /** Every custom bucket with at least one result, newest config last. */
    customBuckets: () =>
      [...new Set([...Object.keys(state.times), ...Object.keys(state.stats)])].filter((b) => b.startsWith('custom:')),
    record(bucket, { won, ms, date = new Date().toISOString() }) {
      state.stats[bucket] = applyResult(state.stats[bucket], won);
      let rank = null;
      if (won) {
        const added = addTime(state.times[bucket], { ms: Math.max(1, Math.round(ms)), date });
        state.times[bucket] = added.list;
        rank = added.rank;
      }
      save();
      return { rank, stats: state.stats[bucket] };
    },
    get current() {
      return state.current;
    },
    setCurrent(current) {
      state.current = current;
      save();
    },
    resetRecords() {
      state.times = {};
      state.stats = {};
      save();
    },
  };
}
