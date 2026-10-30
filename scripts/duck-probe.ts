#!/usr/bin/env bun
/**
 * Diagnostic probe for duck.ai.
 *
 * Unlike `bun test`, this talks to the real API and prints the *raw* status
 * codes, which makes it usable for A/B measuring the 418 (`ERR_CHALLENGE`)
 * failure rate after changing the fingerprint.
 *
 * Usage:
 *   bun run scripts/duck-probe.ts                     # 3 requests, raw mode
 *   bun run scripts/duck-probe.ts --count=10          # more samples
 *   bun run scripts/duck-probe.ts --mode=chat         # full OpenAIService path
 *   bun run scripts/duck-probe.ts --jsa=<base64>      # replay a browser-captured
 *                                                     # x-vqd-hash-1 value
 *   bun run scripts/duck-probe.ts --dump              # full error payload, with
 *                                                     # the `cd` blob decoded
 *   STREAM_KEY='{"publicKey":{...}}' bun run scripts/duck-probe.ts
 *
 * Both modes build the upstream body through the same `validateRequest` +
 * `transformToDuckAIRequest` pair the HTTP server uses, so a `400
 * ERR_BAD_REQUEST` here means the request body is wrong, while a `418
 * ERR_CHALLENGE` means duck.ai refused the solved challenge (it does that
 * intermittently -- see the "Reliability" section in README.md).
 * `--mode=raw` prints the upstream status verbatim (no retries, no
 * streaming); `--mode=chat` exercises retries, penalty handling and JSON
 * aggregation on top.
 *
 * Environment: everything from src/config.ts (X_USER_AGENT, STREAM_KEY, ...).
 */
import { DuckAI } from "../src/duckai";
import { OpenAIService } from "../src/openai-service";
import { config } from "../src/config";
import type { DuckAIRequest } from "../src/types";

interface Options {
  count: number;
  model: string;
  prompt: string;
  mode: "raw" | "chat";
  jsa?: string;
  dump: boolean;
}

function parseArgs(argv: string[]): Options {
  const options: Options = {
    count: 3,
    model: "gpt-6-luna",
    prompt: "Reply with the single word: pong",
    mode: "raw",
    dump: false,
  };

  for (const arg of argv) {
    const [flag, ...rest] = arg.split("=");
    const value = rest.join("=");
    switch (flag) {
      case "--count":
        options.count = Math.max(1, Number.parseInt(value, 10) || 1);
        break;
      case "--model":
        options.model = value;
        break;
      case "--prompt":
        options.prompt = value;
        break;
      case "--mode":
        if (value !== "raw" && value !== "chat") {
          throw new Error("--mode must be 'raw' or 'chat'");
        }
        options.mode = value;
        break;
      case "--jsa":
        options.jsa = value;
        break;
      case "--dump":
        options.dump = true;
        break;
      default:
        if (arg.startsWith("--")) throw new Error(`Unknown flag: ${arg}`);
    }
  }

  return options;
}

function summarize(statuses: string[]): string {
  const counts = new Map<string, number>();
  for (const status of statuses) {
    counts.set(status, (counts.get(status) ?? 0) + 1);
  }
  return [...counts.entries()]
    .map(([status, count]) => `${status}×${count}`)
    .join(" ");
}

/**
 * Decodes the `cd` blob of a duck.ai error payload. The field carries the
 * server's own view of the request (`overrideCode`, `o`/`q` blobs), which is
 * the only diagnostic the API gives for a rejected challenge.
 */
function describeErrorPayload(body: string): string[] {
  const lines: string[] = [];
  let payload: Record<string, unknown>;
  try {
    payload = JSON.parse(body);
  } catch {
    return [body.trim()];
  }

  lines.push(body.trim());
  const cd = payload.cd as Record<string, unknown> | undefined;
  if (!cd) return lines;

  for (const [key, value] of Object.entries(cd)) {
    const raw = String(value);
    lines.push(`    cd.${key} = ${raw.slice(0, 160)}${raw.length > 160 ? "…" : ""}`);
    if (key !== "o" && key !== "q") continue;
    for (const decoder of [
      (input: string) => decodeURIComponent(input),
      (input: string) => Buffer.from(input, "base64").toString("utf-8"),
    ]) {
      try {
        const decoded = decoder(raw);
        if (decoded && decoded !== raw) {
          lines.push(`      decoded: ${decoded.slice(0, 400)}`);
          break;
        }
      } catch {
        /* try the next decoder */
      }
    }
  }

  return lines;
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

async function main() {
  const options = parseArgs(process.argv.slice(2));
  const duck = new DuckAI();
  const environment = await duck.describeEnvironment();

  console.log("fingerprint:");
  console.log(`  user-agent    : ${environment.userAgent}`);
  console.log(`  x-fe-version  : ${environment.feVersion || "(not sent)"}`);
  console.log(`  meta.stack    : ${environment.stack.split("\n")[1] ?? "-"}`);
  console.log(`  durableStream : ${environment.durableStream ? "yes" : "no"}`);
  console.log(
    `  cookies       : ${environment.cookies.length > 0 ? environment.cookies.join(", ") : "(none)"}`,
  );
  console.log(`  api key       : ${config.apiKey ? "set" : "unset"}`);
  console.log(`  mode          : ${options.mode}`);
  if (options.jsa) console.log(`  replay jsa    : ${options.jsa.length} chars`);
  console.log("");

  const service = new OpenAIService();
  const request = service.validateRequest({
    model: options.model,
    messages: [{ role: "user", content: options.prompt }],
  });
  const upstreamRequest: DuckAIRequest =
    DuckAI.transformToDuckAIRequest(request);

  const statuses: string[] = [];

  for (let index = 0; index < options.count; index++) {
    const startedAt = Date.now();

    if (options.mode === "chat") {
      try {
        const result = await service.createChatCompletion(request);
        statuses.push("ok");
        console.log(
          `[${index}] ok ${Date.now() - startedAt}ms -> ${JSON.stringify(result.choices[0].message.content?.slice(0, 80))}`,
        );
      } catch (error) {
        statuses.push("error");
        console.log(
          `[${index}] error ${Date.now() - startedAt}ms -> ${(error as Error).message}`,
        );
      }
    } else {
      try {
        const vqd = options.jsa
          ? { hash: options.jsa }
          : await duck.getVQD();
        const response = await duck.sendChatRequest(
          upstreamRequest,
          environment.userAgent,
          vqd,
        );
        const body = await response.text();
        statuses.push(String(response.status));
        const detail =
          response.status === 200
            ? `${body.length} bytes`
            : body.trim().slice(0, 200).replace(/\s+/g, " ");
        console.log(
          `[${index}] ${response.status} ${Date.now() - startedAt}ms ${detail}`,
        );
        if (options.dump && response.status !== 200) {
          for (const line of describeErrorPayload(body)) console.log(line);
        }
      } catch (error) {
        statuses.push("exception");
        console.log(
          `[${index}] exception ${Date.now() - startedAt}ms -> ${(error as Error).message}`,
        );
      }
    }

    if (index + 1 < options.count) await sleep(1_000);
  }

  console.log(`\nsummary: ${summarize(statuses)}`);
  const failures = statuses.filter((status) => status !== "ok" && status !== "200");
  if (failures.length > 0) process.exitCode = 1;
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
