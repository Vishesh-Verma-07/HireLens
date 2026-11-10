import assert from "node:assert/strict";
import test from "node:test";
import { CircuitBreaker, CircuitOpenError } from "./circuit-breaker.js";

function deferred<T>(): {
  promise: Promise<T>;
  resolve: (value: T) => void;
  reject: (reason?: unknown) => void;
} {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

test("passes results through and clears failures on success", async () => {
  let now = 0;
  const breaker = new CircuitBreaker({ failureThreshold: 2, now: () => now });

  assert.equal(await breaker.exec(() => "ok"), "ok");

  await assert.rejects(
    breaker.exec(async () => {
      throw new Error("boom");
    }),
    /boom/,
  );
  assert.equal(breaker.failureCount, 1);
  assert.equal(breaker.state, "closed");

  assert.equal(await breaker.exec(() => 42), 42);
  assert.equal(breaker.failureCount, 0);
  assert.equal(breaker.state, "closed");
});

test("trips after the failure threshold and then fails fast", async () => {
  let now = 0;
  let calls = 0;
  const breaker = new CircuitBreaker({ failureThreshold: 2, now: () => now });

  const fail = async (): Promise<string> => {
    calls += 1;
    throw new Error("upstream down");
  };

  await assert.rejects(breaker.exec(fail), /upstream down/);
  assert.equal(breaker.state, "closed");

  await assert.rejects(breaker.exec(fail), /upstream down/);
  assert.equal(breaker.state, "open");
  assert.equal(breaker.failureCount, 2);

  await assert.rejects(
    breaker.exec(() => {
      calls += 1;
      return "should not run";
    }),
    (error: unknown) => {
      assert.ok(error instanceof CircuitOpenError);
      assert.equal(error.code, "CIRCUIT_OPEN");
      assert.equal(error.retryAfterMs, 30_000);
      return true;
    },
  );

  assert.equal(calls, 2, "open breaker must not invoke the wrapped function");
});

test("moves open -> half-open -> closed after a successful probe", async () => {
  let now = 0;
  const transitions: string[] = [];
  const breaker = new CircuitBreaker({
    failureThreshold: 1,
    resetTimeoutMs: 1000,
    now: () => now,
    onStateChange: (state, previous) => transitions.push(`${previous}->${state}`),
  });

  await assert.rejects(
    breaker.exec(async () => {
      throw new Error("fail");
    }),
  );
  assert.equal(breaker.state, "open");

  now = 999;
  await assert.rejects(breaker.exec(() => "too soon"), CircuitOpenError);
  assert.equal(breaker.state, "open");

  now = 1000;
  assert.equal(await breaker.exec(() => "probe ok"), "probe ok");
  assert.equal(breaker.state, "closed");
  assert.deepEqual(transitions, [
    "closed->open",
    "open->half-open",
    "half-open->closed",
  ]);
});

test("a failed half-open probe reopens for another full timeout", async () => {
  let now = 0;
  const breaker = new CircuitBreaker({ failureThreshold: 1, resetTimeoutMs: 1000, now: () => now });

  await assert.rejects(
    breaker.exec(async () => {
      throw new Error("first failure");
    }),
  );

  now = 1000;
  await assert.rejects(
    breaker.exec(async () => {
      throw new Error("probe failure");
    }),
    /probe failure/,
  );
  assert.equal(breaker.state, "open");

  now = 1999;
  await assert.rejects(breaker.exec(() => "too soon"), CircuitOpenError);

  now = 2000;
  assert.equal(await breaker.exec(() => "recovered"), "recovered");
  assert.equal(breaker.state, "closed");
});

test("allows only one half-open probe at a time", async () => {
  let now = 0;
  const breaker = new CircuitBreaker({ failureThreshold: 1, resetTimeoutMs: 1000, now: () => now });

  await assert.rejects(
    breaker.exec(async () => {
      throw new Error("fail");
    }),
  );

  now = 1000;
  const probe = deferred<string>();
  const first = breaker.exec(() => probe.promise);

  await assert.rejects(breaker.exec(() => "second probe"), CircuitOpenError);

  probe.resolve("probe ok");
  assert.equal(await first, "probe ok");
  assert.equal(breaker.state, "closed");
});

test("requires successThreshold probes to close", async () => {
  let now = 0;
  const breaker = new CircuitBreaker({
    failureThreshold: 1,
    resetTimeoutMs: 0,
    successThreshold: 2,
    now: () => now,
  });

  await assert.rejects(
    breaker.exec(async () => {
      throw new Error("fail");
    }),
  );

  assert.equal(await breaker.exec(() => "first"), "first");
  assert.equal(breaker.state, "half-open");

  assert.equal(await breaker.exec(() => "second"), "second");
  assert.equal(breaker.state, "closed");
});

test("reset returns the breaker to closed", async () => {
  let now = 0;
  const breaker = new CircuitBreaker({ failureThreshold: 1, now: () => now });

  await assert.rejects(
    breaker.exec(async () => {
      throw new Error("fail");
    }),
  );
  assert.equal(breaker.state, "open");

  breaker.reset();
  assert.equal(breaker.state, "closed");
  assert.equal(breaker.failureCount, 0);
  assert.equal(await breaker.exec(() => "ok"), "ok");
});

test("rejects invalid options", () => {
  assert.throws(() => new CircuitBreaker({ failureThreshold: 0 }), RangeError);
  assert.throws(() => new CircuitBreaker({ resetTimeoutMs: -1 }), RangeError);
  assert.throws(() => new CircuitBreaker({ successThreshold: 0 }), RangeError);
});
