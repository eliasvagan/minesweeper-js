#!/usr/bin/env node
/**
 * Pre-commit check: a commit that changes a package must raise the "version" in that package's package.json above
 * the one in HEAD (HEAD~1 when amending). A file belongs to the package.json in its nearest enclosing directory;
 * files outside every package need no bump, and neither do Markdown files (README, todo.md) or the hooks in
 * .githooks/: notes and tooling, not what a package ships. Run by .githooks/pre-commit once the clone has
 * `git config core.hooksPath .githooks`. Merges aren't checked, and `git commit --no-verify` skips it.
 */
import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';

const RELEASE = /^(\d+)\.(\d+)\.(\d+)$/;

const attempt = (fn) => { try { return fn(); } catch { return null; } };
const git = (...args) => execFileSync('git', args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });
const paths = (...args) => git(...args).split('\0').filter(Boolean);
const versionAt = (rev, file) => attempt(() => JSON.parse(git('show', `${rev}:${file}`)).version);
const isRelease = (version) => typeof version === 'string' && RELEASE.test(version);

/** Orders two x.y.z versions like a sort comparator. */
export function compareVersions(a, b) {
  const [x, y] = [a, b].map((v) => v.match(RELEASE).slice(1).map(Number));
  return x[0] - y[0] || x[1] - y[1] || x[2] - y[2];
}

if (existsSync(git('rev-parse', '--git-path', 'MERGE_HEAD').trim())) process.exit(0);

const parent = attempt(() => execFileSync('ps', ['-o', 'args=', '-p', String(process.ppid)], { encoding: 'utf8' }));
const base = /\s--amend\b/.test(parent ?? '') ? 'HEAD~1' : 'HEAD';
const hasBase = attempt(() => git('rev-parse', '--verify', '--quiet', `${base}^{commit}`)) !== null;

const exempt = (file) => file.endsWith('.md') || file.startsWith('.githooks/');
const changed = (hasBase ? paths('diff', '--cached', '--name-only', '--no-renames', '-z', base) : paths('ls-files', '-z'))
  .filter((file) => !exempt(file));
const isManifest = (file) => file === 'package.json' || file.endsWith('/package.json');
const packages = [...new Set([
  ...paths('ls-files', '-z'),
  ...(hasBase ? paths('ls-tree', '-r', '--name-only', '-z', base) : []),
].filter(isManifest))].map((file) => file.slice(0, -'package.json'.length)).sort((a, b) => b.length - a.length);
const touched = new Set(changed.map((file) => packages.find((dir) => file.startsWith(dir))).filter((dir) => dir !== undefined));

const problems = [];
for (const dir of touched) {
  const file = `${dir}package.json`;
  if (attempt(() => git('cat-file', '-e', `:${file}`)) === null) continue; // the package itself is being removed
  const version = versionAt('', file);
  const before = hasBase ? versionAt(base, file) : null;
  if (!isRelease(version)) problems.push(`${file} needs a "version" of the form x.y.z`);
  else if (isRelease(before) && compareVersions(version, before) <= 0) {
    problems.push(`${file} is at ${version}, which isn't above ${before} in ${base}`);
  }
}

if (problems.length) {
  console.error(`pre-commit: raise the version of every package this commit changes:\n  ${problems.join('\n  ')}`);
  console.error('Run `npm version patch --no-git-tag-version` (or minor/major) in the package\'s directory and git add'
    + ' its package.json and lockfile. `git commit --no-verify` skips the check.');
  process.exit(1);
}
