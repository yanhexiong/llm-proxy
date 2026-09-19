import { env } from "cloudflare:workers";
import { afterEach, describe, expect, it, vi } from "vitest";
import app from "../src/index";
import { signCredential } from "../src/auth";
import { convertRequest, convertRequestInternal, convertResponse, convertResponseInternal, stripThinkingRequest } from "../src/protocols";
import type { Env, Protocol } from "../src/types";

const protocols = ["messages", "chat", "responses"] as const;
const compatible = { thinkingMode: "compatible" } as const;
const argumentsValue = { thinking: "business-field", signature: "business-signature", reasoning: "business-reasoning" };
const argumentsText = JSON.stringify(argumentsValue);
const hidden = "provider-native-state-must-not-cross";

function requestBody(protocol: Protocol): Record<string, unknown> {
  if (protocol === "messages") return {
    model: "demo", max_tokens: 4096, thinking: { type: "adaptive" }, output_config: { effort: "high" },
    messages: [
      { role: "user", content: "Hello" },
      { role: "assistant", content: [{ type: "thinking", thinking: hidden, signature: hidden }] },
      { role: "assistant", content: [
        { type: "thinking", thinking: hidden, signature: hidden }, { type: "redacted_thinking", data: hidden },
        { type: "text", text: "Visible answer" }, { type: "tool_use", id: "call-1", name: "lookup", input: argumentsValue },
      ] },
      { role: "user", content: [{ type: "tool_result", tool_use_id: "call-1", content: argumentsText }] },
    ],
  };
  if (protocol === "chat") return {
    model: "demo", reasoning_effort: "high", thinking: { enabled: true },
    messages: [
      { role: "user", content: "Hello" },
      { role: "assistant", content: null, reasoning_content: hidden },
      { role: "assistant", content: "Visible answer", reasoning_content: hidden, tool_calls: [
        { type: "function", id: "call-1", function: { name: "lookup", arguments: argumentsText } },
      ] },
      { role: "tool", tool_call_id: "call-1", content: argumentsText },
    ],
  };
  return {
    model: "demo", reasoning: { effort: "high" }, include: ["reasoning.encrypted_content"],
    input: [
      { role: "user", content: "Hello" },
      { type: "reasoning", id: "reason-1", summary: [{ type: "summary_text", text: hidden }], encrypted_content: hidden },
      { role: "assistant", content: "Visible answer" },
      { type: "function_call", call_id: "call-1", name: "lookup", arguments: argumentsText },
      { type: "function_call_output", call_id: "call-1", output: argumentsText },
    ],
  };
}

function responseBody(protocol: Protocol): Record<string, unknown> {
  if (protocol === "messages") return {
    id: "msg-1", type: "message", role: "assistant", model: "demo", stop_reason: "tool_use",
    content: [{ type: "thinking", thinking: hidden, signature: hidden }, { type: "redacted_thinking", data: hidden },
      { type: "text", text: "Visible answer" }, { type: "tool_use", id: "call-1", name: "lookup", input: argumentsValue }],
    usage: { input_tokens: 12, output_tokens: 5 },
  };
  if (protocol === "chat") return {
    id: "chat-1", object: "chat.completion", model: "demo",
    choices: [{ index: 0, finish_reason: "tool_calls", message: {
      role: "assistant", content: "Visible answer", reasoning_content: hidden,
      tool_calls: [{ type: "function", id: "call-1", function: { name: "lookup", arguments: argumentsText } }],
    } }], usage: { prompt_tokens: 12, completion_tokens: 5, total_tokens: 17 },
  };
  return {
    id: "resp-1", object: "response", model: "demo", status: "completed",
    output: [
      { type: "reasoning", id: "reason-1", encrypted_content: hidden, summary: [{ type: "summary_text", text: hidden }] },
      { type: "message", role: "assistant", content: [{ type: "output_text", text: "Visible answer" }] },
      { type: "function_call", call_id: "call-1", name: "lookup", arguments: argumentsText },
    ], usage: { input_tokens: 12, output_tokens: 5, total_tokens: 17 },
  };
}

afterEach(() => vi.restoreAllMocks());

describe("cross-protocol thinking compatibility", () => {
  it("keeps text, tool arguments/results and original objects intact in all six request directions", () => {
    for (const source of protocols) for (const target of protocols) {
      if (source === target) continue;
      const body = requestBody(source);
      const original = JSON.stringify(body);
      const result = convertRequest(source, target, body, compatible);
      expect(JSON.stringify(body)).toBe(original);
      expect(JSON.stringify(result)).not.toContain(hidden);
      const normalized = convertRequestInternal(target, result);
      const blocks = normalized.messages.flatMap(message => message.content);
      expect(blocks).toContainEqual({ type: "text", text: "Visible answer" });
      expect(blocks).toContainEqual({ type: "tool_use", id: "call-1", name: "lookup", input: argumentsValue });
      expect(blocks.some(block => block.type === "tool_result" && block.toolUseId === "call-1" && JSON.stringify(block.content).includes("business-field"))).toBe(true);
    }
  });

  it.each(["disabled", "enabled", "adaptive"])("accepts Messages thinking=%s for both OpenAI protocols", type => {
    for (const target of ["chat", "responses"] as const) {
      const body = { model: "demo", messages: [{ role: "user", content: "Hello" }], max_tokens: 4096, thinking: { type, budget_tokens: 2048 } };
      expect(() => convertRequest("messages", target, body, compatible)).not.toThrow();
      expect(() => convertRequest("messages", target, body)).toThrow(/thinking/);
    }
  });

  it("preserves response text, tool IDs and usage in all six directions without emitting provider state", () => {
    for (const source of protocols) for (const target of protocols) {
      if (source === target) continue;
      const result = convertResponse(source, target, responseBody(source), compatible);
      expect(JSON.stringify(result)).not.toContain(hidden);
      const normalized = convertResponseInternal(target, result);
      expect(normalized.messages.flatMap(message => message.content)).toEqual(expect.arrayContaining([
        { type: "text", text: "Visible answer" },
        { type: "tool_use", id: "call-1", name: "lookup", input: argumentsValue },
      ]));
      expect(normalized.finishReason).toBe("tool_call");
      expect(normalized.usage).toMatchObject({ inputTokens: 12, outputTokens: 5, totalTokens: 17 });
    }
  });

  it("does not remove arbitrary user data or unrelated unsupported state", () => {
    const tool = { type: "function", function: { name: "lookup", parameters: { type: "object", properties: { thinking: { type: "string" } } } } };
    const body = { ...requestBody("chat"), tools: [tool] };
    const stripped = stripThinkingRequest("chat", body) as Record<string, unknown>;
    expect(stripped.tools).toBe(body.tools);
    expect(() => convertRequest("responses", "chat", { ...requestBody("responses"), previous_response_id: "old-id" }, compatible)).toThrow(/previous_response_id/);
    expect(() => convertRequest("messages", "chat", { model: "demo", messages: [{ role: "user", content: [{ type: "unrecognized-native-feature" }] }] }, compatible)).toThrow();
  });

  it("keeps same-protocol bodies unchanged even with compatibility enabled", () => {
    for (const protocol of protocols) {
      const request = requestBody(protocol);
      const response = responseBody(protocol);
      expect(convertRequest(protocol, protocol, request, compatible)).toMatchObject({ kind: "passthrough", body: request });
      expect((convertResponse(protocol, protocol, response, compatible) as { body: unknown }).body).toBe(response);
    }
  });

  it("fixes the real HTTP 400 by default, exposes compatibility mode and retains strict opt-in", async () => {
    const id = crypto.randomUUID();
    await env.DB.prepare("INSERT INTO links(id, client_protocol, upstream_protocol, target_type, direct_base_url) VALUES (?, 'messages', 'chat', 'direct', 'https://upstream.example/v1')").bind(id).run();
    const credential = await signCredential(id, env.LINK_SIGNING_SECRET);
    const url = `https://gateway.test/${credential}/messages/chat/u/upstream.example/v1/-/v1/messages`;
    const upstream = vi.spyOn(globalThis, "fetch").mockImplementation(async (_url, init) => {
      const forwarded = JSON.parse(await new Response(init?.body as BodyInit).text());
      expect(forwarded.thinking).toBeUndefined();
      expect(JSON.stringify(forwarded)).not.toContain(hidden);
      return Response.json(responseBody("chat"));
    });
    const init = { method: "POST", headers: { "content-type": "application/json", "x-api-key": "test-key" }, body: JSON.stringify(requestBody("messages")) };
    const result = await app.request(url, init, env as unknown as Env);
    expect(result.status).toBe(200);
    expect(result.headers.get("x-gateway-thinking-mode")).toBe("compatible");
    const body = await result.text();
    expect(body).toContain("Visible answer");
    expect(body).not.toContain(hidden);
    const strict = await app.request(url, init, { ...env, CROSS_PROTOCOL_THINKING: "strict" } as unknown as Env);
    expect(strict.status).toBe(400);
    expect(upstream).toHaveBeenCalledTimes(1);
  });
});
