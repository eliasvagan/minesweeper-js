/**
 * The installable app: registers the service worker (../sw.js) and applies updates without breaking a game.
 * A new version downloads in the background and waits. It is applied (one reload into the new version) only when
 * no game is in progress: straight away at launch, or later from the quiet "update ready" button, which shows
 * only between games. A game in progress is never interrupted; worst case the update waits for the next launch.
 */

/**
 * @param {object} o
 * @param {() => boolean} o.busy       true while a game is in progress
 * @param {(ready: boolean) => void} o.onReady  show or hide the "update ready" hint
 * @returns {{ refresh(): void, apply(): void }}  refresh: call when the game state changes
 */
export function initPwa({ busy, onReady }) {
  const none = { refresh() {}, apply() {} };
  if (!('serviceWorker' in navigator) || !isSecureContext) return none;
  const sw = navigator.serviceWorker;
  let registration = null;
  let applying = false;
  const hadController = !!sw.controller;

  const waiting = () => (registration?.waiting && sw.controller ? registration.waiting : null);
  const refresh = () => onReady(!!waiting() && !busy());
  function apply() {
    const w = waiting();
    if (!w || busy()) return;
    applying = true;
    w.postMessage('skip-waiting');
  }

  // Only a switch this page asked for reloads it; the first install (no controller before) never does.
  sw.addEventListener('controllerchange', () => {
    if (applying && hadController) location.reload();
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
    // At launch, with nothing in progress, an update that was waiting is applied before anyone plays.
    if (waiting() && !busy()) apply();
    else refresh();
    // A long-open app still hears about new versions.
    document.addEventListener('visibilitychange', () => {
      if (document.visibilityState === 'visible') registration.update().catch(() => {});
    });
  });

  return { refresh, apply };
}
