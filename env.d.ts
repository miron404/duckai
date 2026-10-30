declare module "bun" {
  interface Env {
    // Add your environment variables here
    X_USER_AGENT: string;
    X_ACCEPT_LANGUAGE: string;
    X_MODELS_JSON: string;
    X_EMIT_REASONING: string;
    /** Legacy overrides; normally discovered from duck.ai at runtime. */
    X_FE_VERSION: string;
    X_VQD_STACK: string;
    /** Browser-captured `duckaiStreamsTestCredentials` value (JSON). */
    STREAM_KEY: string;
    /** Optional bearer token protecting this server. */
    OPENAI_API_KEY: string;
    /** Tuning knobs, see src/config.ts. */
    X_MAX_REQUESTS_PER_MINUTE: string;
    X_MIN_REQUEST_INTERVAL_MS: string;
    X_MAX_ATTEMPTS: string;
    X_RETRY_BASE_DELAY_MS: string;
    X_RETRY_MAX_DELAY_MS: string;
    X_DISCOVERY_TTL_MS: string;
    X_REQUEST_TIMEOUT_MS: string;
    X_STREAM_TIMEOUT_MS: string;
    X_MAX_BODY_BYTES: string;
    PORT: number;
    HOST: string;
    NODE_ENV: "development" | "production";
  }
  1;
}

// This allows the types to apply to process.env as well
declare global {
  namespace NodeJS {
    interface ProcessEnv extends Bun.Env {}
  }
}
