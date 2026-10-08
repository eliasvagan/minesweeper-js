/**
 * The installable app: registers the service worker (../sw.js) and keeps the game on the newest version without
 * breaking a game. Updates are checked on load, and again whenever the app comes back (visibilitychange, focus,
 * pageshow: iOS standalone resumes without a load). A worker that is waiting is applied automatically (skip
 * waiting, then one reload on controllerchange) whenever the board is a fresh one nobody has touched: at launch,
 * on a new game, on return to the app. A game in progress is never interrupted, and nor is the result of one just
 * finished; then only the quiet "update ready" button shows (between games), and the next new game applies it.
 *
 * Offline play is for the installed app only (home screen or desktop install: display-mode standalone or
 * fullscreen, navigator.standalone on iOS). A browser tab never registers the worker: it removes one left by older
 * versions, with its caches, so it always loads what is deployed, like any page. The installed app registers it
 * again at its next launch.
 */

const RELOAD_KEY = 'minesweeper-sw-reload';

/**
 * The deferral rule. `auto`: may an update reload the page by itself now? Only on a fresh, untouched board.
 * `manual`: may the "update ready" button apply it? Any time but mid-game.
 * @param {string | undefined} status  the game's status (ready | playing | won | lost), or replay while one is watched
 */
export const updatePolicy = (status) => ({ auto: !status || status === 'ready', manual: status !== 'playing' });

/** Running as the installed app rather than in a browser tab. */
export const standalone = () =>
  matchMedia('(display-mode: standalone), (display-mode: fullscreen)').matches || navigator.standalone === true;

/** A tab: drop this scope's worker and the game's caches. */
async function removeWorker(sw) {
  const scope = new URL('../', import.meta.url).href;
  const reg = await sw.getRegistration(scope);
  if (reg?.scope === scope) await reg.unregister();
  for (const key of await caches.keys()) if (key.startsWith('minesweeper-')) await caches.delete(key);
}

/**
 * @param {object} o
 * @param {() => string | undefined} o.status  the current game's status
 * @param {(ready: boolean) => void} o.onReady  show or hide the "update ready" hint
 * @returns {{ refresh(): void, apply(): void }}  refresh: call when the game state changes
 */
export function initPwa({ status, onReady }) {
  const none = { refresh() {}, apply() {} };
  if (!('serviceWorker' in navigator) || !isSecureContext) return none;
  const sw = navigator.serviceWorker;
  if (!standalone()) {
    removeWorker(sw).catch(() => {});
    return none;
  }
  let registration = null;
  let applying = false;

  const waiting = () => (registration?.waiting && sw.controller ? registration.waiting : null);
  function apply() {
    const w = waiting();
    if (!w || !updatePolicy(status()).manual) return;
    applying = true;
    w.postMessage({ type: 'SKIP_WAITING' });
  }
  /** Apply a waiting worker if nothing would be lost; otherwise show the hint when it may be used. */
  function refresh() {
    const policy = updatePolicy(status());
    if (waiting() && policy.auto) apply();
    else onReady(!!waiting() && policy.manual);
  }
  const check = () => registration?.update().catch(() => {}).finally(refresh);

  // Only a switch this page asked for reloads it (the first install claims silently), and only once: a second
  // switch within 10 s never reloads again, so a broken deploy cannot loop.
  sw.addEventListener('controllerchange', () => {
    if (!applying) return;
    const last = Number(sessionStorage.getItem(RELOAD_KEY) || 0);
    if (Date.now() - last < 10_000) return;
    sessionStorage.setItem(RELOAD_KEY, String(Date.now()));
    location.reload();
  });

  addEventListener('load', async () => {
    try {
      registration = await sw.register(new URL('../sw.js', import.meta.url), { scope: new URL('../', import.meta.url).pathname });
    } catch {
      return; // no worker: the game works as a plain page
    }
    const watch = (worker) => worker?.addEventListener('statechange', () => { if (worker.state === 'installed') refresh(); });
    watch(registration.installing);
    registration.addEventListener('updatefound', () => watch(registration.installing));
    refresh();
    check();
    document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible') check(); });
    addEventListener('focus', check);
    addEventListener('pageshow', check);
  });

  return { refresh, apply };
}
