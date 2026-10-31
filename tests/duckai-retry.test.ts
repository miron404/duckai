import { describe, it, expect, beforeAll, afterAll, beforeEach } from "bun:test";
import { DuckAI } from "../src/duckai";
import { OpenAIService } from "../src/openai-service";
import { UpstreamError } from "../src/errors";
import type { ChatCompletionRequest, DuckAIStreamChunk } from "../src/types";

const ENV_KEYS = [
  "X_RETRY_BASE_DELAY_MS",
  "X_MIN_REQUEST_INTERVAL_MS",
  "X_MAX_ATTEMPTS",
] as const;

const sse = (...messages: string[]) =>
  messages.map((m) => `data: ${JSON.stringify({ message: m })}\n\n`).join("") +
  "data: [DONE]\n\n";

/**
 * A DuckAI whose network calls are scripted: `getVQD` never leaves the
 * process and `sendChatRequest` returns the queued responses in order. The
 * rate-limit store is replaced too, so a 429 in a test cannot leak into the
 * shared file a running server reads.
 */
function scriptedDuck(responses: Array<() => Response>) {
  const duck = new DuckAI();
  const calls = { vqd: 0, chat: 0 };
  const internals = duck as unknown as Record<string, unknown>;
  internals.rateLimitStore = { read: () => null, write: () => {} };
  internals.rateLimitMonitor = { printCompactStatus: () => {} };
  duck.getVQD = async () => {
    calls.vqd++;
    return { hash: `hash-${calls.vqd}` };
  };
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

describe("DuckAI retries", () => {
  const saved: Record<string, string | undefined> = {};

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

  it("retries a 418 with a fresh challenge in the non-streaming path", async () => {
    const { duck, calls } = scriptedDuck([
      () => new Response('{"action":"error","type":"ERR_CHALLENGE"}', { status: 418 }),
      () => new Response(sse("Hello", " there"), { status: 200 }),
    ]);

    const result = await duck.chat(request);

    expect(result.content).toBe("Hello there");
    expect(calls.chat).toBe(2);
    expect(calls.vqd).toBe(2);
  });

  it("retries a short 429 instead of failing immediately", async () => {
    const { duck, calls } = scriptedDuck([
      () => new Response("slow down", { status: 429, headers: { "retry-after": "1" } }),
      () => new Response(sse("ok"), { status: 200 }),
    ]);

    const result = await duck.chat(request);

    expect(result.content).toBe("ok");
    expect(calls.chat).toBe(2);
  });

  it("gives up after X_MAX_ATTEMPTS round trips, not attempts squared", async () => {
    const { duck, calls } = scriptedDuck([
      () => new Response("down", { status: 503 }),
      () => new Response("down", { status: 503 }),
      () => new Response("down", { status: 503 }),
    ]);

    await expect(duck.chat(request)).rejects.toBeInstanceOf(UpstreamError);
    expect(calls.chat).toBe(3);
  });

  it("does not retry a 400", async () => {
    const { duck, calls } = scriptedDuck([
      () => new Response('{"action":"error","type":"ERR_BAD_REQUEST","status":400}', { status: 400 }),
    ]);

    await expect(duck.chat(request)).rejects.toBeInstanceOf(UpstreamError);
    expect(calls.chat).toBe(1);
  });

  it("retries an empty completion", async () => {
    const { duck, calls } = scriptedDuck([
      () => new Response(sse(""), { status: 200 }),
      () => new Response(sse("second try"), { status: 200 }),
    ]);

    const result = await duck.chat(request);

    expect(result.content).toBe("second try");
    expect(calls.chat).toBe(2);
  });
});

describe("tool call history", () => {
  const service = new OpenAIService();

  it("turns an assistant tool_calls turn into text duck.ai can read", () => {
    const validated = service.validateRequest({
      model: "gpt-6-luna",
      messages: [
        { role: "user", content: "What time is it?" },
        {
          role: "assistant",
          content: null,
          tool_calls: [
            {
              id: "call_1",
              type: "function",
              function: { name: "get_current_time", arguments: "{}" },
            },
          ],
        },
        { role: "tool", content: "10:30", tool_call_id: "call_1" },
      ],
    });

    const assistant = validated.messages[1];
    expect(assistant.role).toBe("assistant");
    expect(assistant.content).toBe("[tool call call_1: get_current_time({})]");
    expect(assistant.tool_calls).toBeUndefined();
    expect(validated.messages[2]).toEqual({
      role: "user",
      content: "[tool result for call_1]\n10:30",
    });
  });

  it("keeps the assistant text next to the tool calls", () => {
    const validated = service.validateRequest({
      model: "gpt-6-luna",
      messages: [
        { role: "user", content: "Weather?" },
        {
          role: "assistant",
          content: "Let me check.",
          tool_calls: [
            {
              id: "call_2",
              type: "function",
              function: { name: "get_weather", arguments: '{"city":"Oslo"}' },
            },
          ],
        },
        { role: "tool", content: "rain", tool_call_id: "call_2" },
      ],
    });

    expect(validated.messages[1].content).toBe(
      'Let me check.\n[tool call call_2: get_weather({"city":"Oslo"})]',
    );
  });
});

describe("stream errors", () => {
  it("ends a failing stream with an OpenAI error event and [DONE]", async () => {
    const service = new OpenAIService();
    const duck = (service as unknown as { duckAI: DuckAI }).duckAI;

    let sent = false;
    duck.chatStream = async () =>
      new ReadableStream<DuckAIStreamChunk>({
        pull(controller) {
          if (!sent) {
            sent = true;
            controller.enqueue({ type: "content", text: "partial" });
            return;
          }
          controller.error(new UpstreamError("duck.ai error: boom", 502));
        },
      });

    const req: ChatCompletionRequest = {
      model: "gpt-6-luna",
      messages: [{ role: "user", content: "hi" }],
      stream: true,
    };
    const stream = await service.createChatCompletionStream(req);
    const text = await new Response(stream).text();

    const events = text
      .split("\n\n")
      .filter(Boolean)
      .map((event) => event.replace(/^data: /, ""));
    expect(JSON.parse(events[0]).choices[0].delta.content).toBe("partial");
    expect(JSON.parse(events[1])).toEqual({
      error: { message: "duck.ai error: boom", type: "upstream_error" },
    });
    expect(events[2]).toBe("[DONE]");
  });
});
