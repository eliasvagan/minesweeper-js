/** Token buckets in memory, keyed by kind and client. Idle buckets are dropped by `sweep`. */
export class RateLimiter {
  constructor(limits, now = Date.now) {
    this.limits = limits;
    this.now = now;
    this.buckets = new Map();
  }

  /** Take one token; false when the bucket is empty. */
  take(kind, key) {
    const limit = this.limits[kind];
    if (!limit) throw new Error(`no limit named ${kind}`);
    const id = `${kind}\u0000${key}`;
    const t = this.now();
    let b = this.buckets.get(id);
    if (!b) {
      b = { tokens: limit.burst, at: t };
      this.buckets.set(id, b);
    }
    // Refill for the time since the last take, `rate` a second, never above `burst`.
    b.tokens = Math.min(limit.burst, b.tokens + ((t - b.at) / 1000) * limit.rate);
    b.at = t;
    if (b.tokens < 1) return false;
    b.tokens -= 1;
    return true;
  }

  /** Drop buckets idle for an hour: longer than any in LIMITS takes to refill, so a fresh one is the same. */
  sweep() {
    const t = this.now();
    for (const [id, b] of this.buckets) if (t - b.at > 3600e3) this.buckets.delete(id);
  }
}
