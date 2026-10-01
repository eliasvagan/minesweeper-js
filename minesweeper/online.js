/**
 * Talking to the leaderboard server (server/ in this repository). A ranked game is played *through* it: the
 * page sends each open and chord, and draws what comes back. Moves made while a request is out are queued and
 * go together in the next one, so a slow network never drops a tap or blocks the board.
 *
 * Bodies are JSON sent as text/plain, which keeps cross-origin calls from GitHub Pages free of preflights.
 */

export const RANKED_LEVELS = new Set(['beginner', 'intermediate', 'expert']);

/** Where the API is, or null when this copy of the game has none (a local checkout, say). */
export function apiBase(loc = location, storage = globalThis.localStorage) {
  // A saved override wins (the end-to-end tests use it): a base URL, or '' for no server at all.
  try {
    const override = storage?.getItem('minesweeper-js:api');
    if (override !== null && override !== undefined) return override || null;
  } catch { /* storage blocked */ }
  if (loc.hostname === 'eliasv.com' || loc.hostname === 'www.eliasv.com') return '/minesweeper/api';
  if (loc.hostname === 'eliasvagan.github.io') return 'https://eliasv.com/minesweeper/api';
  return null;
}

export class ApiError extends Error {
  constructor(status, code, data) {
    super(code || `HTTP ${status}`);
    this.status = status; // 0: never reached the server
    this.code = code;
    this.data = data;
  }
  /** Worth trying again: the network, the server being busy, or us being told to slow down. */
  get transient() {
    return this.status === 0 || this.status === 429 || this.status >= 500;
  }
}

/** A new device token: 18 random bytes as 24 base64url characters (the server takes 16 to 64 of [A-Za-z0-9_-]). */
export function newToken() {
  const bytes = new Uint8Array(18);
  crypto.getRandomValues(bytes);
  return btoa(String.fromCharCode(...bytes)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

/**
 * The public id the server derives from a token (see server/src/sessions.js), so the page can show the default
 * name before it has talked to the server. Null where SubtleCrypto is unavailable (plain http).
 */
export async function publicIdOf(token) {
  try {
    const hash = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(`minesweeper-public:${token}`));
    return [...new Uint8Array(hash)].map((b) => b.toString(16).padStart(2, '0')).join('').slice(0, 16);
  } catch {
    return null;
  }
}

/**
 * The API client. Each call resolves to the response's JSON, or rejects with an ApiError (status 0 when the
 * network failed or the call took longer than its timeout). Bodies use the server's short field names: d level,
 * t device token, s batch number, m moves, n name; the board takes p period and me public id as a query.
 */
export function createApi(base, { timeoutMs = 5000 } = {}) {
  const latency = []; // round trips of move requests, for the curious and for the e2e test
  const watchers = new Set();
  let inflight = 0;
  const busy = (d) => {
    inflight += d;
    for (const fn of watchers) fn(inflight);
  };
  async function call(path, body, opts = {}) {
    busy(1);
    try {
      return await send(path, body, opts);
    } finally {
      busy(-1);
    }
  }
  async function send(path, body, { timeout = timeoutMs } = {}) {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), timeout);
    const init = body === undefined
      ? { signal: ctrl.signal, cache: 'no-store' }
      : { method: 'POST', body: JSON.stringify(body), headers: { 'content-type': 'text/plain' }, signal: ctrl.signal };
    let res;
    try {
      res = await fetch(base + path, init);
    } catch {
      throw new ApiError(0, 'network');
    } finally {
      clearTimeout(timer);
    }
    const data = await res.json().catch(() => ({})); // a body that is not JSON (a proxy's error page) keeps its status
    if (!res.ok) throw new ApiError(res.status, data.error, data);
    return data;
  }
  return {
    base,
    latency,
    /** `fn(n)` whenever the number of requests in flight changes; returns an unsubscribe. */
    watch: (fn) => { watchers.add(fn); return () => watchers.delete(fn); },
    get inflight() { return inflight; },
    createGame: (d, t) => call('/games', { d, t }, { timeout: 4000 }),
    moves: async (id, t, s, m) => {
      const t0 = performance.now();
      const r = await call(`/games/${encodeURIComponent(id)}/moves`, { t, s, m });
      latency.push(Math.round(performance.now() - t0));
      if (latency.length > 200) latency.shift();
      return r;
    },
    state: (id, t) => call(`/games/${encodeURIComponent(id)}/state`, { t }, { timeout: 3000 }),
    setName: (t, n) => call('/player', { t, n }),
    board: (d, p, me) => call(`/scores?d=${d}&p=${p}${me ? `&me=${me}` : ''}`),
  };
}

/**
 * One ranked game on the server. `send` queues a move; `onAnswer(response, moves)` gets each answer in order;
 * `onLost(error, pendingMoves)` is called once if the server stops being reachable (after retries) or refuses
 * the game, with the moves that never got an answer, so the page can carry on without it.
 */
export class RemoteGame {
  constructor(api, token, difficulty, { onAnswer, onLost, retries = [300, 1000, 2500] }) {
    this.api = api;
    this.token = token;
    this.difficulty = difficulty;
    this.onAnswer = onAnswer;
    this.onLost = onLost;
    this.retries = retries;
    this.id = null;
    this.seq = 0;
    this.queue = [];
    this.busy = false;
    this.dead = false;
    this.created = api.createGame(difficulty, token).then((g) => {
      this.id = g.id;
      return g;
    });
    this.created.catch(() => {}); // handled where it is awaited
  }

  /** Pick up a game started before a reload (without the constructor, which would start a new one on the server). */
  static resume(api, token, difficulty, id, seq, handlers) {
    const r = Object.create(RemoteGame.prototype);
    Object.assign(r, { api, token, difficulty, id, seq, queue: [], busy: false, dead: false, retries: [300, 1000, 2500], ...handlers });
    r.created = Promise.resolve({ id });
    return r;
  }

  send(move) {
    if (this.dead) return;
    this.queue.push(move);
    this.flush();
  }

  /** A request is out, or moves are waiting for one. */
  get pending() {
    return this.busy || this.queue.length > 0;
  }

  /**
   * Send what is queued, one request at a time and at most 64 moves to it (the server's maxMovesPerBatch). A batch
   * keeps its number through the retries, so if only the response was lost the server answers it again rather than
   * applying it twice. Transient errors are retried after each delay in `retries` in turn; any other error, or the
   * last retry failing, ends the game here (onLost).
   */
  async flush() {
    if (this.busy || this.dead || !this.queue.length) return;
    this.busy = true;
    const batch = this.queue.splice(0, 64);
    try {
      await this.created;
      const seq = this.seq + 1;
      let answer;
      for (let attempt = 0; ; attempt++) {
        try {
          answer = await this.api.moves(this.id, this.token, seq, batch);
          break;
        } catch (error) {
          if (!(error instanceof ApiError) || !error.transient || attempt >= this.retries.length) throw error;
          await new Promise((r) => setTimeout(r, this.retries[attempt]));
        }
      }
      this.seq = seq;
      this.busy = false;
      this.onAnswer(answer, batch);
      if (answer.st === 'won' || answer.st === 'lost') this.dead = true;
    } catch (error) {
      this.dead = true;
      this.busy = false;
      const unanswered = [...batch, ...this.queue];
      this.queue = [];
      this.onLost(error, unanswered);
      return;
    }
    this.flush();
  }
}
