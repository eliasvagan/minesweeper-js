import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { ORIGINS, createApp } from './http.js';
import { openStore } from './store.js';

const port = Number(process.env.PORT || 3890);
const host = process.env.HOST || '127.0.0.1';
const dbPath = process.env.DB_PATH || '/var/lib/minesweeper/scores.db';
mkdirSync(dirname(dbPath), { recursive: true });

const store = openStore(dbPath, { salt: process.env.IP_SALT || '' });
// EXTRA_ORIGINS (comma separated) is for local development only; production allows eliasv.com and GitHub Pages.
const origins = new Set([...ORIGINS, ...(process.env.EXTRA_ORIGINS || '').split(',').filter(Boolean)]);
const { server } = createApp({ store, origins });
server.listen(port, host, () => console.log(`minesweeper-api on ${host}:${port}, db ${dbPath}`));

const stop = () => server.close(() => { store.close(); process.exit(0); });
process.on('SIGTERM', stop);
process.on('SIGINT', stop);
