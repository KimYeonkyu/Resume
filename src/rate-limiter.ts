export interface LoginRateLimiter {
  allow(key: string, nowMilliseconds?: number): boolean;
}

export interface BoundedRateLimiterOptions {
  limit: number;
  maxKeys: number;
  windowMs: number;
}

interface Bucket {
  count: number;
  windowStartedAt: number;
}

export class BoundedRateLimiter implements LoginRateLimiter {
  readonly #buckets = new Map<string, Bucket>();
  readonly #limit: number;
  readonly #maxKeys: number;
  readonly #windowMs: number;

  constructor(options: BoundedRateLimiterOptions) {
    if (!Number.isSafeInteger(options.limit) || options.limit < 0) {
      throw new Error("Rate-limit count must be a non-negative integer");
    }
    if (!Number.isSafeInteger(options.maxKeys) || options.maxKeys < 1 || options.maxKeys > 100_000) {
      throw new Error("Rate-limit key capacity is outside the supported range");
    }
    if (!Number.isSafeInteger(options.windowMs) || options.windowMs < 1_000) {
      throw new Error("Rate-limit window must be at least one second");
    }
    this.#limit = options.limit;
    this.#maxKeys = options.maxKeys;
    this.#windowMs = options.windowMs;
  }

  get size(): number {
    return this.#buckets.size;
  }

  allow(key: string, nowMilliseconds = Date.now()): boolean {
    const normalizedKey = key.slice(0, 128) || "unknown";
    const current = this.#buckets.get(normalizedKey);
    if (current && nowMilliseconds - current.windowStartedAt < this.#windowMs) {
      current.count += 1;
      this.#buckets.delete(normalizedKey);
      this.#buckets.set(normalizedKey, current);
      return current.count <= this.#limit;
    }

    if (current) this.#buckets.delete(normalizedKey);
    this.#removeExpired(nowMilliseconds);
    while (this.#buckets.size >= this.#maxKeys) {
      const oldest = this.#buckets.keys().next().value as string | undefined;
      if (oldest === undefined) break;
      this.#buckets.delete(oldest);
    }
    this.#buckets.set(normalizedKey, { count: 1, windowStartedAt: nowMilliseconds });
    return this.#limit >= 1;
  }

  #removeExpired(nowMilliseconds: number): void {
    for (const [key, bucket] of this.#buckets) {
      if (nowMilliseconds - bucket.windowStartedAt >= this.#windowMs) {
        this.#buckets.delete(key);
      }
    }
  }
}
