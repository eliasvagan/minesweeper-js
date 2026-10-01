/**
 * Scores and player names in SQLite. Small tables, a couple of indexes, WAL so reads never wait for a write. Each
 * score has a variant ('classic' or 'ng', no-guess), and every board and rank is per difficulty and variant.
 *
 * The daily challenge has a table of its own, `daily`: one row per player, day and level, written at the first open
 * of that player's first daily game there, which is what makes it the one that counts (the UNIQUE key turns any
 * later try into practice, which is not stored). The row gets the result when that game ends; a game left
 * unfinished keeps its row, so walking away does not buy another try. One kind of row does not count (`counted` 0):
 * practice that an address over its cap was given instead of a first try. It is there because that game ends by
 * showing the board, so the player behind it must never get a counted try at it later, from anywhere. `meta` holds
 * the daily secret when the environment gives none.
 *
 * Nobody sees a daily's mines before their own counted try at it is over: a practice game ends by showing them, so
 * none starts while that player's counted game is still live (startDaily, dailyStatus).
 */
import Database from 'better-sqlite3';
import { createHash, randomBytes } from 'node:crypto';
import { defaultName } from '../../minesweeper/names.js';
import { streakOf } from '../../minesweeper/daily.js';

/** `path` may be ':memory:' (the tests). `salt` (IP_SALT) goes into the hash of client addresses; see ipHash. */
export function openStore(path, { salt = '' } = {}) {
  const db = new Database(path);
  db.pragma('journal_mode = WAL');
  db.pragma('synchronous = NORMAL');
  db.pragma('foreign_keys = ON'); // off by default in SQLite; purgePlayer relies on it to take the scores too
  db.exec(`
    CREATE TABLE IF NOT EXISTS players (
      id INTEGER PRIMARY KEY,
      token_hash TEXT NOT NULL UNIQUE,
      public_id TEXT NOT NULL UNIQUE,
      name TEXT,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS scores (
      id INTEGER PRIMARY KEY,
      player_id INTEGER NOT NULL REFERENCES players(id) ON DELETE CASCADE,
      difficulty TEXT NOT NULL,
      ms INTEGER NOT NULL,
      bbbv INTEGER NOT NULL,
      moves INTEGER NOT NULL,
      game_id TEXT NOT NULL UNIQUE,
      ip_hash TEXT,
      created_at INTEGER NOT NULL,
      variant TEXT NOT NULL DEFAULT 'classic'
    );
  `);
  // A database from before no-guess boards: every score in it is classic, which the column's default says. The
  // indexes gain the variant, and the old ones (without it) go.
  if (!db.prepare('PRAGMA table_info(scores)').all().some((c) => c.name === 'variant')) {
    db.exec("ALTER TABLE scores ADD COLUMN variant TEXT NOT NULL DEFAULT 'classic'");
  }
  db.exec(`
    DROP INDEX IF EXISTS scores_board;
    DROP INDEX IF EXISTS scores_player;
    CREATE INDEX IF NOT EXISTS scores_board_v ON scores (difficulty, variant, created_at, ms);
    CREATE INDEX IF NOT EXISTS scores_player_v ON scores (player_id, difficulty, variant, ms);
  `);
  // The daily challenge and the key-value table: new tables, so a database from before them simply gains them.
  // `day` is the board's Oslo day ('YYYY-MM-DD'); `ranked` is a plausible win, the only kind on the board and in a
  // streak.
  db.exec(`
    CREATE TABLE IF NOT EXISTS daily (
      id INTEGER PRIMARY KEY,
      day TEXT NOT NULL,
      difficulty TEXT NOT NULL,
      player_id INTEGER NOT NULL REFERENCES players(id) ON DELETE CASCADE,
      game_id TEXT NOT NULL UNIQUE,
      ip_hash TEXT,
      started_at INTEGER NOT NULL,
      ended_at INTEGER,
      won INTEGER NOT NULL DEFAULT 0,
      ranked INTEGER NOT NULL DEFAULT 0,
      ms INTEGER,
      bbbv INTEGER,
      moves INTEGER,
      counted INTEGER NOT NULL DEFAULT 1,
      UNIQUE (day, difficulty, player_id)
    );
    CREATE INDEX IF NOT EXISTS daily_board ON daily (day, difficulty, ranked, ms);
    CREATE INDEX IF NOT EXISTS daily_ip ON daily (day, difficulty, ip_hash);
    CREATE INDEX IF NOT EXISTS daily_player ON daily (player_id, ranked, day);
    CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
  `);
  // A daily table from before the uncounted "seen" rows: all of its rows are counted ones.
  if (!db.prepare('PRAGMA table_info(daily)').all().some((c) => c.name === 'counted')) {
    db.exec('ALTER TABLE daily ADD COLUMN counted INTEGER NOT NULL DEFAULT 1');
  }

  const q = {
    player: db.prepare('SELECT id, public_id, name FROM players WHERE token_hash = ?'),
    byPublic: db.prepare('SELECT id, public_id, name FROM players WHERE public_id = ?'),
    addPlayer: db.prepare('INSERT INTO players (token_hash, public_id, created_at, updated_at) VALUES (?, ?, ?, ?) ON CONFLICT (token_hash) DO NOTHING'),
    rename: db.prepare('UPDATE players SET name = ?, updated_at = ? WHERE id = ?'),
    addScore: db.prepare(`INSERT INTO scores (player_id, difficulty, variant, ms, bbbv, moves, game_id, ip_hash, created_at)
      VALUES (@player, @difficulty, @variant, @ms, @bbbv, @moves, @game, @ip, @at)`),
    // Each player's best in the period; equal times go to whoever set theirs first (`at`, the earliest such win).
    board: db.prepare(`
      WITH best AS (
        SELECT player_id, MIN(ms) AS ms FROM scores
        WHERE difficulty = @d AND variant = @v AND created_at >= @since GROUP BY player_id
      )
      SELECT b.ms AS ms, p.name AS name, p.public_id AS pid,
        (SELECT MIN(s.created_at) FROM scores s
          WHERE s.player_id = b.player_id AND s.difficulty = @d AND s.variant = @v AND s.ms = b.ms AND s.created_at >= @since) AS at
      FROM best b JOIN players p ON p.id = b.player_id
      ORDER BY b.ms, at LIMIT @limit`),
    bestOf: db.prepare('SELECT MIN(ms) AS ms FROM scores WHERE player_id = ? AND difficulty = ? AND variant = ? AND created_at >= ?'),
    ahead: db.prepare(`SELECT COUNT(*) AS n FROM (
        SELECT MIN(ms) AS ms FROM scores
        WHERE difficulty = @d AND variant = @v AND created_at >= @since AND player_id != @player GROUP BY player_id
      ) WHERE ms < @ms`),
    purgePlayer: db.prepare('DELETE FROM players WHERE public_id = ?'),
    counts: db.prepare('SELECT (SELECT COUNT(*) FROM players) AS players, (SELECT COUNT(*) FROM scores) AS scores, (SELECT COUNT(*) FROM daily) AS daily'),

    dailyFromIp: db.prepare('SELECT COUNT(*) AS n FROM daily WHERE day = ? AND difficulty = ? AND ip_hash = ? AND counted = 1'),
    dailyStart: db.prepare(`INSERT INTO daily (day, difficulty, player_id, game_id, ip_hash, started_at, counted, ended_at)
      VALUES (@day, @difficulty, @player, @game, @ip, @at, @counted, @ended) ON CONFLICT DO NOTHING`),
    dailyClose: db.prepare('UPDATE daily SET ended_at = @at WHERE game_id = @game AND ended_at IS NULL'),
    dailyFinish: db.prepare(`UPDATE daily SET ended_at = @at, won = @won, ranked = @ranked, ms = @ms, bbbv = @bbbv, moves = @moves
      WHERE game_id = @game AND ended_at IS NULL`),
    dailyRow: db.prepare('SELECT * FROM daily WHERE game_id = ?'),
    // Ties go to whoever finished first, then to whoever started first.
    dailyAhead: db.prepare(`SELECT COUNT(*) AS n FROM daily WHERE day = @day AND difficulty = @d AND ranked = 1
      AND (ms < @ms OR (ms = @ms AND (ended_at < @at OR (ended_at = @at AND id < @id))))`),
    dailyPlayers: db.prepare('SELECT COUNT(*) AS n FROM daily WHERE day = ? AND difficulty = ? AND counted = 1'),
    dailyBoard: db.prepare(`SELECT d.ms AS ms, p.name AS name, p.public_id AS pid FROM daily d JOIN players p ON p.id = d.player_id
      WHERE d.day = @day AND d.difficulty = @d AND d.ranked = 1 ORDER BY d.ms, d.ended_at, d.id LIMIT @limit`),
    dailyMine: db.prepare('SELECT * FROM daily WHERE day = ? AND difficulty = ? AND player_id = ?'),
    dailyDays: db.prepare('SELECT DISTINCT day FROM daily WHERE player_id = ? AND ranked = 1'),
    meta: db.prepare('SELECT value FROM meta WHERE key = ?'),
    setMeta: db.prepare('INSERT INTO meta (key, value) VALUES (?, ?) ON CONFLICT (key) DO NOTHING'),
  };

  const ensurePlayer = (tokenHash, pid, at) => {
    q.addPlayer.run(tokenHash, pid, at, at);
    return q.player.get(tokenHash);
  };
  // Addresses are kept only as a salted hash: without the salt, a hash cannot be matched by trying every address.
  const ipHash = (ip) => (ip ? createHash('sha256').update(`${salt}:${ip}`).digest('hex').slice(0, 24) : null);

  /** Rank a time would have among each player's best, this player excluded (1 = top). */
  const rankOf = (d, v, since, player, ms) => q.ahead.get({ d, v, since, player, ms }).n + 1;
  /** A finished daily row's place among the ranked wins of its day and level (1 = top). */
  const dailyRank = (row) => q.dailyAhead.get({ day: row.day, d: row.difficulty, ms: row.ms, at: row.ended_at, id: row.id }).n + 1;
  /**
   * The player's try at a daily, as the first open of a new daily game would find it: `{ state, id }`, state being
   * 'none' (no try yet), 'live' (their counted game `id` is still under way, `isLive(id)`), or 'over' (a counted try
   * that ended, or practice already given at an address over its cap). A counted row whose game is gone without
   * ending (it expired, or the server restarted) is closed here: that try is over. Without `isLive`, an open row is
   * taken to be live, the safe way round: no practice game until it is known to be over.
   */
  const tryAt = ({ tokenHash, day, difficulty, isLive = () => true, at = Date.now() }) => {
    const p = q.player.get(tokenHash);
    const row = p ? q.dailyMine.get(day, difficulty, p.id) : null;
    if (!row) return { state: 'none' };
    if (row.counted && row.ended_at === null) {
      if (isLive(row.game_id)) return { state: 'live', id: row.game_id };
      q.dailyClose.run({ game: row.game_id, at });
    }
    return { state: 'over' };
  };

  /** The player's daily streak as of `today`: `{ now, best }` (see streakOf in minesweeper/daily.js). */
  const streakFor = (playerId, today) => streakOf(q.dailyDays.all(playerId).map((r) => r.day), today);

  return {
    db,
    player: (tokenHash) => q.player.get(tokenHash) || null,
    setName(tokenHash, pid, name, at = Date.now()) {
      const p = ensurePlayer(tokenHash, pid, at);
      q.rename.run(name, at, p.id);
      return { pid: p.public_id, name: name || defaultName(p.public_id), custom: Boolean(name) };
    },
    /**
     * File a ranked win on the board of its difficulty and variant ('classic' when left out); returns its rank in each
     * period and whether it is the player's new best there.
     */
    addWin({ tokenHash, pid, difficulty, variant = 'classic', ms, bbbv, moves, gameId, ip, at = Date.now(), periods }) {
      const tx = db.transaction(() => {
        const p = ensurePlayer(tokenHash, pid, at);
        // The player's best in each period before this win, to tell whether it is a new one.
        const before = {};
        for (const [name, span] of Object.entries(periods)) {
          before[name] = q.bestOf.get(p.id, difficulty, variant, Number.isFinite(span) ? at - span : 0).ms;
        }
        q.addScore.run({ player: p.id, difficulty, variant, ms, bbbv, moves, game: gameId, ip: ipHash(ip), at });
        const ranks = {};
        const best = {};
        for (const [name, span] of Object.entries(periods)) {
          const since = Number.isFinite(span) ? at - span : 0;
          ranks[name] = rankOf(difficulty, variant, since, p.id, ms);
          best[name] = before[name] === null || ms < before[name];
        }
        return { ranks, best, named: Boolean(p.name), name: p.name || defaultName(p.public_id) };
      });
      return tx();
    },
    /**
     * The top `limit` of one difficulty and variant since `since`, as `{ e: [{ r, n, d, ms, at, me }], me }`: `d` is 1
     * for a default name, and `me` marks the entry of public id `me`, whose rank and best also come back as `me` (null
     * with no win), for when it is off the list.
     */
    board({ difficulty, variant = 'classic', since, limit, me }) {
      const rows = q.board.all({ d: difficulty, v: variant, since, limit });
      const entries = rows.map((r, k) => ({ r: k + 1, n: r.name || defaultName(r.pid), d: r.name ? undefined : 1, ms: r.ms, at: r.at, me: me ? r.pid === me : undefined }));
      let mine = null;
      if (me) {
        const p = q.byPublic.get(me);
        const best = p ? q.bestOf.get(p.id, difficulty, variant, since).ms : null;
        if (best !== null && best !== undefined) mine = { r: rankOf(difficulty, variant, since, p.id, best), ms: best };
      }
      return { e: entries, me: mine };
    },
    purgePlayer: (pid) => q.purgePlayer.run(pid).changes, // their scores and dailies go too (ON DELETE CASCADE)
    counts: () => q.counts.get(),

    /** This player's try at a daily, as tryAt above finds it. */
    dailyTry: tryAt,
    /**
     * Would a daily game started now count? `{ first, why }`: first is false once this player has had a try at this
     * level today (why 'played'), or once this address has had its `perIp` counted first tries there (why 'network').
     * `why` is 'in-progress' (with the game's `id`) while the player's counted game there is still live: no new daily
     * game may start then. Only a hint for the page: startDaily decides, at the first open.
     */
    dailyStatus({ tokenHash, day, difficulty, ip, perIp, isLive, at = Date.now() }) {
      const t = tryAt({ tokenHash, day, difficulty, isLive, at });
      if (t.state === 'live') return { first: false, why: 'in-progress', id: t.id };
      if (t.state === 'over') return { first: false, why: 'played' };
      if (q.dailyFromIp.get(day, difficulty, ipHash(ip)).n >= perIp) return { first: false, why: 'network' };
      return { first: true };
    },
    /**
     * The first open of a daily game: file it as this player's try for the day and level if it is the first one (and
     * the address is within `perIp`). Returns `{ counted, why, id }`, why being 'played', 'network', or 'in-progress'
     * (with the live game's `id`) when the caller must refuse the open. Over the cap, the practice game is filed as
     * an uncounted row, so that this player never gets a counted try at a board they have seen. In one transaction,
     * so two games of the same player started at once (two tabs) cannot both count.
     */
    startDaily({ tokenHash, pid, day, difficulty, gameId, ip, at = Date.now(), perIp, isLive }) {
      const tx = db.transaction(() => {
        const p = ensurePlayer(tokenHash, pid, at);
        const t = tryAt({ tokenHash, day, difficulty, isLive, at });
        if (t.state === 'live') return { counted: false, why: 'in-progress', id: t.id };
        if (t.state === 'over') return { counted: false, why: 'played' };
        const hash = ipHash(ip);
        const capped = q.dailyFromIp.get(day, difficulty, hash).n >= perIp;
        const row = { day, difficulty, player: p.id, game: gameId, ip: hash, at, counted: capped ? 0 : 1, ended: capped ? at : null };
        const added = q.dailyStart.run(row).changes === 1;
        if (!added) return { counted: false, why: 'played' };
        return capped ? { counted: false, why: 'network' } : { counted: true };
      });
      return tx();
    },
    /** A counted daily game that ended without a result (the player walked away): its try is over, not won. */
    closeDaily: (gameId, at = Date.now()) => q.dailyClose.run({ game: gameId, at }).changes,
    /**
     * The end of a counted daily game (won or lost). Returns `{ rank, n, streak }`: its place among the day's ranked
     * wins at this level (null unless it is one), the players who have taken their try there, and the player's
     * streak as of `today`. A second call for the same game changes nothing.
     */
    finishDaily({ gameId, won, ranked, ms, bbbv, moves, at = Date.now(), today }) {
      q.dailyFinish.run({ game: gameId, at, won: won ? 1 : 0, ranked: ranked ? 1 : 0, ms: won ? ms : null, bbbv: bbbv ?? null, moves: moves ?? null });
      const row = q.dailyRow.get(gameId);
      if (!row) return { rank: null, n: 0, streak: { now: 0, best: 0 } };
      return {
        rank: row.ranked ? dailyRank(row) : null,
        n: q.dailyPlayers.get(row.day, row.difficulty).n,
        streak: streakFor(row.player_id, today ?? row.day),
      };
    },
    /**
     * The daily board of `day` and `difficulty`: `{ e: [{ r, n, d, ms, me }], me, n }` like board(), where `n` counts
     * the players who took their try, and `me` (for public id `me`) is that player's try there: `{ won, ms, r }`, or
     * null without one.
     */
    dailyBoard({ day, difficulty, limit, me }) {
      const rows = q.dailyBoard.all({ day, d: difficulty, limit });
      const e = rows.map((r, k) => ({ r: k + 1, n: r.name || defaultName(r.pid), d: r.name ? undefined : 1, ms: r.ms, me: me ? r.pid === me : undefined }));
      let mine = null;
      if (me) {
        const p = q.byPublic.get(me);
        const row = p ? q.dailyMine.get(day, difficulty, p.id) : null;
        if (row) mine = { won: Boolean(row.won), ms: row.won ? row.ms : null, r: row.ranked ? dailyRank(row) : null };
      }
      return { e, me: mine, n: q.dailyPlayers.get(day, difficulty).n };
    },
    /** The daily streak of public id `pid` as of `today`, or null for a player the server has never seen. */
    dailyStreak(pid, today) {
      const p = q.byPublic.get(pid);
      return p ? streakFor(p.id, today) : null;
    },
    /**
     * The secret the daily boards are seeded with when DAILY_SECRET is not set: 32 random bytes made the first time
     * and kept here, so the boards survive restarts and still cannot be computed by anyone without the database.
     */
    dailySecret() {
      const kept = q.meta.get('daily-secret');
      if (kept) return kept.value;
      q.setMeta.run('daily-secret', randomBytes(32).toString('hex'));
      return q.meta.get('daily-secret').value;
    },
    close: () => db.close(),
  };
}
