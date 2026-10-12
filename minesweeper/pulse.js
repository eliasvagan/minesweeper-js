// pulse: tiny, privacy first game events for the eliasv.com dashboard (eliasv.com/analytics).
// No cookies, no ids, nothing about the player: an event is a name and a few plain values. Batched and sent with
// sendBeacon when the page hides, every 15 s, or at 20 events. Do Not Track and Global Privacy Control turn it
// off. A browser tab keeps nothing: what cannot be sent is dropped. Only the installed app (home screen) keeps
// unsent events in localStorage, at most 200, and sends them when it is next online.
// Usage: const pulse = createPulse('gemtd', { version: '1.4.0', installed: () => standalone() }); pulse('game.end', { won: true })
export function createPulse(project, { version = null, installed = () => false, endpoint = `/dash/in/${project}` } = {}) {
  const nav = typeof navigator === 'undefined' ? null : navigator;
  const off = !nav || nav.doNotTrack === '1' || nav.globalPrivacyControl === true || typeof location === 'undefined' || !/^(www\.)?eliasv\.com$/.test(location.hostname);
  if (off) return Object.assign(() => {}, { flush() {} });
  const KEY = `pulse:${project}`;
  let queue = [];
  let timer = null;
  const keep = () => { try { return installed(); } catch { return false; } };
  const send = (events) => {
    const body = JSON.stringify({ v: 1, version, installed: keep(), events });
    try { return nav.onLine !== false && nav.sendBeacon(endpoint, new Blob([body], { type: 'text/plain' })); } catch { return false; }
  };
  const flush = () => {
    clearTimeout(timer); timer = null;
    let events = queue; queue = [];
    if (keep()) { try { events = [...JSON.parse(localStorage.getItem(KEY) || '[]'), ...events]; localStorage.removeItem(KEY); } catch {} }
    for (let i = 0; i < events.length; i += 20) {
      const batch = events.slice(i, i + 20);
      if (!send(batch) && keep()) {
        try { localStorage.setItem(KEY, JSON.stringify(events.slice(i).slice(-200))); } catch {}
        break;
      }
    }
  };
  addEventListener('pagehide', flush);
  addEventListener('online', flush);
  document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'hidden') flush(); });
  if (keep()) setTimeout(flush, 3000); // what an earlier offline session kept
  const pulse = (name, props) => {
    queue.push(props ? { name, props } : { name });
    if (queue.length >= 20) flush(); else if (!timer) timer = setTimeout(flush, 15000);
  };
  pulse.flush = flush;
  return pulse;
}
