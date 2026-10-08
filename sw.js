/*
 * Minesweeper's service worker: the app shell is precached, so the game launches and plays offline (unranked,
 * as it already does when the server is away). Scope is this directory, e.g. https://eliasv.com/minesweeper/.
 *
 *   - VERSION is a hash of the shell files (node scripts/sw-version.mjs stamps it; a unit test checks it), so any
 *     change to the shell is a new worker and a new cache, and nothing else is.
 *   - The shell is served cache-first from its versioned cache; navigations inside the scope get index.html.
 *   - The API (…/api/) is never touched: network only, not even intercepted. Nor is anything but GET.
 *   - The web font (Google Fonts) is cached as it is first used, in a cache of its own that outlives versions.
 *   - A new worker installs in the background and waits. The page applies it (SKIP_WAITING) by itself on a fresh
 *     board: at launch, on a new game, on return to the app. Mid-game, or on a result, only the quiet "update
 *     ready" button shows; the next new game applies it.
 */
const VERSION = '61f920e5c44a';
const SHELL_CACHE = `minesweeper-shell-${VERSION}`;
const FONT_CACHE = 'minesweeper-fonts-1';
const SHELL = [
  './',
  'manifest.webmanifest',
  'favicon.svg',
  'icons/icon-32.png',
  'icons/icon-192.png',
  'icons/apple-touch-icon.png',
  'minesweeper/style.css',
  'minesweeper/app.js',
  'minesweeper/engine.js',
  'minesweeper/names.js',
  'minesweeper/online.js',
  'minesweeper/records.js',
  'minesweeper/pwa.js',
  'minesweeper/daily.js',
  'minesweeper/replay.js',
  'minesweeper/share.js',
  'minesweeper/charts.js',
];

// Everything is relative to the scope, so the same worker runs wherever the directory is served.
const scope = new URL(self.registration.scope);
const api = new URL('api/', scope).pathname;
const shellUrl = new URL('./', scope).href;

self.addEventListener('install', (event) => {
  // `reload`: fetch past the HTTP cache, so a new version never precaches an old file.
  event.waitUntil(caches.open(SHELL_CACHE).then((cache) => cache.addAll(SHELL.map((u) => new Request(u, { cache: 'reload' })))));
});

self.addEventListener('activate', (event) => {
  event.waitUntil((async () => {
    const keep = new Set([SHELL_CACHE, FONT_CACHE]);
    for (const key of await caches.keys()) if (key.startsWith('minesweeper-') && !keep.has(key)) await caches.delete(key);
    await self.clients.claim();
  })());
});

self.addEventListener('message', (event) => {
  if (event.data === 'skip-waiting' || event.data?.type === 'SKIP_WAITING') self.skipWaiting();
  else if (event.data === 'version') event.source?.postMessage({ version: VERSION });
});

const FONT_HOSTS = new Set(['fonts.googleapis.com', 'fonts.gstatic.com']);

self.addEventListener('fetch', (event) => {
  const { request } = event;
  if (request.method !== 'GET') return;
  const url = new URL(request.url);

  if (url.origin === scope.origin) {
    if (url.pathname.startsWith(api) || !url.pathname.startsWith(scope.pathname)) return; // network only
    if (request.mode === 'navigate') {
      event.respondWith(navigate(url));
      return;
    }
    event.respondWith(caches.match(request, { cacheName: SHELL_CACHE, ignoreSearch: true }).then((hit) => hit || fetch(request)));
    return;
  }
  if (FONT_HOSTS.has(url.hostname)) event.respondWith(font(request));
});

/** The game's own page is the shell; any other page in the scope is tried on the network first. */
async function navigate(url) {
  const cache = await caches.open(SHELL_CACHE);
  const isShell = url.pathname === scope.pathname || url.pathname === `${scope.pathname}index.html`;
  if (isShell) return (await cache.match(shellUrl)) || fetch(url);
  try {
    return await fetch(url);
  } catch {
    // Offline and not the game's own address (say /minesweeper/minesweeper/, the old one): go to the game.
    return Response.redirect(shellUrl, 302);
  }
}

/**
 * Cache first, filled on first use. Opaque responses (cross-origin, no CORS, so their status cannot be read) are
 * kept as well as good ones.
 */
async function font(request) {
  const cache = await caches.open(FONT_CACHE);
  const hit = await cache.match(request);
  if (hit) return hit;
  const res = await fetch(request);
  if (res.ok || res.type === 'opaque') cache.put(request, res.clone());
  return res;
}
