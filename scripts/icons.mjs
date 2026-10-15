#!/usr/bin/env node
/**
 * Draws the favicon and the app icons: the mine that went off, exactly as the board shows it after a loss
 * (the `is-hit` cell: --bad red, corner radius 20 % of the cell, the #g-mine glyph at 64 % in #1d1d1d).
 * Writes favicon.svg and icons/*.png, and media/logo.png: the same cell beside the "Minesweeper" wordmark in the
 * page's own monospace font, on a transparent background. Run after changing the glyph or the colours:
 *
 *     PUPPETEER=/path/to/node_modules/puppeteer node scripts/icons.mjs
 */
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT = resolve(fileURLToPath(new URL('..', import.meta.url)));
const html = readFileSync(resolve(ROOT, 'index.html'), 'utf8');
const css = readFileSync(resolve(ROOT, 'minesweeper/style.css'), 'utf8');
const color = (name) => css.match(new RegExp(`--${name}:\\s*(#[0-9a-f]+)`, 'i'))[1];
const BAD = color('bad'); // the exploded cell
const BOARD = color('board'); // the frame around the cells
const TEXT = color('ink');
const ACCENT = color('accent');
const MONO = css.match(/--mono:\s*([^;]+);/)[1];
const INK = css.match(/\.cell\.is-hit\s*\{[^}]*color:\s*(#[0-9a-f]+)/i)[1];
// The glyph itself, taken from the page's sprite so the icon can never drift from the board.
const mine = html.match(/<symbol id="g-mine" viewBox="0 0 24 24">([\s\S]*?)<\/symbol>/)[1];

/** A cell of side `s` centred in a `size` square, with the glyph at 64 % of it, like `.cell > svg`. */
function cell(size, s) {
  const o = (size - s) / 2;
  const g = s * 0.64;
  const go = o + (s - g) / 2;
  return `<rect x="${o}" y="${o}" width="${s}" height="${s}" rx="${s * 0.2}" fill="${BAD}"/>`
    + `<g transform="translate(${go} ${go}) scale(${g / 24})" color="${INK}">${mine}</g>`;
}
const svg = (size, body) => `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${size} ${size}" width="${size}" height="${size}">${body}</svg>`;

// Transparent corners: the cell alone. Browser tabs, the install dialog, the Android "any" icon.
const plain = svg(512, cell(512, 512));
// Opaque, on the board's colour (iOS fills transparency with black and rounds the corners itself).
const touch = svg(512, `<rect width="512" height="512" fill="${BOARD}"/>${cell(512, 512 * 0.76)}`);
// Maskable: the whole cell, rounded corners included, inside the 40 %-radius safe circle (0.624 s <= 0.4).
const maskable = svg(512, `<rect width="512" height="512" fill="${BOARD}"/>${cell(512, 512 * 0.62)}`);

writeFileSync(resolve(ROOT, 'favicon.svg'), plain.replace(/ width="512" height="512"/, '') + '\n');
mkdirSync(resolve(ROOT, 'icons'), { recursive: true });

// Puppeteer is not a dependency of this repository: PUPPETEER points at any install of it, else plain 'puppeteer'.
async function loadPuppeteer() {
  const where = process.env.PUPPETEER;
  if (where) return (await import(pathToFileURL(createRequire(import.meta.url).resolve(resolve(where))).href)).default;
  return (await import('puppeteer')).default;
}
const puppeteer = await loadPuppeteer();
const browser = await puppeteer.launch({ args: ['--no-sandbox'] });
const page = await browser.newPage();
const outputs = [
  ['icon-16.png', plain, 16], ['icon-32.png', plain, 32], ['icon-192.png', plain, 192], ['icon-512.png', plain, 512],
  ['apple-touch-icon.png', touch, 180], ['icon-maskable-512.png', maskable, 512],
];
// Each PNG is a screenshot of the SVG at its own size; omitBackground keeps the transparent corners transparent.
for (const [name, source, px] of outputs) {
  await page.setViewport({ width: px, height: px, deviceScaleFactor: 1 });
  const sized = source.replace(/ width="512" height="512"/, ` width="${px}" height="${px}"`);
  await page.setContent(`<!doctype html><style>html,body{margin:0;background:transparent}svg{display:block}</style>${sized}`);
  await page.screenshot({ path: resolve(ROOT, 'icons', name), omitBackground: true, clip: { x: 0, y: 0, width: px, height: px } });
  console.log(`icons/${name} ${px}×${px}`);
}

// The logo: the cell, then "Mine" in the page's ink and "sweeper" in its accent, plain and
// transparent. Trimmed to the drawn pixels by the screenshot's clip.
const LOGO_H = 240;
await page.setViewport({ width: 1600, height: 400, deviceScaleFactor: 1 });
await page.setContent(`<!doctype html><style>
html,body{margin:0;background:transparent}
.logo{display:inline-flex;align-items:center;gap:${LOGO_H * 0.16}px;padding:${LOGO_H * 0.04}px;font:800 ${LOGO_H * 0.5}px/1 ${MONO};letter-spacing:-0.02em}
.logo svg{display:block;width:${LOGO_H * 0.62}px;height:${LOGO_H * 0.62}px}
.mine{color:${TEXT}}.sweeper{color:${ACCENT}}
</style><div class="logo">${svg(512, cell(512, 512)).replace(/ width="512" height="512"/, '')}<span><span class="mine">Mine</span><span class="sweeper">sweeper</span></span></div>`);
await page.evaluate(() => document.fonts.ready);
const box = await (await page.$('.logo')).boundingBox();
mkdirSync(resolve(ROOT, 'media'), { recursive: true });
await page.screenshot({ path: resolve(ROOT, 'media/logo.png'), omitBackground: true, clip: box });
console.log(`media/logo.png ${Math.round(box.width)}×${Math.round(box.height)}`);
await browser.close();
