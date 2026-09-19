import { invalidField, invalidResponseField, unsupportedField } from "./errors";
import {
  asArray,
  asRecord,
  contentText,
  encodeUsage,
  firstAssistantMessage,
  finishReasonFromExternal,
  finishReasonToResponses,
  isRecord,
  normalizeContent,
  normalizeImageValue,
  mergeAdjacentMessages,
  normalizeRole,
  optionalBoolean,
  optionalNumber,
  optionalString,
  parseJsonText,
  parseUsage,
  requiredString,
  validateRequestForTarget,
} from "./common";
import type {
  ContentBlock,
  ConversionOptions,
  FinishReason,
  InternalMessage,
  InternalRequest,
  InternalResponse,
  InternalTool,
  ToolChoice,
} from "./types";

export const RESPONSES_PROTOCOL = "responses" as const;

export function decodeResponsesRequest(value: unknown): InternalRequest {
  const body = asRecord(value, "$", "responses");
  if (body.reasoning !== undefined) {
    const reasoning = asRecord(body.reasoning, "reasoning", "responses");
    if (reasoning.effort !== "none") throw unsupportedField("reasoning", "provider-native reasoning cannot be converted", "responses");
  }
  const input = decodeResponsesInput(body.input, "input");
  const instructions = body.instructions === undefined ? undefined : normalizeContent(body.instructions, "instructions", "responses");
  const tools = body.tools === undefined ? undefined : decodeResponsesTools(body.tools);
  const toolChoice = body.tool_choice === undefined ? undefined : decodeResponsesToolChoice(body.tool_choice);
  if (body.include !== undefined) {
    const include = asArray(body.include, "include", "responses");
    for (const [index, item] of include.entries()) {
      if (item !== "message.output_text.logprobs") {
        throw unsupportedField(`include[${index}]`, "provider-specific include fields are not converted", "responses");
      }
    }
  }
  return {
    model: requiredString(body.model, "model", "responses"),
    messages: input.messages,
    instructions,
    tools,
    toolChoice,
    temperature: optionalNumber(body.temperature, "temperature", "responses"),
    topP: optionalNumber(body.top_p, "top_p", "responses"),
    maxOutputTokens: optionalNumber(body.max_output_tokens, "max_output_tokens", "responses"),
    stop: decodeStop(body.stop),
    stream: optionalBoolean(body.stream, "stream", "responses"),
    previousResponseId: optionalString(body.previous_response_id, "previous_response_id", "responses"),
    store: optionalBoolean(body.store, "store", "responses"),
    background: optionalBoolean(body.background, "background", "responses"),
    n: optionalNumber(body.n, "n", "responses"),
    metadata: decodeMetadata(body.metadata),
  };
}

export function encodeResponsesRequest(request: InternalRequest, _options: ConversionOptions = {}): Record<string, unknown> {
  validateRequestForTarget(request, "responses");
  const output: Record<string, unknown> = {
    model: request.model,
    input: encodeResponsesInput(request.messages),
  };
  if (request.instructions !== undefined) {
    const text = contentText(request.instructions);
    if (request.instructions.some((block) => block.type !== "text")) {
      throw unsupportedField("instructions", "Responses instructions must be text", "responses");
    }
    output.instructions = text;
  }
  if (request.temperature !== undefined) output.temperature = request.temperature;
  if (request.topP !== undefined) output.top_p = request.topP;
  if (request.maxOutputTokens !== undefined) output.max_output_tokens = request.maxOutputTokens;
  if (request.stop !== undefined) output.stop = request.stop;
  if (request.stream !== undefined) output.stream = request.stream;
  if (request.tools !== undefined) output.tools = request.tools.map(encodeResponsesTool);
  if (request.toolChoice !== undefined) output.tool_choice = encodeResponsesToolChoice(request.toolChoice);
  if (request.store !== undefined && request.store === false) output.store = false;
  if (request.metadata !== undefined) output.metadata = request.metadata;
  return output;
}

export function decodeResponsesResponse(value: unknown): InternalResponse {
  const body = asRecord(value, "$", "responses");
  const output = body.output === undefined ? [] : asArray(body.output, "output", "responses");
  const messages: InternalMessage[] = [];
  for (const [index, itemValue] of output.entries()) {
    const item = asRecord(itemValue, `output[${index}]`, "responses");
    const type = requiredString(item.type, `output[${index}].type`, "responses");
    if (type === "message") {
      const role = normalizeRole(item.role ?? "assistant", `output[${index}].role`, "responses");
      if (role !== "assistant" && role !== "user" && role !== "system" && role !== "developer") {
        throw unsupportedField(`output[${index}].role`, "only assistant message output is supported", "responses");
      }
      const content = decodeResponsesOutputContent(item.content, `output[${index}].content`);
      messages.push({ role, content, id: optionalString(item.id, `output[${index}].id`, "responses") });
    } else if (type === "function_call") {
      messages.push({
        role: "assistant",
        content: [
          {
            type: "tool_use",
            id: requiredString(item.call_id ?? item.id, `output[${index}].call_id`, "responses"),
            name: requiredString(item.name, `output[${index}].name`, "responses"),
            input: parseJsonText(item.arguments ?? "{}", `output[${index}].arguments`, "responses"),
          },
        ],
      });
    } else if (type === "reasoning") {
      if (hasMeaningfulReasoning(item)) throw unsupportedField(`output[${index}]`, "provider-native reasoning output cannot be converted", "responses");
    } else {
      throw unsupportedField(`output[${index}].type`, `output item type ${JSON.stringify(type)} cannot be converted`, "responses");
    }
  }
  const status = decodeResponseStatus(body.status);
  const incompleteReason = decodeIncompleteReason(body.incomplete_details);
  let finishReason: FinishReason = status === "failed" ? "error" : status === "incomplete" ? incompleteReason === "content_filter" ? "content_filter" : "length" : status === "completed" ? "stop" : null;
  if ((finishReason === null || finishReason === "stop") && messages.some((message) => message.content.some((block) => block.type === "tool_use"))) finishReason = "tool_call";
  const error = body.error === undefined || body.error === null ? undefined : decodeResponseError(body.error);
  return {
    id: requiredString(body.id, "id", "responses"),
    model: requiredString(body.model, "model", "responses"),
    createdAt: body.created_at === undefined ? undefined : optionalNumber(body.created_at, "created_at", "responses"),
    messages,
    finishReason,
    usage: body.usage === undefined ? undefined : parseUsage(body.usage, "usage", "responses"),
    status,
    incompleteReason,
    error,
  };
}

export function encodeResponsesResponse(response: InternalResponse): Record<string, unknown> {
  const output: Record<string, unknown>[] = [];
  const outputText: string[] = [];
  let messageIndex = 0;
  for (const message of response.messages) {
    const toolBlocks = message.content.filter((block): block is Extract<ContentBlock, { type: "tool_use" }> => block.type === "tool_use");
    const textBlocks = message.content.filter((block): block is Extract<ContentBlock, { type: "text" }> => block.type === "text");
    if (textBlocks.length > 0) {
      const text = textBlocks.map((block) => block.text).join("");
      outputText.push(text);
      output.push({
        type: "message",
        id: message.id ?? `${response.id}-message-${messageIndex++}`,
        role: message.role,
        status: "completed",
        content: [{ type: "output_text", text, annotations: [] }],
      });
    }
    for (const tool of toolBlocks) {
      output.push({
        type: "function_call",
        id: tool.id,
        call_id: tool.id,
        name: tool.name,
        arguments: JSON.stringify(tool.input ?? {}),
        status: "completed",
      });
    }
  }
  const status = response.finishReason === "error" ? "failed"
    : response.finishReason === "length" || response.finishReason === "content_filter" ? "incomplete"
    : response.status ?? "completed";
  const result: Record<string, unknown> = {
    id: response.id,
    object: "response",
    created_at: response.createdAt ?? Math.floor(Date.now() / 1000),
    model: response.model,
    status,
    output,
    output_text: outputText.join(""),
  };
  if (status === "incomplete") {
    result.incomplete_details = { reason: response.incompleteReason ?? (response.finishReason === "content_filter" ? "content_filter" : "max_output_tokens") };
  }
  if (response.error) result.error = response.error;
  if (response.usage) result.usage = encodeResponsesUsage(response.usage);
  return result;
}

function decodeResponsesInput(value: unknown, path: string): { messages: InternalMessage[] } {
  if (typeof value === "string") return { messages: [{ role: "user", content: [{ type: "text", text: value }] }] };
  const items = asArray(value, path, "responses");
  const messages: InternalMessage[] = [];
  for (const [index, itemValue] of items.entries()) {
    const itemPath = `${path}[${index}]`;
    const item = asRecord(itemValue, itemPath, "responses");
    const type = typeof item.type === "string" ? item.type : item.role !== undefined ? "message" : requiredString(item.type, `${itemPath}.type`, "responses");
    if (type === "message") {
      const role = normalizeRole(item.role, `${itemPath}.role`, "responses");
      const content = normalizeContent(item.content ?? "", `${itemPath}.content`, "responses");
      const previous = messages[messages.length - 1];
      if (previous?.role === role && role === "assistant") previous.content.push(...content);
      else messages.push({ role, content, id: optionalString(item.id, `${itemPath}.id`, "responses") });
    } else if (type === "input_text" || type === "input_image") {
      const previous = messages[messages.length - 1];
      const block = normalizeContentBlockForResponses(item, itemPath);
      if (previous?.role === "user") previous.content.push(block);
      else messages.push({ role: "user", content: [block] });
    } else if (type === "function_call") {
      const toolUse = {
        type: "tool_use" as const,
        id: requiredString(item.call_id ?? item.id, `${itemPath}.call_id`, "responses"),
        name: requiredString(item.name, `${itemPath}.name`, "responses"),
        input: parseJsonText(item.arguments ?? "{}", `${itemPath}.arguments`, "responses"),
      };
      const previous = messages[messages.length - 1];
      if (previous?.role === "assistant") previous.content.push(toolUse);
      else messages.push({ role: "assistant", content: [toolUse] });
    } else if (type === "function_call_output") {
      const toolResult = {
        type: "tool_result" as const,
        toolUseId: requiredString(item.call_id, `${itemPath}.call_id`, "responses"),
        content: typeof item.output === "string" ? [{ type: "text" as const, text: item.output }] : normalizeContent(item.output ?? "", `${itemPath}.output`, "responses"),
      };
      const previous = messages[messages.length - 1];
      if (previous?.role === "tool") previous.content.push(toolResult);
      else messages.push({ role: "tool", content: [toolResult] });
    } else if (type === "item_reference") {
      throw unsupportedField(itemPath, "server-side item references cannot be converted", "responses");
    } else {
      throw unsupportedField(`${itemPath}.type`, `input item type ${JSON.stringify(type)} cannot be converted`, "responses");
    }
  }
  return { messages };
}

function normalizeContentBlockForResponses(item: Record<string, unknown>, path: string): ContentBlock {
  if (item.type === "input_text") return { type: "text", text: requiredString(item.text, `${path}.text`, "responses") };
  const raw = item.image_url;
  const url = typeof raw === "string" ? raw : isRecord(raw) ? requiredString(raw.url, `${path}.image_url.url`, "responses") : undefined;
  if (!url) throw invalidField(`${path}.image_url`, "expected an image URL", "responses");
  return { type: "image", source: normalizeImageValue(url, `${path}.image_url`, "responses") };
}

function decodeResponsesOutputContent(value: unknown, path: string): ContentBlock[] {
  if (value === undefined) return [];
  if (!Array.isArray(value)) throw invalidResponseField(path, "expected an array", "responses");
  return value.map((itemValue, index) => {
    const item = asRecord(itemValue, `${path}[${index}]`, "responses");
    if (item.type === "output_text") return { type: "text", text: requiredString(item.text, `${path}[${index}].text`, "responses") };
    if (item.type === "refusal") return { type: "text", text: requiredString(item.refusal, `${path}[${index}].refusal`, "responses") };
    if (item.type === "input_image") return normalizeContentBlockForResponses(item, `${path}[${index}]`);
    throw unsupportedField(`${path}[${index}].type`, `output content type ${JSON.stringify(item.type)} cannot be converted`, "responses");
  });
}

function decodeResponsesTools(value: unknown): InternalTool[] {
  if (!Array.isArray(value)) throw invalidField("tools", "expected an array", "responses");
  return value.map((itemValue, index) => {
    const item = asRecord(itemValue, `tools[${index}]`, "responses");
    if (item.type !== "function") throw unsupportedField(`tools[${index}].type`, "only function tools are supported", "responses");
    return {
      type: "function" as const,
      name: requiredString(item.name, `tools[${index}].name`, "responses"),
      description: optionalString(item.description, `tools[${index}].description`, "responses"),
      parameters: item.parameters === undefined ? undefined : asRecord(item.parameters, `tools[${index}].parameters`, "responses"),
      strict: optionalBoolean(item.strict, `tools[${index}].strict`, "responses"),
    };
  });
}

function decodeResponsesToolChoice(value: unknown): ToolChoice {
  if (value === "auto" || value === "none" || value === "required") return { type: value };
  const choice = asRecord(value, "tool_choice", "responses");
  if (choice.type === "function") return { type: "function", name: requiredString(choice.name, "tool_choice.name", "responses") };
  throw unsupportedField("tool_choice", "only auto, none, required, or a named function is supported", "responses");
}

function encodeResponsesInput(messages: InternalMessage[]): Record<string, unknown>[] {
  const items: Record<string, unknown>[] = [];
  for (const message of mergeAdjacentMessages(messages)) {
    const toolResults = message.content.filter((block): block is Extract<ContentBlock, { type: "tool_result" }> => block.type === "tool_result");
    const toolUses = message.content.filter((block): block is Extract<ContentBlock, { type: "tool_use" }> => block.type === "tool_use");
    const regular = message.content.filter((block) => block.type !== "tool_result" && block.type !== "tool_use");
    if (regular.length > 0) {
      items.push({
        type: "message",
        role: message.role,
        ...(message.id === undefined ? {} : { id: message.id }),
        content: regular.map((block) => encodeResponsesContent(block, message.role)),
      });
    }
    for (const tool of toolUses) {
      items.push({ type: "function_call", id: tool.id, call_id: tool.id, name: tool.name, arguments: JSON.stringify(tool.input ?? {}) });
    }
    for (const result of toolResults) {
      items.push({ type: "function_call_output", call_id: result.toolUseId, output: contentText(result.content) });
    }
  }
  return items;
}

function encodeResponsesContent(block: ContentBlock, role: InternalMessage["role"]): Record<string, unknown> {
  if (block.type === "text") return { type: role === "assistant" ? "output_text" : "input_text", text: block.text };
  if (block.type === "image") {
    const url = block.source.type === "url" ? block.source.url : `data:${block.source.mediaType};base64,${block.source.data}`;
    return { type: "input_image", image_url: url, ...(block.source.type === "url" && block.source.detail ? { detail: block.source.detail } : {}) };
  }
  throw unsupportedField("input[].content", "tool blocks must be separate input items", "responses");
}

function encodeResponsesTool(tool: InternalTool): Record<string, unknown> {
  return {
    type: "function",
    name: tool.name,
    ...(tool.description === undefined ? {} : { description: tool.description }),
    parameters: tool.parameters ?? { type: "object", properties: {} },
    ...(tool.strict === undefined ? {} : { strict: tool.strict }),
  };
}

function encodeResponsesToolChoice(choice: ToolChoice): unknown {
  if (choice.type === "auto" || choice.type === "none" || choice.type === "required") return choice.type;
  return { type: "function", name: choice.name };
}

function decodeStop(value: unknown): string | string[] | undefined {
  if (value === undefined || value === null) return undefined;
  if (typeof value === "string") return value;
  if (Array.isArray(value)) return value.map((item, index) => requiredString(item, `stop[${index}]`, "responses"));
  throw invalidField("stop", "expected a string or array of strings", "responses");
}

function decodeMetadata(value: unknown): Record<string, string> | undefined {
  if (value === undefined || value === null) return undefined;
  const metadata = asRecord(value, "metadata", "responses");
  const output: Record<string, string> = {};
  for (const [key, item] of Object.entries(metadata)) {
    if (typeof item !== "string") throw invalidField(`metadata.${key}`, "metadata values must be strings", "responses");
    output[key] = item;
  }
  return output;
}

function encodeResponsesUsage(usage: NonNullable<InternalResponse["usage"]>): Record<string, unknown> {
  return {
    input_tokens: usage.inputTokens,
    output_tokens: usage.outputTokens,
    total_tokens: usage.totalTokens,
    ...(usage.cacheReadInputTokens === undefined ? {} : { input_tokens_details: { cached_tokens: usage.cacheReadInputTokens } }),
  };
}

function decodeResponseStatus(value: unknown): InternalResponse["status"] {
  if (value === undefined || value === null) return "completed";
  if (value === "in_progress" || value === "completed" || value === "failed" || value === "incomplete") return value;
  throw invalidResponseField("status", `unknown response status ${JSON.stringify(value)}`, "responses");
}

function decodeIncompleteReason(value: unknown): InternalResponse["incompleteReason"] {
  if (value === undefined || value === null) return undefined;
  const details = asRecord(value, "incomplete_details", "responses");
  if (details.reason === "max_output_tokens" || details.reason === "content_filter" || details.reason === "other") return details.reason;
  throw invalidResponseField("incomplete_details.reason", "unknown incomplete reason", "responses");
}

function decodeResponseError(value: unknown): NonNullable<InternalResponse["error"]> {
  const error = asRecord(value, "error", "responses");
  return {
    message: requiredString(error.message, "error.message", "responses"),
    type: optionalString(error.type, "error.type", "responses"),
    code: optionalString(error.code, "error.code", "responses"),
  };
}

function hasMeaningfulReasoning(value: Record<string, unknown>): boolean {
  return [value.content, value.summary, value.encrypted_content, value.signature, value.thinking].some(hasMeaningfulValue);
}

function hasMeaningfulValue(value: unknown): boolean {
  if (value === undefined || value === null) return false;
  if (typeof value === "string") return value.length > 0;
  if (Array.isArray(value)) return value.some(hasMeaningfulValue);
  if (isRecord(value)) return [value.text, value.thinking, value.summary_text, value.content, value.summary, value.encrypted_content, value.signature].some(hasMeaningfulValue);
  return true;
}
