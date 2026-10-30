import { DuckAI } from "./duckai";
import { ToolService } from "./tool-service";
import type {
  ChatCompletionRequest,
  ChatCompletionResponse,
  ChatCompletionStreamResponse,
  ChatCompletionMessage,
  ModelsResponse,
  Model,
  ToolCall,
  DuckAIMetadata,
} from "./types";
import { ValidationError } from "./errors";

export class OpenAIService {
  private duckAI: DuckAI;
  private toolService: ToolService;
  private availableFunctions: Record<string, Function>;

  constructor() {
    this.duckAI = new DuckAI();
    this.toolService = new ToolService();
    this.availableFunctions = this.initializeBuiltInFunctions();
  }

  private initializeBuiltInFunctions(): Record<string, Function> {
    return {
      // Example built-in functions - users can extend this
      get_current_time: () => new Date().toISOString(),
      calculate: (args: { expression: string }) => {
        try {
          // Simple calculator - in production, use a proper math parser
          const result = Function(
            `"use strict"; return (${args.expression})`,
          )();
          return { result };
        } catch (error) {
          return { error: "Invalid expression" };
        }
      },
      get_weather: (args: { location: string }) => {
        // Mock weather function
        return {
          location: args.location,
          temperature: Math.floor(Math.random() * 30) + 10,
          condition: ["sunny", "cloudy", "rainy"][
            Math.floor(Math.random() * 3)
          ],
          note: "This is a mock weather function for demonstration",
        };
      },
    };
  }

  registerFunction(name: string, func: Function): void {
    this.availableFunctions[name] = func;
  }

  private generateId(): string {
    return `chatcmpl-${Math.random().toString(36).substring(2, 15)}`;
  }

  private getCurrentTimestamp(): number {
    return Math.floor(Date.now() / 1000);
  }

  private estimateTokens(text: string): number {
    // Rough estimation: ~4 characters per token
    return Math.ceil(text.length / 4);
  }

  /** Flattens OpenAI message content (string | parts | null) into plain text. */
  private contentToText(content: ChatCompletionMessage["content"]): string {
    if (typeof content === "string") return content;
    if (!Array.isArray(content)) return "";
    return content
      .map((part) => {
        if (part && typeof part === "object" && "text" in part) {
          const text = (part as { text?: unknown }).text;
          return typeof text === "string" ? text : "";
        }
        return "";
      })
      .filter((text) => text.length > 0)
      .join("\n");
  }

  private messagesToText(messages: ChatCompletionMessage[]): string {
    return messages
      .map((message) => this.contentToText(message.content))
      .filter((text) => text.length > 0)
      .join(" ");
  }

  async createChatCompletion(
    request: ChatCompletionRequest,
  ): Promise<ChatCompletionResponse> {
    // Check if this request involves function calling
    if (
      this.toolService.shouldUseFunctionCalling(
        request.tools,
        request.tool_choice,
      )
    ) {
      return this.createChatCompletionWithTools(request);
    }

    const duckAIRequest = DuckAI.transformToDuckAIRequest(request);
    const { content: response, reasoning } =
      await this.duckAI.chat(duckAIRequest);

    const id = this.generateId();
    const created = this.getCurrentTimestamp();

    // Calculate token usage
    const promptTokens = this.estimateTokens(
      this.messagesToText(request.messages),
    );
    const completionTokens = this.estimateTokens(response);

    return {
      id,
      object: "chat.completion",
      created,
      model: request.model,
      choices: [
        {
          index: 0,
          message: {
            role: "assistant",
            content: response,
            ...(reasoning ? { reasoning_content: reasoning } : {}),
          },
          finish_reason: "stop",
        },
      ],
      usage: {
        prompt_tokens: promptTokens,
        completion_tokens: completionTokens,
        total_tokens: promptTokens + completionTokens,
      },
    };
  }

  private async createChatCompletionWithTools(
    request: ChatCompletionRequest,
  ): Promise<ChatCompletionResponse> {
    const id = this.generateId();
    const created = this.getCurrentTimestamp();

    // Validate tools
    if (request.tools) {
      const validation = this.toolService.validateTools(request.tools);
      if (!validation.valid) {
        throw new ValidationError(
          `Invalid tools: ${validation.errors.join(", ")}`,
        );
      }
    }

    // Create a modified request with tool instructions
    const modifiedMessages = [...request.messages];

    // Add tool instructions as user message (DuckAI doesn't support system messages)
    if (request.tools && request.tools.length > 0) {
      const toolPrompt = this.toolService.generateToolSystemPrompt(
        request.tools,
        request.tool_choice,
      );
      modifiedMessages.unshift({
        role: "user",
        content: `[SYSTEM INSTRUCTIONS] ${toolPrompt}

Please follow these instructions when responding to the following user message.`,
      });
    }

    const duckAIRequest = DuckAI.transformToDuckAIRequest({
      ...request,
      messages: modifiedMessages,
    });

    const { content: response, reasoning } =
      await this.duckAI.chat(duckAIRequest);

    // Check if the response contains function calls
    if (this.toolService.detectFunctionCalls(response)) {
      const toolCalls = this.toolService.extractFunctionCalls(response);

      if (toolCalls.length > 0) {
        // Calculate token usage
        const promptTokens = this.estimateTokens(
          this.messagesToText(modifiedMessages),
        );
        const completionTokens = this.estimateTokens(response);

        return {
          id,
          object: "chat.completion",
          created,
          model: request.model,
          choices: [
            {
              index: 0,
              message: {
                role: "assistant",
                content: null,
                tool_calls: toolCalls,
              },
              finish_reason: "tool_calls",
            },
          ],
          usage: {
            prompt_tokens: promptTokens,
            completion_tokens: completionTokens,
            total_tokens: promptTokens + completionTokens,
          },
        };
      }
    }

    // No function calls detected
    // If tool_choice is "required" or specific function, we need to force a function call
    if (
      (request.tool_choice === "required" ||
        (typeof request.tool_choice === "object" &&
          request.tool_choice.type === "function")) &&
      request.tools &&
      request.tools.length > 0
    ) {
      // Get user message for argument extraction
      const userMessage = request.messages[request.messages.length - 1];
      const userContent = userMessage.content || "";

      // Determine which function to call
      let functionToCall: string = "";

      // If specific function is requested, use that
      if (
        typeof request.tool_choice === "object" &&
        request.tool_choice.type === "function"
      ) {
        functionToCall = request.tool_choice.function.name;
      } else if (typeof userContent == "string") {
        // Try to infer which function to call based on the user's request
        // Simple heuristics to choose appropriate function
        functionToCall = request.tools[0].function.name; // Default to first function

        if (userContent.toLowerCase().includes("time")) {
          const timeFunction = request.tools.find(
            (t) => t.function.name === "get_current_time",
          );
          if (timeFunction) functionToCall = timeFunction.function.name;
        } else if (
          userContent.toLowerCase().includes("calculate") ||
          /\d+\s*[+\-*/]\s*\d+/.test(userContent)
        ) {
          const calcFunction = request.tools.find(
            (t) => t.function.name === "calculate",
          );
          if (calcFunction) functionToCall = calcFunction.function.name;
        } else if (userContent.toLowerCase().includes("weather")) {
          const weatherFunction = request.tools.find(
            (t) => t.function.name === "get_weather",
          );
          if (weatherFunction) functionToCall = weatherFunction.function.name;
        }
      }

      // Generate appropriate arguments based on function
      let args = "{}";
      if (typeof userContent == "string") {
        if (functionToCall === "calculate") {
          const mathMatch = userContent.match(/(\d+\s*[+\-*/]\s*\d+)/);
          if (mathMatch) {
            args = JSON.stringify({ expression: mathMatch[1] });
          }
        } else if (functionToCall === "get_weather") {
          // Try to extract location from user message
          const locationMatch = userContent.match(
            /(?:in|for|at)\s+([A-Za-z\s,]+)/i,
          );
          if (locationMatch) {
            args = JSON.stringify({ location: locationMatch[1].trim() });
          }
        }
      }

      const forcedToolCall: ToolCall = {
        id: `call_${Date.now()}`,
        type: "function",
        function: {
          name: functionToCall,
          arguments: args,
        },
      };

      const promptTokens = this.estimateTokens(
        this.messagesToText(modifiedMessages),
      );
      const completionTokens = this.estimateTokens(
        JSON.stringify(forcedToolCall),
      );

      return {
        id,
        object: "chat.completion",
        created,
        model: request.model,
        choices: [
          {
            index: 0,
            message: {
              role: "assistant",
              content: null,
              tool_calls: [forcedToolCall],
            },
            finish_reason: "tool_calls",
          },
        ],
        usage: {
          prompt_tokens: promptTokens,
          completion_tokens: completionTokens,
          total_tokens: promptTokens + completionTokens,
        },
      };
    }

    // No function calls detected, return normal response
    const promptTokens = this.estimateTokens(
      this.messagesToText(modifiedMessages),
    );
    const completionTokens = this.estimateTokens(response);

    return {
      id,
      object: "chat.completion",
      created,
      model: request.model,
      choices: [
        {
          index: 0,
          message: {
            role: "assistant",
            content: response,
            ...(reasoning ? { reasoning_content: reasoning } : {}),
          },
          finish_reason: "stop",
        },
      ],
      usage: {
        prompt_tokens: promptTokens,
        completion_tokens: completionTokens,
        total_tokens: promptTokens + completionTokens,
      },
    };
  }

  async createChatCompletionStream(
    request: ChatCompletionRequest,
  ): Promise<ReadableStream<Uint8Array>> {
    // Check if this request involves function calling
    if (
      this.toolService.shouldUseFunctionCalling(
        request.tools,
        request.tool_choice,
      )
    ) {
      return this.createChatCompletionStreamWithTools(request);
    }

    const duckAIRequest = DuckAI.transformToDuckAIRequest(request);
    const duckStream = await this.duckAI.chatStream(duckAIRequest);

    const id = this.generateId();
    const created = this.getCurrentTimestamp();

    const encoder = new TextEncoder();
    const reader = duckStream.getReader();
    let isFirst = true;

    const finish = (
      controller: ReadableStreamDefaultController<Uint8Array>,
      finishReason: "stop" | "tool_calls",
    ) => {
      const finalChunk: ChatCompletionStreamResponse = {
        id,
        object: "chat.completion.chunk",
        created,
        model: request.model,
        choices: [{ index: 0, delta: {}, finish_reason: finishReason }],
      };
      controller.enqueue(
        encoder.encode(`data: ${JSON.stringify(finalChunk)}\n\n`),
      );
      controller.enqueue(encoder.encode("data: [DONE]\n\n"));
      controller.close();
    };

    return new ReadableStream<Uint8Array>({
      async pull(controller) {
        const { done, value } = await reader.read();
        if (done) {
          finish(controller, "stop");
          return;
        }

        const delta: ChatCompletionStreamResponse["choices"][0]["delta"] =
          isFirst ? { role: "assistant" } : {};
        if (value.type === "reasoning") {
          delta.reasoning_content = value.text;
        } else {
          delta.content = value.text;
        }

        const chunk: ChatCompletionStreamResponse = {
          id,
          object: "chat.completion.chunk",
          created,
          model: request.model,
          choices: [{ index: 0, delta, finish_reason: null }],
        };

        isFirst = false;
        controller.enqueue(encoder.encode(`data: ${JSON.stringify(chunk)}\n\n`));
      },
      cancel(reason) {
        // Client disconnected: do not keep the duck.ai response open.
        reader.cancel(reason).catch(() => {});
      },
    });
  }

  private async createChatCompletionStreamWithTools(
    request: ChatCompletionRequest,
  ): Promise<ReadableStream<Uint8Array>> {
    // For tools, we need to collect the full response first to parse function calls
    // This is a limitation of the "trick" approach - streaming with tools is complex
    const completion = await this.createChatCompletionWithTools(request);

    const id = completion.id;
    const created = completion.created;

    return new ReadableStream({
      start(controller) {
        const choice = completion.choices[0];

        if (choice.message.tool_calls) {
          // Stream tool calls
          const toolCallsChunk: ChatCompletionStreamResponse = {
            id,
            object: "chat.completion.chunk",
            created,
            model: request.model,
            choices: [
              {
                index: 0,
                delta: {
                  role: "assistant",
                  tool_calls: choice.message.tool_calls,
                },
                finish_reason: null,
              },
            ],
          };

          const toolCallsData = `data: ${JSON.stringify(toolCallsChunk)}\n\n`;
          controller.enqueue(new TextEncoder().encode(toolCallsData));

          // Send final chunk
          const finalChunk: ChatCompletionStreamResponse = {
            id,
            object: "chat.completion.chunk",
            created,
            model: request.model,
            choices: [
              {
                index: 0,
                delta: {},
                finish_reason: "tool_calls",
              },
            ],
          };

          const finalData = `data: ${JSON.stringify(finalChunk)}\n\n`;
          const finalDone = `data: [DONE]\n\n`;

          controller.enqueue(new TextEncoder().encode(finalData));
          controller.enqueue(new TextEncoder().encode(finalDone));
        } else {
          // Stream regular content
          const content = choice.message.content || "";

          // Send role first
          const roleChunk: ChatCompletionStreamResponse = {
            id,
            object: "chat.completion.chunk",
            created,
            model: request.model,
            choices: [
              {
                index: 0,
                delta: { role: "assistant" },
                finish_reason: null,
              },
            ],
          };

          const roleData = `data: ${JSON.stringify(roleChunk)}\n\n`;
          controller.enqueue(new TextEncoder().encode(roleData));

          // Stream content in chunks
          const chunkSize = 10;
          for (let i = 0; i < content.length; i += chunkSize) {
            const contentChunk = content.slice(i, i + chunkSize);

            const chunk: ChatCompletionStreamResponse = {
              id,
              object: "chat.completion.chunk",
              created,
              model: request.model,
              choices: [
                {
                  index: 0,
                  delta: { content: contentChunk as string },
                  finish_reason: null,
                },
              ],
            };

            const data = `data: ${JSON.stringify(chunk)}\n\n`;
            controller.enqueue(new TextEncoder().encode(data));
          }

          // Send final chunk
          const finalChunk: ChatCompletionStreamResponse = {
            id,
            object: "chat.completion.chunk",
            created,
            model: request.model,
            choices: [
              {
                index: 0,
                delta: {},
                finish_reason: "stop",
              },
            ],
          };

          const finalData = `data: ${JSON.stringify(finalChunk)}\n\n`;
          const finalDone = `data: [DONE]\n\n`;

          controller.enqueue(new TextEncoder().encode(finalData));
          controller.enqueue(new TextEncoder().encode(finalDone));
        }

        controller.close();
      },
    });
  }

  getModels(): ModelsResponse {
    const models = this.duckAI.getAvailableModels();
    const created = this.getCurrentTimestamp();

    const modelData: Model[] = models.map((modelId) => ({
      id: modelId,
      object: "model",
      created,
      owned_by: "duckai",
    }));

    return {
      object: "list",
      data: modelData,
    };
  }

  /**
   * Validates the incoming request and normalises it for duck.ai.
   *
   * System/developer messages are hoisted into
   * `metadata.customization.additionalInstructions` because duck.ai has no
   * system role; the caller's array is never mutated.
   */
  validateRequest(request: any): ChatCompletionRequest {
    if (!request || typeof request !== "object") {
      throw new ValidationError("Request body must be a JSON object");
    }
    if (!Array.isArray(request.messages)) {
      throw new ValidationError("messages field is required and must be an array");
    }
    if (request.messages.length === 0) {
      throw new ValidationError("messages array cannot be empty");
    }

    const conversation: ChatCompletionMessage[] = [];
    const instructions: string[] = [];

    for (const message of request.messages as ChatCompletionMessage[]) {
      if (
        !message ||
        typeof message !== "object" ||
        !message.role ||
        !["system", "developer", "user", "assistant", "tool"].includes(
          message.role,
        )
      ) {
        throw new ValidationError(
          "Each message must have a valid role (system, developer, user, assistant, or tool)",
        );
      }

      // Tool messages have different validation rules
      if (message.role === "tool") {
        if (!message.tool_call_id) {
          throw new ValidationError("Tool messages must have a tool_call_id");
        }
        if (typeof message.content !== "string") {
          throw new ValidationError("Tool messages must have content as a string");
        }
      } else if (
        message.content === undefined ||
        (message.content !== null &&
          typeof message.content !== "string" &&
          !Array.isArray(message.content))
      ) {
        // For non-tool messages, content can be null if there are tool_calls
        throw new ValidationError(
          "Each message must have content as a string, array (for images), or null",
        );
      }

      if (message.role === "system" || message.role === "developer") {
        const text = this.contentToText(message.content);
        if (text) instructions.push(text);
        continue;
      }

      // duck.ai only knows user/assistant turns, so keep tool results in the
      // conversation but let them reach the model as regular text.
      if (message.role === "tool") {
        conversation.push({
          role: "user",
          content: `[tool result for ${message.tool_call_id}]\n${message.content}`,
        });
        continue;
      }

      conversation.push(message);
    }

    if (conversation.length === 0) {
      throw new ValidationError(
        "messages must contain at least one user or assistant message",
      );
    }

    // Validate tools if provided
    if (request.tools) {
      const validation = this.toolService.validateTools(request.tools);
      if (!validation.valid) {
        throw new ValidationError(
          `Invalid tools: ${validation.errors.join(", ")}`,
        );
      }
    }

    const metadata: DuckAIMetadata = {
      customization: {
        additionalInstructions: instructions.join("\n\n"),
        shouldSeekClarity: false,
      },
      toolChoice: {
        NewsSearch: false,
        VideosSearch: false,
        LocalSearch: false,
        WeatherForecast: false,
      },
    };

    return {
      model: request.model || "gpt-6-luna",
      messages: conversation,
      metadata,
      temperature: request.temperature,
      max_tokens: request.max_tokens,
      stream: request.stream || false,
      top_p: request.top_p,
      frequency_penalty: request.frequency_penalty,
      presence_penalty: request.presence_penalty,
      stop: request.stop,
      tools: request.tools,
      tool_choice: request.tool_choice,
      reasoning_effort: request.reasoning_effort,
    };
  }

  async executeToolCall(toolCall: ToolCall): Promise<string> {
    return this.toolService.executeFunctionCall(
      toolCall,
      this.availableFunctions,
    );
  }

  /**
   * Get current rate limit status from DuckAI
   */
  getRateLimitStatus() {
    return this.duckAI.getRateLimitStatus();
  }
}
