import type {
  DistributedRateLimitResult,
  RateLimitQuota,
} from './distributed-rate-limiter.js';
import type { RateLimitDecision } from './policy.js';

/** Enough for an outage's clients. Past it the oldest counters go first. */
const MAX_COUNTERS = 50_000;

interface Counter {
  count: number;
  expiresAt: number;
}

/**
 * Counts fallback requests with the same increment/refusal rule as Redis's script.
 * Each process starts an independent window on first use, without Redis's prior count.
 * Restarting the process or evicting a counter grants that subject a fresh budget.
 */
export class LocalRateLimiter {
  private readonly counters = new Map<string, Counter>();

  public constructor(private readonly now: () => number = Date.now) {}

  public consume(decision: RateLimitDecision): DistributedRateLimitResult {
    const now = this.now();
    const keyed = decision.dimensions.map((dimension) => ({
      dimension,
      key: `${decision.endpointClass}\0${dimension.kind}\0${dimension.identifier}`,
    }));
    let limited:
      | { retryMillis: number; dimension: (typeof keyed)[number]['dimension'] }
      | undefined;
    for (const { dimension, key } of keyed) {
      const counter = this.live(key, now);
      if (counter === undefined || counter.count < dimension.limit) continue;
      const retryMillis = counter.expiresAt - now;
      if (limited === undefined || retryMillis > limited.retryMillis)
        limited = { retryMillis, dimension };
    }
    if (limited !== undefined)
      return {
        allowed: false,
        retryAfterSeconds: Math.ceil(limited.retryMillis / 1_000),
        limitedDimension: limited.dimension.kind,
      };
    let quota: RateLimitQuota | undefined;
    for (const { dimension, key } of keyed) {
      let counter = this.live(key, now);
      if (counter === undefined) {
        this.makeRoom(now);
        counter = { count: 1, expiresAt: now + decision.windowSeconds * 1_000 };
        this.counters.set(key, counter);
      } else counter.count += 1;
      const remaining = dimension.limit - counter.count;
      if (quota === undefined || remaining < quota.remaining)
        quota = {
          limit: dimension.limit,
          remaining,
          resetSeconds: Math.max(
            1,
            Math.ceil((counter.expiresAt - now) / 1_000),
          ),
        };
    }
    return quota === undefined ? { allowed: true } : { allowed: true, quota };
  }

  private live(key: string, now: number): Counter | undefined {
    const counter = this.counters.get(key);
    if (counter === undefined || counter.expiresAt > now) return counter;
    this.counters.delete(key);
    return undefined;
  }

  private makeRoom(now: number): void {
    if (this.counters.size < MAX_COUNTERS) return;
    for (const [key, counter] of this.counters)
      if (counter.expiresAt <= now) this.counters.delete(key);
    if (this.counters.size < MAX_COUNTERS) return;
    const oldest = this.counters.keys().next();
    if (oldest.done !== true) this.counters.delete(oldest.value);
  }
}
