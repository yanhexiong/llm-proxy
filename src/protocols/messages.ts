import { invalidField, invalidResponseField, unsupportedField } from "./errors";
import {
  asRecord,
  contentToTextOrBlocks,
  firstAssistantMessage,
  finishReasonFromExternal,
  finishReasonToMessages,
  isRecord,
  normalizeContent,
  normalizeMessages,
  mergeAdjacentMessages,
  normalizeRole,
  optionalBoolean,
  optionalNumber,
  optionalString,
  parseUsage,
  requiredString,
  validateRequestForTarget,
} from "./common";
import type {
  ContentBlock,
  ConversionOptions,
  InternalMessage,
  InternalRequest,
  InternalResponse,
  InternalTool,
  ToolChoice,
} from "./types";

export const MESSAGES_PROTOCOL = "messages" as const;

export function decodeMessagesRequest(value: unknown): InternalRequest {
  const body = asRecord(value, "$", "messages");
  const messages = normalizeMessages(body.messages, "messages", "messages");

  const instructions = body.system === undefined ? undefined : normalizeContent(body.system, "system", "messages");
  const tools = body.tools === undefined ? undefined : decodeMessagesTools(body.tools);
  const toolChoice = body.tool_choice === undefined ? undefined : decodeMessagesToolChoice(body.tool_choice);
  const maxOutputTokens = optionalNumber(body.max_tokens ?? body.max_output_tokens, "max_tokens", "messages");
  const stop = body.stop_sequences === undefined ? undefined : decodeStop(body.stop_sequences);
  const metadata = decodeMetadata(body.metadata);
  if (body.thinking !== undefined) {
    throw unsupportedField("thinking", "provider-native thinking cannot be represented across protocols", "messages");
  }

  return {
    model: requiredString(body.model, "model", "messages"),
    messages,
    instructions,
    tools,
    toolChoice,
    temperature: optionalNumber(body.temperature, "temperature", "messages"),
    topP: optionalNumber(body.top_p, "top_p", "messages"),
    topK: optionalNumber(body.top_k, "top_k", "messages"),
    maxOutputTokens,
    stop,
    stream: optionalBoolean(body.stream, "stream", "messages"),
    metadata,
  };
}

export function encodeMessagesRequest(request: InternalRequest, options: ConversionOptions = {}): Record<string, unknown> {
  validateRequestForTarget(request, "messages");
  const output: Record<string, unknown> = {
    model: request.model,
    messages: [],
    max_tokens: request.maxOutputTokens ?? options.defaultMaxOutputTokens ?? options.defaultMaxTokens ?? 4096,
  };

  const topLevelSystem = [...(request.instructions ?? [])];
  const regularMessages: InternalMessage[] = [];
  for (const message of request.messages) {
    if (message.role === "system" || message.role === "developer") topLevelSystem.push(...message.content);
    else regularMessages.push(message);
  }
  output.messages = encodeMessages(mergeAdjacentMessages(regularMessages));
  if (topLevelSystem.length > 0) output.system = encodeSystem(topLevelSystem);
  if (request.temperature !== undefined) output.temperature = request.temperature;
  if (request.topP !== undefined) output.top_p = request.topP;
  if (request.topK !== undefined) output.top_k = request.topK;
  if (request.stop !== undefined) output.stop_sequences = Array.isArray(request.stop) ? request.stop : [request.stop];
  if (request.stream !== undefined) output.stream = request.stream;
  if (request.tools !== undefined) output.tools = request.tools.map(encodeMessagesTool);
  if (request.toolChoice !== undefined) output.tool_choice = encodeMessagesToolChoice(request.toolChoice);
  if (request.metadata !== undefined) output.metadata = request.metadata;
  return output;
}

export function decodeMessagesResponse(value: unknown): InternalResponse {
  const body = asRecord(value, "$", "messages");
  const content = body.content === undefined ? [] : normalizeContent(body.content, "content", "messages");
  const usage = body.usage === undefined ? undefined : parseUsage(body.usage, "usage", "messages");
  const stopReason = body.stop_reason === undefined ? null : finishReasonFromExternal(body.stop_reason);
  return {
    id: requiredString(body.id, "id", "messages"),
    model: requiredString(body.model, "model", "messages"),
    messages: [{ role: "assistant", content }],
    finishReason: stopReason,
    usage,
    stopSequence: body.stop_sequence === null ? null : optionalString(body.stop_sequence, "stop_sequence", "messages"),
    status: stopReason === null ? "in_progress" : "completed",
  };
}

export function encodeMessagesResponse(response: InternalResponse): Record<string, unknown> {
  const assistant = firstAssistantMessage(response.messages);
  const output: Record<string, unknown> = {
    id: response.id,
    type: "message",
    role: "assistant",
    model: response.model,
    content: assistant.content.map(encodeMessagesBlock),
    stop_reason: finishReasonToMessages(response.finishReason),
    stop_sequence: response.stopSequence ?? null,
  };
  if (response.usage) output.usage = encodeMessagesUsage(response.usage);
  return output;
}

export function encodeMessagesError(error: { message: string; type?: string; code?: string }): Record<string, unknown> {
  return { type: "error", error: { type: error.type ?? "invalid_request_error", message: error.message } };
}

function decodeMessagesTools(value: unknown): InternalTool[] {
  if (!Array.isArray(value)) throw invalidField("tools", "expected an array", "messages");
  return value.map((item, index) => {
    const tool = asRecord(item, `tools[${index}]`, "messages");
    if (tool.type !== undefined && tool.type !== "custom" && tool.type !== "function") {
      throw unsupportedField(`tools[${index}].type`, "only custom function tools can be converted", "messages");
    }
    return {
      type: "function" as const,
      name: requiredString(tool.name, `tools[${index}].name`, "messages"),
      description: optionalString(tool.description, `tools[${index}].description`, "messages"),
      parameters: tool.input_schema === undefined ? undefined : asRecord(tool.input_schema, `tools[${index}].input_schema`, "messages"),
      strict: optionalBoolean(tool.strict, `tools[${index}].strict`, "messages"),
    };
  });
}

function decodeMessagesToolChoice(value: unknown): ToolChoice {
  if (value === "auto") return { type: "auto" };
  if (value === "any") return { type: "required" };
  if (value === "none") return { type: "none" };
  const choice = asRecord(value, "tool_choice", "messages");
  if (choice.type === "auto") return { type: "auto" };
  if (choice.type === "tool") {
    return { type: "function", name: requiredString(choice.name, "tool_choice.name", "messages") };
  }
  throw unsupportedField("tool_choice", "only auto, any, none, or a named tool is supported", "messages");
}

function encodeMessagesTool(tool: InternalTool): Record<string, unknown> {
  return {
    name: tool.name,
    ...(tool.description === undefined ? {} : { description: tool.description }),
    input_schema: tool.parameters ?? { type: "object", properties: {} },
    ...(tool.strict === undefined ? {} : { strict: tool.strict }),
  };
}

function encodeMessagesToolChoice(choice: ToolChoice): unknown {
  if (choice.type === "auto") return { type: "auto" };
  if (choice.type === "required") return "any";
  if (choice.type === "function") return { type: "tool", name: choice.name };
  throw unsupportedField("tool_choice", "none cannot be represented by the Messages API", "messages");
}

function decodeStop(value: unknown): string[] {
  if (!Array.isArray(value)) throw invalidField("stop_sequences", "expected an array", "messages");
  return value.map((stop, index) => requiredString(stop, `stop_sequences[${index}]`, "messages"));
}

function decodeMetadata(value: unknown): Record<string, string> | undefined {
  if (value === undefined || value === null) return undefined;
  const metadata = asRecord(value, "metadata", "messages");
  const output: Record<string, string> = {};
  for (const [key, item] of Object.entries(metadata)) {
    if (typeof item !== "string") throw invalidField(`metadata.${key}`, "metadata values must be strings", "messages");
    output[key] = item;
  }
  return output;
}

function encodeSystem(blocks: ContentBlock[]): unknown {
  const encoded = blocks.map(encodeMessagesBlock);
  return encoded.length === 1 && encoded[0]?.type === "text" ? encoded[0].text : encoded;
}

function encodeMessages(messages: InternalMessage[]): Record<string, unknown>[] {
  return messages.map((message, index) => {
    const role = message.role === "tool" ? "user" : message.role;
    if (role !== "user" && role !== "assistant") throw unsupportedField(`messages[${index}].role`, "system/developer roles must be represented by top-level system", "messages");
    return {
      role,
      ...(message.name === undefined ? {} : { name: message.name }),
      content: message.content.map(encodeMessagesBlock),
    };
  });
}

export function encodeMessagesBlock(block: ContentBlock): Record<string, unknown> {
  if (block.type === "text") return { type: "text", text: block.text };
  if (block.type === "image") {
    return {
      type: "image",
      source:
        block.source.type === "url"
          ? { type: "url", url: block.source.url }
          : { type: "base64", media_type: block.source.mediaType, data: block.source.data },
    };
  }
  if (block.type === "tool_use") return { type: "tool_use", id: block.id, name: block.name, input: block.input };
  return {
    type: "tool_result",
    tool_use_id: block.toolUseId,
    content: block.content.map(encodeMessagesBlock),
    ...(block.isError === undefined ? {} : { is_error: block.isError }),
  };
}

function encodeMessagesUsage(usage: NonNullable<InternalResponse["usage"]>): Record<string, unknown> {
  return {
    input_tokens: messagesInputTokens(usage),
    output_tokens: usage.outputTokens,
    ...(usage.cacheReadInputTokens === undefined ? {} : { cache_read_input_tokens: usage.cacheReadInputTokens }),
    ...(usage.cacheCreationInputTokens === undefined ? {} : { cache_creation_input_tokens: usage.cacheCreationInputTokens }),
  };
}

function messagesInputTokens(usage: NonNullable<InternalResponse["usage"]>): number {
  return Math.max(0, usage.inputTokens - (usage.cacheReadInputTokens ?? 0) - (usage.cacheCreationInputTokens ?? 0));
}
