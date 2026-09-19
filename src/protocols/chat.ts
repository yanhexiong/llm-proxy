import { invalidField, unsupportedField } from "./errors";
import {
  asRecord,
  contentText,
  encodeUsage,
  firstAssistantMessage,
  finishReasonFromExternal,
  finishReasonToChat,
  isRecord,
  normalizeContent,
  normalizeMessages,
  mergeAdjacentMessages,
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

export const CHAT_PROTOCOL = "chat" as const;

export function decodeChatRequest(value: unknown): InternalRequest {
  const body = asRecord(value, "$", "chat");
  const messages = normalizeMessages(body.messages, "messages", "chat");
  const tools = body.tools === undefined ? undefined : decodeChatTools(body.tools);
  const toolChoice = body.tool_choice === undefined ? undefined : decodeChatToolChoice(body.tool_choice);
  if (body.response_format !== undefined) validateResponseFormat(body.response_format);
  if (body.logprobs !== undefined || body.top_logprobs !== undefined) {
    throw unsupportedField("logprobs", "log probability output is not represented across protocols", "chat");
  }
  if (body.logit_bias !== undefined) {
    throw unsupportedField("logit_bias", "logit bias is not represented across protocols", "chat");
  }
  if (body.reasoning_effort !== undefined) {
    throw unsupportedField("reasoning_effort", "provider-native reasoning controls cannot be converted", "chat");
  }
  if (body.thinking !== undefined) {
    const thinking = asRecord(body.thinking, "thinking", "chat");
    const disabled = thinking.type === "disabled" || thinking.enabled === false;
    if (!disabled) throw unsupportedField("thinking", "provider-native thinking cannot be converted", "chat");
  }
  let includeUsage: boolean | undefined;
  if (body.stream_options !== undefined) {
    const streamOptions = asRecord(body.stream_options, "stream_options", "chat");
    includeUsage = optionalBoolean(streamOptions.include_usage, "stream_options.include_usage", "chat");
  }
  return {
    model: requiredString(body.model, "model", "chat"),
    messages,
    tools,
    toolChoice,
    temperature: optionalNumber(body.temperature, "temperature", "chat"),
    topP: optionalNumber(body.top_p, "top_p", "chat"),
    maxOutputTokens: optionalNumber(body.max_completion_tokens ?? body.max_tokens, "max_tokens", "chat"),
    stop: decodeStop(body.stop),
    presencePenalty: optionalNumber(body.presence_penalty, "presence_penalty", "chat"),
    frequencyPenalty: optionalNumber(body.frequency_penalty, "frequency_penalty", "chat"),
    seed: optionalNumber(body.seed, "seed", "chat"),
    stream: optionalBoolean(body.stream, "stream", "chat"),
    includeUsage,
    n: optionalNumber(body.n, "n", "chat"),
    user: optionalString(body.user, "user", "chat"),
  };
}

export function encodeChatRequest(request: InternalRequest, _options: ConversionOptions = {}): Record<string, unknown> {
  validateRequestForTarget(request, "chat");
  const messages: Record<string, unknown>[] = [];
  if (request.instructions && request.instructions.length > 0) {
    messages.push({ role: "system", content: encodeChatContentValue(request.instructions) });
  }
  for (const message of mergeAdjacentMessages(request.messages)) messages.push(...encodeChatMessage(message));
  const output: Record<string, unknown> = { model: request.model, messages };
  if (request.temperature !== undefined) output.temperature = request.temperature;
  if (request.topP !== undefined) output.top_p = request.topP;
  if (request.maxOutputTokens !== undefined) output.max_tokens = request.maxOutputTokens;
  if (request.stop !== undefined) output.stop = request.stop;
  if (request.presencePenalty !== undefined) output.presence_penalty = request.presencePenalty;
  if (request.frequencyPenalty !== undefined) output.frequency_penalty = request.frequencyPenalty;
  if (request.seed !== undefined) output.seed = request.seed;
  if (request.stream !== undefined) output.stream = request.stream;
  if (request.stream === true) output.stream_options = { include_usage: request.includeUsage !== false };
  else if (request.includeUsage !== undefined) output.stream_options = { include_usage: request.includeUsage };
  if (request.n !== undefined) output.n = request.n;
  if (request.user !== undefined) output.user = request.user;
  if (request.tools !== undefined) output.tools = request.tools.map(encodeChatTool);
  if (request.toolChoice !== undefined) output.tool_choice = encodeChatToolChoice(request.toolChoice);
  return output;
}

export function decodeChatResponse(value: unknown): InternalResponse {
  const body = asRecord(value, "$", "chat");
  if (!Array.isArray(body.choices) || body.choices.length === 0) {
    throw invalidField("choices", "expected at least one choice", "chat");
  }
  const choice = asRecord(body.choices[0], "choices[0]", "chat");
  const message = asRecord(choice.message, "choices[0].message", "chat");
  const normalized = normalizeMessages([message], "choices[0].message", "chat")[0];
  if (!normalized) throw invalidField("choices[0].message", "expected a message object", "chat");
  return {
    id: requiredString(body.id, "id", "chat"),
    model: requiredString(body.model, "model", "chat"),
    createdAt: body.created === undefined ? undefined : optionalNumber(body.created, "created", "chat"),
    messages: [normalized],
    finishReason: finishReasonFromExternal(choice.finish_reason),
    usage: body.usage === undefined ? undefined : parseUsage(body.usage, "usage", "chat"),
    status: choice.finish_reason === null || choice.finish_reason === undefined ? "in_progress" : "completed",
  };
}

export function encodeChatResponse(response: InternalResponse): Record<string, unknown> {
  const assistant = firstAssistantMessage(response.messages);
  const toolCalls = assistant.content.filter((block): block is Extract<ContentBlock, { type: "tool_use" }> => block.type === "tool_use");
  const textBlocks = assistant.content.filter((block): block is Extract<ContentBlock, { type: "text" }> => block.type === "text");
  const firstText = textBlocks[0];
  const message: Record<string, unknown> = {
    role: "assistant",
    content: textBlocks.length === 0 ? null : textBlocks.length === 1 ? firstText?.text ?? null : encodeChatContent(textBlocks),
  };
  if (toolCalls.length > 0) {
    message.tool_calls = toolCalls.map((tool, index) => ({
      id: tool.id,
      type: "function",
      index,
      function: { name: tool.name, arguments: JSON.stringify(tool.input ?? {}) },
    }));
  }
  const output: Record<string, unknown> = {
    id: response.id,
    object: "chat.completion",
    created: response.createdAt ?? Math.floor(Date.now() / 1000),
    model: response.model,
    choices: [
      {
        index: 0,
        message,
        finish_reason: finishReasonToChat(response.finishReason),
      },
    ],
  };
  if (response.usage) output.usage = encodeChatUsage(response.usage);
  return output;
}

function decodeChatTools(value: unknown): InternalTool[] {
  if (!Array.isArray(value)) throw invalidField("tools", "expected an array", "chat");
  return value.map((item, index) => {
    const tool = asRecord(item, `tools[${index}]`, "chat");
    if (tool.type !== "function") throw unsupportedField(`tools[${index}].type`, "only function tools are supported", "chat");
    const fn = asRecord(tool.function, `tools[${index}].function`, "chat");
    return {
      type: "function" as const,
      name: requiredString(fn.name, `tools[${index}].function.name`, "chat"),
      description: optionalString(fn.description, `tools[${index}].function.description`, "chat"),
      parameters: fn.parameters === undefined ? undefined : asRecord(fn.parameters, `tools[${index}].function.parameters`, "chat"),
      strict: optionalBoolean(fn.strict, `tools[${index}].function.strict`, "chat"),
    };
  });
}

function decodeChatToolChoice(value: unknown): ToolChoice {
  if (value === "auto" || value === "none" || value === "required") return { type: value };
  const choice = asRecord(value, "tool_choice", "chat");
  if (choice.type === "function") {
    const fn = asRecord(choice.function, "tool_choice.function", "chat");
    return { type: "function", name: requiredString(fn.name, "tool_choice.function.name", "chat") };
  }
  throw unsupportedField("tool_choice", "only auto, none, required, or a named function is supported", "chat");
}

function encodeChatTool(tool: InternalTool): Record<string, unknown> {
  return {
    type: "function",
    function: {
      name: tool.name,
      ...(tool.description === undefined ? {} : { description: tool.description }),
      parameters: tool.parameters ?? { type: "object", properties: {} },
      ...(tool.strict === undefined ? {} : { strict: tool.strict }),
    },
  };
}

function encodeChatToolChoice(choice: ToolChoice): unknown {
  if (choice.type === "auto" || choice.type === "none" || choice.type === "required") return choice.type;
  return { type: "function", function: { name: choice.name } };
}

function encodeChatMessage(message: InternalMessage): Record<string, unknown>[] {
  const results = message.content.filter((block): block is Extract<ContentBlock, { type: "tool_result" }> => block.type === "tool_result");
  if (message.role === "tool") {
    return results.map((result) => ({
      role: "tool",
      tool_call_id: result.toolUseId,
      content: contentText(result.content),
    }));
  }
  const toolCalls = message.content.filter((block): block is Extract<ContentBlock, { type: "tool_use" }> => block.type === "tool_use");
  const regular = message.content.filter((block): block is Exclude<ContentBlock, { type: "tool_use" | "tool_result" }> => block.type !== "tool_use" && block.type !== "tool_result");
  const firstRegular = regular[0];
  const encoded: Record<string, unknown> = {
    role: message.role,
    ...(message.name === undefined ? {} : { name: message.name }),
    content: regular.length === 0 ? null : regular.length === 1 && firstRegular?.type === "text" ? firstRegular.text : encodeChatContent(regular),
  };
  if (toolCalls.length > 0) {
    encoded.tool_calls = toolCalls.map((tool, index) => ({
      id: tool.id,
      type: "function",
      index,
      function: { name: tool.name, arguments: JSON.stringify(tool.input ?? {}) },
    }));
  }
  const output: Record<string, unknown>[] = [];
  if (regular.length > 0 || toolCalls.length > 0) output.push(encoded);
  output.push(
    ...results.map((result) => ({
      role: "tool",
      tool_call_id: result.toolUseId,
      content: contentText(result.content),
    })),
  );
  return output;
}

export function encodeChatContent(blocks: ContentBlock[]): unknown {
  return blocks.map((block) => {
    if (block.type === "text") return { type: "text", text: block.text };
    if (block.type === "image") {
      const url = block.source.type === "url" ? block.source.url : `data:${block.source.mediaType};base64,${block.source.data}`;
      return { type: "image_url", image_url: { url, ...(block.source.type === "url" && block.source.detail ? { detail: block.source.detail } : {}) } };
    }
    if (block.type === "tool_result") return { type: "text", text: contentText(block.content) };
    throw unsupportedField("messages[].content", "tool calls must be encoded at message level", "chat");
  });
}

function encodeChatContentValue(blocks: ContentBlock[]): unknown {
  const first = blocks[0];
  return blocks.length === 1 && first?.type === "text" ? first.text : encodeChatContent(blocks);
}

function decodeStop(value: unknown): string | string[] | undefined {
  if (value === undefined || value === null) return undefined;
  if (typeof value === "string") return value;
  if (Array.isArray(value)) return value.map((item, index) => requiredString(item, `stop[${index}]`, "chat"));
  throw invalidField("stop", "expected a string or array of strings", "chat");
}

function validateResponseFormat(value: unknown): void {
  if (value === "text") return;
  if (!isRecord(value)) throw invalidField("response_format", "expected an object", "chat");
  if (value.type !== "text") {
    throw unsupportedField("response_format", "JSON response formats are not represented across all protocols", "chat");
  }
}

function encodeChatUsage(usage: NonNullable<InternalResponse["usage"]>): Record<string, unknown> {
  return {
    prompt_tokens: usage.inputTokens,
    completion_tokens: usage.outputTokens,
    total_tokens: usage.totalTokens,
    ...(usage.cacheReadInputTokens === undefined ? {} : { prompt_tokens_details: { cached_tokens: usage.cacheReadInputTokens } }),
  };
}
