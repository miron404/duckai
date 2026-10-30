/**
 * Runtime configuration. Every value is read lazily from the environment so
 * that a process spawned with a different environment (or a test that tweaks
 * `process.env` between cases) always sees the current value.
 */

export const DEFAULT_USER_AGENT =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/138.0.0.0 Safari/537.36";

export const DEFAULT_ACCEPT_LANGUAGE = "en-US,en;q=0.9";

function readInt(name: string, fallback: number): number {
  const raw = process.env[name];
  if (!raw) return fallback;
  const value = Number.parseInt(raw, 10);
  return Number.isFinite(value) && value >= 0 ? value : fallback;
}

function readFlag(name: string): boolean {
  const raw = process.env[name];
  return raw === "1" || raw === "true";
}

export const config = {
  /** Hard cap of chat requests per sliding window (default: 1 minute). */
  get maxRequestsPerMinute(): number {
    return readInt("X_MAX_REQUESTS_PER_MINUTE", 20);
  },

  /** Minimum delay between two requests leaving this process. */
  get minRequestIntervalMs(): number {
    return readInt("X_MIN_REQUEST_INTERVAL_MS", 1000);
  },

  get windowSizeMs(): number {
    return 60_000;
  },

  /** How many times a single chat request is retried on 418/5xx. */
  get maxAttempts(): number {
    return Math.max(1, readInt("X_MAX_ATTEMPTS", 3));
  },

  get retryBaseDelayMs(): number {
    return readInt("X_RETRY_BASE_DELAY_MS", 600);
  },

  get retryMaxDelayMs(): number {
    return readInt("X_RETRY_MAX_DELAY_MS", 8_000);
  },

  /** How long the discovered frontend version/stack is trusted. */
  get discoveryTtlMs(): number {
    return readInt("X_DISCOVERY_TTL_MS", 10 * 60_000);
  },

  /** Timeout for a single request to duck.ai (VQD, HTML, chat). */
  get requestTimeoutMs(): number {
    return readInt("X_REQUEST_TIMEOUT_MS", 120_000);
  },

  /**
   * Streams can legitimately run for minutes, so they get their own (larger)
   * timeout -- the abort signal also tears down the response body.
   */
  get streamTimeoutMs(): number {
    return readInt("X_STREAM_TIMEOUT_MS", 600_000);
  },

  /** Upper bound for the request body accepted by the HTTP server. */
  get maxBodyBytes(): number {
    return readInt("X_MAX_BODY_BYTES", 25 * 1024 * 1024);
  },

  get userAgent(): string {
    return process.env.X_USER_AGENT || DEFAULT_USER_AGENT;
  },

  get acceptLanguage(): string {
    return process.env.X_ACCEPT_LANGUAGE || DEFAULT_ACCEPT_LANGUAGE;
  },

  get emitReasoning(): boolean {
    return readFlag("X_EMIT_REASONING");
  },

  /** Optional bearer token protecting the HTTP API. Empty = no auth. */
  get apiKey(): string {
    return process.env.OPENAI_API_KEY || "";
  },

  /** Raw value of `duckaiStreamsTestCredentials` captured from the browser. */
  get streamKey(): string {
    return process.env.STREAM_KEY || "";
  },

  /**
   * Raw `Cookie:` header value captured from a browser, e.g.
   * `atb=...; ah=...` (see "Cookies" in README.md). Cookies picked up from
   * duck.ai responses are added to the same jar.
   */
  get cookie(): string {
    return process.env.X_COOKIE || "";
  },
};
