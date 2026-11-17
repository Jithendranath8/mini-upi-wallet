export interface RateLimitDecision {
  allowed: boolean;
  remaining: number;
  retryAfterMs: number;
}

export interface RateLimiter {
  tryConsume(clientKey: string): RateLimitDecision;
  stats(): { capacity: number; refillPerSecond: number; allowed: number; rejected: number; trackedClients: number };
  reset(): void;
}

interface Bucket {
  tokens: number;
  lastRefill: number;
}

/**
 * Token bucket: each client has a bucket of `capacity` tokens that refills at a steady rate.
 * A request costs one token. This allows short bursts while capping the sustained rate.
 */
export class TokenBucketRateLimiter implements RateLimiter {
  static readonly MAX_TRACKED_CLIENTS = 10_000;
  readonly #buckets = new Map<string, Bucket>();
  #allowed = 0;
  #rejected = 0;

  constructor(
    private readonly capacity: number,
    private readonly refillPerSecond: number,
  ) {}

  tryConsume(clientKey: string): RateLimitDecision {
    const now = Date.now();
    const bucket = this.#buckets.get(clientKey) ?? { tokens: this.capacity, lastRefill: now };
    this.#buckets.set(clientKey, bucket);
    if (this.#buckets.size > TokenBucketRateLimiter.MAX_TRACKED_CLIENTS) this.evictIdle(now);

    // Never negative: if the wall clock steps backwards (NTP correction, VM resume) a bucket
    // must not lose the tokens it already holds.
    const elapsedSeconds = Math.max(0, now - bucket.lastRefill) / 1000;
    bucket.tokens = Math.min(this.capacity, bucket.tokens + elapsedSeconds * this.refillPerSecond);
    bucket.lastRefill = now;

    if (bucket.tokens >= 1) {
      bucket.tokens -= 1;
      this.#allowed += 1;
      return { allowed: true, remaining: Math.floor(bucket.tokens), retryAfterMs: 0 };
    }
    this.#rejected += 1;
    const retryAfterMs = Math.ceil(((1 - bucket.tokens) / this.refillPerSecond) * 1000);
    return { allowed: false, remaining: 0, retryAfterMs };
  }

  /** A bucket that has had time to refill completely carries no information: drop it. */
  private evictIdle(now: number): void {
    const fullAfterMs = (this.capacity / this.refillPerSecond) * 1000;
    for (const [key, bucket] of this.#buckets) {
      if (now - bucket.lastRefill >= fullAfterMs) this.#buckets.delete(key);
    }
    // Still too many (a flood of distinct keys): drop the oldest entries.
    for (const key of this.#buckets.keys()) {
      if (this.#buckets.size <= TokenBucketRateLimiter.MAX_TRACKED_CLIENTS) break;
      this.#buckets.delete(key);
    }
  }

  stats() {
    return {
      capacity: this.capacity,
      refillPerSecond: this.refillPerSecond,
      allowed: this.#allowed,
      rejected: this.#rejected,
      trackedClients: this.#buckets.size,
    };
  }

  reset(): void {
    this.#buckets.clear();
  }
}
