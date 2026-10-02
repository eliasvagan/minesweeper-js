#!/usr/bin/env node
/**
 * Stamps the release from package.json into the page footer (index.html, `<span class="version">v…</span>`), so the
 * app always says which version is running. package.json's "version" script runs it, then sw-version.mjs (index.html
 * is part of the shell), so `npm version patch --no-git-tag-version` bumps, stamps and restamps in one go. `--check`
 * only reports a mismatch; the unit tests run the same check, and the pre-push hook runs the unit tests.
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(fileURLToPath(new URL('..', import.meta.url)));
const PAGE = resolve(ROOT, 'index.html');
const STAMP = /<span class="version">v([^<]*)<\/span>/;

export const packageVersion = () => JSON.parse(readFileSync(resolve(ROOT, 'package.json'), 'utf8')).version;

/** The version the footer shows, or undefined when index.html has no stamp. */
export const shownVersion = (html = readFileSync(PAGE, 'utf8')) => (html.match(STAMP) || [])[1];

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const html = readFileSync(PAGE, 'utf8');
  const version = packageVersion();
  if (!STAMP.test(html)) {
    console.error('index.html has no <span class="version">v…</span> to stamp');
    process.exit(1);
  }
  if (process.argv.includes('--check')) {
    if (shownVersion(html) !== version) {
      console.error(`index.html shows v${shownVersion(html)}, package.json is ${version}: run node scripts/app-version.mjs`);
      process.exit(1);
    }
    console.log(`index.html shows v${version}`);
  } else {
    writeFileSync(PAGE, html.replace(STAMP, `<span class="version">v${version}</span>`));
    console.log(`index.html v${version}`);
  }
}
