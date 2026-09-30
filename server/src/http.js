/**
 * The HTTP surface. JSON in and out, sent as text/plain from the browser so cross-origin calls from GitHub
 * Pages are "simple" requests with no preflight round trip. Everything is POST except the board and health.
 */
import { createServer } from 'node:http';
import { performance } from 'node:perf_hooks';
import { checkName } from '../../minesweeper/names.js';
import { LIMITS, RULES } from './rules.js';
import { RateLimiter } from './ratelimit.js';
import { HttpError, Sessions, hashToken, publicId, validToken } from './sessions.js';

export const ORIGINS = new Set(['https://eliasv.com', 'https://www.eliasv.com', 'https://eliasvagan.github.io']);
const MAX_BODY = 8 * 1024;
const RANKED = new Set(['beginner', 'intermediate', 'expert']);

export function createApp({ store, sessions = new Sessions(), limiter = new RateLimiter(LIMITS), rules = RULES, now = Date.now, origins = ORIGINS, log = console } = {}) {
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
      const me = url.searchParams.get('me');
      return store.board({ difficulty: d, since: periodSince(url.searchParams.get('p') || 'all'), limit: rules.boardSize, me: me && /^[0-9a-f]{16}$/.test(me) ? me : null });
    }

    if (req.method !== 'POST') throw new HttpError(405, 'method');
    const body = await readJson(req);

    if (head === 'games' && parts.length === 1) {
      limit('create', ip);
      return sessions.create({ difficulty: body.d, token: body.t, ip });
    }
    if (head === 'games' && action === 'moves' && parts.length === 3) {
      limit('move', ip);
      const { response, win, repeat } = sessions.move(id, { token: body.t, seq: body.s, moves: body.m });
      if (win && !repeat) {
        if (win.ranked && !limiter.take('win', ip)) {
          response.ranked = false;
          response.why = 'rate';
        } else if (win.ranked) {
          const filed = store.addWin({
            tokenHash: win.token, pid: publicId(body.t), difficulty: win.difficulty, ms: win.ms, bbbv: win.bbbv,
            moves: win.moves, gameId: win.id, ip, at: now(), periods: rules.periods,
          });
          response.rank = filed.ranks;
          response.best = filed.best;
          response.named = filed.named;
          response.pid = publicId(body.t);
          response.top = rules.boardSize;
        }
      }
      return response;
    }
    if (head === 'games' && action === 'state' && parts.length === 3) {
      limit('read', ip);
      return sessions.state(id, { token: body.t });
    }
    if (head === 'player' && parts.length === 1) {
      limit('name', ip);
      if (!validToken(body.t)) throw new HttpError(400, 'token');
      const { name, error } = checkName(body.n);
      if (!name) return { error: 'name', message: error, status: 422 };
      return store.setName(hashToken(body.t), publicId(body.t), name, now());
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
        payload = { error: error.code };
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
  const timer = setInterval(() => { sessions.sweep(); limiter.sweep(); }, 60e3);
  timer.unref();
  server.on('close', () => clearInterval(timer));
  return { server, sessions, limiter };
}
