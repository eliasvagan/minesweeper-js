/**
 * The API process (`npm start`; minesweeper-api.service on the droplet). Set up by the environment: PORT and HOST
 * (loopback by default: nginx is in front), DB_PATH for the SQLite file, IP_SALT for hashing client addresses,
 * DAILY_SECRET for seeding the daily boards, and EXTRA_ORIGINS. SIGTERM or SIGINT stops it cleanly, closing the
 * database.
 *
 * DAILY_SECRET is what keeps the day's board from being worked out ahead (src/daily.js). Without it the server uses
 * a random secret it makes once and keeps in the database: safe (nobody else has it) and stable across restarts,
 * which is the right default for development and still sound in production. Setting it in the environment file
 * keeps the boards the same when the database is replaced, and lets a second server deal the same ones.
 */
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
const dailySecret = process.env.DAILY_SECRET || null;
if (!dailySecret) console.log('DAILY_SECRET is not set: the daily boards are seeded with the random secret kept in the database');
const { server } = createApp({ store, origins, dailySecret });
server.listen(port, host, () => console.log(`minesweeper-api on ${host}:${port}, db ${dbPath}`));

const stop = () => server.close(() => { store.close(); process.exit(0); });
process.on('SIGTERM', stop);
process.on('SIGINT', stop);
