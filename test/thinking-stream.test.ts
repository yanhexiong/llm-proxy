import { describe, expect, it } from "vitest";
import { convertSseStream, parseSseChunked } from "../src/protocols/sse";
import type { Protocol } from "../src/protocols/types";

const encoder = new TextEncoder();

function frame(data: Record<string, unknown>, event?: string): string {
  return `${event ? `event: ${event}\n` : ""}data: ${JSON.stringify(data)}\n\n`;
}

function done(): string {
  return "data: [DONE]\n\n";
}

function stream(frames: string[]): ReadableStream<Uint8Array> {
  return new ReadableStream<Uint8Array>({
    start(controller) {
      for (const value of frames) controller.enqueue(encoder.encode(value));
      controller.close();
    },
  });
}

async function convert(
  source: Protocol,
  target: Protocol,
  frames: string[],
  thinkingMode: "strict" | "compatible" = "compatible",
): Promise<{ text: string; events: ReturnType<typeof parseSseChunked> }> {
  const text = await new Response(convertSseStream(source, target, stream(frames), { thinkingMode })).text();
  return { text, events: parseSseChunked([text]) };
}

const messagesFrames = [
  frame({
    type: "message_start",
    message: { id: "msg-thinking", type: "message", role: "assistant", model: "demo", content: [], usage: { input_tokens: 2, output_tokens: 0 } },
  }, "message_start"),
  frame({ type: "content_block_start", index: 0, content_block: { type: "thinking", thinking: "internal-thought" } }, "content_block_start"),
  frame({ type: "content_block_delta", index: 0, delta: { type: "thinking_delta", thinking: "internal-part-1" } }, "content_block_delta"),
  frame({ type: "content_block_delta", index: 0, delta: { type: "signature_delta", signature: "signature-part-1" } }, "content_block_delta"),
  frame({ type: "content_block_delta", index: 0, delta: { type: "signature_delta", signature: "signature-part-2" } }, "content_block_delta"),
  frame({ type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "thinking-leak" } }, "content_block_delta"),
  frame({ type: "content_block_stop", index: 0 }, "content_block_stop"),
  frame({ type: "content_block_start", index: 1, content_block: { type: "text", text: "" } }, "content_block_start"),
  frame({ type: "content_block_delta", index: 1, delta: { type: "text_delta", text: "Hello " } }, "content_block_delta"),
  frame({ type: "content_block_delta", index: 1, delta: { type: "text_delta", text: "world" } }, "content_block_delta"),
  frame({ type: "content_block_stop", index: 1 }, "content_block_stop"),
  frame({ type: "content_block_start", index: 2, content_block: { type: "tool_use", id: "call-weather", name: "weather", input: {} } }, "content_block_start"),
  frame({ type: "content_block_delta", index: 2, delta: { type: "input_json_delta", partial_json: '{"city":"' } }, "content_block_delta"),
  frame({ type: "content_block_delta", index: 2, delta: { type: "input_json_delta", partial_json: 'Shanghai"}' } }, "content_block_delta"),
  frame({ type: "content_block_stop", index: 2 }, "content_block_stop"),
  frame({ type: "message_delta", delta: { stop_reason: "tool_use", stop_sequence: null }, usage: { output_tokens: 3 } }, "message_delta"),
  frame({ type: "message_stop" }, "message_stop"),
] as const;

const chatFrames = [
  frame({ id: "chat-thinking", object: "chat.completion.chunk", model: "demo", choices: [{ index: 0, delta: { role: "assistant" }, finish_reason: null }], usage: null }),
  frame({
    id: "chat-thinking",
    model: "demo",
    choices: [{ index: 0, delta: { reasoning_content: "internal-thought", thinking: "internal-part-1", reasoning: "internal-part-2", reasoning_details: [{ text: "internal-details" }], signature: "signature-part-1", content: "Hello " }, finish_reason: null }],
    error: null,
  }),
  frame({
    id: "chat-thinking",
    model: "demo",
    choices: [{ index: 0, delta: { reasoning_content: "internal-part-3", signature: "signature-part-2", tool_calls: [{ index: 0, id: "call-weather", type: "function", function: { name: "weather", arguments: '{"city":"' } }] }, finish_reason: null }],
  }),
  frame({
    id: "chat-thinking",
    model: "demo",
    choices: [{ index: 0, delta: { reasoning_content: "internal-part-4", tool_calls: [{ index: 0, function: { arguments: "Shanghai" } }] }, finish_reason: null }],
  }),
  frame({ id: "chat-thinking", model: "demo", choices: [{ index: 0, delta: {}, finish_reason: "tool_calls" }], usage: { prompt_tokens: 2, completion_tokens: 3, total_tokens: 5 } }),
  done(),
] as const;

function responsesTerminalFrames(): string[] {
  return [
    frame({ type: "response.reasoning_summary_part.added", summary_index: 0, part: { type: "summary_text", text: "internal-summary" } }, "response.reasoning_summary_part.added"),
    frame({ type: "response.reasoning_summary_text.delta", summary_index: 0, delta: "internal-summary-part" }, "response.reasoning_summary_text.delta"),
    frame({ type: "response.reasoning_summary_part.done", summary_index: 0, part: { type: "summary_text", text: "internal-summary" } }, "response.reasoning_summary_part.done"),
    frame({
      type: "response.completed",
      response: {
        id: "response-thinking",
        object: "response",
        model: "demo",
        status: "completed",
        output: [
          { id: "reasoning-item", type: "reasoning", summary: [{ type: "summary_text", text: "internal-terminal" }], encrypted_content: "opaque-signature" },
          { id: "message-item", type: "message", role: "assistant", status: "completed", content: [{ type: "output_text", text: "Hello world", annotations: [] }] },
          { id: "call-weather", type: "function_call", call_id: "call-weather", name: "weather", arguments: '{"city":"Shanghai"}', status: "completed" },
        ],
        usage: { input_tokens: 2, output_tokens: 3, total_tokens: 5 },
      },
    }, "response.completed"),
  ];
}

function expectVisibleResult(text: string, target: Protocol): void {
  expect(text).toContain("Hello");
  expect(text).toContain("weather");
  expect(text).toContain("Shanghai");
  expect(text).toMatch(/"(?:output_tokens|completion_tokens)":3/u);
  expect(text).not.toContain("internal-thought");
  expect(text).not.toContain("internal-part");
  expect(text).not.toContain("thinking-leak");
  expect(text).not.toContain("internal-details");
  expect(text).not.toContain("internal-summary");
  expect(text).not.toContain("internal-terminal");
  expect(text).not.toContain("signature-part");
  expect(text).not.toContain("opaque-signature");
  expect(text).not.toContain("unsupported_content");

  const events = parseSseChunked([text]);
  expect(events.some((event) => event.data.includes("stream_error"))).toBe(false);
  if (target === "messages") expect(events.some((event) => event.event === "message_stop")).toBe(true);
  if (target === "chat") expect(events.some((event) => event.data === "[DONE]")).toBe(true);
  if (target === "responses") expect(events.some((event) => event.event === "response.completed")).toBe(true);
}

describe("compatible thinking stream sanitization", () => {
  it("keeps text, tools, usage, and stop semantics in all six cross-protocol directions", async () => {
    const fixtures: Record<Protocol, string[]> = {
      messages: [...messagesFrames],
      chat: [...chatFrames],
      responses: responsesTerminalFrames(),
    };
    for (const source of ["messages", "chat", "responses"] as const) {
      for (const target of ["messages", "chat", "responses"] as const) {
        if (source === target) continue;
        const result = await convert(source, target, fixtures[source]);
        expectVisibleResult(result.text, target);
      }
    }
  });

  it("sanitizes a Responses terminal-only envelope and summary_done without requiring deltas", async () => {
    const frames = responsesTerminalFrames().filter((value) => !value.includes("response.reasoning_summary_part.added"));
    for (const target of ["messages", "chat"] as const) {
      const result = await convert("responses", target, frames);
      expectVisibleResult(result.text, target);
    }
  });

  it("keeps server errors visible in compatible mode", async () => {
    const frames = [
      frame({ id: "server-error", model: "demo", choices: [{ index: 0, delta: { role: "assistant", content: "before error" }, finish_reason: null }] }),
      frame({ error: { type: "server_error", message: "upstream failed" } }),
    ];
    const result = await convert("chat", "messages", frames);
    const events = parseSseChunked([result.text]);
    expect(result.text).toContain("before error");
    expect(result.text).toContain("upstream failed");
    expect(events.some((event) => event.event === "error")).toBe(true);
    expect(events.some((event) => event.event === "message_stop")).toBe(false);

    const failedResponses = [
      frame({ type: "response.failed", response: { id: "failed", model: "demo", status: "failed", output: [{ type: "reasoning", summary: [{ type: "summary_text", text: "do-not-hide-error" }] }], error: { type: "server_error", message: "responses failed" } } }, "response.failed"),
    ];
    const failed = await convert("responses", "chat", failedResponses);
    expect(failed.text).toContain("responses failed");
    expect(failed.text).not.toContain("do-not-hide-error");
    expect(parseSseChunked([failed.text]).some((event) => event.data.includes("server_error"))).toBe(true);
  });

  it("keeps strict mode rejecting meaningful native reasoning", async () => {
    const result = await convert("messages", "chat", [...messagesFrames], "strict");
    const events = parseSseChunked([result.text]);
    expect(result.text).toContain("reasoning");
    expect(events.some((event) => event.data.includes("stream_error"))).toBe(true);
    expect(events.some((event) => event.data === "[DONE]")).toBe(false);
  });

  it("returns the original same-protocol stream without sanitizing or rewriting bytes", async () => {
    const input = stream([...chatFrames]);
    const output = convertSseStream("chat", "chat", input, { thinkingMode: "compatible" });
    expect(output).toBe(input);
    const original = await new Response(input).text();
    expect(original).toContain("internal-thought");
    expect(original).toContain("signature-part-1");
  });
});
