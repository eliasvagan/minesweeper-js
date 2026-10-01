/**
 * The HTTP surface. JSON in and out, sent as text/plain from the browser so cross-origin calls from GitHub
 * Pages are "simple" requests with no preflight round trip. Everything is POST except the boards and health.
 *
 * The daily challenge rides on the same routes: `POST /games` with `daily: true` makes a daily game, its moves go
 * through `POST /games/:id/moves` like any other, and `GET /daily` is its board. Everything it adds is a new field
 * or route, so older pages see exactly what they did before.
 */
import { createServer } from 'node:http';
import { performance } from 'node:perf_hooks';
import { addDays, dayOf } from '../../minesweeper/daily.js';
import { checkName, defaultName } from '../../minesweeper/names.js';
import { DailyBoards } from './daily.js';
import { LIMITS, RULES } from './rules.js';
import { RateLimiter } from './ratelimit.js';
import { HttpError, Sessions, hashToken, publicId, validToken } from './sessions.js';

export const ORIGINS = new Set(['https://eliasv.com', 'https://www.eliasv.com', 'https://eliasvagan.github.io']);
const MAX_BODY = 8 * 1024; // bytes: a full batch of 64 chords is well under it
const RANKED = new Set(['beginner', 'intermediate', 'expert']);

/**
 * The server and its routes. Only `store` is required; the rest default to production and a test may replace
 * them (a fake clock, looser limits). The returned `sessions` and `limiter` are the live ones, for tests to inspect.
 *
 * `dailySecret` seeds the daily boards (DAILY_SECRET in src/index.js); without one, the store's own random secret is
 * used. Sessions that have no daily boards are given them from it.
 */
export function createApp({ store, sessions = new Sessions(), limiter = new RateLimiter(LIMITS), rules = RULES, now = Date.now, origins = ORIGINS, log = console, dailySecret = null } = {}) {
  if (!sessions.dailyBoards) sessions.dailyBoards = new DailyBoards({ secret: dailySecret || store.dailySecret(), rules: sessions.rules });
  const isLive = (id) => sessions.live(id);
  // A daily game's first open files its try first (Sessions.move calls this before opening anything): the one that
  // counts, practice, or refused while the player's counted game there is still live, since practice ends by
  // showing the mines of a board that counted game is still being played on.
  sessions.onDailyStart = (s, token) => {
    const c = store.startDaily({
      tokenHash: s.token, pid: publicId(token), day: s.daily.day, difficulty: s.difficulty, gameId: s.id, ip: s.ip,
      at: now(), perIp: rules.dailyPerIp, isLive,
    });
    if (c.why === 'in-progress') throw new HttpError(409, 'daily-in-progress', { id: c.id });
    s.daily.counted = c.counted;
    s.daily.why = c.why || null;
  };

  // X-Real-IP is trusted only from loopback, where nginx sets it; any other client is its socket's address.
  const clientIp = (req) => {
    const peer = req.socket.remoteAddress;
    const local = peer === '127.0.0.1' || peer === '::1' || peer === '::ffff:127.0.0.1';
    return (local && req.headers['x-real-ip']) || peer || 'unknown';
  };

  const readJson = (req) => new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', (c) => {
      size += c.length;
      if (size > MAX_BODY) {
        reject(new HttpError(413, 'too-large'));
        req.destroy();
      } else chunks.push(c);
    });
    req.on('end', () => {
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}'));
      } catch {
        reject(new HttpError(400, 'json'));
      }
    });
    req.on('error', reject);
  });

  const limit = (kind, ip) => {
    if (!limiter.take(kind, ip)) throw new HttpError(429, 'slow-down');
  };

  /**
   * What a daily game's answer says (its try was filed by onDailyStart): at the first open `daily: { day, counted }`
   * (with `why`, 'played' or 'network', when it does not count), and at the end of a counted one `rank` (null unless
   * a ranked win), `n` (players who took their try) and `streak`. A practice win is never ranked (why 'practice');
   * a counted one is ranked when plausible, within the address's win rate like any other.
   */
  function dailyMove(s, response, win, started, token, ip) {
    const d = s.daily;
    if (started) response.daily = d.why ? { day: d.day, counted: d.counted, why: d.why } : { day: d.day, counted: d.counted };
    if (response.st !== 'won' && response.st !== 'lost') return;
    const out = response.daily || (response.daily = { day: d.day, counted: Boolean(d.counted) });
    if (!d.counted) {
      if (response.st === 'won') {
        response.ranked = false;
        response.why = 'practice';
      }
      return;
    }
    let ranked = response.st === 'won' && win.ranked;
    if (ranked && !limiter.take('win', ip)) {
      ranked = false;
      response.ranked = false;
      response.why = 'rate';
    }
    Object.assign(out, store.finishDaily({
      gameId: s.id, won: response.st === 'won', ranked, ms: response.ms, bbbv: win?.bbbv, moves: s.moves, at: now(), today: dayOf(now()),
    }));
    if (ranked) {
      response.pid = publicId(token);
      response.top = rules.boardSize;
    }
  }

  // The start of period `p` in ms (0 for all time). hasOwn: names like "constructor" are not periods.
  const periodSince = (p) => {
    const span = rules.periods[p];
    if (span === undefined || !Object.hasOwn(rules.periods, p)) throw new HttpError(400, 'period');
    return Number.isFinite(span) ? now() - span : 0;
  };

  async function route(req, url, ip) {
    const parts = url.pathname.split('/').filter(Boolean);
    const [head, id, action] = parts;
    if (req.method === 'GET' && head === 'health' && parts.length === 1) return { ok: true, games: sessions.games.size };

    if (req.method === 'GET' && head === 'scores' && parts.length === 1) {
      limit('read', ip);
      const d = url.searchParams.get('d');
      if (!RANKED.has(d)) throw new HttpError(400, 'difficulty');
      // No v is the classic board, which is all an older client knows to ask for.
      const variant = url.searchParams.get('v') || 'classic';
      if (!rules.variants.includes(variant)) throw new HttpError(400, 'variant');
      const me = url.searchParams.get('me');
      const board = store.board({
        difficulty: d, variant, since: periodSince(url.searchParams.get('p') || 'all'), limit: rules.boardSize,
        me: me && /^[0-9a-f]{16}$/.test(me) ? me : null,
      });
      // Which board this is. A server from before variants ignores v and answers with the classic board and no v,
      // which is how a newer page tells the two apart.
      return { ...board, v: variant };
    }

    // The daily board: `p` is today (the default) or yesterday, by the Oslo calendar. Times and names only, never
    // anything about the board itself; `streak` is the daily streak of `me`.
    if (req.method === 'GET' && head === 'daily' && parts.length === 1) {
      limit('read', ip);
      const d = url.searchParams.get('d');
      if (!RANKED.has(d)) throw new HttpError(400, 'difficulty');
      const p = url.searchParams.get('p') || 'today';
      if (!rules.dailyPeriods.includes(p)) throw new HttpError(400, 'period');
      const today = dayOf(now());
      const day = p === 'today' ? today : addDays(today, -1);
      const me = url.searchParams.get('me');
      const pid = me && /^[0-9a-f]{16}$/.test(me) ? me : null;
      const board = store.dailyBoard({ day, difficulty: d, limit: rules.boardSize, me: pid });
      return { ...board, d, p, day, today, streak: pid ? store.dailyStreak(pid, today) : null };
    }

    if (req.method !== 'POST') throw new HttpError(405, 'method');
    const body = await readJson(req);

    if (head === 'games' && parts.length === 1) {
      limit('create', ip);
      // `daily` is true or left out (older pages, which an older server treats the same way: a normal game).
      if (body.daily !== undefined && typeof body.daily !== 'boolean') throw new HttpError(400, 'daily');
      const created = sessions.create({ difficulty: body.d, token: body.t, ip, variant: body.v, daily: body.daily === true });
      // Whether this one would count, so the page can say "practice" before the first click (startDaily decides).
      // None while the player's counted game at this level is still live: the answer names it, to be picked up.
      if (created.daily) {
        const status = store.dailyStatus({
          tokenHash: hashToken(body.t), day: created.daily.day, difficulty: body.d, ip, perIp: rules.dailyPerIp, isLive, at: now(),
        });
        if (status.why === 'in-progress') {
          sessions.games.delete(created.id);
          throw new HttpError(409, 'daily-in-progress', { id: status.id, day: created.daily.day });
        }
        Object.assign(created.daily, status);
      }
      return created;
    }
    if (head === 'games' && action === 'moves' && parts.length === 3) {
      limit('move', ip);
      const { response, win, repeat, started, session } = sessions.move(id, { token: body.t, seq: body.s, moves: body.m });
      if (repeat) return response; // filed the first time
      if (session.daily) {
        dailyMove(session, response, win, started, body.t, ip);
        return response;
      }
      // A plausible win beyond this address's win rate stands, unranked.
      if (win) {
        if (win.ranked && !limiter.take('win', ip)) {
          response.ranked = false;
          response.why = 'rate';
        } else if (win.ranked) {
          const filed = store.addWin({
            tokenHash: win.token, pid: publicId(body.t), difficulty: win.difficulty, variant: win.variant, ms: win.ms,
            bbbv: win.bbbv, moves: win.moves, gameId: win.id, ip, at: now(), periods: rules.periods,
          });
          response.rank = filed.ranks;
          response.best = filed.best;
          response.named = filed.named;
          response.name = filed.name;
          response.pid = publicId(body.t);
          response.top = rules.boardSize;
        }
      }
      return response;
    }
    // Walking away from a game: it ends, unwon and unranked, and a daily try ends with it, so a practice game can
    // follow at once. Older pages never call it; their abandoned games simply expire.
    if (head === 'games' && action === 'close' && parts.length === 3) {
      limit('move', ip);
      const s = sessions.close(id, { token: body.t });
      if (s.daily?.counted) store.closeDaily(s.id, now());
      return { st: s.game.status };
    }
    if (head === 'games' && action === 'state' && parts.length === 3) {
      limit('read', ip);
      return sessions.state(id, { token: body.t });
    }
    if (head === 'player' && parts.length === 1) {
      limit('name', ip);
      if (!validToken(body.t)) throw new HttpError(400, 'token');
      const pid = publicId(body.t);
      // Empty, or the player's own default typed back in: back to the default (stored as no name).
      const raw = typeof body.n === 'string' ? body.n.trim() : body.n;
      if (raw === '' || raw === null || (typeof raw === 'string' && raw.toLowerCase() === defaultName(pid).toLowerCase())) {
        return store.setName(hashToken(body.t), pid, null, now());
      }
      const { name, error } = checkName(raw);
      // A route may answer an error with a body of its own: `status` sets the code and is taken out by handle().
      if (!name) return { error: 'name', message: error, status: 422 };
      return store.setName(hashToken(body.t), pid, name, now());
    }
    throw new HttpError(404, 'route');
  }

  async function handle(req, res) {
    const started = performance.now();
    const origin = req.headers.origin;
    const headers = {
      'content-type': 'application/json; charset=utf-8',
      'cache-control': 'no-store',
      'x-content-type-options': 'nosniff',
      vary: 'Origin',
    };
    // CORS for the known origins only (hence Vary: Origin); a preflight, should one come, is cached for a day.
    if (origin && origins.has(origin)) {
      headers['access-control-allow-origin'] = origin;
      headers['access-control-max-age'] = '86400';
    }
    if (req.method === 'OPTIONS') {
      headers['access-control-allow-methods'] = 'GET, POST';
      headers['access-control-allow-headers'] = 'content-type';
      res.writeHead(204, headers).end();
      return;
    }
    let status = 200;
    let payload;
    const url = new URL(req.url, 'http://api');
    try {
      payload = await route(req, url, clientIp(req));
      if (payload && payload.status && payload.error) {
        status = payload.status;
        delete payload.status;
      }
    } catch (error) {
      if (error instanceof HttpError) {
        status = error.status;
        payload = { ...(error.data || {}), error: error.code };
      } else {
        status = 500;
        payload = { error: 'server' };
        log.error(error);
      }
    }
    headers['server-timing'] = `app;dur=${(performance.now() - started).toFixed(2)}`;
    const body = JSON.stringify(payload);
    res.writeHead(status, headers).end(body);
  }

  const server = createServer(handle);
  server.keepAliveTimeout = 65e3;
  // Expired games and idle rate buckets are dropped every minute; unref, so the timer alone keeps no process alive.
  const timer = setInterval(() => { sessions.sweep(); limiter.sweep(); }, 60e3);
  timer.unref();
  server.on('close', () => clearInterval(timer));
  return { server, sessions, limiter };
}
