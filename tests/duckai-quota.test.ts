import { describe, it, expect, beforeAll, afterAll, afterEach } from "bun:test";
import { DuckAI } from "../src/duckai";
import {
  AppError,
  QuotaExceededError,
  UpstreamError,
} from "../src/errors";

// Payload shapes follow what the duck.ai web client parses
// (`fixedCostWindowUsage.windows`, `statusV2` bitmask, `retriable`); a real
// exhausted allowance has not been captured live yet.

const ENV_KEYS = [
  "X_RETRY_BASE_DELAY_MS",
  "X_MIN_REQUEST_INTERVAL_MS",
  "X_MAX_ATTEMPTS",
] as const;

const inHours = (hours: number) =>
  new Date(Date.now() + hours * 3_600_000).toISOString();

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });

function isolatedDuck() {
  const duck = new DuckAI();
  const internals = duck as unknown as Record<string, unknown>;
  internals.rateLimitStore = { read: () => null, write: () => {} };
  internals.rateLimitMonitor = { printCompactStatus: () => {} };
  // Pretend discovery already ran, so only /status and /chat hit `fetch`.
  internals.discovery = { version: "v", sha: "s", stack: "", fetchedAt: Date.now() };
  return duck;
}

/** A DuckAI whose /chat responses are scripted (the challenge is skipped). */
function scriptedChat(responses: Array<() => Response>) {
  const duck = isolatedDuck();
  const calls = { chat: 0 };
  duck.getVQD = async () => ({ hash: "hash" });
  duck.sendChatRequest = async () => {
    const next = responses[calls.chat++];
    if (!next) throw new Error("unexpected extra chat request");
    return next();
  };
  return { duck, calls };
}

const request = DuckAI.transformToDuckAIRequest({
  model: "gpt-6-luna",
  messages: [{ role: "user", content: "hi" }],
});

describe("duck.ai usage limits", () => {
  const saved: Record<string, string | undefined> = {};
  const originalFetch = globalThis.fetch;

  beforeAll(() => {
    for (const key of ENV_KEYS) saved[key] = process.env[key];
    process.env.X_RETRY_BASE_DELAY_MS = "0";
    process.env.X_MIN_REQUEST_INTERVAL_MS = "0";
    process.env.X_MAX_ATTEMPTS = "3";
  });

  afterAll(() => {
    for (const key of ENV_KEYS) {
      if (saved[key] === undefined) delete process.env[key];
      else process.env[key] = saved[key];
    }
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  /** Serves /status from `statusResponse`; any other URL is a test failure. */
  function mockStatus(statusResponse: () => Response) {
    const urls: string[] = [];
    globalThis.fetch = (async (input: RequestInfo | URL) => {
      const url = String(input);
      urls.push(url);
      if (url.endsWith("/duckchat/v1/status")) return statusResponse();
      throw new Error(`unexpected fetch: ${url}`);
    }) as typeof fetch;
    return urls;
  }

  it("fails before /chat when /status marks chat as unavailable", async () => {
    const resetAt = inHours(5);
    const urls = mockStatus(() =>
      json({
        status: "0",
        statusV2: 1,
        grant: null,
        fixedCostWindowUsage: {
          windows: [
            { id: "six_hours", percentUsed: 100, resetAt, isBlocked: true },
            { id: "day", percentUsed: 60, resetAt: inHours(20), isBlocked: false },
          ],
        },
      }),
    );
    const duck = isolatedDuck();

    const error = await duck.chat(request).catch((e) => e);

    expect(error).toBeInstanceOf(QuotaExceededError);
    expect(error.status).toBe(429);
    expect(error.type).toBe("insufficient_quota");
    expect(error.upstreamType).toBe("ERR_USER_LIMIT");
    expect(error.message).toContain("six_hours window at 100%");
    // Retry-After points at the reset of the blocking window.
    expect(error.retryAfterMs).toBeGreaterThan(4.9 * 3_600_000);
    expect(error.retryAfterMs).toBeLessThanOrEqual(5 * 3_600_000);
    expect(urls.every((url) => url.endsWith("/status"))).toBe(true);
    expect(urls).toHaveLength(1);
  });

  it("reports a service-wide limit from status \"2\"", async () => {
    mockStatus(() => json({ status: "2", statusV2: 0, grant: null }));
    const error = await isolatedDuck().chat(request).catch((e) => e);

    expect(error).toBeInstanceOf(QuotaExceededError);
    expect(error.upstreamType).toBe("ERR_SERVICE_LIMIT");
    expect(error.retryAfterMs).toBeUndefined();
  });

  it("keeps an IP rate limit on /status a rate limit, not a quota", async () => {
    process.env.X_MAX_ATTEMPTS = "1";
    try {
      mockStatus(() =>
        json({ action: "error", status: 429, type: "ERR_RATE_LIMIT" }, 429),
      );
      const error = await isolatedDuck().chat(request).catch((e) => e);

      expect(error).toBeInstanceOf(UpstreamError);
      expect(error.status).toBe(429);
      expect(error.message).toContain("ERR_RATE_LIMIT");
    } finally {
      process.env.X_MAX_ATTEMPTS = "3";
    }
  });

  it("maps ERR_USER_LIMIT from /chat to a quota error without retrying", async () => {
    const { duck, calls } = scriptedChat([
      () =>
        json(
          {
            action: "error",
            status: 429,
            type: "ERR_USER_LIMIT",
            fixedCostWindowUsage: {
              windows: [
                { id: "six_hours", percentUsed: 100, resetAt: inHours(2), isBlocked: true },
                { id: "day", percentUsed: 100, resetAt: inHours(10), isBlocked: true },
              ],
            },
          },
          429,
        ),
    ]);

    const error = await duck.chat(request).catch((e) => e);

    expect(error).toBeInstanceOf(QuotaExceededError);
    // Both windows are blocked; chatting resumes only when the later one resets.
    expect(error.message).toContain("day window at 100%");
    expect(error.retryAfterMs).toBeGreaterThan(9.9 * 3_600_000);
    expect(calls.chat).toBe(1);
  });

  it("maps ERR_CONVERSATION_LIMIT to a 400 the client can act on", async () => {
    const { duck, calls } = scriptedChat([
      () => json({ action: "error", status: 400, type: "ERR_CONVERSATION_LIMIT" }, 400),
    ]);

    const error = await duck.chat(request).catch((e) => e);

    expect(error).toBeInstanceOf(AppError);
    expect(error).not.toBeInstanceOf(UpstreamError);
    expect(error.status).toBe(400);
    expect(error.type).toBe("invalid_request_error");
    expect(error.message).toContain("ERR_CONVERSATION_LIMIT");
    expect(calls.chat).toBe(1);
  });

  it("does not retry what duck.ai marks as retriable: false", async () => {
    const { duck, calls } = scriptedChat([
      () =>
        json(
          { action: "error", status: 503, type: "ERR_SERVICE_UNAVAILABLE", retriable: false },
          503,
        ),
    ]);

    await expect(duck.chat(request)).rejects.toBeInstanceOf(UpstreamError);
    expect(calls.chat).toBe(1);
  });

  it("does not retry a quota error that arrives inside a 200 body", async () => {
    const { duck, calls } = scriptedChat([
      () =>
        new Response(
          `data: ${JSON.stringify({ action: "error", status: 429, type: "ERR_USER_LIMIT" })}\n\n`,
          { status: 200 },
        ),
    ]);

    const error = await duck.chat(request).catch((e) => e);

    expect(error).toBeInstanceOf(QuotaExceededError);
    expect(error.retryAfterMs).toBeUndefined();
    expect(calls.chat).toBe(1);
  });
});
