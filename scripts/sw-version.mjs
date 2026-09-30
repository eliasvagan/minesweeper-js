#!/usr/bin/env node
/**
 * Stamps sw.js with the version of the app shell: a hash of the service worker itself (minus the stamp) and of
 * every file it precaches. `node scripts/sw-version.mjs` rewrites VERSION; `--check` only reports a mismatch.
 * test/sw.test.mjs runs the check, so a change to the shell without a new version fails the tests.
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(fileURLToPath(new URL('..', import.meta.url)));
const SW = resolve(ROOT, 'sw.js');
const STAMP = /const VERSION = '([0-9a-f]*)';/;

export function shellFiles(source = readFileSync(SW, 'utf8')) {
  const list = source.match(/const SHELL = \[([\s\S]*?)\];/)[1];
  return [...list.matchAll(/'([^']*)'/g)].map((m) => (m[1] === './' ? 'index.html' : m[1]));
}

export function computeVersion(source = readFileSync(SW, 'utf8')) {
  const hash = createHash('sha256');
  hash.update(source.replace(STAMP, "const VERSION = '';"));
  for (const file of shellFiles(source)) hash.update(`\0${file}\0`).update(readFileSync(resolve(ROOT, file)));
  return hash.digest('hex').slice(0, 12);
}

export const stampedVersion = (source = readFileSync(SW, 'utf8')) => source.match(STAMP)[1];

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const source = readFileSync(SW, 'utf8');
  const version = computeVersion(source);
  if (process.argv.includes('--check')) {
    if (stampedVersion(source) !== version) {
      console.error(`sw.js VERSION is ${stampedVersion(source)}, the shell is ${version}: run node scripts/sw-version.mjs`);
      process.exit(1);
    }
    console.log(`sw.js VERSION ${version} is current`);
  } else {
    writeFileSync(SW, source.replace(STAMP, `const VERSION = '${version}';`));
    console.log(`sw.js VERSION ${version}`);
  }
}
