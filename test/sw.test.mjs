/**
 * Static checks of the installable app, run by `npm test`: sw.js's VERSION matches the shell it precaches (see
 * scripts/sw-version.mjs), the shell lists every file the page loads, the API is never cached, and the manifest is
 * complete. test/e2e-pwa.mjs checks the same app in a browser.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { computeVersion, shellFiles, stampedVersion } from '../scripts/sw-version.mjs';
import { packageVersion, shownVersion } from '../scripts/app-version.mjs';
import { updatePolicy } from '../minesweeper/pwa.js';

const ROOT = resolve(fileURLToPath(new URL('..', import.meta.url)));

test('the service worker version matches the shell it precaches', () => {
  assert.equal(stampedVersion(), computeVersion(), 'run node scripts/sw-version.mjs');
});

test('every precached file exists, and every module the page imports is precached', () => {
  const files = shellFiles();
  for (const f of files) assert.ok(existsSync(resolve(ROOT, f)), f);
  for (const f of ['app.js', 'engine.js', 'names.js', 'online.js', 'records.js', 'pwa.js', 'daily.js', 'replay.js', 'share.js', 'charts.js']) {
    assert.ok(files.includes(`minesweeper/${f}`), f);
    const src = readFileSync(resolve(ROOT, 'minesweeper', f), 'utf8');
    for (const [, dep] of src.matchAll(/from '\.\/([\w.-]+)'/g)) assert.ok(files.includes(`minesweeper/${dep}`), `${f} imports ${dep}`);
  }
  const html = readFileSync(resolve(ROOT, 'index.html'), 'utf8');
  for (const [, href] of html.matchAll(/(?:href|src)="((?:minesweeper|icons)\/[^"]+|favicon\.svg|manifest\.webmanifest)"/g)) {
    assert.ok(files.includes(href), `index.html uses ${href}`);
  }
});

test('the API is never cached', () => {
  const sw = readFileSync(resolve(ROOT, 'sw.js'), 'utf8');
  assert.ok(!shellFiles().some((f) => f.includes('api/')));
  assert.match(sw, /url\.pathname\.startsWith\(api\)[^\n]*return;/);
});

test('the manifest is complete and relative to where the game is served', () => {
  const m = JSON.parse(readFileSync(resolve(ROOT, 'manifest.webmanifest'), 'utf8'));
  assert.equal(m.name, 'Minesweeper');
  assert.equal(m.short_name, 'Minesweeper');
  assert.equal(m.description, 'The way it should be.');
  assert.equal(m.start_url, './');
  assert.equal(m.scope, './');
  assert.equal(m.display, 'standalone');
  for (const icon of m.icons) assert.ok(existsSync(resolve(ROOT, icon.src)), icon.src);
  assert.ok(m.icons.some((i) => i.sizes === '512x512' && i.purpose === 'maskable'));
  assert.ok(m.icons.some((i) => i.sizes === '192x192' && i.purpose === 'any'));
});

test('the footer shows the version in package.json', () => {
  assert.equal(shownVersion(), packageVersion(), 'stale footer version: run node scripts/app-version.mjs');
});

test('an update applies itself only on a fresh board, and never mid-game', () => {
  assert.deepEqual(updatePolicy('ready'), { auto: true, manual: true });
  assert.deepEqual(updatePolicy(undefined), { auto: true, manual: true }, 'before the first board');
  assert.deepEqual(updatePolicy('playing'), { auto: false, manual: false }, 'a game in progress');
  for (const s of ['won', 'lost', 'replay']) assert.deepEqual(updatePolicy(s), { auto: false, manual: true }, s);
});

test('the worker answers SKIP_WAITING, deletes old caches and claims its clients', () => {
  const sw = readFileSync(resolve(ROOT, 'sw.js'), 'utf8');
  assert.match(sw, /event\.data\?\.type === 'SKIP_WAITING'\) self\.skipWaiting\(\)/);
  assert.match(sw, /caches\.delete\(key\)/);
  assert.match(sw, /self\.clients\.claim\(\)/);
});
