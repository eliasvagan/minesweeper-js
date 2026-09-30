/** Scores and player names in SQLite. Small tables, a couple of indexes, WAL so reads never wait for a write. */
import Database from 'better-sqlite3';
import { createHash } from 'node:crypto';

export function openStore(path, { salt = '' } = {}) {
  const db = new Database(path);
  db.pragma('journal_mode = WAL');
  db.pragma('synchronous = NORMAL');
  db.pragma('foreign_keys = ON');
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
      created_at INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS scores_board ON scores (difficulty, created_at, ms);
    CREATE INDEX IF NOT EXISTS scores_player ON scores (player_id, difficulty, ms);
  `);

  const q = {
    player: db.prepare('SELECT id, public_id, name FROM players WHERE token_hash = ?'),
    byPublic: db.prepare('SELECT id, public_id, name FROM players WHERE public_id = ?'),
    addPlayer: db.prepare('INSERT INTO players (token_hash, public_id, created_at, updated_at) VALUES (?, ?, ?, ?) ON CONFLICT (token_hash) DO NOTHING'),
    rename: db.prepare('UPDATE players SET name = ?, updated_at = ? WHERE id = ?'),
    addScore: db.prepare(`INSERT INTO scores (player_id, difficulty, ms, bbbv, moves, game_id, ip_hash, created_at)
      VALUES (@player, @difficulty, @ms, @bbbv, @moves, @game, @ip, @at)`),
    board: db.prepare(`
      WITH best AS (
        SELECT player_id, MIN(ms) AS ms FROM scores WHERE difficulty = @d AND created_at >= @since GROUP BY player_id
      )
      SELECT b.ms AS ms, p.name AS name, p.public_id AS pid,
        (SELECT MIN(s.created_at) FROM scores s
          WHERE s.player_id = b.player_id AND s.difficulty = @d AND s.ms = b.ms AND s.created_at >= @since) AS at
      FROM best b JOIN players p ON p.id = b.player_id
      ORDER BY b.ms, at LIMIT @limit`),
    bestOf: db.prepare('SELECT MIN(ms) AS ms FROM scores WHERE player_id = ? AND difficulty = ? AND created_at >= ?'),
    ahead: db.prepare(`SELECT COUNT(*) AS n FROM (
        SELECT MIN(ms) AS ms FROM scores WHERE difficulty = @d AND created_at >= @since AND player_id != @player GROUP BY player_id
      ) WHERE ms < @ms`),
    purgePlayer: db.prepare('DELETE FROM players WHERE public_id = ?'),
    counts: db.prepare('SELECT (SELECT COUNT(*) FROM players) AS players, (SELECT COUNT(*) FROM scores) AS scores'),
  };

  const ensurePlayer = (tokenHash, pid, at) => {
    q.addPlayer.run(tokenHash, pid, at, at);
    return q.player.get(tokenHash);
  };
  const ipHash = (ip) => (ip ? createHash('sha256').update(`${salt}:${ip}`).digest('hex').slice(0, 24) : null);

  /** Rank a time would have among each player's best, this player excluded (1 = top). */
  const rankOf = (d, since, player, ms) => q.ahead.get({ d, since, player, ms }).n + 1;

  return {
    db,
    player: (tokenHash) => q.player.get(tokenHash) || null,
    setName(tokenHash, pid, name, at = Date.now()) {
      const p = ensurePlayer(tokenHash, pid, at);
      q.rename.run(name, at, p.id);
      return { pid: p.public_id, name };
    },
    /** File a ranked win; returns its rank in each period and whether it is the player's new best there. */
    addWin({ tokenHash, pid, difficulty, ms, bbbv, moves, gameId, ip, at = Date.now(), periods }) {
      const tx = db.transaction(() => {
        const p = ensurePlayer(tokenHash, pid, at);
        const before = {};
        for (const [name, span] of Object.entries(periods)) {
          before[name] = q.bestOf.get(p.id, difficulty, Number.isFinite(span) ? at - span : 0).ms;
        }
        q.addScore.run({ player: p.id, difficulty, ms, bbbv, moves, game: gameId, ip: ipHash(ip), at });
        const ranks = {};
        const best = {};
        for (const [name, span] of Object.entries(periods)) {
          const since = Number.isFinite(span) ? at - span : 0;
          ranks[name] = rankOf(difficulty, since, p.id, ms);
          best[name] = before[name] === null || ms < before[name];
        }
        return { ranks, best, named: Boolean(p.name) };
      });
      return tx();
    },
    board({ difficulty, since, limit, me }) {
      const rows = q.board.all({ d: difficulty, since, limit });
      const entries = rows.map((r, k) => ({ r: k + 1, n: r.name, ms: r.ms, at: r.at, me: me ? r.pid === me : undefined }));
      let mine = null;
      if (me) {
        const p = q.byPublic.get(me);
        const best = p ? q.bestOf.get(p.id, difficulty, since).ms : null;
        if (best !== null && best !== undefined) mine = { r: rankOf(difficulty, since, p.id, best), ms: best };
      }
      return { e: entries, me: mine };
    },
    purgePlayer: (pid) => q.purgePlayer.run(pid).changes,
    counts: () => q.counts.get(),
    close: () => db.close(),
  };
}
