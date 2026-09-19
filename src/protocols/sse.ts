import { ProtocolConversionError, invalidResponseField } from "./errors";
import {
  asRecord,
  contentText,
  finishReasonFromExternal,
  finishReasonToChat,
  finishReasonToMessages,
  finishReasonToResponses,
  isRecord,
  parseJsonText,
  parseUsage,
  requiredString,
} from "./common";
import { decodeResponsesResponse } from "./responses";
import { isThinkingBlock, stripThinkingResponse } from "./thinking-compat";
import type { FinishReason, InternalUsage, Protocol, SseEvent, StreamEvent } from "./types";

/** Incremental SSE parser. TextDecoder keeps a UTF-8 code point split across network chunks intact. */
export class SseParser {
  private readonly decoder = new TextDecoder();
  private text = "";
  private line = "";
  private eventName = "";
  private dataLines: string[] = [];
  private eventId: string | undefined;
  private retry: number | undefined;
  private lastEventId: string | undefined;
  private firstChunk = true;

  push(chunk: Uint8Array | ArrayBuffer | string): SseEvent[] {
    let text: string;
    if (typeof chunk === "string") text = chunk;
    else text = this.decoder.decode(chunk instanceof ArrayBuffer ? new Uint8Array(chunk) : chunk, { stream: true });
    if (this.firstChunk) {
      this.firstChunk = false;
      if (text.charCodeAt(0) === 0xfeff) text = text.slice(1);
    }
    this.text += text;
    return this.consumeLines(false);
  }

  finish(): SseEvent[] {
    this.text += this.decoder.decode();
    const events = this.consumeLines(true);
    if (this.line.length > 0) {
      this.processLine(this.line);
      this.line = "";
    }
    const final = this.dispatch();
    if (final) events.push(final);
    return events;
  }

  private consumeLines(flush: boolean): SseEvent[] {
    this.line += this.text;
    this.text = "";
    const events: SseEvent[] = [];
    let start = 0;
    for (let index = 0; index < this.line.length; index += 1) {
      const character = this.line[index];
      if (character !== "\n" && character !== "\r") continue;
      if (character === "\r" && index === this.line.length - 1 && !flush) {
        this.text = this.line.slice(start);
        this.line = "";
        return events;
      }
      const line = this.line.slice(start, index);
      this.processLine(line);
      if (character === "\r" && this.line[index + 1] === "\n") index += 1;
      if (this.dataLines.length > 0 && line.length === 0) {
        // processLine already dispatched on a blank line; this branch is kept
        // deliberately empty to document the event-frame boundary.
      }
      const dispatched = this.takeDispatched();
      if (dispatched) events.push(dispatched);
      start = index + 1;
    }
    this.line = this.line.slice(start);
    return events;
  }

  private pendingDispatch: SseEvent | undefined;

  private processLine(line: string): void {
    if (line.length === 0) {
      this.pendingDispatch = this.dispatch();
      return;
    }
    if (line.startsWith(":")) return;
    const separator = line.indexOf(":");
    const field = separator === -1 ? line : line.slice(0, separator);
    let value = separator === -1 ? "" : line.slice(separator + 1);
    if (value.startsWith(" ")) value = value.slice(1);
    if (field === "event") this.eventName = value;
    else if (field === "data") this.dataLines.push(value);
    else if (field === "id" && !value.includes("\u0000")) {
      this.eventId = value;
      this.lastEventId = value;
    } else if (field === "retry" && /^\d+$/.test(value)) this.retry = Number(value);
  }

  private takeDispatched(): SseEvent | undefined {
    const event = this.pendingDispatch;
    this.pendingDispatch = undefined;
    return event;
  }

  private dispatch(): SseEvent | undefined {
    if (this.dataLines.length === 0 && !this.eventName && this.eventId === undefined && this.retry === undefined) return undefined;
    const event: SseEvent = {
      ...(this.eventName ? { event: this.eventName } : {}),
      data: this.dataLines.join("\n"),
      ...(this.eventId === undefined ? (this.lastEventId === undefined ? {} : { id: this.lastEventId }) : { id: this.eventId }),
      ...(this.retry === undefined ? {} : { retry: this.retry }),
    };
    this.eventName = "";
    this.dataLines = [];
    this.eventId = undefined;
    this.retry = undefined;
    return event;
  }
}

export function parseSseChunked(chunks: Iterable<Uint8Array | string>): SseEvent[] {
  const parser = new SseParser();
  const events: SseEvent[] = [];
  for (const chunk of chunks) events.push(...parser.push(chunk));
  events.push(...parser.finish());
  return events;
}

export async function* parseSseStream(
  stream: AsyncIterable<Uint8Array | string> | ReadableStream<Uint8Array | string>,
): AsyncGenerator<SseEvent> {
  const parser = new SseParser();
  if (isReadableStream(stream)) {
    const reader = stream.getReader();
    try {
      while (true) {
        const result = await reader.read();
        if (result.done) break;
        for (const event of parser.push(result.value)) yield event;
      }
    } finally {
      reader.releaseLock();
    }
  } else {
    for await (const chunk of stream) {
      for (const event of parser.push(chunk)) yield event;
    }
  }
  for (const event of parser.finish()) yield event;
}

export const parseSSE = parseSseStream;

export function formatSse(event: SseEvent): string {
  const lines: string[] = [];
  if (event.event !== undefined) lines.push(`event: ${event.event}`);
  if (event.id !== undefined) lines.push(`id: ${event.id}`);
  if (event.retry !== undefined) lines.push(`retry: ${event.retry}`);
  const dataLines = event.data.split("\n");
  for (const line of dataLines) lines.push(`data: ${line}`);
  return `${lines.join("\n")}\n\n`;
}

export const encodeSse = formatSse;

interface StreamDecodeState {
  id?: string;
  model?: string;
  started: boolean;
  finishSeen: boolean;
  finishReason: FinishReason;
  stopSequence?: string | null;
  usage?: InternalUsage;
  ended: boolean;
  blocks: Map<number, { kind: "text" | "tool"; id?: string; name?: string }>;
  tools: Map<number, { id: string; name: string; started: boolean; pendingArguments: string }>;
  textBuffers: Map<number, string>;
  textEnded: Set<number>;
  toolBuffers: Map<number, string>;
  toolEnded: Set<number>;
}

function newDecodeState(): StreamDecodeState {
  return {
    finishReason: null,
    finishSeen: false,
    ended: false,
    started: false,
    blocks: new Map(),
    tools: new Map(),
    textBuffers: new Map(),
    textEnded: new Set(),
    toolBuffers: new Map(),
    toolEnded: new Set(),
  };
}

interface ThinkingSanitizeState {
  messageIndexes: Set<number>;
  responseIndexes: Set<number>;
}

function newThinkingSanitizeState(): ThinkingSanitizeState {
  return { messageIndexes: new Set(), responseIndexes: new Set() };
}

/**
 * Remove only known provider-thinking frames before the normal decoder sees
 * them. Unknown frames still reach the strict decoder and can fail loudly.
 */
function sanitizeThinkingFrame(
  protocol: Protocol,
  frame: SseEvent,
  state: ThinkingSanitizeState,
): SseEvent | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(frame.data || "{}");
  } catch {
    // Keep malformed data on the normal path so it remains a stream error.
    return frame;
  }
  if (!isRecord(parsed)) return frame;
  const type = typeof parsed.type === "string" ? parsed.type : frame.event;
  if (isStreamErrorFrame(type, parsed)) return frame;

  if (protocol === "messages") return sanitizeMessagesThinking(frame, parsed, type, state);
  if (protocol === "chat") return sanitizeChatThinking(frame, parsed);
  return sanitizeResponsesThinking(frame, parsed, type, state);
}

function sanitizeMessagesThinking(
  frame: SseEvent,
  payload: Record<string, unknown>,
  type: string | undefined,
  state: ThinkingSanitizeState,
): SseEvent | null {
  if (type === "content_block_start") {
    const block = isRecord(payload.content_block) ? payload.content_block : undefined;
    if (isThinkingBlock(block)) {
      const index = nonNegativeIndex(payload.index);
      if (index !== undefined) state.messageIndexes.add(index);
      return null;
    }
  }
  if (type === "content_block_delta") {
    const index = nonNegativeIndex(payload.index);
    if (index !== undefined && state.messageIndexes.has(index)) return null;
    const delta = isRecord(payload.delta) ? payload.delta : undefined;
    const deltaType = typeof delta?.type === "string" ? delta.type : undefined;
    if (deltaType === "thinking_delta" || deltaType === "signature_delta") return null;
  }
  if (type === "content_block_stop") {
    const index = nonNegativeIndex(payload.index);
    if (index !== undefined && state.messageIndexes.delete(index)) return null;
  }
  if (type === "thinking_start" || type === "thinking_delta" || type === "thinking_end" || type === "signature_delta") return null;
  return frame;
}

function sanitizeChatThinking(frame: SseEvent, payload: Record<string, unknown>): SseEvent {
  const nextPayload = { ...payload };
  let changed = false;
  if (nextPayload.error === null) {
    delete nextPayload.error;
    changed = true;
  }
  if (!Array.isArray(nextPayload.choices)) {
    return changed ? { ...frame, data: JSON.stringify(nextPayload) } : frame;
  }
  const choices = nextPayload.choices.map((choice) => {
    if (!isRecord(choice) || !isRecord(choice.delta)) return choice;
    const delta = { ...choice.delta };
    for (const field of ["reasoning_content", "thinking", "reasoning", "reasoning_details", "signature"]) {
      if (field in delta) {
        delete delta[field];
        changed = true;
      }
    }
    return changed ? { ...choice, delta } : choice;
  });
  return changed ? { ...frame, data: JSON.stringify({ ...nextPayload, choices }) } : frame;
}

function sanitizeResponsesThinking(
  frame: SseEvent,
  payload: Record<string, unknown>,
  type: string | undefined,
  state: ThinkingSanitizeState,
): SseEvent | null {
  if (typeof type === "string" && type.startsWith("response.reasoning_")) return null;
  if (type === "response.output_item.added") {
    const item = isRecord(payload.item) ? payload.item : undefined;
    if (isThinkingBlock(item)) {
      const index = nonNegativeIndex(payload.output_index);
      if (index !== undefined) state.responseIndexes.add(index);
      return null;
    }
  }
  if (type === "response.output_item.done") {
    const item = isRecord(payload.item) ? payload.item : undefined;
    const index = nonNegativeIndex(payload.output_index);
    if (isThinkingBlock(item) || (index !== undefined && state.responseIndexes.has(index))) {
      if (index !== undefined) state.responseIndexes.delete(index);
      return null;
    }
  }
  if (type === "response.content_part.added") {
    const part = isRecord(payload.part) ? payload.part : undefined;
    if (isThinkingBlock(part) || (typeof part?.type === "string" && part.type.startsWith("reasoning"))) return null;
  }
  const outputIndex = nonNegativeIndex(payload.output_index);
  if (outputIndex !== undefined && state.responseIndexes.has(outputIndex) &&
    (type === "response.content_part.done" || type === "response.output_text.delta" || type === "response.output_text.done")) return null;
  if (type === "response.completed" || type === "response.incomplete" || type === "response.failed") {
    const terminal = isRecord(payload.response) ? payload.response : payload;
    const stripped = stripThinkingResponse("responses", terminal);
    const next = terminal === payload ? stripped : { ...payload, response: stripped };
    return { ...frame, data: JSON.stringify(next) };
  }
  return frame;
}

function isStreamErrorFrame(type: string | undefined, payload: Record<string, unknown>): boolean {
  return type === "error" || type === "response.error" || type === "response.failed" ||
    (payload.error !== undefined && payload.error !== null);
}

function nonNegativeIndex(value: unknown): number | undefined {
  return typeof value === "number" && Number.isInteger(value) && value >= 0 ? value : undefined;
}

/** Convert one source SSE frame to one or more protocol-neutral stream events. */
export function decodeProtocolSseEvent(protocol: Protocol, event: SseEvent, state = newDecodeState()): StreamEvent[] {
  if (event.data === "[DONE]") {
    if (state.ended) return [];
    state.ended = true;
    return [{ type: "message_end", finishReason: state.finishReason, usage: state.usage, stopSequence: state.stopSequence }];
  }
  let data: unknown;
  try {
    data = JSON.parse(event.data || "{}");
  } catch (error) {
    throw new ProtocolConversionError("stream data: expected valid JSON", {
      code: "stream_error",
      path: "stream.data",
      protocol,
      cause: error,
    });
  }
  const payload = isRecord(data) ? data : {};
  if (protocol === "messages") return decodeMessagesStream(payload, event.event, state);
  if (protocol === "chat") return decodeChatStream(payload, state);
  return decodeResponsesStream(payload, event.event, state);
}

export const decodeStreamEvent = decodeProtocolSseEvent;

function decodeMessagesStream(payload: Record<string, unknown>, eventName: string | undefined, state: StreamDecodeState): StreamEvent[] {
  const type = typeof payload.type === "string" ? payload.type : eventName;
  if (typeof type === "string" && (type.includes("thinking") || type.includes("reasoning"))) {
    if (hasMeaningfulReasoningPayload(payload)) throw new ProtocolConversionError("stream reasoning content cannot be converted", { code: "unsupported_content", path: "stream.type", protocol: "messages" });
    return [];
  }
  if (type === "ping") return [{ type: "ping" }];
  if (type === "message_start") {
    const message = isRecord(payload.message) ? payload.message : payload;
    state.id = typeof message.id === "string" ? message.id : state.id;
    state.model = typeof message.model === "string" ? message.model : state.model;
    const usage = message.usage === undefined || message.usage === null ? undefined : parseUsage(message.usage, "message.usage", "messages");
    if (usage) state.usage = usage;
    if (state.started) return usage ? [{ type: "usage", usage }] : [];
    state.started = true;
    return [{ type: "message_start", id: state.id ?? "", model: state.model, role: "assistant", usage }];
  }
  if (type === "content_block_start") {
    const index = numberIndex(payload.index);
    const block = isRecord(payload.content_block) ? payload.content_block : {};
    if (block.type === "text") {
      state.blocks.set(index, { kind: "text" });
      return [{ type: "text_start", outputIndex: 0, contentIndex: index }];
    }
    if (block.type === "tool_use") {
      const id = requiredString(block.id, `content_block_start[${index}].content_block.id`, "messages");
      const name = requiredString(block.name, `content_block_start[${index}].content_block.name`, "messages");
      state.blocks.set(index, { kind: "tool", id, name });
      return [{ type: "tool_start", id, name, input: block.input, outputIndex: 0, contentIndex: index }];
    }
    if (block.type === "thinking" || block.type === "redacted_thinking" || block.type === "reasoning") {
      if (hasMeaningfulReasoningPayload(block)) throw new ProtocolConversionError("stream reasoning content cannot be converted", { code: "unsupported_content", path: `content_block_start[${index}].content_block.type`, protocol: "messages" });
      return [];
    }
    return [{ type: "raw", protocol: "messages", event: "content_block_start", data: payload }];
  }
  if (type === "content_block_delta") {
    const index = numberIndex(payload.index);
    const delta = isRecord(payload.delta) ? payload.delta : {};
    const block = state.blocks.get(index);
    if (delta.type === "text_delta") return [{ type: "text_delta", text: requiredString(delta.text, `content_block_delta[${index}].delta.text`, "messages"), outputIndex: 0, contentIndex: index }];
    if (delta.type === "input_json_delta") {
      if (!block || block.kind !== "tool" || !block.id) throw invalidResponseField(`content_block_delta[${index}]`, "tool block was not started", "messages");
      return [{ type: "tool_delta", id: block.id, argumentsDelta: requiredString(delta.partial_json, `content_block_delta[${index}].delta.partial_json`, "messages"), outputIndex: 0, contentIndex: index }];
    }
    return [{ type: "raw", protocol: "messages", event: "content_block_delta", data: payload }];
  }
  if (type === "content_block_stop") {
    const index = numberIndex(payload.index);
    const block = state.blocks.get(index);
    if (block?.kind === "text") return [{ type: "text_end", outputIndex: 0, contentIndex: index }];
    if (block?.kind === "tool" && block.id) return [{ type: "tool_end", id: block.id, outputIndex: 0, contentIndex: index }];
    return [];
  }
  if (type === "message_delta") {
    const delta = isRecord(payload.delta) ? payload.delta : {};
    state.finishReason = finishReasonFromExternal(delta.stop_reason);
    state.finishSeen = true;
    state.stopSequence = typeof delta.stop_sequence === "string" ? delta.stop_sequence : null;
    const usage = payload.usage === undefined || payload.usage === null ? undefined : parsePartialUsage(payload.usage, state.usage, "message_delta.usage", "messages");
    if (usage) state.usage = usage;
    return usage ? [{ type: "usage", usage }] : [];
  }
  if (type === "message_stop") {
    if (state.ended) return [];
    state.ended = true;
    return [{ type: "message_end", finishReason: state.finishReason, usage: state.usage, stopSequence: state.stopSequence }];
  }
  if (type === "error") return [{ type: "error", error: decodeStreamError(payload.error ?? payload) }];
  return [{ type: "raw", protocol: "messages", event: type ?? "", data: payload }];
}

function decodeChatStream(payload: Record<string, unknown>, state: StreamDecodeState): StreamEvent[] {
  if (payload.error !== undefined && payload.error !== null) return [{ type: "error", error: decodeStreamError(payload.error) }];
  state.id = typeof payload.id === "string" ? payload.id : state.id;
  state.model = typeof payload.model === "string" ? payload.model : state.model;
  const choices = Array.isArray(payload.choices) ? payload.choices : [];
  const choice = choices.length > 0 && isRecord(choices[0]) ? choices[0] : undefined;
  const delta = choice && isRecord(choice.delta) ? choice.delta : {};
  if (hasMeaningfulValue(delta.reasoning_content) || hasMeaningfulValue(delta.thinking) || hasMeaningfulValue(delta.reasoning)) {
    throw new ProtocolConversionError("stream reasoning content cannot be converted", { code: "unsupported_content", path: "choices[0].delta.reasoning_content", protocol: "chat" });
  }
  const events: StreamEvent[] = [];
  if (typeof delta.role === "string" && !state.id) state.id = typeof payload.id === "string" ? payload.id : "";
  if ((typeof delta.role === "string" || (!state.ended && !state.blocks.size && state.id)) && !state.started) {
    // Chat has no explicit start event. Emit it once, keyed by response id.
    if (!state.blocks.has(-1)) {
      state.blocks.set(-1, { kind: "text" });
      state.started = true;
      events.push({ type: "message_start", id: state.id ?? "", model: state.model, role: "assistant" });
    }
  }
  if (typeof delta.content === "string" && delta.content.length > 0) events.push({ type: "text_delta", text: delta.content, outputIndex: 0, contentIndex: 0, itemId: state.id });
  if (Array.isArray(delta.tool_calls)) {
    for (const [arrayIndex, callValue] of delta.tool_calls.entries()) {
      const call = isRecord(callValue) ? callValue : {};
      const functionValue = isRecord(call.function) ? call.function : {};
      const callIndex = typeof call.index === "number" && Number.isInteger(call.index) && call.index >= 0 ? call.index : arrayIndex;
      const existing = state.tools.get(callIndex);
      const id = typeof call.id === "string" ? call.id : existing?.id;
      const name = typeof functionValue.name === "string" ? functionValue.name : existing?.name;
      if (!id) throw invalidResponseField(`choices[0].delta.tool_calls[${arrayIndex}].id`, "tool call id was not provided before arguments", "chat");
      if (!existing) {
        const entry = { id, name: name ?? "", started: Boolean(name), pendingArguments: "" };
        state.tools.set(callIndex, entry);
        if (entry.started) events.push({ type: "tool_start", id, name: entry.name, outputIndex: callIndex, contentIndex: callIndex });
      } else if (name && existing.name !== name) {
        existing.name = name;
        if (!existing.started) {
          existing.started = true;
          events.push({ type: "tool_start", id, name, outputIndex: callIndex, contentIndex: callIndex });
          if (existing.pendingArguments) {
            events.push({ type: "tool_delta", id, argumentsDelta: existing.pendingArguments, outputIndex: callIndex, contentIndex: callIndex });
            existing.pendingArguments = "";
          }
        } else events.push({ type: "tool_delta", id, argumentsDelta: "", nameDelta: name, outputIndex: callIndex, contentIndex: callIndex });
      }
      const argumentsDelta = typeof functionValue.arguments === "string" ? functionValue.arguments : "";
      if (argumentsDelta) {
        if (existing?.started || state.tools.get(callIndex)?.started) events.push({ type: "tool_delta", id, argumentsDelta, outputIndex: callIndex, contentIndex: callIndex });
        else {
          const pending = state.tools.get(callIndex);
          if (pending) pending.pendingArguments += argumentsDelta;
        }
      }
    }
  }
  const finish = choice?.finish_reason;
  if (finish !== undefined && finish !== null) {
    state.finishReason = finishReasonFromExternal(finish);
    state.finishSeen = true;
    const usage = payload.usage === undefined || payload.usage === null ? state.usage : parsePartialUsage(payload.usage, state.usage, "usage", "chat");
    if (usage) state.usage = usage;
  } else if (payload.usage !== undefined && payload.usage !== null) {
    state.usage = parsePartialUsage(payload.usage, state.usage, "usage", "chat");
  }
  return events;
}

function decodeResponsesStream(payload: Record<string, unknown>, eventName: string | undefined, state: StreamDecodeState): StreamEvent[] {
  const type = typeof payload.type === "string" ? payload.type : eventName;
  if (typeof type === "string" && type.includes("reasoning")) {
    if (hasMeaningfulReasoningPayload(payload)) throw new ProtocolConversionError("stream reasoning content cannot be converted", { code: "unsupported_content", path: "stream.type", protocol: "responses" });
    return [];
  }
  const events: StreamEvent[] = [];
  if (type === "response.created" || type === "response.in_progress") {
    const response = isRecord(payload.response) ? payload.response : {};
    state.id = typeof response.id === "string" ? response.id : state.id;
    state.model = typeof response.model === "string" ? response.model : state.model;
    if (!state.started) {
      state.started = true;
      events.push({ type: "message_start", id: state.id ?? "", model: state.model, role: "assistant" });
    }
  } else if (type === "response.output_item.added") {
    const item = isRecord(payload.item) ? payload.item : {};
    const outputIndex = typeof payload.output_index === "number" ? payload.output_index : 0;
    if (item.type === "message") {
      const itemId = typeof item.id === "string" ? item.id : undefined;
      state.blocks.set(outputIndex, { kind: "text", id: itemId });
    } else if (item.type === "function_call") {
      const id = requiredString(item.call_id ?? item.id, `output_item[${outputIndex}].call_id`, "responses");
      const name = requiredString(item.name, `output_item[${outputIndex}].name`, "responses");
      state.blocks.set(outputIndex, { kind: "tool", id, name });
      events.push({ type: "tool_start", id, name, outputIndex, contentIndex: 0, itemId: typeof item.id === "string" ? item.id : undefined });
    } else if (item.type === "reasoning") {
      if (hasMeaningfulReasoningPayload(item)) throw new ProtocolConversionError("stream reasoning content cannot be converted", { code: "unsupported_content", path: `output_item[${outputIndex}].type`, protocol: "responses" });
    } else if (item.type !== undefined) {
      throw new ProtocolConversionError(`output item type ${JSON.stringify(item.type)} cannot be converted`, { code: "unsupported_content", path: `output_item[${outputIndex}].type`, protocol: "responses" });
    }
  } else if (type === "response.content_part.added") {
    const part = isRecord(payload.part) ? payload.part : {};
    if (part.type === "output_text") {
      const outputIndex = typeof payload.output_index === "number" ? payload.output_index : 0;
      state.blocks.set(outputIndex, { kind: "text", id: typeof payload.item_id === "string" ? payload.item_id : undefined });
      events.push({ type: "text_start", outputIndex, contentIndex: typeof payload.content_index === "number" ? payload.content_index : 0, itemId: typeof payload.item_id === "string" ? payload.item_id : undefined });
    }
  } else if (type === "response.output_text.delta") {
    const text = requiredString(payload.delta, "delta", "responses");
    const outputIndex = numberOr(payload.output_index) ?? 0;
    state.textBuffers.set(outputIndex, `${state.textBuffers.get(outputIndex) ?? ""}${text}`);
    events.push({ type: "text_delta", text, outputIndex, contentIndex: numberOr(payload.content_index), itemId: stringOrUndefined(payload.item_id) });
  } else if (type === "response.output_text.done") {
    const outputIndex = numberOr(payload.output_index) ?? 0;
    const finalText = typeof payload.text === "string" ? payload.text : undefined;
    const previousText = state.textBuffers.get(outputIndex) ?? "";
    if (finalText !== undefined && finalText !== previousText) {
      const suffix = finalText.startsWith(previousText) ? finalText.slice(previousText.length) : finalText;
      if (suffix) events.push({ type: "text_delta", text: suffix, outputIndex, contentIndex: numberOr(payload.content_index), itemId: stringOrUndefined(payload.item_id) });
      state.textBuffers.set(outputIndex, finalText);
    }
    state.textEnded.add(outputIndex);
    events.push({ type: "text_end", text: finalText, outputIndex, contentIndex: numberOr(payload.content_index), itemId: stringOrUndefined(payload.item_id) });
  } else if (type === "response.function_call_arguments.delta") {
    const outputIndex = numberOr(payload.output_index);
    const block = state.blocks.get(outputIndex ?? 0);
    const id = stringOrUndefined(payload.call_id) ?? block?.id;
    if (!id) throw invalidResponseField("call_id", "function call id was not provided", "responses");
    const argumentsDelta = requiredString(payload.delta, "delta", "responses");
    const key = outputIndex ?? 0;
    state.toolBuffers.set(key, `${state.toolBuffers.get(key) ?? ""}${argumentsDelta}`);
    events.push({ type: "tool_delta", id, argumentsDelta, outputIndex, itemId: stringOrUndefined(payload.item_id) });
  } else if (type === "response.function_call_arguments.done") {
    const outputIndex = numberOr(payload.output_index);
    const block = state.blocks.get(outputIndex ?? 0);
    const id = stringOrUndefined(payload.call_id) ?? block?.id;
    if (id) {
      const argumentsText = typeof payload.arguments === "string" ? payload.arguments : "{}";
      state.toolBuffers.set(outputIndex ?? 0, argumentsText);
      state.toolEnded.add(outputIndex ?? 0);
      events.push({ type: "tool_end", id, input: parseJsonText(argumentsText, "arguments", "responses"), outputIndex, itemId: stringOrUndefined(payload.item_id) });
    }
  } else if (type === "response.output_item.done") {
    const item = isRecord(payload.item) ? payload.item : {};
    if (item.type === "reasoning") {
      if (hasMeaningfulReasoningPayload(item)) throw new ProtocolConversionError("stream reasoning content cannot be converted", { code: "unsupported_content", path: "output_item.type", protocol: "responses" });
      return events;
    }
    if (item.type === "function_call") {
      const id = stringOrUndefined(item.call_id) ?? stringOrUndefined(item.id);
      if (id) {
        const outputIndex = numberOr(payload.output_index) ?? 0;
        const argumentsText = typeof item.arguments === "string" ? item.arguments : "{}";
        state.toolBuffers.set(outputIndex, argumentsText);
        if (!state.toolEnded.has(outputIndex)) {
          state.toolEnded.add(outputIndex);
          events.push({ type: "tool_end", id, input: parseJsonText(argumentsText, "item.arguments", "responses"), outputIndex, itemId: stringOrUndefined(item.id) });
        }
      }
    }
  } else if (type === "response.completed" || type === "response.incomplete" || type === "response.failed") {
    const response = isRecord(payload.response) ? payload.response : payload;
    if (response.usage !== undefined && response.usage !== null) {
      state.usage = parseUsage(response.usage, "response.usage", "responses");
      events.push({ type: "usage", usage: state.usage });
    }
    let finishReason: FinishReason = type === "response.failed" ? "error" : type === "response.incomplete" ? "length" : "stop";
    if (type !== "response.failed") {
      const normalized = decodeResponsesResponse(response);
      finishReason = normalized.finishReason;
    }
    appendResponsesTerminalContent(response, state, events);
    state.finishReason = finishReason;
    state.finishSeen = true;
    state.ended = true;
    if (type === "response.failed") {
      events.push({ type: "error", error: decodeStreamError(response.error ?? payload.error) });
    }
    events.push({ type: "message_end", finishReason, usage: state.usage });
  } else if (type === "error" || type === "response.error") {
    events.push({ type: "error", error: decodeStreamError(payload.error ?? payload) });
  } else if (type === "ping") {
    events.push({ type: "ping" });
  } else {
    events.push({ type: "raw", protocol: "responses", event: type ?? "", data: payload });
  }
  return events;
}

/**
 * Some Responses-compatible servers include the complete output only on the
 * terminal `response.completed` envelope. Fill any missing deltas from that
 * envelope so a converted target cannot finish with truncated content.
 */
function appendResponsesTerminalContent(
  response: Record<string, unknown>,
  state: StreamDecodeState,
  events: StreamEvent[],
): void {
  if (!Array.isArray(response.output)) return;
  for (const [outputIndex, rawItem] of response.output.entries()) {
    if (!isRecord(rawItem)) continue;
    const itemId = stringOrUndefined(rawItem.id);
    if (rawItem.type === "message") {
      const content = Array.isArray(rawItem.content) ? rawItem.content : [];
      const textParts = content
        .filter((part): part is Record<string, unknown> => isRecord(part) && part.type === "output_text" && typeof part.text === "string")
        .map((part) => part.text as string);
      const finalText = textParts.join("");
      if (!finalText) continue;
      const previousText = state.textBuffers.get(outputIndex) ?? "";
      if (!state.textBuffers.has(outputIndex)) {
        events.push({ type: "text_start", outputIndex, contentIndex: 0, itemId });
      }
      if (finalText !== previousText) {
        const suffix = finalText.startsWith(previousText) ? finalText.slice(previousText.length) : state.textBuffers.has(outputIndex) ? "" : finalText;
        if (suffix) events.push({ type: "text_delta", text: suffix, outputIndex, contentIndex: 0, itemId });
        state.textBuffers.set(outputIndex, finalText);
      }
      if (!state.textEnded.has(outputIndex)) {
        state.textEnded.add(outputIndex);
        events.push({ type: "text_end", text: finalText, outputIndex, contentIndex: 0, itemId });
      }
    } else if (rawItem.type === "function_call") {
      const id = stringOrUndefined(rawItem.call_id) ?? itemId;
      const name = stringOrUndefined(rawItem.name) ?? "";
      if (!id) continue;
      const block = state.blocks.get(outputIndex);
      if (!block) {
        state.blocks.set(outputIndex, { kind: "tool", id, name });
        events.push({ type: "tool_start", id, name, outputIndex, contentIndex: 0, itemId });
      }
      const finalArguments = typeof rawItem.arguments === "string" ? rawItem.arguments : "{}";
      const previousArguments = state.toolBuffers.get(outputIndex) ?? "";
      if (finalArguments !== previousArguments) {
        const suffix = finalArguments.startsWith(previousArguments) ? finalArguments.slice(previousArguments.length) : state.toolBuffers.has(outputIndex) ? "" : finalArguments;
        if (suffix) events.push({ type: "tool_delta", id, argumentsDelta: suffix, outputIndex, itemId });
        state.toolBuffers.set(outputIndex, finalArguments);
      }
      if (!state.toolEnded.has(outputIndex)) {
        state.toolEnded.add(outputIndex);
        events.push({ type: "tool_end", id, input: parseJsonText(finalArguments, `output[${outputIndex}].arguments`, "responses"), outputIndex, itemId });
      }
    }
  }
}

function numberIndex(value: unknown): number {
  if (typeof value !== "number" || !Number.isInteger(value) || value < 0) throw invalidResponseField("index", "expected a non-negative integer", "messages");
  return value;
}

function numberOr(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function stringOrUndefined(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

function decodeStreamError(value: unknown): { message: string; code?: string; type?: string } {
  const error = isRecord(value) ? value : {};
  return {
    message: typeof error.message === "string" ? error.message : "upstream stream error",
    code: typeof error.code === "string" ? error.code : undefined,
    type: typeof error.type === "string" ? error.type : undefined,
  };
}

function hasMeaningfulReasoningPayload(value: Record<string, unknown>): boolean {
  return [value.content, value.summary, value.encrypted_content, value.signature, value.thinking, value.reasoning_content, value.delta, value.part, value.item].some(hasMeaningfulValue);
}

function hasMeaningfulValue(value: unknown): boolean {
  if (value === undefined || value === null) return false;
  if (typeof value === "string") return value.length > 0;
  if (Array.isArray(value)) return value.some(hasMeaningfulValue);
  if (isRecord(value)) return [value.text, value.thinking, value.summary_text, value.content, value.summary, value.encrypted_content, value.signature, value.reasoning_content].some(hasMeaningfulValue);
  return true;
}

function parsePartialUsage(value: unknown, previous: InternalUsage | undefined, path: string, protocol: Protocol): InternalUsage {
  if (value === undefined || value === null) return previous ?? { inputTokens: 0, outputTokens: 0, totalTokens: 0 };
  const raw = asRecord(value, path, protocol);
  const parsed = parseUsage(value, path, protocol);
  const hasInput = raw.input_tokens !== undefined || raw.prompt_tokens !== undefined;
  const hasOutput = raw.output_tokens !== undefined || raw.completion_tokens !== undefined;
  const hasTotal = raw.total_tokens !== undefined;
  const inputTokens = hasInput ? parsed.inputTokens : previous?.inputTokens ?? 0;
  const outputTokens = hasOutput ? parsed.outputTokens : previous?.outputTokens ?? 0;
  return {
    inputTokens,
    outputTokens,
    totalTokens: hasTotal ? parsed.totalTokens : inputTokens + outputTokens,
    cacheReadInputTokens: parsed.cacheReadInputTokens ?? previous?.cacheReadInputTokens,
    cacheCreationInputTokens: parsed.cacheCreationInputTokens ?? previous?.cacheCreationInputTokens,
  };
}

interface StreamEncodeState {
  id?: string;
  model?: string;
  started: boolean;
  ended: boolean;
  nextContentIndex: number;
  nextToolIndex: number;
  activeText?: { index: number; outputIndex: number; itemId?: string; text: string };
  activeTools: Map<string, { index: number; outputIndex: number; itemId?: string; name: string; arguments: string }>;
  toolOutputIndexes: Map<string, number>;
  toolContentIndexes: Map<string, number>;
  usage?: InternalUsage;
  outputItems: Record<string, unknown>[];
}

function newEncodeState(): StreamEncodeState {
  return { started: false, ended: false, nextContentIndex: 0, nextToolIndex: 0, activeTools: new Map(), toolOutputIndexes: new Map(), toolContentIndexes: new Map(), outputItems: [] };
}

/** Encode protocol-neutral events into valid SSE frames for a target protocol. */
export function encodeProtocolStreamEvent(protocol: Protocol, event: StreamEvent, state = newEncodeState()): string[] {
  if (event.type === "message_start") {
    state.id = event.id || state.id;
    state.model = event.model || state.model;
    state.started = true;
    if (protocol === "messages") {
      return [formatSse({ event: "message_start", data: JSON.stringify({ type: "message_start", message: { id: state.id ?? "", type: "message", role: "assistant", content: [], model: state.model ?? "", stop_reason: null, stop_sequence: null, usage: messagesUsage(event.usage) } }) })];
    }
    if (protocol === "chat") {
      return [formatSse({ data: JSON.stringify({ id: state.id ?? "", object: "chat.completion.chunk", created: Math.floor(Date.now() / 1000), model: state.model ?? "", choices: [{ index: 0, delta: { role: "assistant", content: null }, finish_reason: null }] }) })];
    }
    const response = { id: state.id ?? "", object: "response", created_at: Math.floor(Date.now() / 1000), model: state.model ?? "", status: "in_progress", output: [] };
    return [
      formatSse({ event: "response.created", data: JSON.stringify({ type: "response.created", response }) }),
      formatSse({ event: "response.in_progress", data: JSON.stringify({ type: "response.in_progress", response }) }),
    ];
  }
  if (event.type === "text_start") {
    const index = event.contentIndex ?? state.nextContentIndex;
    state.nextContentIndex = Math.max(state.nextContentIndex, index + 1);
    if (protocol === "chat") {
      // Some Responses servers can deliver a delta before content_part.added.
      // Do not reset text already accumulated from that delta.
      if (!state.activeText) state.activeText = { index, outputIndex: event.outputIndex ?? 0, itemId: event.itemId, text: "" };
      return [];
    }
    state.activeText = { index, outputIndex: event.outputIndex ?? 0, itemId: event.itemId, text: "" };
    if (protocol === "messages") return [formatSse({ event: "content_block_start", data: JSON.stringify({ type: "content_block_start", index, content_block: { type: "text", text: "" } }) })];
    const itemId = event.itemId ?? `${state.id ?? "response"}-message-${event.outputIndex ?? 0}`;
    state.outputItems[event.outputIndex ?? 0] = { type: "message", id: itemId, role: "assistant", status: "in_progress", content: [] };
    return [
      formatSse({ event: "response.output_item.added", data: JSON.stringify({ type: "response.output_item.added", output_index: event.outputIndex ?? 0, item: state.outputItems[event.outputIndex ?? 0] }) }),
      formatSse({ event: "response.content_part.added", data: JSON.stringify({ type: "response.content_part.added", item_id: itemId, output_index: event.outputIndex ?? 0, content_index: index, part: { type: "output_text", text: "", annotations: [] } }) }),
    ];
  }
  if (event.type === "text_delta") {
    const frames = state.activeText ? [] : encodeProtocolStreamEvent(protocol, {
      type: "text_start", outputIndex: event.outputIndex ?? 0,
      contentIndex: event.contentIndex ?? 0, itemId: event.itemId,
    }, state);
    // Start the block first, then update that same object. Creating a new block
    // after appending a delta loses the first chunk from done/final responses.
    const active = state.activeText!;
    active.text += event.text;
    if (protocol === "messages") {
      frames.push(formatSse({ event: "content_block_delta", data: JSON.stringify({ type: "content_block_delta", index: active.index, delta: { type: "text_delta", text: event.text } }) }));
      return frames;
    }
    if (protocol === "chat") return [formatSse({ data: JSON.stringify({ id: state.id ?? "", object: "chat.completion.chunk", created: Math.floor(Date.now() / 1000), model: state.model ?? "", choices: [{ index: 0, delta: { content: event.text }, finish_reason: null }] }) })];
    frames.push(formatSse({ event: "response.output_text.delta", data: JSON.stringify({ type: "response.output_text.delta", item_id: active.itemId ?? `${state.id ?? "response"}-message-${active.outputIndex}`, output_index: active.outputIndex, content_index: active.index, delta: event.text }) }));
    return frames;
  }
  if (event.type === "text_end") {
    const active = state.activeText ?? { index: event.contentIndex ?? 0, outputIndex: event.outputIndex ?? 0, itemId: event.itemId, text: event.text ?? "" };
    if (protocol === "messages") {
      state.activeText = undefined;
      return [formatSse({ event: "content_block_stop", data: JSON.stringify({ type: "content_block_stop", index: active.index }) })];
    }
    if (protocol === "chat") {
      state.activeText = undefined;
      return [];
    }
    const itemId = active.itemId ?? `${state.id ?? "response"}-message-${active.outputIndex}`;
    state.activeText = undefined;
    const item = state.outputItems[active.outputIndex];
    if (item && isRecord(item)) {
      item.content = [{ type: "output_text", text: event.text ?? active.text, annotations: [] }];
      item.status = "completed";
    }
    return [
      formatSse({ event: "response.output_text.done", data: JSON.stringify({ type: "response.output_text.done", item_id: itemId, output_index: active.outputIndex, content_index: active.index, text: event.text ?? active.text }) }),
      formatSse({ event: "response.content_part.done", data: JSON.stringify({ type: "response.content_part.done", item_id: itemId, output_index: active.outputIndex, content_index: active.index, part: { type: "output_text", text: event.text ?? active.text, annotations: [] } }) }),
      formatSse({ event: "response.output_item.done", data: JSON.stringify({ type: "response.output_item.done", output_index: active.outputIndex, item: item ?? { type: "message", id: itemId, role: "assistant", status: "completed", content: [] } }) }),
    ];
  }
  if (event.type === "tool_start") {
    const index = protocol === "messages"
      ? state.toolContentIndexes.get(event.id) ?? state.nextContentIndex
      : protocol === "chat"
        ? state.toolContentIndexes.get(event.id) ?? state.nextToolIndex++
        : event.contentIndex ?? state.nextContentIndex;
    if (protocol === "messages") state.nextContentIndex = Math.max(state.nextContentIndex, index + 1);
    state.toolContentIndexes.set(event.id, index);
    const outputIndex = protocol === "responses" ? state.toolOutputIndexes.get(event.id) ?? nextOutputIndex(state) : event.outputIndex ?? 0;
    state.toolOutputIndexes.set(event.id, outputIndex);
    const active = { index, outputIndex, itemId: event.itemId, name: event.name, arguments: "" };
    state.activeTools.set(event.id, active);
    if (protocol === "messages") return [formatSse({ event: "content_block_start", data: JSON.stringify({ type: "content_block_start", index, content_block: { type: "tool_use", id: event.id, name: event.name, input: {} } }) })];
    if (protocol === "chat") return [formatSse({ data: JSON.stringify({ id: state.id ?? "", object: "chat.completion.chunk", created: Math.floor(Date.now() / 1000), model: state.model ?? "", choices: [{ index: 0, delta: { tool_calls: [{ index, id: event.id, type: "function", function: { name: event.name, arguments: "" } }] }, finish_reason: null }] }) })];
    const item = { type: "function_call", id: event.itemId ?? event.id, call_id: event.id, name: event.name, arguments: "", status: "in_progress" };
    state.outputItems[active.outputIndex] = item;
    return [formatSse({ event: "response.output_item.added", data: JSON.stringify({ type: "response.output_item.added", output_index: active.outputIndex, item }) })];
  }
  if (event.type === "tool_delta") {
    const outputIndex = protocol === "responses" ? state.toolOutputIndexes.get(event.id) ?? nextOutputIndex(state) : event.outputIndex ?? 0;
    state.toolOutputIndexes.set(event.id, outputIndex);
    const contentIndex = protocol === "messages" || protocol === "chat" ? state.toolContentIndexes.get(event.id) ?? (protocol === "chat" ? state.nextToolIndex++ : state.nextContentIndex) : event.contentIndex ?? 0;
    state.toolContentIndexes.set(event.id, contentIndex);
    if (protocol === "messages") state.nextContentIndex = Math.max(state.nextContentIndex, contentIndex + 1);
    const active = state.activeTools.get(event.id) ?? { index: contentIndex, outputIndex, itemId: event.itemId, name: event.nameDelta ?? "", arguments: "" };
    state.activeTools.set(event.id, active);
    active.arguments += event.argumentsDelta;
    if (protocol === "messages") return [formatSse({ event: "content_block_delta", data: JSON.stringify({ type: "content_block_delta", index: active.index, delta: { type: "input_json_delta", partial_json: event.argumentsDelta } }) })];
    if (protocol === "chat") return [formatSse({ data: JSON.stringify({ id: state.id ?? "", object: "chat.completion.chunk", created: Math.floor(Date.now() / 1000), model: state.model ?? "", choices: [{ index: 0, delta: { tool_calls: [{ index: active.index, function: { ...(event.nameDelta ? { name: event.nameDelta } : {}), arguments: event.argumentsDelta } }] }, finish_reason: null }] }) })];
    return [formatSse({ event: "response.function_call_arguments.delta", data: JSON.stringify({ type: "response.function_call_arguments.delta", item_id: active.itemId ?? event.id, output_index: active.outputIndex, call_id: event.id, delta: event.argumentsDelta }) })];
  }
  if (event.type === "tool_end") {
    const outputIndex = protocol === "responses" ? state.toolOutputIndexes.get(event.id) ?? nextOutputIndex(state) : event.outputIndex ?? 0;
    state.toolOutputIndexes.set(event.id, outputIndex);
    const contentIndex = protocol === "messages" || protocol === "chat" ? state.toolContentIndexes.get(event.id) ?? (protocol === "chat" ? state.nextToolIndex++ : state.nextContentIndex) : event.contentIndex ?? 0;
    state.toolContentIndexes.set(event.id, contentIndex);
    if (protocol === "messages") state.nextContentIndex = Math.max(state.nextContentIndex, contentIndex + 1);
    const active = state.activeTools.get(event.id) ?? { index: contentIndex, outputIndex, itemId: event.itemId, name: "", arguments: "" };
    if (event.input !== undefined && active.arguments.length === 0) active.arguments = JSON.stringify(event.input);
    state.activeTools.delete(event.id);
    if (protocol === "messages") return [formatSse({ event: "content_block_stop", data: JSON.stringify({ type: "content_block_stop", index: active.index }) })];
    if (protocol === "chat") return [];
    const item = state.outputItems[active.outputIndex];
    if (item && isRecord(item)) {
      item.arguments = active.arguments || "{}";
      item.status = "completed";
    }
    return [
      formatSse({ event: "response.function_call_arguments.done", data: JSON.stringify({ type: "response.function_call_arguments.done", item_id: active.itemId ?? event.id, output_index: active.outputIndex, call_id: event.id, arguments: active.arguments || "{}" }) }),
      formatSse({ event: "response.output_item.done", data: JSON.stringify({ type: "response.output_item.done", output_index: active.outputIndex, item: item ?? { type: "function_call", id: active.itemId ?? event.id, call_id: event.id, name: active.name, arguments: active.arguments || "{}", status: "completed" } }) }),
    ];
  }
  if (event.type === "usage") {
    state.usage = event.usage;
    if (protocol === "messages") return [];
    if (protocol === "chat") return [];
    return [];
  }
  if (event.type === "message_end") {
    state.usage = event.usage ?? state.usage;
    state.ended = true;
    // An upstream error is terminal, but it must not be rendered as a normal
    // completion frame (especially Chat's finish chunk + [DONE]). The error
    // event immediately preceding this event carries the protocol error.
    if (event.finishReason === "error") return [];
    if (protocol === "messages") {
      const frames: string[] = [];
      if (state.activeText) frames.push(...encodeProtocolStreamEvent("messages", { type: "text_end", outputIndex: state.activeText.outputIndex, contentIndex: state.activeText.index }, state));
      for (const [id, active] of state.activeTools) frames.push(...encodeProtocolStreamEvent("messages", { type: "tool_end", id, outputIndex: active.outputIndex, contentIndex: active.index }, state));
      const usage = state.usage;
      frames.push(formatSse({ event: "message_delta", data: JSON.stringify({ type: "message_delta", delta: { stop_reason: finishReasonToMessages(event.finishReason), stop_sequence: event.stopSequence ?? null }, usage: usage ? messagesUsage(usage) : { output_tokens: 0 } }) }));
      frames.push(formatSse({ event: "message_stop", data: JSON.stringify({ type: "message_stop" }) }));
      return frames;
    }
    if (protocol === "chat") {
      return [
        formatSse({ data: JSON.stringify({ id: state.id ?? "", object: "chat.completion.chunk", created: Math.floor(Date.now() / 1000), model: state.model ?? "", choices: [{ index: 0, delta: {}, finish_reason: finishReasonToChat(event.finishReason) }], ...(state.usage ? { usage: chatStreamUsage(state.usage) } : {}) }) }),
        "data: [DONE]\n\n",
      ];
    }
    const frames: string[] = [];
    if (state.activeText) frames.push(...encodeProtocolStreamEvent("responses", { type: "text_end", outputIndex: state.activeText.outputIndex, contentIndex: state.activeText.index, itemId: state.activeText.itemId }, state));
    for (const [id, active] of state.activeTools) frames.push(...encodeProtocolStreamEvent("responses", { type: "tool_end", id, outputIndex: active.outputIndex, itemId: active.itemId }, state));
    const incomplete = event.finishReason === "length" || event.finishReason === "content_filter";
    const status = incomplete ? "incomplete" : "completed";
    const response = { id: state.id ?? "", object: "response", created_at: Math.floor(Date.now() / 1000), model: state.model ?? "", status, output: state.outputItems, ...(incomplete ? { incomplete_details: { reason: event.finishReason === "content_filter" ? "content_filter" : "max_output_tokens" } } : {}), ...(state.usage ? { usage: responsesStreamUsage(state.usage) } : {}) };
    frames.push(formatSse({ event: incomplete ? "response.incomplete" : "response.completed", data: JSON.stringify({ type: incomplete ? "response.incomplete" : "response.completed", response }) }));
    return frames;
  }
  if (event.type === "error") {
    if (protocol === "messages") return [formatSse({ event: "error", data: JSON.stringify({ type: "error", error: { type: event.error.type ?? "api_error", message: event.error.message } }) })];
    if (protocol === "chat") return [formatSse({ data: JSON.stringify({ error: event.error }) })];
    return [formatSse({ event: "response.failed", data: JSON.stringify({ type: "response.failed", response: { id: state.id ?? "", object: "response", status: "failed", model: state.model ?? "", output: [], error: event.error } }) })];
  }
  if (event.type === "ping") {
    if (protocol === "messages") return [formatSse({ event: "ping", data: JSON.stringify({ type: "ping" }) })];
    return [];
  }
  return [];
}

export const encodeStreamEvent = encodeProtocolStreamEvent;

export interface ConvertSseOptions {
  signal?: AbortSignal;
  onError?: (error: unknown) => void;
  /** Maximum aggregate state permitted by the caller; conversion remains streaming. */
  maxStateBytes?: number;
  requestId?: string;
  /** Strict preserves native reasoning errors; compatible removes known thinking frames. */
  thinkingMode?: "strict" | "compatible";
}

/** Transform an upstream SSE ReadableStream while preserving streaming/backpressure. */
export function convertSseStream(
  upstream: Protocol,
  client: Protocol,
  input: ReadableStream<Uint8Array | string>,
  options: ConvertSseOptions = {},
): ReadableStream<Uint8Array> {
  if (upstream === client) return input as ReadableStream<Uint8Array>;
  const encoder = new TextEncoder();
  const reader = input.getReader();
  const parser = new SseParser();
  const decodeState = newDecodeState();
  const encodeState = newEncodeState();
  const thinkingState = newThinkingSanitizeState();
  const pending: Uint8Array[] = [];
  let upstreamDone = false;
  let outputClosed = false;
  let readerReleased = false;
  let errorHandled = false;
  let responsesSequence = 0;

  const releaseReader = () => {
    if (readerReleased) return;
    readerReleased = true;
    reader.releaseLock();
  };

  const queueEncoded = (value: string) => {
    const output = client === "responses" ? addResponsesSequence(value, responsesSequence++) : value;
    pending.push(encoder.encode(output));
  };

  const processFrame = (frame: SseEvent) => {
    const sanitized = options.thinkingMode === "compatible"
      ? sanitizeThinkingFrame(upstream, frame, thinkingState)
      : frame;
    if (sanitized) {
      const events = decodeProtocolSseEvent(upstream, sanitized, decodeState);
      for (const event of events) {
        for (const encoded of encodeProtocolStreamEvent(client, event, encodeState)) queueEncoded(encoded);
      }
    }
    if (options.maxStateBytes !== undefined && streamStateBytes(decodeState, encodeState, thinkingState) > options.maxStateBytes) {
      throw new ProtocolConversionError("stream state exceeded the configured memory limit", {
        code: "stream_error",
        path: "stream.state",
        status: 413,
      });
    }
  };

  const queueError = (error: unknown) => {
    if (errorHandled) return;
    errorHandled = true;
    options.onError?.(error);
    if (!encodeState.ended) {
      const converted = error instanceof ProtocolConversionError
        ? { message: error.message, code: error.code, type: "stream_error" }
        : { message: error instanceof Error ? error.message : String(error), type: "stream_error" };
      for (const encoded of encodeProtocolStreamEvent(client, { type: "error", error: converted }, encodeState)) queueEncoded(encoded);
    }
    upstreamDone = true;
    void reader.cancel(error).catch(() => undefined);
    releaseReader();
  };

  return new ReadableStream<Uint8Array>({
    async pull(controller) {
      if (outputClosed) return;
      try {
        while (pending.length === 0 && !upstreamDone && !outputClosed) {
          if (options.signal?.aborted) throw new DOMException("The stream was aborted", "AbortError");
          const result = await reader.read();
          if (outputClosed) return;
          if (result.done) {
            upstreamDone = true;
            for (const frame of parser.finish()) processFrame(frame);
            releaseReader();
            break;
          }
          for (const frame of parser.push(result.value)) processFrame(frame);
        }
      } catch (error) {
        queueError(error);
      }
      if (pending.length > 0) {
        controller.enqueue(pending.shift() as Uint8Array);
        return;
      }
      if (upstreamDone && !outputClosed) {
        outputClosed = true;
        releaseReader();
        controller.close();
      }
    },
    async cancel(reason) {
      outputClosed = true;
      try {
        await reader.cancel(reason);
      } catch {
        // Cancellation is best effort; the consumer has already detached.
      } finally {
        releaseReader();
      }
    },
  });
}

export const convertSSEStream = convertSseStream;

function messagesUsage(usage: InternalUsage | undefined): Record<string, unknown> {
  return usage ? {
    input_tokens: messagesInputTokens(usage),
    output_tokens: usage.outputTokens,
    ...(usage.cacheReadInputTokens === undefined ? {} : { cache_read_input_tokens: usage.cacheReadInputTokens }),
    ...(usage.cacheCreationInputTokens === undefined ? {} : { cache_creation_input_tokens: usage.cacheCreationInputTokens }),
  } : { input_tokens: 0, output_tokens: 0 };
}

function messagesInputTokens(usage: InternalUsage): number {
  return Math.max(0, usage.inputTokens - (usage.cacheReadInputTokens ?? 0) - (usage.cacheCreationInputTokens ?? 0));
}

function addResponsesSequence(frame: string, sequence: number): string {
  const lines = frame.split("\n");
  const dataIndex = lines.findIndex((line) => line.startsWith("data: "));
  if (dataIndex < 0) return frame;
  const data = lines[dataIndex]?.slice("data: ".length);
  if (!data || data === "[DONE]") return frame;
  try {
    const payload = JSON.parse(data);
    if (!isRecord(payload)) return frame;
    lines[dataIndex] = `data: ${JSON.stringify({ ...payload, sequence_number: sequence })}`;
    return lines.join("\n");
  } catch {
    return frame;
  }
}

function chatStreamUsage(usage: InternalUsage): Record<string, unknown> {
  return {
    prompt_tokens: usage.inputTokens,
    completion_tokens: usage.outputTokens,
    total_tokens: usage.totalTokens,
    ...(usage.cacheReadInputTokens === undefined ? {} : { prompt_tokens_details: { cached_tokens: usage.cacheReadInputTokens } }),
  };
}

function responsesStreamUsage(usage: InternalUsage): Record<string, unknown> {
  return {
    input_tokens: usage.inputTokens,
    output_tokens: usage.outputTokens,
    total_tokens: usage.totalTokens,
    ...(usage.cacheReadInputTokens === undefined ? {} : { input_tokens_details: { cached_tokens: usage.cacheReadInputTokens } }),
  };
}

function isReadableStream(value: unknown): value is ReadableStream<Uint8Array | string> {
  return typeof value === "object" && value !== null && typeof (value as { getReader?: unknown }).getReader === "function";
}

function streamStateBytes(decode: StreamDecodeState, encode: StreamEncodeState, thinking?: ThinkingSanitizeState): number {
  return JSON.stringify({
    id: decode.id,
    model: decode.model,
    blocks: [...decode.blocks.entries()],
    tools: [...decode.tools.entries()],
    textBuffers: [...decode.textBuffers.entries()],
    textEnded: [...decode.textEnded.values()],
    toolBuffers: [...decode.toolBuffers.entries()],
    toolEnded: [...decode.toolEnded.values()],
    activeText: encode.activeText,
    activeTools: [...encode.activeTools.entries()],
    toolOutputIndexes: [...encode.toolOutputIndexes.entries()],
    toolContentIndexes: [...encode.toolContentIndexes.entries()],
    outputItems: encode.outputItems,
    thinkingMessageIndexes: thinking ? [...thinking.messageIndexes.values()] : [],
    thinkingResponseIndexes: thinking ? [...thinking.responseIndexes.values()] : [],
  }).length;
}

function nextOutputIndex(state: StreamEncodeState): number {
  let index = 0;
  while (state.outputItems[index] !== undefined) index += 1;
  return index;
}
