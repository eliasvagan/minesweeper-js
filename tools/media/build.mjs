#!/usr/bin/env node
/**
 * Builds media/ from the game itself: a seeded no guess board solved by logic (tools/media/solve.mjs), played back
 * in the page's own replay viewer and captured move by move. Run `node scripts/icons.mjs` first for media/logo.png.
 *
 *     PUPPETEER=/path/to/node_modules/puppeteer node tools/media/build.mjs
 *
 * Writes media/banner.gif, banner.webp and banner.png (960×540, the still is the first frame), media/screenshots/
 * and media/media.json. Needs ffmpeg. The banner ends on the cleared board and fades back to the empty one, so it
 * loops without a jump.
 */
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync, copyFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { extname, join, normalize, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { solveReplay } from './solve.mjs';

const ROOT = resolve(fileURLToPath(new URL('../..', import.meta.url)));
const OUT = resolve(ROOT, 'media');
const W = 960, H = 540, FPS = 25;
const HOLD_START = 12, PLAY = 120, HOLD_END = 28, FADE = 0.6; // frames, frames, frames, seconds
const SHOTS = [
  ['01-intermediate', { level: 'intermediate', seed: 7, at: 0.45, view: [W, H] }, 'Intermediate halfway, every flag and opening proven by logic'],
  ['02-expert', { level: 'expert', seed: 3, at: 0.6, view: [W, H] }, 'Expert, 99 mines on a 30 by 16 board'],
  ['03-won', { level: 'beginner', seed: 2, at: 1, view: [W, H] }, 'A cleared Beginner board, every mine flagged'],
  ['04-phone', { level: 'intermediate', seed: 7, at: 0.7, view: [390, 844] }, 'Made for phones first'],
];

const TYPES = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.svg': 'image/svg+xml', '.png': 'image/png', '.json': 'application/json', '.webmanifest': 'application/manifest+json' };
function serve() {
  const server = createServer((req, res) => {
    let file = join(ROOT, normalize(decodeURIComponent(new URL(req.url, 'http://x').pathname)));
    if (!file.startsWith(ROOT)) return res.writeHead(403).end();
    try {
      if (statSync(file).isDirectory()) file = join(file, 'index.html');
      res.writeHead(200, { 'content-type': TYPES[extname(file)] || 'application/octet-stream', 'cache-control': 'no-store' });
      res.end(readFileSync(file));
    } catch {
      res.writeHead(404).end('not found');
    }
  });
  return new Promise((done) => server.listen(0, '127.0.0.1', () => done(server)));
}
async function loadPuppeteer() {
  const where = process.env.PUPPETEER;
  if (where) return (await import(pathToFileURL(createRequire(import.meta.url).resolve(resolve(where))).href)).default;
  return (await import('puppeteer')).default;
}

const server = await serve();
const base = `http://127.0.0.1:${server.address().port}/`;
const browser = await (await loadPuppeteer()).launch({ args: ['--no-sandbox'] });

/** A fresh page with `record` opened in the replay viewer; returns it and a seek to move `k`. */
async function viewer(record, [width, height]) {
  const context = await browser.createBrowserContext();
  const page = await context.newPage();
  await page.setViewport({ width, height, deviceScaleFactor: 1 });
  // Reduced motion: each capture is the settled board, never a cell caught halfway through its animation.
  await page.emulateMediaFeatures([{ name: 'prefers-reduced-motion', value: 'reduce' }]);
  // Seeded randomness (Math.random and crypto.getRandomValues), so the default player name and anything else drawn
  // at random comes out the same on every run.
  await page.evaluateOnNewDocument(() => {
    let a = 20261015;
    Math.random = () => {
      a = (a + 0x6d2b79f5) | 0;
      let t = Math.imul(a ^ (a >>> 15), 1 | a);
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
    crypto.getRandomValues = (bytes) => {
      for (let i = 0; i < bytes.length; i++) bytes[i] = Math.floor(Math.random() * 256);
      return bytes;
    };
  });
  await page.goto(base, { waitUntil: 'networkidle0' });
  await page.evaluate((r) => {
    localStorage.clear();
    localStorage.setItem('minesweeper-js:replays', JSON.stringify({ v: 1, last: 'media', items: { media: r } }));
  }, record);
  await page.reload({ waitUntil: 'networkidle0' });
  // The page opens a replay from a [data-replay] click in the scores panel: borrow that path.
  await page.evaluate(() => {
    const b = Object.assign(document.createElement('button'), { hidden: true });
    b.dataset.replay = 'media';
    document.getElementById('score-panel').append(b);
    b.click();
    b.remove();
    document.activeElement?.blur();
  });
  await page.evaluate(() => document.fonts.ready);
  await new Promise((done) => setTimeout(done, 300)); // let the viewer settle before the first capture
  // Seek, then wait two frames for the board to be painted.
  const seek = (k) => page.evaluate((k) => {
    const r = document.getElementById('replay-range');
    r.value = String(k);
    r.dispatchEvent(new Event('input', { bubbles: true }));
    r.blur();
    return new Promise((done) => requestAnimationFrame(() => requestAnimationFrame(done)));
  }, k);
  return { page, context, seek };
}

mkdirSync(join(OUT, 'screenshots'), { recursive: true });
const tmp = mkdtempSync(join(tmpdir(), 'minesweeper-media-'));
try {
  // Banner frames: hold the empty board, play the solve evenly over PLAY frames, hold the cleared board.
  const record = solveReplay({ level: 'intermediate', seed: 7 });
  const { page, context, seek } = await viewer(record, [W, H]);
  const moves = await page.evaluate(() => Number(document.getElementById('replay-range').max));
  const plan = [
    ...Array(HOLD_START).fill(0),
    ...Array.from({ length: PLAY }, (_, f) => Math.round(((f + 1) / PLAY) ** 1.15 * moves)),
    ...Array(HOLD_END).fill(moves),
  ];
  for (const [f, k] of plan.entries()) {
    await seek(k);
    await page.screenshot({ path: join(tmp, `${String(f).padStart(4, '0')}.png`) });
  }
  await context.close();
  copyFileSync(join(tmp, '0000.png'), join(OUT, 'banner.png'));

  // The loop: the sequence, then a fade from its last frame into its first.
  const offset = (plan.length / FPS - FADE).toFixed(3);
  const loop = `[0]fps=${FPS}[a];[1]fps=${FPS},trim=duration=${FADE}[b];[a][b]xfade=transition=fade:duration=${FADE}:offset=${offset}`;
  const inputs = ['-framerate', String(FPS), '-i', join(tmp, '%04d.png'), '-loop', '1', '-framerate', String(FPS), '-t', String(FADE), '-i', join(tmp, '0000.png')];
  const ff = (...a) => execFileSync('ffmpeg', ['-v', 'error', '-y', ...inputs, ...a], { stdio: 'inherit' });
  ff('-filter_complex', `${loop},split[x][y];[x]palettegen=max_colors=64:stats_mode=diff[p];[y][p]paletteuse=dither=none:diff_mode=rectangle`, '-loop', '0', join(OUT, 'banner.gif'));
  ff('-filter_complex', loop, '-c:v', 'libwebp_anim', '-lossless', '0', '-quality', '80', '-loop', '0', join(OUT, 'banner.webp'));

  const screenshots = [];
  for (const [name, { level, seed, at, view }, caption] of SHOTS) {
    const r = solveReplay({ level, seed });
    const v = await viewer(r, view);
    const max = await v.page.evaluate(() => Number(document.getElementById('replay-range').max));
    await v.seek(Math.round(at * max));
    const src = `screenshots/${name}.png`;
    await v.page.screenshot({ path: join(OUT, src) });
    await v.context.close();
    screenshots.push({ src, caption });
  }

  const git = (...a) => execFileSync('git', a, { cwd: ROOT, encoding: 'utf8' }).trim();
  const pkg = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8'));
  const manifest = {
    logo: 'logo.png',
    banner: { webp: 'banner.webp', gif: 'banner.gif', still: 'banner.png' },
    screenshots,
    version: pkg.version,
    commit: git('rev-parse', '--short', 'HEAD'),
    generatedAt: new Date().toISOString().replace(/\.\d+Z$/, 'Z'),
  };
  writeFileSync(join(OUT, 'media.json'), `${JSON.stringify(manifest, null, '\t')}\n`);
  for (const f of ['logo.png', 'banner.png', 'banner.gif', 'banner.webp', ...screenshots.map((s) => s.src)]) {
    console.log(`media/${f} ${(statSync(join(OUT, f)).size / 1024).toFixed(0)} KB`);
  }
} finally {
  rmSync(tmp, { recursive: true, force: true });
  await browser.close();
  server.close();
}
