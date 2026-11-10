/**
 * Circuit breaker for a flaky upstream (a source, an API, a service).
 *
 * Wraps async work and tracks consecutive failures:
 *
 * - **closed** — calls pass through. Consecutive failures trip the breaker.
 * - **open** — calls fail fast with `CircuitOpenError`; no work is attempted.
 * - **half-open** — after `resetTimeoutMs`, a single probe is allowed. Success
 *   closes the breaker; failure reopens it for another timeout.
 *
 * ```ts
 * const breaker = new CircuitBreaker({ failureThreshold: 5 });
 * await breaker.exec(() => fetchJson(url));
 * ```
 */

export type CircuitState = "closed" | "open" | "half-open";

export interface CircuitBreakerOptions {
  /** Consecutive failures that trip the breaker. Default 5. */
  failureThreshold?: number;
  /** How long the breaker stays open before allowing a probe. Default 30s. */
  resetTimeoutMs?: number;
  /** Successful half-open probes needed to close the breaker. Default 1. */
  successThreshold?: number;
  /** Injectable clock (milliseconds). Defaults to `Date.now`. */
  now?: () => number;
  /** Called whenever the state changes, e.g. to emit metrics. */
  onStateChange?: (state: CircuitState, previous: CircuitState) => void;
}

/** Thrown without invoking the wrapped function while the breaker is open. */
export class CircuitOpenError extends Error {
  readonly code = "CIRCUIT_OPEN" as const;
  /** Best-effort hint for when a probe will next be allowed. */
  readonly retryAfterMs: number;

  constructor(retryAfterMs = 0) {
    const wait = Math.max(0, Math.ceil(retryAfterMs));
    super(`Circuit breaker is open; retry in ${wait}ms`);
    this.name = "CircuitOpenError";
    this.retryAfterMs = wait;
  }
}

export function isCircuitOpenError(error: unknown): error is CircuitOpenError {
  return error instanceof CircuitOpenError;
}

export class CircuitBreaker {
  readonly failureThreshold: number;
  readonly resetTimeoutMs: number;
  readonly successThreshold: number;

  private readonly now: () => number;
  private readonly onStateChange?: (state: CircuitState, previous: CircuitState) => void;
  private currentState: CircuitState = "closed";
  private failures = 0;
  private halfOpenSuccesses = 0;
  private openedAt = 0;
  private probeInFlight = false;

  constructor(options: CircuitBreakerOptions = {}) {
    const failureThreshold = options.failureThreshold ?? 5;
    const resetTimeoutMs = options.resetTimeoutMs ?? 30_000;
    const successThreshold = options.successThreshold ?? 1;

    if (!Number.isInteger(failureThreshold) || failureThreshold < 1) {
      throw new RangeError("CircuitBreaker failureThreshold must be a positive integer");
    }
    if (!Number.isFinite(resetTimeoutMs) || resetTimeoutMs < 0) {
      throw new RangeError("CircuitBreaker resetTimeoutMs must be zero or greater");
    }
    if (!Number.isInteger(successThreshold) || successThreshold < 1) {
      throw new RangeError("CircuitBreaker successThreshold must be a positive integer");
    }

    this.failureThreshold = failureThreshold;
    this.resetTimeoutMs = resetTimeoutMs;
    this.successThreshold = successThreshold;
    this.now = options.now ?? Date.now;
    this.onStateChange = options.onStateChange;
  }

  get state(): CircuitState {
    return this.currentState;
  }

  /** Consecutive failures recorded while closed (or in the last closed run). */
  get failureCount(): number {
    return this.failures;
  }

  /** Runs `fn`, recording successes/failures and enforcing the breaker state. */
  async exec<T>(fn: () => Promise<T> | T): Promise<T> {
    const now = this.now();

    // Move open -> half-open lazily, on the first call after the timeout.
    if (
      this.currentState === "open" &&
      now - this.openedAt >= this.resetTimeoutMs
    ) {
      this.halfOpenSuccesses = 0;
      this.transition("half-open");
    }

    if (this.currentState === "open") {
      throw new CircuitOpenError(this.resetTimeoutMs - (now - this.openedAt));
    }

    const isProbe = this.currentState === "half-open";
    if (isProbe) {
      if (this.probeInFlight) {
        // Only one trial call at a time; let the probe decide the outcome.
        throw new CircuitOpenError(this.resetTimeoutMs);
      }
      this.probeInFlight = true;
    }

    try {
      const result = await fn();
      this.recordSuccess();
      return result;
    } catch (error) {
      this.recordFailure();
      throw error;
    } finally {
      if (isProbe) this.probeInFlight = false;
    }
  }

  /** Returns the breaker to its initial closed state. */
  reset(): void {
    this.failures = 0;
    this.halfOpenSuccesses = 0;
    this.openedAt = 0;
    this.probeInFlight = false;
    this.transition("closed");
  }

  private recordSuccess(): void {
    if (this.currentState === "half-open") {
      this.halfOpenSuccesses += 1;
      if (this.halfOpenSuccesses >= this.successThreshold) {
        this.failures = 0;
        this.halfOpenSuccesses = 0;
        this.transition("closed");
      }
      return;
    }

    // Any success in the closed state clears the consecutive-failure count.
    this.failures = 0;
  }

  private recordFailure(): void {
    if (this.currentState === "half-open") {
      this.halfOpenSuccesses = 0;
      this.trip();
      return;
    }

    this.failures += 1;
    if (this.failures >= this.failureThreshold) this.trip();
  }

  private trip(): void {
    this.openedAt = this.now();
    this.probeInFlight = false;
    this.transition("open");
  }

  private transition(next: CircuitState): void {
    if (this.currentState === next) return;

    const previous = this.currentState;
    this.currentState = next;

    try {
      this.onStateChange?.(next, previous);
    } catch {
      // Observability hooks must never break the breaker itself.
    }
  }
}
