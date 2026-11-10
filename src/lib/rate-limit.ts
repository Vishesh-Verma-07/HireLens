/**
 * Per-source token bucket.
 *
 * Sources are public endpoints with undocumented (or explicit) rate limits, so
 * every outbound request should ask its limiter for permission first:
 *
 * ```ts
 * const limiter = new RateLimiter({ capacity: 5, refillPerSecond: 1 });
 * await limiter.acquire(); // resolves once a token is available
 * ```
 *
 * Bursts up to `capacity` are allowed immediately; after that tokens refill
 * continuously at `refillPerSecond`. `acquire()` waits instead of failing, and
 * waiters are served in FIFO order so a burst cannot starve an earlier caller.
 */

export interface RateLimiterOptions {
  /** Maximum tokens the bucket can hold, i.e. the largest burst. Default 1. */
  capacity?: number;
  /** Tokens added per second. Default 1. */
  refillPerSecond?: number;
  /** Injectable clock (milliseconds). Defaults to `Date.now`. */
  now?: () => number;
  /**
   * Injectable timer scheduler, used by tests. Must call `fn` after `delayMs`
   * and return a function that cancels the pending callback.
   */
  schedule?: (fn: () => void, delayMs: number) => () => void;
}

interface Waiter {
  cost: number;
  resolve: () => void;
}

/** Guards against floating-point drift when checking `tokens >= cost`. */
const EPSILON = 1e-9;

function defaultSchedule(fn: () => void, delayMs: number): () => void {
  const timer = setTimeout(fn, delayMs);
  return () => clearTimeout(timer);
}

export class RateLimiter {
  readonly capacity: number;
  readonly refillPerSecond: number;

  private readonly now: () => number;
  private readonly schedule: (fn: () => void, delayMs: number) => () => void;
  private tokens: number;
  private lastRefillAt: number;
  private readonly waiters: Waiter[] = [];
  private cancelTimer: (() => void) | null = null;

  constructor(options: RateLimiterOptions = {}) {
    const capacity = options.capacity ?? 1;
    const refillPerSecond = options.refillPerSecond ?? 1;

    if (!Number.isFinite(capacity) || capacity <= 0) {
      throw new RangeError("RateLimiter capacity must be a positive number");
    }
    if (!Number.isFinite(refillPerSecond) || refillPerSecond <= 0) {
      throw new RangeError("RateLimiter refillPerSecond must be a positive number");
    }

    this.capacity = capacity;
    this.refillPerSecond = refillPerSecond;
    this.now = options.now ?? Date.now;
    this.schedule = options.schedule ?? defaultSchedule;

    this.tokens = capacity;
    this.lastRefillAt = this.now();
  }

  /** Tokens currently available without waiting. */
  get availableTokens(): number {
    this.refill(this.now());
    return this.tokens;
  }

  /** Callers waiting for a token. Useful for metrics and tests. */
  get pending(): number {
    return this.waiters.length;
  }

  /**
   * Resolves when `cost` tokens are available. Tokens are deducted immediately;
   * callers are served in FIFO order.
   */
  acquire(cost = 1): Promise<void> {
    if (!Number.isFinite(cost) || cost <= 0) {
      return Promise.reject(new RangeError("RateLimiter acquire cost must be a positive number"));
    }
    if (cost > this.capacity) {
      return Promise.reject(
        new RangeError(
          `RateLimiter acquire cost (${cost}) exceeds capacity (${this.capacity}) and would never resolve`,
        ),
      );
    }

    return new Promise<void>((resolve) => {
      this.waiters.push({ cost, resolve });
      this.pump();
    });
  }

  /** Refills the bucket and resolves as many waiters as the tokens allow. */
  private pump(): void {
    this.refill(this.now());

    while (this.waiters.length > 0) {
      const next = this.waiters[0]!;
      if (this.tokens + EPSILON < next.cost) break;

      this.tokens = Math.max(0, this.tokens - next.cost);
      this.waiters.shift();
      next.resolve();
    }

    // Any schedule we made earlier is stale; recompute from the current head.
    if (this.cancelTimer) {
      this.cancelTimer();
      this.cancelTimer = null;
    }

    const head = this.waiters[0];
    if (!head) return;

    const deficit = head.cost - this.tokens;
    const delayMs = Math.max(1, Math.ceil((deficit / this.refillPerSecond) * 1000));

    this.cancelTimer = this.schedule(() => {
      this.cancelTimer = null;
      this.pump();
    }, delayMs);
  }

  private refill(at: number): void {
    const elapsedMs = Math.max(0, at - this.lastRefillAt);
    if (elapsedMs === 0) return;

    this.lastRefillAt = at;
    this.tokens = Math.min(this.capacity, this.tokens + (elapsedMs / 1000) * this.refillPerSecond);
  }
}
