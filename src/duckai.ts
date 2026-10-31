import { JSDOM } from "jsdom";
import { createHash, randomUUID } from "node:crypto";
import { RateLimitStore } from "./rate-limit-store";
import { SharedRateLimitMonitor } from "./shared-rate-limit-monitor";
import { DUCKAI_MODELS } from "./models";
import { config } from "./config";
import { CookieJar } from "./cookie-jar";
import { RateLimitError, UpstreamError, ValidationError } from "./errors";
import type {
  ChatCompletionMessage,
  VQDResponse,
  DuckAIRequest,
  DuckAIChatResult,
  DuckAIStreamChunk,
  DuckChatCompletionMessage,
  ChatCompletionRequest,
  DuckChatCompletionContentPartImage,
  DuckChatCompletionContentPartFile,
  DuckChatCompletionContentPart,
} from "./types";
import type { ChatCompletionContentPart } from "openai/src/resources.js";

const DUCKAI_ORIGIN = "https://duck.ai";
const DUCKAI_STATUS_URL = `${DUCKAI_ORIGIN}/duckchat/v1/status`;
const DUCKAI_CHAT_URL = `${DUCKAI_ORIGIN}/duckchat/v1/chat`;
const DEFAULT_STACK_URL = `${DUCKAI_ORIGIN}/dist/duckai-dist/entry.duckai.js`;

/** Stand-in used when duck.ai keeps returning empty completions. */
const EMPTY_RESPONSE_FALLBACK =
  "I apologize, but I'm unable to provide a response at the moment. Please try again.";

/** Marks the offscreen document the challenge script runs in (see JSDOM below). */
const CHALLENGE_DOCUMENT = `<!DOCTYPE html>
<html>
<head>
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; script-src 'unsafe-inline';">
</head>
<body></body>
</html>`;

const sleep = (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms));

/**
 * 32 hex characters, the shape of `x-ddg-journey-id`. Measured against the real
 * client: the value differs on *every* request (`/status`, `/auth/token` and
 * `/chat` each carry a different one), so it is generated per request instead
 * of being pinned per process.
 */
function randomHexId(): string {
  return Array.from({ length: 32 }, () =>
    "0123456789abcdef"[Math.floor(Math.random() * 16)],
  ).join("");
}

// Rate limiting tracking with sliding window
interface RateLimitInfo {
  requestTimestamps: number[]; // Array of request timestamps for sliding window
  lastRequestTime: number;
  isLimited: boolean;
  retryAfter?: number;
}

/** Version/stack of the frontend bundle currently served by duck.ai. */
interface FrontendInfo {
  version: string;
  sha: string;
  stack: string;
  fetchedAt: number;
}

interface UpstreamErrorPayload {
  status?: number;
  type?: string;
  message: string;
}

function truncate(value: string, limit = 300): string {
  return value.length > limit ? `${value.slice(0, limit)}…` : value;
}

/** Parses the `{"action":"error",...}` body duck.ai sends on failures. */
function parseUpstreamErrorPayload(body: string): UpstreamErrorPayload | null {
  const trimmed = body.trim();
  if (!trimmed.startsWith("{")) return null;
  let parsed: Record<string, unknown>;
  try {
    parsed = JSON.parse(trimmed) as Record<string, unknown>;
  } catch {
    return null;
  }
  if (!parsed || parsed.action !== "error") return null;
  const status = typeof parsed.status === "number" ? parsed.status : undefined;
  const type = typeof parsed.type === "string" ? parsed.type : undefined;
  return {
    status,
    type,
    message: `duck.ai error${type ? ` ${type}` : ""}${status ? ` (${status})` : ""}: ${truncate(trimmed)}`,
  };
}

function isRetryableStatus(status: number): boolean {
  return (
    status === 418 || status === 429 || status === 500 || status === 502 ||
    status === 503 || status === 504
  );
}

/** Parses `data:<mime>[;<encoding>],<payload>` URLs used for files/images. */
function parseDataUrl(dataUrl: string): {
  mimeType: string;
  encoding: string;
  data: string;
} {
  const match = /^data:([^;,]*)(?:;([^,]*))?,([\s\S]*)$/.exec(dataUrl);
  if (!match) {
    throw new ValidationError(
      "File payload must be a data URL (data:<mime>[;base64],<payload>)",
    );
  }
  return {
    mimeType: match[1] || "application/octet-stream",
    encoding: match[2] || "base64",
    data: match[3],
  };
}

export class DuckAI {
  private rateLimitInfo: RateLimitInfo = {
    requestTimestamps: [],
    lastRequestTime: 0,
    isLimited: false,
  };
  private rateLimitStore: RateLimitStore;
  private rateLimitMonitor: SharedRateLimitMonitor;

  /** Cached frontend version/stack, refreshed on a TTL and after a 418. */
  private discovery: FrontendInfo | null = null;
  private discoveryInFlight: Promise<FrontendInfo> | null = null;

  /** Serialises the "check limits, then record the request" critical section. */
  private slotLock: Promise<void> = Promise.resolve();

  /** Cookies picked up from duck.ai (plus anything seeded via `X_COOKIE`). */
  private cookies = new CookieJar();

  constructor() {
    this.rateLimitStore = new RateLimitStore();
    this.rateLimitMonitor = new SharedRateLimitMonitor();
    this.loadRateLimitFromStore();
    this.cookies.seed(config.cookie);
  }

  // ---------------------------------------------------------------- rate limit

  private cleanOldTimestamps(): void {
    const now = Date.now();
    const cutoff = now - config.windowSizeMs;
    this.rateLimitInfo.requestTimestamps =
      this.rateLimitInfo.requestTimestamps.filter(
        (timestamp) => timestamp > cutoff,
      );
  }

  private getCurrentRequestCount(): number {
    this.cleanOldTimestamps();
    return this.rateLimitInfo.requestTimestamps.length;
  }

  private loadRateLimitFromStore(): void {
    const stored = this.rateLimitStore.read();
    if (!stored) return;

    const storedAny = stored as unknown as Record<string, unknown>;
    const requestTimestamps = Array.isArray(storedAny.requestTimestamps)
      ? (storedAny.requestTimestamps as number[])
      : []; // old fixed-window format: start from an empty sliding window

    this.rateLimitInfo = {
      requestTimestamps,
      lastRequestTime:
        typeof storedAny.lastRequestTime === "number"
          ? storedAny.lastRequestTime
          : 0,
      isLimited: storedAny.isLimited === true,
      retryAfter:
        typeof storedAny.retryAfter === "number"
          ? storedAny.retryAfter
          : undefined,
    };

    // Drop an expired penalty so a stale flag cannot stall the server forever.
    if (
      this.rateLimitInfo.isLimited &&
      this.rateLimitInfo.retryAfter !== undefined &&
      this.rateLimitInfo.retryAfter <= Date.now()
    ) {
      this.rateLimitInfo.isLimited = false;
      this.rateLimitInfo.retryAfter = undefined;
    }

    this.cleanOldTimestamps();
  }

  private saveRateLimitToStore(): void {
    this.cleanOldTimestamps();
    this.rateLimitStore.write({
      requestTimestamps: this.rateLimitInfo.requestTimestamps,
      lastRequestTime: this.rateLimitInfo.lastRequestTime,
      isLimited: this.rateLimitInfo.isLimited,
      retryAfter: this.rateLimitInfo.retryAfter,
    });
  }

  getRateLimitStatus(): {
    requestsInCurrentWindow: number;
    maxRequestsPerMinute: number;
    timeUntilWindowReset: number;
    isCurrentlyLimited: boolean;
    recommendedWaitTime: number;
  } {
    this.loadRateLimitFromStore();

    const now = Date.now();
    const currentRequestCount = this.getCurrentRequestCount();
    const oldestTimestamp = this.rateLimitInfo.requestTimestamps[0];
    const timeUntilReset = oldestTimestamp
      ? Math.max(0, oldestTimestamp + config.windowSizeMs - now)
      : 0;
    const timeSinceLastRequest = now - this.rateLimitInfo.lastRequestTime;
    const recommendedWait = Math.max(
      0,
      config.minRequestIntervalMs - timeSinceLastRequest,
    );

    return {
      requestsInCurrentWindow: currentRequestCount,
      maxRequestsPerMinute: config.maxRequestsPerMinute,
      timeUntilWindowReset: timeUntilReset,
      isCurrentlyLimited: this.rateLimitInfo.isLimited,
      recommendedWaitTime: recommendedWait,
    };
  }

  private shouldWaitBeforeRequest(): { shouldWait: boolean; waitTime: number } {
    this.loadRateLimitFromStore();
    const now = Date.now();

    // Honor a penalty recorded from an upstream 429.
    if (this.rateLimitInfo.isLimited && this.rateLimitInfo.retryAfter) {
      const waitTime = this.rateLimitInfo.retryAfter - now;
      if (waitTime > 0) return { shouldWait: true, waitTime };
    }

    if (this.getCurrentRequestCount() >= config.maxRequestsPerMinute) {
      const oldestTimestamp = this.rateLimitInfo.requestTimestamps[0];
      if (oldestTimestamp) {
        const waitTime = oldestTimestamp + config.windowSizeMs - now + 100;
        return { shouldWait: true, waitTime: Math.max(0, waitTime) };
      }
    }

    const timeSinceLastRequest = now - this.rateLimitInfo.lastRequestTime;
    if (timeSinceLastRequest < config.minRequestIntervalMs) {
      return {
        shouldWait: true,
        waitTime: config.minRequestIntervalMs - timeSinceLastRequest,
      };
    }

    return { shouldWait: false, waitTime: 0 };
  }

  private async waitIfNeeded(): Promise<void> {
    const { shouldWait, waitTime } = this.shouldWaitBeforeRequest();
    if (!shouldWait) return;
    console.log(`Rate limiting: waiting ${waitTime}ms before next request`);
    await sleep(waitTime);
  }

  /**
   * Waits for a free slot and records the request atomically. Without the lock
   * two concurrent requests would both read "0 requests in window" and then
   * overwrite each other's timestamp in the shared store.
   */
  private async acquireRateLimitSlot(): Promise<void> {
    const previous = this.slotLock;
    let release!: () => void;
    this.slotLock = new Promise<void>((resolve) => {
      release = resolve;
    });

    await previous;
    try {
      await this.waitIfNeeded();
      const now = Date.now();
      this.rateLimitInfo.requestTimestamps.push(now);
      this.rateLimitInfo.lastRequestTime = now;
      this.saveRateLimitToStore();
      this.rateLimitMonitor.printCompactStatus();
    } finally {
      release();
    }
  }

  private noteRateLimited(retryAfterHeader: string | null): number {
    const seconds = retryAfterHeader ? Number.parseInt(retryAfterHeader, 10) : NaN;
    const waitMs = Number.isFinite(seconds) && seconds > 0 ? seconds * 1000 : 60_000;
    this.rateLimitInfo.isLimited = true;
    this.rateLimitInfo.retryAfter = Date.now() + waitMs;
    this.saveRateLimitToStore();
    return waitMs;
  }

  // ------------------------------------------------------- frontend discovery

  private invalidateDiscovery(): void {
    this.discovery = null;
  }

  private async getFrontendInfo(): Promise<FrontendInfo> {
    const cached = this.discovery;
    if (cached && Date.now() - cached.fetchedAt < config.discoveryTtlMs) {
      return cached;
    }
    if (this.discoveryInFlight) return this.discoveryInFlight;

    const task = this.fetchFrontendInfo();
    this.discoveryInFlight = task.finally(() => {
      this.discoveryInFlight = null;
    });
    this.discovery = await this.discoveryInFlight;
    return this.discovery;
  }

  /**
   * Reads the current `data-version-*` attributes and the duckai bundle URL from
   * duck.ai. Falls back to the env override / built-in values so a markup change
   * degrades instead of breaking every request.
   */
  private async fetchFrontendInfo(): Promise<FrontendInfo> {
    const fallback = (): FrontendInfo => ({
      version: "",
      sha: "",
      stack: process.env.X_VQD_STACK || "",
      fetchedAt: Date.now(),
    });

    try {
      const response = await fetch(`${DUCKAI_ORIGIN}/`, {
        headers: {
          accept:
            "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
          "accept-language": config.acceptLanguage,
          "user-agent": config.userAgent,
        },
        signal: AbortSignal.timeout(config.requestTimeoutMs),
      });
      if (!response.ok) {
        throw new Error(`HTTP ${response.status} ${response.statusText}`);
      }
      // The landing page is where a browser picks up its first cookies.
      this.cookies.absorb(response.headers);

      const html = await response.text();
      const dom = new JSDOM(html);
      const root = dom.window.document.documentElement;
      const version = root.getAttribute("data-version-tag") || "";
      const sha = root.getAttribute("data-version-sha") || "";
      const scriptSrc = Array.from(
        dom.window.document.querySelectorAll("script[src]"),
      )
        .map((element) => element.getAttribute("src") || "")
        .find((src) =>
          /\/dist\/duckai-dist\/entry\.duckai\.[a-zA-Z0-9]+\.js/.test(src),
        );
      const stack = scriptSrc
        ? new URL(scriptSrc, DUCKAI_ORIGIN).toString()
        : "";
      dom.window.close();

      const info: FrontendInfo = {
        version,
        sha,
        stack,
        fetchedAt: Date.now(),
      };
      if (!version || !sha) {
        console.warn(
          "duck.ai frontend version could not be detected; falling back to configured values",
        );
      }
      // The frontend hits these two before it can send anything; they are also
      // where a browser picks up its experiment cookies, so treat them as part
      // of the "page visit" that a chat request follows.
      await this.warmUp();
      return info;
    } catch (error) {
      console.warn(
        `Failed to discover the duck.ai frontend version: ${(error as Error).message}`,
      );
      return fallback();
    }
  }

  /**
   * `GET /duckchat/v1/capabilities` and `GET /duckchat/v1/auth/token` are the
   * two calls the frontend makes before it can chat. They are cheap and set the
   * anonymous session cookie, so failures are ignored: they are parity, not a
   * requirement for the chat request.
   */
  private async warmUp(): Promise<void> {
    const request = (path: string) =>
      fetch(`${DUCKAI_ORIGIN}${path}`, {
        headers: {
          ...this.cookieHeaders(),
          accept: "*/*",
          "accept-language": config.acceptLanguage,
          "sec-fetch-dest": "empty",
          "sec-fetch-mode": "cors",
          "sec-fetch-site": "same-origin",
          "sec-gpc": "1",
          "te": "trailers",
          "user-agent": config.userAgent,
          "x-ddg-journey-id": randomHexId(),
          referer: `${DUCKAI_ORIGIN}/`,
        },
        signal: AbortSignal.timeout(config.requestTimeoutMs),
      });

    for (const path of [
      "/duckchat/v1/capabilities",
      "/duckchat/v1/auth/token",
    ]) {
      try {
        const response = await request(path);
        this.cookies.absorb(response.headers);
        await response.arrayBuffer().catch(() => undefined);
      } catch {
        // Best effort: a warm-up failure must not break discovery.
      }
    }
  }

  private xFeVersion(frontend: FrontendInfo): string {
    if (process.env.X_FE_VERSION) return process.env.X_FE_VERSION;
    if (frontend.version && frontend.sha) {
      return `${frontend.version}-${frontend.sha}`;
    }
    return "";
  }

  /** `meta.stack` as the web client reports it (`new Error().stack`). */
  private stackFor(frontend: FrontendInfo): string {
    if (process.env.X_VQD_STACK) return process.env.X_VQD_STACK;
    const url = frontend.stack || DEFAULT_STACK_URL;
    return `Error\n    at ${url}:2:1308110`;
  }

  /**
   * `x-fe-signals` payload: base64 of the fraud-signal envelope. The web client
   * records a `start`, the UI events of the session and an `end` offset; the
   * measured values are `{start: <epoch ms>, events: [{name, delta, ...}],
   * end: <ms since start>}`. Reporting an empty event list is accepted, but a
   * single trusted `action` (the send click) is what a real session looks like.
   */
  private feSignals(): string {
    const start = Date.now();
    const delta = 40 + Math.floor(Math.random() * 200);
    return btoa(
      JSON.stringify({
        start,
        events: [{ name: "action", delta, trusted: true }],
        end: delta + 15 + Math.floor(Math.random() * 60),
      }),
    );
  }

  // --------------------------------------------------------------------- VQD

  /**
   * Runs the obfuscated challenge returned by `/duckchat/v1/status` inside a
   * throwaway document and returns the encoded `x-vqd-hash-1` value.
   */
  private async encodeVqdHash(
    vqdHash: string,
    userAgent: string,
    frontend: FrontendInfo,
  ): Promise<VQDResponse> {
    const script = atob(vqdHash);

    const dom = new JSDOM(CHALLENGE_DOCUMENT, {
      url: `${DUCKAI_ORIGIN}/`,
      runScripts: "outside-only",
      pretendToBeVisual: true,
    });

    try {
      const scope = dom.window as unknown as Record<string, unknown>;
      scope.__DDG_BE_VERSION__ = frontend.version || "dev";
      scope.__DDG_FE_CHAT_HASH__ = frontend.sha || "hash";

      // Browsers report the time spent *executing* the challenge (8-27 ms in
      // measurements); JSDOM's document setup is not part of that number.
      const startedAt = Date.now();
      const result = (await dom.window.eval(script)) as {
        client_hashes?: unknown;
        meta?: unknown;
        [key: string]: unknown;
      };

      if (
        !result || typeof result !== "object" ||
        !Array.isArray(result.client_hashes)
      ) {
        throw new UpstreamError(
          `Unexpected VQD challenge payload: ${truncate(JSON.stringify(result))}`,
          502,
        );
      }

      // The challenge hashes the real navigator.userAgent; we replace it with
      // the UA we actually send so the fingerprint stays consistent.
      result.client_hashes[0] = userAgent;
      result.client_hashes = (result.client_hashes as unknown[]).map((value) =>
        createHash("sha256").update(String(value)).digest("base64"),
      );

      const meta =
        result.meta && typeof result.meta === "object"
          ? (result.meta as Record<string, unknown>)
          : {};
      const duration = Math.max(5, Math.min(40, Date.now() - startedAt));
      result.meta = {
        ...meta,
        origin: DUCKAI_ORIGIN,
        stack: this.stackFor(frontend),
        duration: String(duration),
      };

      return {
        hash: btoa(JSON.stringify(result)),
        version: this.xFeVersion(frontend),
      };
    } finally {
      dom.window.close();
    }
  }

  /** Low-level: fetches a fresh challenge. Exposed for diagnostics/tests. */
  async getVQD(userAgent: string = config.userAgent): Promise<VQDResponse> {
    const frontend = await this.getFrontendInfo();

    const response = await fetch(DUCKAI_STATUS_URL, {
      headers: {
        ...this.cookieHeaders(),
        accept: "*/*",
        "accept-language": config.acceptLanguage,
        "cache-control": "no-store",
        pragma: "no-cache",
        priority: "u=1, i",
        "sec-fetch-dest": "empty",
        "sec-fetch-mode": "cors",
        "sec-fetch-site": "same-origin",
        "x-vqd-accept": "1",
        "x-ddg-journey-id": randomHexId(),
        "user-agent": userAgent,
        referer: `${DUCKAI_ORIGIN}/`,
      },
      method: "GET",
      signal: AbortSignal.timeout(config.requestTimeoutMs),
    });
    this.cookies.absorb(response.headers);
    await this.inspectStatusBody(response);

    if (!response.ok) {
      throw new UpstreamError(
        `VQD status request failed: ${response.status} ${response.statusText}`,
        response.status,
      );
    }

    const hashHeader = response.headers.get("x-vqd-hash-1");
    if (!hashHeader) {
      throw new UpstreamError(
        "VQD status response is missing the x-vqd-hash-1 header",
        502,
      );
    }

    return this.encodeVqdHash(hashHeader, userAgent, frontend);
  }

  /**
   * Reads the JSON body of `/duckchat/v1/status`, which is
   * `{"status":"0","secondaryStatus":"0","statusV2":0,"grant":null}` for an
   * anonymous client. `grant` is the field to watch: if DuckDuckGo ever hands
   * out a signed grant instead of trusting the challenge alone, it arrives here
   * and would have to be forwarded, so a non-null value is worth a warning.
   * Never throws -- the body is diagnostics, the header carries the challenge.
   */
  private async inspectStatusBody(response: Response): Promise<void> {
    try {
      const body = await response.text();
      if (!body.trim()) return;

      const status = JSON.parse(body) as {
        status?: unknown;
        secondaryStatus?: unknown;
        statusV2?: unknown;
        grant?: unknown;
      };
      if (status.grant) {
        console.warn(
          "duck.ai /status returned a grant; the client does not forward it yet",
        );
      }
      const level = Number(status.statusV2 ?? status.status ?? 0);
      if (Number.isFinite(level) && level !== 0) {
        console.warn(
          `duck.ai /status raised the challenge level (statusV2=${level})`,
        );
      }
    } catch {
      // Not JSON or an unreadable body: not a reason to fail the request.
    }
  }

  /** Sends one chat request. Public so diagnostics scripts can reuse it. */
  async sendChatRequest(
    request: DuckAIRequest,
    userAgent: string,
    vqd: VQDResponse,
    timeoutMs: number = config.requestTimeoutMs,
  ): Promise<Response> {
    const headers: Record<string, string> = {
      ...this.cookieHeaders(),
      accept: "text/event-stream",
      "accept-language": config.acceptLanguage,
      "cache-control": "no-cache",
      "content-type": "application/json",
      pragma: "no-cache",
      priority: "u=0",
      "sec-fetch-dest": "empty",
      "sec-fetch-mode": "cors",
      "sec-fetch-site": "same-origin",
      "sec-gpc": "1",
      "te": "trailers",
      origin: DUCKAI_ORIGIN,
      referer: `${DUCKAI_ORIGIN}/`,
      "user-agent": userAgent,
      "x-ddg-journey-id": randomHexId(),
      "x-duckai-consent-purposes":
        "user-location,image-generation,web-search",
      "x-duckai-response-id": randomUUID(),
      "x-fe-signals": this.feSignals(),
      "x-vqd-hash-1": vqd.hash,
    };
    if (vqd.version) headers["x-fe-version"] = vqd.version;
    // Only forward model ids that cannot become a header-injection vector.
    if (/^[A-Za-z0-9._:\/-]+$/.test(request.model)) {
      headers["x-duckai-chat-model"] = request.model;
    }

    return fetch(DUCKAI_CHAT_URL, {
      method: "POST",
      headers,
      body: JSON.stringify(request),
      signal: AbortSignal.timeout(timeoutMs),
    });
  }

  /** `Cookie` header for the duck.ai requests, empty when the jar is empty. */
  private cookieHeaders(): Record<string, string> {
    const cookie = this.cookies.header();
    return cookie ? { cookie } : {};
  }

  private retryDelay(attempt: number): number {
    const exponential = config.retryBaseDelayMs * 2 ** (attempt - 1);
    const capped = Math.min(config.retryMaxDelayMs, exponential);
    // Jitter keeps parallel clients from retrying in lockstep.
    return Math.round(capped * (0.5 + Math.random() * 0.5));
  }

  /**
   * Performs the VQD + chat round trip, retrying retryable upstream failures.
   * Every attempt gets a *fresh* VQD challenge: reusing the one that was just
   * rejected with a 418 is what made the previous retry loop pointless.
   */
  private async requestChatSession(
    request: DuckAIRequest,
    options: { timeoutMs: number; attempts: number },
  ): Promise<Response> {
    const attempts = Math.max(1, options.attempts);
    let lastError: Error | null = null;
    // Extra wait added to the next retry after a rejected challenge.
    let penaltyMs = 0;

    for (let attempt = 0; attempt < attempts; attempt++) {
      if (attempt > 0) await sleep(this.retryDelay(attempt) + penaltyMs);
      await this.acquireRateLimitSlot();

      const userAgent = config.userAgent;
      let vqd: VQDResponse;
      try {
        vqd = await this.getVQD(userAgent);
      } catch (error) {
        lastError = error as Error;
        const status =
          error instanceof UpstreamError ? error.upstreamStatus : 0;
        if (!isRetryableStatus(status)) throw error;
        continue;
      }

      let response: Response;
      try {
        response = await this.sendChatRequest(
          request,
          userAgent,
          vqd,
          options.timeoutMs,
        );
      } catch (error) {
        // Network error / timeout: retryable.
        lastError = error as Error;
        continue;
      }

      if (response.ok) return response;

      const body = await response.text().catch(() => "");
      const payload = parseUpstreamErrorPayload(body);
      lastError = new UpstreamError(
        payload?.message ??
          `duck.ai returned ${response.status} ${response.statusText}: ${truncate(body)}`,
        payload?.status ?? response.status,
      );

      if (response.status === 418) {
        // The frontend bundle almost certainly moved; re-discover next attempt.
        this.invalidateDiscovery();
        // Rejected challenges arrive in bursts rather than one at a time, so
        // wait longer than a plain network retry before solving the next one.
        penaltyMs = 1_500 * 2 ** attempt;
      }

      if (response.status === 429) {
        const waitMs = this.noteRateLimited(
          response.headers.get("retry-after"),
        );
        if (waitMs > 30_000 || attempt === attempts - 1) {
          throw new RateLimitError(
            `duck.ai rate limit hit; retry after ${Math.ceil(waitMs / 1000)}s`,
            waitMs,
          );
        }
        continue;
      }

      if (!isRetryableStatus(response.status)) throw lastError;
    }

    throw lastError ??
      new UpstreamError("duck.ai request failed after all retries", 502);
  }

  // ------------------------------------------------------------------- chat

  /** Parses the SSE-ish body of a non-streaming completion. */
  private parseChatResponse(text: string): DuckAIChatResult {
    const payloadError = parseUpstreamErrorPayload(text);
    if (payloadError) {
      throw new UpstreamError(payloadError.message, payloadError.status ?? 502);
    }

    let content = "";
    let reasoning = "";

    for (const rawLine of text.replace(/\r/g, "").split("\n")) {
      if (!rawLine.startsWith("data: ")) continue;
      const payload = rawLine.slice(6).trim();
      if (!payload || payload === "[DONE]") continue;

      let json: Record<string, unknown>;
      try {
        json = JSON.parse(payload) as Record<string, unknown>;
      } catch {
        // [PING] / [CHAT_TITLE:...] sentinels and partial lines
        continue;
      }
      if (!json || typeof json !== "object") continue;

      if (json.action === "error") {
        throw new UpstreamError(
          `duck.ai error: ${truncate(payload)}`,
          typeof json.status === "number" ? json.status : 502,
        );
      }
      if (json.role === "reasoning" && typeof json.text === "string") {
        reasoning += json.text;
      } else if (typeof json.message === "string") {
        content += json.message;
      }
    }

    const result: DuckAIChatResult = { content: content.trim() };
    if (config.emitReasoning && reasoning) result.reasoning = reasoning;
    return result;
  }

  async chat(request: DuckAIRequest): Promise<DuckAIChatResult> {
    const attempts = config.maxAttempts;
    let lastError: Error | null = null;
    let result: DuckAIChatResult = { content: "" };

    for (let attempt = 0; attempt < attempts; attempt++) {
      if (attempt > 0) await sleep(this.retryDelay(attempt));

      try {
        const response = await this.requestChatSession(request, {
          timeoutMs: config.requestTimeoutMs,
          // The retry budget lives in this loop, so each session attempt is a
          // single round trip (with a freshly fetched VQD challenge).
          attempts: 1,
        });
        result = this.parseChatResponse(await response.text());
      } catch (error) {
        lastError = error as Error;
        if (error instanceof RateLimitError) throw error;
        const retryable =
          error instanceof UpstreamError
            ? isRetryableStatus(error.upstreamStatus)
            : true;
        if (!retryable) throw error;
        console.warn(
          `duck.ai request failed (attempt ${attempt + 1}/${attempts}): ${(error as Error).message}`,
        );
        continue;
      }

      if (result.content) return result;
      console.warn(
        `duck.ai returned an empty completion (attempt ${attempt + 1}/${attempts})`,
      );
    }

    if (result.content) return result;
    if (lastError) throw lastError;
    return { content: EMPTY_RESPONSE_FALLBACK };
  }

  async chatStream(
    request: DuckAIRequest,
  ): Promise<ReadableStream<DuckAIStreamChunk>> {
    const response = await this.requestChatSession(request, {
      timeoutMs: config.streamTimeoutMs,
      attempts: config.maxAttempts,
    });

    if (!response.body) {
      throw new UpstreamError("duck.ai returned an empty response body", 502);
    }

    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    const emitReasoning = config.emitReasoning;
    let buffer = "";

    const emitLine = (
      controller: ReadableStreamDefaultController<DuckAIStreamChunk>,
      line: string,
    ): boolean => {
      if (!line.startsWith("data: ")) return false;
      const payload = line.slice(6).trim();
      if (!payload || payload === "[DONE]") return false;

      let json: Record<string, unknown>;
      try {
        json = JSON.parse(payload) as Record<string, unknown>;
      } catch {
        return false; // [PING] / [CHAT_TITLE:...] sentinels
      }
      if (!json || typeof json !== "object") return false;

      if (json.action === "error") {
        throw new UpstreamError(
          `duck.ai error: ${truncate(payload)}`,
          typeof json.status === "number" ? json.status : 502,
        );
      }
      if (
        emitReasoning && json.role === "reasoning" &&
        typeof json.text === "string" && json.text.length > 0
      ) {
        controller.enqueue({ type: "reasoning", text: json.text });
        return true;
      }
      if (typeof json.message === "string" && json.message.length > 0) {
        controller.enqueue({ type: "content", text: json.message });
        return true;
      }
      return false;
    };

    return new ReadableStream<DuckAIStreamChunk>({
      async pull(controller) {
        for (;;) {
          const newlineIndex = buffer.indexOf("\n");
          if (newlineIndex < 0) {
            const { done, value } = await reader.read();
            if (done) {
              if (buffer.length > 0) emitLine(controller, buffer);
              buffer = "";
              controller.close();
              return;
            }
            buffer += decoder.decode(value, { stream: true });
            continue;
          }

          const line = buffer.slice(0, newlineIndex);
          buffer = buffer.slice(newlineIndex + 1);
          if (emitLine(controller, line)) return;
        }
      },
      cancel(reason) {
        // Client went away: stop pulling from duck.ai instead of leaking it.
        reader.cancel(reason).catch(() => {});
      },
    });
  }

  /** Snapshot of the fingerprint this process would send. */
  async describeEnvironment(): Promise<{
    userAgent: string;
    feVersion: string;
    stack: string;
    durableStream: boolean;
    cookies: string[];
  }> {
    const frontend = await this.getFrontendInfo();
    return {
      userAgent: config.userAgent,
      feVersion: this.xFeVersion(frontend),
      stack: this.stackFor(frontend),
      durableStream: config.streamKey.length > 0,
      cookies: this.cookies.names(),
    };
  }

  getAvailableModels(): string[] {
    return Object.keys(DUCKAI_MODELS);
  }

  // -------------------------------------------------------------- conversion

  private static buildDurableStream(): DuckAIRequest["durableStream"] {
    const raw = config.streamKey;
    if (!raw) return undefined;

    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      throw new ValidationError(
        "STREAM_KEY is not valid JSON (expected the duckaiStreamsTestCredentials value)",
      );
    }

    const publicKey =
      parsed && typeof parsed === "object" && "publicKey" in parsed
        ? (parsed as { publicKey?: unknown }).publicKey
        : parsed;
    if (!publicKey || typeof publicKey !== "object") {
      throw new ValidationError("STREAM_KEY does not contain a publicKey object");
    }

    return {
      conversationId: randomUUID(),
      messageId: randomUUID(),
      publicKey,
    };
  }

  static transformToDuckAIRequest(
    request: ChatCompletionRequest,
  ): DuckAIRequest {
    const model = request.model || "gpt-6-luna";

    if (!(model in DUCKAI_MODELS)) {
      throw new ValidationError(
        `Model ${model} is not a valid model, valid models: ${Object.keys(DUCKAI_MODELS).join(", ")}`,
      );
    }

    const transformedMessages: DuckChatCompletionMessage[] = [];

    for (const message of request.messages as ChatCompletionMessage[]) {
      if (!Array.isArray(message.content)) {
        transformedMessages.push(message as DuckChatCompletionMessage);
        continue;
      }

      const transformedContent: DuckChatCompletionContentPart[] = [];
      for (const content of message.content as ChatCompletionContentPart[]) {
        if (content.type === "text") {
          if (typeof content.text !== "string") {
            throw new ValidationError("Text content must be a string");
          }
          transformedContent.push({ type: "text", text: content.text });
        } else if (content.type === "image_url") {
          const url = content.image_url?.url;
          if (typeof url !== "string" || url.length === 0) {
            throw new ValidationError("Image payload is incorrect");
          }
          const image: DuckChatCompletionContentPartImage = {
            image: url,
            type: "image",
            mimeType: parseDataUrl(url).mimeType,
          };
          transformedContent.push(image);
        } else if (content.type === "file") {
          const fileData = content.file?.file_data;
          const filename = content.file?.filename;
          if (typeof fileData !== "string" || typeof filename !== "string") {
            throw new ValidationError("File payload is incorrect or missing");
          }
          const parsedFile = parseDataUrl(fileData);
          const file: DuckChatCompletionContentPartFile = {
            content: parsedFile.data,
            encoding: parsedFile.encoding,
            filename,
            mimeType: parsedFile.mimeType,
            type: "file",
          };
          transformedContent.push(file);
        }
      }

      transformedMessages.push({
        ...structuredClone(message),
        content: transformedContent,
      } as DuckChatCompletionMessage);
    }

    const modelDefaults = DUCKAI_MODELS[model];
    const validReasoningEfforts = modelDefaults.valid_reasoning_efforts;

    // Models that do not declare a reasoning effort (e.g. mistral-small-2603)
    // do not get one, even when the client asks for it.
    const reasoning_effort =
      validReasoningEfforts !== undefined
        ? request.reasoning_effort || modelDefaults.reasoning_effort
        : undefined;

    if (
      validReasoningEfforts !== undefined &&
      reasoning_effort !== undefined &&
      !validReasoningEfforts.includes(reasoning_effort)
    ) {
      throw new ValidationError(
        `Model ${model} does not support this reasoning effort (${reasoning_effort}), valid reasoning efforts: ${validReasoningEfforts.join(", ")}`,
      );
    }

    const durableStream = DuckAI.buildDurableStream();

    return {
      canUseTools: true,
      messages: transformedMessages,
      metadata: request.metadata,
      model,
      reasoningEffort: reasoning_effort,
      // The console shows these three on every request; they are the consent
      // switches of the UI, so mirror their values when nothing was granted.
      canUseApproxLocation: null,
      canDelegateImageGeneration: null,
      canShowGreeting: false,
      ...(durableStream ? { durableStream } : {}),
    };
  }
}

