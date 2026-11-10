import assert from "node:assert/strict";
import test from "node:test";
import { CircuitBreaker, CircuitOpenError } from "./circuit-breaker.js";
import { fetchJson, fetchText, HttpError } from "./http.js";
import type { RateLimiter } from "./rate-limit.js";

function installFetch(mock: typeof fetch): () => void {
  const original = globalThis.fetch;
  globalThis.fetch = mock;
  return () => {
    globalThis.fetch = original;
  };
}

function responds(body: string, status = 200): Response {
  return new Response(body, { status });
}

test("retries retryable statuses with exponential backoff", async () => {
  let calls = 0;
  const delays: number[] = [];

  const restore = installFetch((async () => {
    calls += 1;
    return calls < 3
      ? responds("upstream down", 503)
      : responds("finally ok", 200);
  }) as typeof fetch);

  try {
    const body = await fetchText("https://example.test/jobs", {
      retries: 2,
      backoffMs: 50,
      maxBackoffMs: 500,
      sleep: async (ms) => {
        delays.push(ms);
      },
    });

    assert.equal(body, "finally ok");
    assert.equal(calls, 3);
    assert.deepEqual(delays, [50, 100]);
  } finally {
    restore();
  }
});

test("caps the backoff delay", async () => {
  const delays: number[] = [];

  const restore = installFetch((async () => responds("nope", 500)) as typeof fetch);

  try {
    await assert.rejects(
      fetchText("https://example.test/jobs", {
        retries: 3,
        backoffMs: 100,
        maxBackoffMs: 150,
        sleep: async (ms) => {
          delays.push(ms);
        },
      }),
      (error: unknown) => error instanceof HttpError && error.status === 500,
    );

    assert.deepEqual(delays, [100, 150, 150]);
  } finally {
    restore();
  }
});

test("does not retry non-retryable 4xx responses", async () => {
  let calls = 0;
  const delays: number[] = [];

  const restore = installFetch((async () => {
    calls += 1;
    return responds("missing", 404);
  }) as typeof fetch);

  try {
    await assert.rejects(
      fetchText("https://example.test/jobs", {
        retries: 3,
        sleep: async (ms) => {
          delays.push(ms);
        },
      }),
      (error: unknown) => {
        assert.ok(error instanceof HttpError);
        assert.equal(error.status, 404);
        assert.equal(error.retryable, false);
        return true;
      },
    );

    assert.equal(calls, 1);
    assert.deepEqual(delays, []);
  } finally {
    restore();
  }
});

test("retries network failures", async () => {
  let calls = 0;

  const restore = installFetch((async () => {
    calls += 1;
    if (calls === 1) throw new TypeError("fetch failed");
    return responds("ok");
  }) as typeof fetch);

  try {
    const body = await fetchText("https://example.test/jobs", {
      retries: 1,
      sleep: async () => {},
    });

    assert.equal(body, "ok");
    assert.equal(calls, 2);
  } finally {
    restore();
  }
});

test("wraps timeouts in HttpError", async () => {
  const restore = installFetch(((input: string | URL | Request, init?: RequestInit) => {
    return new Promise<Response>((_resolve, reject) => {
      init?.signal?.addEventListener("abort", () => {
        const error = new Error("The operation was aborted.");
        error.name = "AbortError";
        reject(error);
      });
    });
  }) as typeof fetch);

  try {
    await assert.rejects(
      fetchText("https://example.test/slow", { timeoutMs: 10, retries: 0 }),
      (error: unknown) => {
        assert.ok(error instanceof HttpError);
        assert.equal(error.status, 0);
        assert.equal(error.retryable, true);
        assert.match(error.message, /aborted/i);
        return true;
      },
    );
  } finally {
    restore();
  }
});

test("consults the rate limiter before every attempt", async () => {
  let acquires = 0;
  let calls = 0;

  const limiter = {
    acquire: async () => {
      acquires += 1;
    },
  } as unknown as RateLimiter;

  const restore = installFetch((async () => {
    calls += 1;
    return calls === 1 ? responds("retry me", 503) : responds("ok");
  }) as typeof fetch);

  try {
    const body = await fetchText("https://example.test/jobs", {
      retries: 1,
      rateLimiter: limiter,
      sleep: async () => {},
    });

    assert.equal(body, "ok");
    assert.equal(acquires, 2);
  } finally {
    restore();
  }
});

test("an open circuit breaker stops retries without more network calls", async () => {
  let calls = 0;
  const breaker = new CircuitBreaker({ failureThreshold: 2 });

  const restore = installFetch((async () => {
    calls += 1;
    throw new TypeError("fetch failed");
  }) as typeof fetch);

  try {
    await assert.rejects(
      fetchText("https://example.test/jobs", {
        retries: 5,
        circuitBreaker: breaker,
        sleep: async () => {},
      }),
      CircuitOpenError,
    );

    // Two failures trip the breaker; the next attempt fails fast.
    assert.equal(calls, 2);
    assert.equal(breaker.state, "open");

    await assert.rejects(
      fetchText("https://example.test/jobs", {
        retries: 0,
        circuitBreaker: breaker,
      }),
      CircuitOpenError,
    );
    assert.equal(calls, 2, "open breaker must not touch the network");
  } finally {
    restore();
  }
});

test("fetchJson parses JSON and requests it via the accept header", async () => {
  let headers: Record<string, string> = {};

  const restore = installFetch(((input: string | URL | Request, init?: RequestInit) => {
    headers = init?.headers as Record<string, string>;
    return Promise.resolve(
      new Response(JSON.stringify({ jobs: [{ id: 1 }] }), {
        status: 200,
        headers: { "content-type": "application/json" },
      }),
    );
  }) as typeof fetch);

  try {
    const data = await fetchJson<{ jobs: Array<{ id: number }> }>(
      "https://example.test/jobs.json",
    );

    assert.equal(data.jobs[0]?.id, 1);
    assert.equal(headers.accept, "application/json");
    assert.match(headers["user-agent"] ?? "", /^jobfinder\//);
  } finally {
    restore();
  }
});
