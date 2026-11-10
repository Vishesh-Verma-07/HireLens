import assert from "node:assert/strict";
import test from "node:test";
import { RateLimiter } from "./rate-limit.js";

interface Timer {
  at: number;
  fn: () => void;
  cancelled: boolean;
}

/** Deterministic clock/timer pair so token-bucket tests never sleep. */
class FakeClock {
  time = 0;
  private readonly timers: Timer[] = [];

  readonly now = (): number => this.time;

  readonly schedule = (fn: () => void, delayMs: number): (() => void) => {
    const timer: Timer = { at: this.time + delayMs, fn, cancelled: false };
    this.timers.push(timer);
    return () => {
      timer.cancelled = true;
    };
  };

  advance(ms: number): void {
    const target = this.time + ms;

    for (;;) {
      let next: Timer | undefined;
      for (const timer of this.timers) {
        if (timer.cancelled || timer.at > target) continue;
        if (!next || timer.at < next.at) next = timer;
      }
      if (!next) break;

      next.cancelled = true;
      this.time = next.at;
      next.fn();
    }

    this.time = target;
  }

  get pendingTimers(): number {
    return this.timers.filter((timer) => !timer.cancelled).length;
  }
}

function flush(): Promise<void> {
  return new Promise((resolve) => setImmediate(resolve));
}

test("allows a burst up to capacity, then waits for a refill", async () => {
  const clock = new FakeClock();
  const limiter = new RateLimiter({
    capacity: 2,
    refillPerSecond: 1,
    now: clock.now,
    schedule: clock.schedule,
  });

  await limiter.acquire();
  await limiter.acquire();

  let resolved = false;
  const pending = limiter.acquire().then(() => {
    resolved = true;
  });

  await flush();
  assert.equal(resolved, false);
  assert.equal(limiter.pending, 1);
  assert.equal(clock.pendingTimers, 1);

  clock.advance(999);
  await flush();
  assert.equal(resolved, false, "must not refill before a full token");

  clock.advance(1);
  await flush();
  assert.equal(resolved, true);
  assert.equal(limiter.pending, 0);

  await pending;
});

test("serves waiters in FIFO order", async () => {
  const clock = new FakeClock();
  const limiter = new RateLimiter({
    capacity: 2,
    refillPerSecond: 1,
    now: clock.now,
    schedule: clock.schedule,
  });

  await limiter.acquire(2);

  const order: string[] = [];
  const first = limiter.acquire().then(() => order.push("first"));
  const second = limiter.acquire().then(() => order.push("second"));

  await flush();
  assert.deepEqual(order, []);
  assert.equal(limiter.pending, 2);

  clock.advance(1000);
  await flush();
  assert.deepEqual(order, ["first"]);
  assert.equal(limiter.pending, 1);

  clock.advance(1000);
  await flush();
  assert.deepEqual(order, ["first", "second"]);
  assert.equal(limiter.pending, 0);

  await Promise.all([first, second]);
});

test("supports fractional refill rates", async () => {
  const clock = new FakeClock();
  const limiter = new RateLimiter({
    capacity: 1,
    refillPerSecond: 0.5,
    now: clock.now,
    schedule: clock.schedule,
  });

  await limiter.acquire();

  let resolved = false;
  const pending = limiter.acquire().then(() => {
    resolved = true;
  });

  clock.advance(1999);
  await flush();
  assert.equal(resolved, false);

  clock.advance(1);
  await flush();
  assert.equal(resolved, true);

  await pending;
});

test("refills no further than capacity", () => {
  const clock = new FakeClock();
  const limiter = new RateLimiter({
    capacity: 3,
    refillPerSecond: 2,
    now: clock.now,
    schedule: clock.schedule,
  });

  clock.advance(60_000);
  assert.equal(limiter.availableTokens, 3);
});

test("keeps at most one scheduled timer while waiters queue", async () => {
  const clock = new FakeClock();
  const limiter = new RateLimiter({
    capacity: 1,
    refillPerSecond: 1,
    now: clock.now,
    schedule: clock.schedule,
  });

  await limiter.acquire();

  const waiters = [
    limiter.acquire(),
    limiter.acquire(),
    limiter.acquire(),
    limiter.acquire(),
  ];

  assert.equal(clock.pendingTimers, 1);
  assert.equal(limiter.pending, 4);

  for (let i = 0; i < waiters.length; i++) {
    clock.advance(1000);
    await flush();
  }

  await Promise.all(waiters);
});

test("rejects invalid constructors and impossible costs", async () => {
  assert.throws(() => new RateLimiter({ capacity: 0 }), RangeError);
  assert.throws(() => new RateLimiter({ refillPerSecond: -1 }), RangeError);

  const limiter = new RateLimiter({ capacity: 2 });

  await assert.rejects(limiter.acquire(0), RangeError);
  await assert.rejects(limiter.acquire(-1), RangeError);
  await assert.rejects(limiter.acquire(3), RangeError);

  assert.equal(limiter.pending, 0);
});
