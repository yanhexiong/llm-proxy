import { invalidField, invalidResponseField, ProtocolConversionError, unsupportedField } from "./errors";
import type {
  ContentBlock,
  FinishReason,
  ImageSource,
  InternalMessage,
  InternalRequest,
  InternalResponse,
  InternalTool,
  InternalUsage,
  MessageRole,
  Protocol,
  TextBlock,
  ToolChoice,
} from "./types";

export type UnknownRecord = Record<string, unknown>;

export function isRecord(value: unknown): value is UnknownRecord {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function asRecord(value: unknown, path: string, protocol?: Protocol): UnknownRecord {
  if (!isRecord(value)) throw invalidField(path, "expected an object", protocol);
  return value;
}

export function asArray(value: unknown, path: string, protocol?: Protocol): unknown[] {
  if (!Array.isArray(value)) throw invalidField(path, "expected an array", protocol);
  return value;
}

export function optionalString(value: unknown, path: string, protocol?: Protocol): string | undefined {
  if (value === undefined || value === null) return undefined;
  if (typeof value !== "string") throw invalidField(path, "expected a string", protocol);
  return value;
}

export function requiredString(value: unknown, path: string, protocol?: Protocol): string {
  if (typeof value !== "string" || value.length === 0) {
    throw invalidField(path, "expected a non-empty string", protocol);
  }
  return value;
}

export function optionalNumber(value: unknown, path: string, protocol?: Protocol): number | undefined {
  if (value === undefined || value === null) return undefined;
  if (typeof value !== "number" || !Number.isFinite(value)) {
    throw invalidField(path, "expected a finite number", protocol);
  }
  return value;
}

export function optionalBoolean(value: unknown, path: string, protocol?: Protocol): boolean | undefined {
  if (value === undefined || value === null) return undefined;
  if (typeof value !== "boolean") throw invalidField(path, "expected a boolean", protocol);
  return value;
}

export function parseJsonText(value: unknown, path: string, protocol?: Protocol): unknown {
  if (typeof value !== "string") return value;
  try {
    return JSON.parse(value);
  } catch (error) {
    throw new ProtocolConversionError(`${path}: expected valid JSON`, {
      code: "invalid_json",
      path,
      protocol,
      cause: error,
    });
  }
}

export function jsonText(value: unknown): string {
  return typeof value === "string" ? value : JSON.stringify(value ?? {});
}

export function blockText(text: string): TextBlock {
  return { type: "text", text };
}

export function contentText(blocks: ContentBlock[]): string {
  return blocks
    .filter((block): block is TextBlock => block.type === "text")
    .map((block) => block.text)
    .join("");
}

export function contentToTextOrBlocks(blocks: ContentBlock[]): string | ContentBlock[] {
  if (blocks.length === 1 && blocks[0]?.type === "text") return blocks[0].text;
  return blocks;
}

export function normalizeContent(value: unknown, path: string, protocol?: Protocol): ContentBlock[] {
  if (typeof value === "string") return [blockText(value)];
  if (!Array.isArray(value)) throw invalidField(path, "expected text or an array of content blocks", protocol);
  return value.map((block, index) => normalizeContentBlock(block, `${path}[${index}]`, protocol));
}

export function normalizeContentBlock(value: unknown, path: string, protocol?: Protocol): ContentBlock {
  const block = asRecord(value, path, protocol);
  const type = requiredString(block.type, `${path}.type`, protocol);
  if (type === "text" || type === "input_text" || type === "output_text") {
    return { type: "text", text: requiredString(block.text, `${path}.text`, protocol) };
  }
  if (type === "image") {
    return { type: "image", source: normalizeImageSource(block.source, `${path}.source`, protocol) };
  }
  if (type === "image_url") {
    const image = typeof block.image_url === "string" ? { url: block.image_url } : asRecord(block.image_url, `${path}.image_url`, protocol);
    const source = normalizeImageValue(requiredString(image.url, `${path}.image_url.url`, protocol), `${path}.image_url.url`, protocol);
    if (source.type === "url" && image.detail !== undefined) source.detail = image.detail as "auto" | "low" | "high";
    return {
      type: "image",
      source,
    };
  }
  if (type === "input_image") {
    const imageUrl = block.image_url;
    if (typeof imageUrl === "string") {
      return { type: "image", source: normalizeImageValue(imageUrl, `${path}.image_url`, protocol) };
    }
    if (isRecord(imageUrl)) {
      const url = requiredString(imageUrl.url, `${path}.image_url.url`, protocol);
      return { type: "image", source: normalizeImageValue(url, `${path}.image_url.url`, protocol) };
    }
    throw invalidField(`${path}.image_url`, "expected an image URL", protocol);
  }
  if (type === "tool_use" || type === "function_call") {
    return {
      type: "tool_use",
      id: requiredString(block.id ?? block.call_id, `${path}.${type === "tool_use" ? "id" : "call_id"}`, protocol),
      name: requiredString(block.name, `${path}.name`, protocol),
      input: parseJsonText(block.input ?? block.arguments, `${path}.${block.input !== undefined ? "input" : "arguments"}`, protocol),
    };
  }
  if (type === "tool_result" || type === "function_call_output") {
    const toolUseId = requiredString(block.tool_use_id ?? block.call_id, `${path}.${type === "tool_result" ? "tool_use_id" : "call_id"}`, protocol);
    const rawContent = block.content ?? block.output ?? "";
    return {
      type: "tool_result",
      toolUseId,
      content: typeof rawContent === "string" ? [blockText(rawContent)] : normalizeContent(rawContent, `${path}.${block.content !== undefined ? "content" : "output"}`, protocol),
      isError: typeof block.is_error === "boolean" ? block.is_error : undefined,
    };
  }
  throw unsupportedField(path, `content block type ${JSON.stringify(type)} cannot be converted`, protocol);
}

export function normalizeImageSource(value: unknown, path: string, protocol?: Protocol): ImageSource {
  const source = asRecord(value, path, protocol);
  const type = requiredString(source.type, `${path}.type`, protocol);
  if (type === "url") {
    return {
      type: "url",
      url: requiredString(source.url, `${path}.url`, protocol),
      detail: source.detail as "auto" | "low" | "high" | undefined,
    };
  }
  if (type === "base64") {
    return {
      type: "base64",
      mediaType: requiredString(source.mediaType ?? source.media_type, `${path}.mediaType`, protocol),
      data: requiredString(source.data, `${path}.data`, protocol),
    };
  }
  throw unsupportedField(path, `image source type ${JSON.stringify(type)} cannot be converted`, protocol);
}

export function normalizeImageValue(value: string, path: string, protocol?: Protocol): ImageSource {
  if (!value.startsWith("data:")) return { type: "url", url: value };
  const match = /^data:([^;,]+)(?:;base64)?,(.*)$/s.exec(value);
  if (!match) throw invalidField(path, "invalid data URL", protocol);
  return { type: "base64", mediaType: match[1] ?? "", data: match[2] ?? "" };
}

export function normalizeRole(value: unknown, path: string, protocol?: Protocol): MessageRole {
  if (value === "system" || value === "developer" || value === "user" || value === "assistant" || value === "tool") return value;
  throw unsupportedField(path, `message role ${JSON.stringify(value)} cannot be converted`, protocol);
}

export function normalizeTool(value: unknown, path: string, protocol?: Protocol): InternalTool {
  const tool = asRecord(value, path);
  if (tool.type !== undefined && tool.type !== "function") {
    throw unsupportedField(`${path}.type`, `tool type ${JSON.stringify(tool.type)} is not a function tool`);
  }
  const definition = isRecord(tool.function) ? tool.function : tool;
  return {
    type: "function",
    name: requiredString(definition.name, `${path}.function.name`, "chat"),
    description: optionalString(definition.description, `${path}.function.description`, "chat"),
    parameters: definition.parameters === undefined ? undefined : asRecord(definition.parameters, `${path}.function.parameters`, "chat"),
    strict: optionalBoolean(definition.strict, `${path}.function.strict`, "chat"),
  };
}

export function normalizeToolChoice(value: unknown, path: string, protocol?: Protocol): ToolChoice | undefined {
  if (value === undefined || value === null) return undefined;
  if (value === "auto" || value === "none" || value === "required") return { type: value };
  const choice = asRecord(value, path, protocol);
  if (choice.type === "function") {
    const fn = isRecord(choice.function) ? choice.function : choice;
    return { type: "function", name: requiredString(fn.name, `${path}.function.name`, protocol) };
  }
  if (choice.type === "auto" || choice.type === "none" || choice.type === "required") return { type: choice.type };
  throw unsupportedField(path, `tool choice ${JSON.stringify(choice.type)} cannot be converted`, protocol);
}

export function normalizeMessages(value: unknown, path: string, protocol?: Protocol): InternalMessage[] {
  const values = asArray(value, path, protocol);
  return values.map((value, index) => normalizeMessage(value, `${path}[${index}]`, protocol));
}

export function normalizeMessage(value: unknown, path: string, protocol?: Protocol): InternalMessage {
  const message = asRecord(value, path, protocol);
  const role = normalizeRole(message.role, `${path}.role`, protocol);
  let content: ContentBlock[];
  if (role === "assistant" && (Array.isArray(message.tool_calls) || isRecord(message.function_call))) {
    const base = message.content === null || message.content === undefined ? [] : normalizeContent(message.content, `${path}.content`, protocol).filter((block) => block.type !== "text" || block.text.length > 0);
    const rawCalls = Array.isArray(message.tool_calls) ? message.tool_calls : [message.function_call];
    const calls = rawCalls.map((call, index) => {
      const item = asRecord(call, `${path}.tool_calls[${index}]`, protocol);
      const fn = isRecord(item.function) ? item.function : item;
      return {
        type: "tool_use" as const,
        id: requiredString(item.id ?? item.call_id ?? `call_${index}`, `${path}.tool_calls[${index}].id`, protocol),
        name: requiredString(fn.name, `${path}.tool_calls[${index}].function.name`, protocol),
        input: parseJsonText(fn.arguments ?? "{}", `${path}.tool_calls[${index}].function.arguments`, protocol),
      };
    });
    content = base.concat(calls);
  } else if (role === "tool") {
    const toolUseId = requiredString(message.tool_call_id, `${path}.tool_call_id`, protocol);
    content = [{ type: "tool_result", toolUseId, content: normalizeContent(message.content ?? "", `${path}.content`, protocol) }];
  } else {
    content = normalizeContent(message.content ?? "", `${path}.content`, protocol);
  }
  return {
    role,
    content,
    id: optionalString(message.id, `${path}.id`, protocol),
    name: optionalString(message.name, `${path}.name`, protocol),
  };
}

export function parseUsage(value: unknown, path: string, protocol?: Protocol): InternalUsage {
  const usage = asRecord(value, path, protocol);
  const rawInputTokens = numberOrZero(usage.input_tokens ?? usage.prompt_tokens, `${path}.input_tokens`, protocol);
  const outputTokens = numberOrZero(usage.output_tokens ?? usage.completion_tokens, `${path}.output_tokens`, protocol);
  const inputDetails = isRecord(usage.input_tokens_details) ? usage.input_tokens_details : undefined;
  const promptDetails = isRecord(usage.prompt_tokens_details) ? usage.prompt_tokens_details : undefined;
  const cacheReadInputTokens = numberOptional(
    usage.cache_read_input_tokens ?? inputDetails?.cached_tokens ?? promptDetails?.cached_tokens,
    `${path}.input_tokens_details.cached_tokens`,
    protocol,
  );
  const cacheCreationInputTokens = numberOptional(usage.cache_creation_input_tokens, `${path}.cache_creation_input_tokens`, protocol);
  // Anthropic reports cache read/write input separately from input_tokens;
  // OpenAI reports prompt/input tokens with cache already included.
  const inputTokens = rawInputTokens + (protocol === "messages" ? (cacheReadInputTokens ?? 0) + (cacheCreationInputTokens ?? 0) : 0);
  const rawTotalTokens = numberOptional(usage.total_tokens, `${path}.total_tokens`, protocol);
  const totalTokens = rawTotalTokens === undefined
    ? inputTokens + outputTokens
    : rawTotalTokens + (protocol === "messages" ? (cacheReadInputTokens ?? 0) + (cacheCreationInputTokens ?? 0) : 0);
  return {
    inputTokens,
    outputTokens,
    totalTokens,
    cacheReadInputTokens,
    cacheCreationInputTokens,
  };
}

function numberOptional(value: unknown, path: string, protocol?: Protocol): number | undefined {
  if (value === undefined || value === null) return undefined;
  if (typeof value !== "number" || !Number.isFinite(value)) throw invalidResponseField(path, "expected a finite number", protocol);
  return value;
}

function numberOrZero(value: unknown, path: string, protocol?: Protocol, fallback = 0): number {
  if (value === undefined || value === null) return fallback;
  if (typeof value !== "number" || !Number.isFinite(value)) throw invalidResponseField(path, "expected a finite number", protocol);
  return value;
}

export function encodeUsage(usage: InternalUsage): Record<string, unknown> {
  return {
    input_tokens: usage.inputTokens,
    output_tokens: usage.outputTokens,
    total_tokens: usage.totalTokens,
    ...(usage.cacheReadInputTokens === undefined ? {} : { cache_read_input_tokens: usage.cacheReadInputTokens }),
    ...(usage.cacheCreationInputTokens === undefined ? {} : { cache_creation_input_tokens: usage.cacheCreationInputTokens }),
  };
}

export function finishReasonFromExternal(value: unknown): FinishReason {
  if (value === null || value === undefined) return null;
  if (value === "stop" || value === "end_turn") return "stop";
  if (value === "length" || value === "max_tokens") return "length";
  if (value === "tool_calls" || value === "tool_use" || value === "function_call") return "tool_call";
  if (value === "stop_sequence") return "stop_sequence";
  if (value === "content_filter") return "content_filter";
  if (value === "error" || value === "failed") return "error";
  return "stop";
}

export function finishReasonToChat(value: FinishReason): string | null {
  if (value === "tool_call") return "tool_calls";
  if (value === "stop_sequence") return "stop";
  return value;
}

export function finishReasonToMessages(value: FinishReason): string | null {
  if (value === "tool_call") return "tool_use";
  if (value === "length") return "max_tokens";
  if (value === "stop") return "end_turn";
  return value;
}

export function finishReasonToResponses(value: FinishReason): string | null {
  if (value === "length") return "max_output_tokens";
  if (value === "tool_call") return "tool_calls";
  if (value === "stop_sequence") return "stop_sequence";
  return value;
}

export function validateRequestForTarget(request: InternalRequest, target: Protocol): void {
  if (request.previousResponseId !== undefined) {
    throw unsupportedField("previous_response_id", "server-side response state cannot be converted", undefined, target);
  }
  if (request.store === true) {
    throw unsupportedField("store", "server-side response storage cannot be converted", undefined, target);
  }
  if (request.background === true) {
    throw unsupportedField("background", "background execution cannot be converted", undefined, target);
  }
  if (request.n !== undefined && request.n !== 1) {
    throw unsupportedField("n", "only one generation result is supported", undefined, target);
  }
  if (request.topK !== undefined && target !== "messages") {
    throw unsupportedField("top_k", "the target protocol has no equivalent top-k parameter", undefined, target);
  }
  if ((request.presencePenalty !== undefined || request.frequencyPenalty !== undefined) && target !== "chat") {
    throw unsupportedField(
      request.presencePenalty !== undefined ? "presence_penalty" : "frequency_penalty",
      "the target protocol has no equivalent frequency/presence penalty",
      undefined,
      target,
    );
  }
  if (request.seed !== undefined && target !== "chat") {
    throw unsupportedField("seed", "the target protocol has no equivalent seed parameter", undefined, target);
  }
  for (const [index, tool] of (request.tools ?? []).entries()) {
    if (tool.type !== "function") throw unsupportedField(`tools[${index}].type`, "only function tools are supported", undefined, target);
  }
}

export function makeResponse(
  id: string,
  model: string,
  messages: InternalMessage[],
  finishReason: FinishReason,
  usage?: InternalUsage,
  extra: Partial<InternalResponse> = {},
): InternalResponse {
  return { id, model, messages, finishReason, usage, ...extra };
}

export function firstAssistantMessage(messages: InternalMessage[]): InternalMessage {
  const assistants = messages.filter((message) => message.role === "assistant");
  const first = assistants[0];
  if (first) {
    return {
      ...first,
      content: assistants.flatMap((message) => message.content),
    };
  }
  return { role: "assistant", content: [] };
}

export function mergeTextBlocks(blocks: ContentBlock[]): ContentBlock[] {
  const merged: ContentBlock[] = [];
  for (const block of blocks) {
    const previous = merged[merged.length - 1];
    if (block.type === "text" && previous?.type === "text") previous.text += block.text;
    else merged.push(block);
  }
  return merged;
}

export function mergeAdjacentMessages(messages: InternalMessage[]): InternalMessage[] {
  const merged: InternalMessage[] = [];
  for (const message of messages) {
    const previous = merged[merged.length - 1];
    if (previous && previous.role === message.role && (message.role === "assistant" || message.role === "tool")) {
      previous.content = previous.content.concat(message.content);
    } else {
      merged.push({ ...message, content: [...message.content] });
    }
  }
  return merged;
}
