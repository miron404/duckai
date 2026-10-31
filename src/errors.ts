/**
 * Errors that carry an HTTP status so the server does not have to guess from
 * the message text.
 */
export class AppError extends Error {
  readonly status: number;
  readonly type: string;

  constructor(message: string, status = 500, type = "internal_server_error") {
    super(message);
    this.name = "AppError";
    this.status = status;
    this.type = type;
  }
}

export class ValidationError extends AppError {
  constructor(message: string) {
    super(message, 400, "invalid_request_error");
    this.name = "ValidationError";
  }
}

export class UnauthorizedError extends AppError {
  constructor(message = "Missing or invalid API key") {
    super(message, 401, "invalid_request_error");
    this.name = "UnauthorizedError";
  }
}

export class UpstreamError extends AppError {
  readonly upstreamStatus: number;

  constructor(message: string, upstreamStatus: number) {
    // Upstream rate limits are passed through so clients back off; a rejected
    // challenge (418) is an upstream problem, not a client one.
    const status = upstreamStatus === 429 ? 429 : 502;
    super(message, status, "upstream_error");
    this.name = "UpstreamError";
    this.upstreamStatus = upstreamStatus;
  }
}

/**
 * duck.ai's usage allowance is spent (`ERR_USER_LIMIT` and friends). Unlike a
 * rate limit this does not clear in seconds, so it is reported the way OpenAI
 * reports an exhausted quota, with `Retry-After` pointing at the reset when
 * duck.ai told us when that is.
 */
export class QuotaExceededError extends AppError {
  readonly upstreamType: string;
  readonly retryAfterMs: number | undefined;

  constructor(message: string, upstreamType: string, retryAfterMs?: number) {
    super(message, 429, "insufficient_quota");
    this.name = "QuotaExceededError";
    this.upstreamType = upstreamType;
    this.retryAfterMs = retryAfterMs;
  }
}

export class RateLimitError extends AppError {
  readonly retryAfterMs: number;

  constructor(message: string, retryAfterMs: number) {
    super(message, 429, "rate_limit_error");
    this.name = "RateLimitError";
    this.retryAfterMs = retryAfterMs;
  }
}
