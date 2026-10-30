import { OpenAIService } from "./openai-service";
import { config } from "./config";
import { AppError, RateLimitError, UnauthorizedError, ValidationError } from "./errors";

const openAIService = new OpenAIService();

const PORT = Number.parseInt(String(process.env.PORT ?? "3000"), 10);
const HOST = process.env.HOST || "0.0.0.0";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, Authorization, api-key",
};

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json", ...corsHeaders },
  });
}

function errorResponse(error: unknown): Response {
  const isAppError = error instanceof AppError;
  const status = isAppError ? error.status : 500;
  const type = isAppError ? error.type : "internal_server_error";
  const message =
    error instanceof Error ? error.message : "Internal server error";

  const headers: Record<string, string> = {
    "Content-Type": "application/json",
    ...corsHeaders,
  };
  if (error instanceof RateLimitError) {
    headers["Retry-After"] = String(Math.ceil(error.retryAfterMs / 1000));
  }

  return new Response(
    JSON.stringify({ error: { message, type } }),
    { status, headers },
  );
}

function isAuthorized(req: Request): boolean {
  const expected = config.apiKey;
  if (!expected) return true; // auth disabled

  const header =
    req.headers.get("authorization") ?? req.headers.get("api-key") ?? "";
  const token = header.toLowerCase().startsWith("bearer ")
    ? header.slice(7).trim()
    : header.trim();
  return token === expected;
}

async function readJsonBody(req: Request): Promise<unknown> {
  const declaredLength = Number(req.headers.get("content-length") ?? "0");
  if (declaredLength > config.maxBodyBytes) {
    throw new AppError(
      `Request body is larger than ${config.maxBodyBytes} bytes`,
      413,
      "invalid_request_error",
    );
  }

  const raw = await req.text();
  if (raw.length > config.maxBodyBytes) {
    throw new AppError(
      `Request body is larger than ${config.maxBodyBytes} bytes`,
      413,
      "invalid_request_error",
    );
  }

  try {
    return JSON.parse(raw) as unknown;
  } catch {
    throw new ValidationError("Request body must be valid JSON");
  }
}

const server = Bun.serve({
  port: Number.isFinite(PORT) ? PORT : 3000,
  hostname: HOST,
  idleTimeout: 0, // streaming completions can be silent for a while
  async fetch(req) {
    const url = new URL(req.url);

    // Handle preflight requests
    if (req.method === "OPTIONS") {
      return new Response(null, { headers: corsHeaders });
    }

    try {
      // Health check endpoint
      if (url.pathname === "/health" && req.method === "GET") {
        return jsonResponse({ status: "ok" });
      }

      if (!isAuthorized(req)) {
        throw new UnauthorizedError();
      }

      // Models endpoint
      if (url.pathname === "/v1/models" && req.method === "GET") {
        return jsonResponse(openAIService.getModels());
      }

      // Chat completions endpoint
      if (url.pathname === "/v1/chat/completions" && req.method === "POST") {
        const body = await readJsonBody(req);
        const validatedRequest = openAIService.validateRequest(body);

        // Handle streaming
        if (validatedRequest.stream) {
          const stream =
            await openAIService.createChatCompletionStream(validatedRequest);
          return new Response(stream, {
            headers: {
              "Content-Type": "text/event-stream",
              "Cache-Control": "no-cache",
              Connection: "keep-alive",
              ...corsHeaders,
            },
          });
        }

        // Handle non-streaming
        const completion =
          await openAIService.createChatCompletion(validatedRequest);
        return jsonResponse(completion);
      }

      // 404 for unknown endpoints
      return jsonResponse(
        { error: { message: "Not found", type: "invalid_request_error" } },
        404,
      );
    } catch (error) {
      const status = error instanceof AppError ? error.status : 500;
      if (status >= 500) {
        console.error("Server error:", error);
      } else {
        console.warn("Request rejected:", (error as Error).message);
      }
      return errorResponse(error);
    }
  },
});

console.log(
  `🚀 OpenAI-compatible server running on http://${HOST}:${server.port}`,
);
console.log(`📚 Available endpoints:`);
console.log(`  GET  /health - Health check`);
console.log(`  GET  /v1/models - List available models`);
console.log(
  `  POST /v1/chat/completions - Chat completions (streaming & non-streaming)`,
);
if (!config.apiKey) {
  console.log(
    `⚠️  OPENAI_API_KEY is not set - the API is open to anyone who can reach it`,
  );
}
if (!config.streamKey) {
  console.log(
    `⚠️  STREAM_KEY is not set - requests are sent without durableStream`,
  );
}
console.log(`\n🔧 Example usage:`);
console.log(
  `curl -X POST http://localhost:${server.port}/v1/chat/completions \\`,
);
console.log(`  -H "Content-Type: application/json" \\`);
console.log(
  `  -d '{"model":"gpt-6-luna","messages":[{"role":"user","content":"Hello!"}]}'`,
);

const shutdown = (signal: string) => {
  console.log(`\n${signal} received, shutting down...`);
  server.stop();
  process.exit(0);
};
process.on("SIGINT", () => shutdown("SIGINT"));
process.on("SIGTERM", () => shutdown("SIGTERM"));
