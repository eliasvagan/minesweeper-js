#!/usr/bin/env node
/**
 * Maintenance on the droplet:  node admin.js counts | purge-player <public id> | backup <dir> [keep days]
 * `backup` writes an online copy of the database (safe while the service runs) and prunes old copies.
 */
import { mkdirSync, readdirSync, statSync, unlinkSync } from 'node:fs';
import { join } from 'node:path';
import { openStore } from './src/store.js';

const [cmd, arg, keepArg] = process.argv.slice(2);
const store = openStore(process.env.DB_PATH || '/var/lib/minesweeper/scores.db');
try {
  if (cmd === 'counts') console.log(store.counts());
  else if (cmd === 'purge-player' && /^[0-9a-f]{16}$/.test(arg || '')) console.log({ removedPlayers: store.purgePlayer(arg) });
  else if (cmd === 'backup' && arg) {
    mkdirSync(arg, { recursive: true });
    const file = join(arg, `scores-${new Date().toISOString().slice(0, 10)}.db`);
    await store.db.backup(file);
    const keep = Number(keepArg || 14) * 86400e3;
    for (const f of readdirSync(arg)) {
      const p = join(arg, f);
      if (/^scores-\d{4}-\d{2}-\d{2}\.db$/.test(f) && Date.now() - statSync(p).mtimeMs > keep) unlinkSync(p);
    }
    console.log(`backup ${file}`);
  } else {
    console.error('usage: admin.js counts | purge-player <public id> | backup <dir> [keep days]');
    process.exitCode = 2;
  }
} finally {
  store.close();
}
