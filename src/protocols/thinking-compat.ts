import { isRecord } from "./common";
import type { Protocol } from "./types";

const THINKING_TYPES = new Set([
  "thinking", "redacted_thinking", "reasoning", "reasoning_text",
  "reasoning_summary", "reasoning_summary_text",
]);
const THINKING_FIELDS = ["thinking", "reasoning", "reasoning_content", "reasoning_details", "signature"];

export function isThinkingBlock(value: unknown): boolean {
  return isRecord(value) && typeof value.type === "string" && THINKING_TYPES.has(value.type);
}

function withoutThinkingFields(value: Record<string, unknown>): Record<string, unknown> {
  const result = { ...value };
  for (const field of THINKING_FIELDS) delete result[field];
  return result;
}

function visibleContent(content: unknown[]): unknown[] {
  return content.filter(block => !isThinkingBlock(block));
}

function visibleMessage(value: unknown): unknown | null {
  if (!isRecord(value) || value.role !== "assistant") return value;
  const message = withoutThinkingFields(value);
  const hasToolCall = (Array.isArray(value.tool_calls) && value.tool_calls.length > 0) || Boolean(value.function_call);
  const hasThinkingFields = THINKING_FIELDS.some(field => value[field] !== undefined);
  if (hasThinkingFields && !hasToolCall &&
    (value.content === undefined || value.content === null || value.content === "" || (Array.isArray(value.content) && value.content.length === 0))) return null;
  if (Array.isArray(value.content)) {
    const content = visibleContent(value.content);
    // A historical turn containing only discarded provider state must not
    // become an invalid empty assistant message. Preserve real tool calls.
    if (value.content.length > 0 && content.length === 0 && !hasToolCall) return null;
    message.content = content;
  }
  return message;
}

/** Compatibility applies only when crossing protocols. It removes provider
 * thinking controls/state, never user text, tool arguments or tool results.
 * Model IDs, opaque reasoning signatures and budgets are not fabricated.
 */
export function stripThinkingRequest(protocol: Protocol, value: unknown): unknown {
  if (!isRecord(value)) return value;
  const body = { ...value };
  delete body.thinking;
  delete body.reasoning;
  delete body.reasoning_effort;
  delete body.enable_thinking;
  if (isRecord(body.output_config)) {
    body.output_config = { ...body.output_config };
    delete (body.output_config as Record<string, unknown>).effort;
  }
  if (protocol === "responses") {
    if (Array.isArray(body.include)) {
      body.include = body.include.filter(item => typeof item !== "string" || !item.startsWith("reasoning."));
    }
    if (Array.isArray(body.input)) {
      body.input = body.input.filter(item => !isThinkingBlock(item)).map(visibleMessage).filter(item => item !== null);
    }
  } else if (Array.isArray(body.messages)) {
    body.messages = body.messages.map(visibleMessage).filter(message => message !== null);
  }
  return body;
}

/** Remove only provider thinking output. Usage, finish reasons, errors and
 * normal text/tool output remain available to the existing response adapters.
 */
export function stripThinkingResponse(protocol: Protocol, value: unknown): unknown {
  if (!isRecord(value)) return value;
  const body = { ...value };
  if (protocol === "messages" && Array.isArray(body.content)) {
    body.content = visibleContent(body.content);
  } else if (protocol === "responses" && Array.isArray(body.output)) {
    body.output = body.output.filter(item => !isThinkingBlock(item)).map(visibleMessage).filter(item => item !== null);
  } else if (protocol === "chat" && Array.isArray(body.choices)) {
    body.choices = body.choices.map(choice => {
      if (!isRecord(choice) || !isRecord(choice.message)) return choice;
      const message = withoutThinkingFields(choice.message);
      if (Array.isArray(message.content)) message.content = visibleContent(message.content);
      return { ...choice, message };
    });
  }
  return body;
}
