import { describe, expect, it } from "vitest";
import {
  ProtocolConversionError,
  convertRequest,
  convertResponse,
  convertSseStream,
  decodeProtocolSseEvent,
  isPassthrough,
  parseSseChunked,
} from "../../src/protocols";

const imageData = "data:image/png;base64,ZmFrZQ==";

const messagesRequest = {
  model: "demo-model",
  system: [{ type: "text", text: "You are precise." }],
  messages: [
    { role: "user", content: [{ type: "text", text: "Describe this" }, { type: "image", source: { type: "base64", media_type: "image/png", data: "ZmFrZQ==" } }] },
    { role: "assistant", content: [{ type: "tool_use", id: "call-1", name: "weather", input: { city: "Shanghai" } }] },
    { role: "user", content: [{ type: "tool_result", tool_use_id: "call-1", content: [{ type: "text", text: "22 C" }] }] },
  ],
  tools: [{ name: "weather", description: "Get weather", input_schema: { type: "object", properties: { city: { type: "string" } } } }],
  tool_choice: { type: "tool", name: "weather" },
  temperature: 0.2,
  top_p: 0.8,
  max_tokens: 300,
  stream: false,
};

const chatRequest = {
  model: "demo-model",
  messages: [
    { role: "system", content: "You are precise." },
    { role: "developer", content: "Return compact answers." },
    { role: "user", content: [{ type: "text", text: "Describe this" }, { type: "image_url", image_url: { url: imageData, detail: "high" } }] },
    { role: "assistant", content: null, tool_calls: [{ id: "call-1", type: "function", function: { name: "weather", arguments: '{"city":"Shanghai"}' } }] },
    { role: "tool", tool_call_id: "call-1", content: "22 C" },
  ],
  tools: [{ type: "function", function: { name: "weather", description: "Get weather", parameters: { type: "object" } } }],
  tool_choice: { type: "function", function: { name: "weather" } },
  temperature: 0.2,
  top_p: 0.8,
  max_tokens: 300,
  stream: false,
};

const responsesRequest = {
  model: "demo-model",
  instructions: "You are precise.",
  input: [
    { type: "message", role: "user", content: [{ type: "input_text", text: "Describe this" }, { type: "input_image", image_url: imageData }] },
    { type: "function_call", id: "call-1", call_id: "call-1", name: "weather", arguments: '{"city":"Shanghai"}' },
    { type: "function_call_output", call_id: "call-1", output: "22 C" },
  ],
  tools: [{ type: "function", name: "weather", description: "Get weather", parameters: { type: "object" } }],
  tool_choice: { type: "function", name: "weather" },
  temperature: 0.2,
  top_p: 0.8,
  max_output_tokens: 300,
  stream: false,
};

const responseBodies = {
  messages: {
    id: "msg-1",
    type: "message",
    role: "assistant",
    model: "demo-model",
    content: [{ type: "text", text: "Done" }, { type: "tool_use", id: "call-1", name: "weather", input: { city: "Shanghai" } }],
    stop_reason: "tool_use",
    stop_sequence: null,
    usage: { input_tokens: 4, output_tokens: 5, cache_read_input_tokens: 1, cache_creation_input_tokens: 0 },
  },
  chat: {
    id: "chat-1",
    object: "chat.completion",
    created: 1,
    model: "demo-model",
    choices: [{ index: 0, message: { role: "assistant", content: "Done", tool_calls: [{ id: "call-1", type: "function", function: { name: "weather", arguments: '{"city":"Shanghai"}' } }] }, finish_reason: "tool_calls" }],
    usage: { prompt_tokens: 4, completion_tokens: 5, total_tokens: 9, prompt_tokens_details: { cached_tokens: 1 } },
  },
  responses: {
    id: "resp-1",
    object: "response",
    created_at: 1,
    model: "demo-model",
    status: "completed",
    output: [
      { type: "message", id: "out-1", role: "assistant", status: "completed", content: [{ type: "output_text", text: "Done", annotations: [] }] },
      { type: "function_call", id: "call-1", call_id: "call-1", name: "weather", arguments: '{"city":"Shanghai"}', status: "completed" },
    ],
    usage: { input_tokens: 4, output_tokens: 5, total_tokens: 9, input_tokens_details: { cached_tokens: 1 } },
  },
} as const;

describe("protocol request conversion", () => {
  it("converts all six request directions while retaining instructions, images and tools", () => {
    const mToC = convertRequest("messages", "chat", messagesRequest) as Record<string, any>;
    expect(mToC.messages[0]).toMatchObject({ role: "system", content: "You are precise." });
    expect(mToC.messages.some((message: any) => message.role === "tool")).toBe(true);
    expect(mToC.tools[0].function.name).toBe("weather");
    expect(mToC.messages[1].content[1].image_url.url).toBe(imageData);

    const mToR = convertRequest("messages", "responses", messagesRequest) as Record<string, any>;
    expect(mToR.instructions).toBe("You are precise.");
    expect(mToR.input.some((item: any) => item.type === "function_call")).toBe(true);

    const cToM = convertRequest("chat", "messages", chatRequest) as Record<string, any>;
    expect(cToM.system).toEqual(expect.arrayContaining([expect.objectContaining({ text: "You are precise." })]));
    expect(cToM.messages.some((message: any) => message.content.some((block: any) => block.type === "tool_result"))).toBe(true);
    const cToMImage = cToM.messages.flatMap((message: any) => message.content).find((block: any) => block.type === "image");
    expect(cToMImage.source.type).toBe("base64");

    const cToR = convertRequest("chat", "responses", chatRequest) as Record<string, any>;
    expect(cToR.input.some((item: any) => item.type === "function_call_output")).toBe(true);

    const rToM = convertRequest("responses", "messages", responsesRequest) as Record<string, any>;
    expect(rToM.system).toBe("You are precise.");
    expect(rToM.messages.some((message: any) => message.role === "user")).toBe(true);

    const rToC = convertRequest("responses", "chat", responsesRequest) as Record<string, any>;
    expect(rToC.messages.some((message: any) => message.role === "tool")).toBe(true);
    expect(rToC.messages.some((message: any) => Array.isArray(message.content) && message.content.some((block: any) => block.type === "image_url"))).toBe(true);
  });

  it("returns an identity-preserving marker for each same-protocol direction", () => {
    for (const protocol of ["messages", "responses", "chat"] as const) {
      const body = { model: "demo", messages: [] };
      const result = convertRequest(protocol, protocol, body);
      expect(isPassthrough(result, protocol)).toBe(true);
      expect((result as any).body).toBe(body);
    }
  });

  it("rejects non-convertible state with a field path", () => {
    expect(() => convertRequest("responses", "chat", { ...responsesRequest, previous_response_id: "resp-old" })).toThrow(ProtocolConversionError);
    try {
      convertRequest("responses", "chat", { ...responsesRequest, previous_response_id: "resp-old" });
    } catch (error) {
      expect(error).toMatchObject({ code: "unsupported_field", field: "previous_response_id" });
    }
    expect(() => convertRequest("responses", "chat", { ...responsesRequest, tools: [{ type: "web_search_preview" }] })).toThrow(/tools\[0\]\.type/);
    expect(() => convertRequest("chat", "messages", { ...chatRequest, thinking: { enabled: true } })).toThrow(/thinking/);
    expect(() => convertRequest("chat", "messages", { ...chatRequest, thinking: { type: "disabled" } })).not.toThrow();
    const autoToolChoice = convertRequest("chat", "messages", { ...chatRequest, tool_choice: "auto" }) as Record<string, any>;
    expect(autoToolChoice.tool_choice).toEqual({ type: "auto" });

    const parallel = convertRequest("responses", "chat", {
      model: "demo-model",
      input: [
        { type: "message", role: "user", content: "run both" },
        { type: "function_call", call_id: "call-a", name: "a", arguments: "{}" },
        { type: "function_call", call_id: "call-b", name: "b", arguments: "{}" },
        { type: "function_call_output", call_id: "call-a", output: "a-result" },
        { type: "function_call_output", call_id: "call-b", output: "b-result" },
      ],
    }) as Record<string, any>;
    const assistant = parallel.messages.find((message: any) => message.role === "assistant");
    expect(assistant.tool_calls.map((call: any) => call.id)).toEqual(["call-a", "call-b"]);
    expect(parallel.messages.filter((message: any) => message.role === "tool").map((message: any) => message.tool_call_id)).toEqual(["call-a", "call-b"]);
  });
});

describe("protocol response conversion", () => {
  it("marks length-limited Chat and Messages JSON responses as incomplete", () => {
    const chat = { ...responseBodies.chat, choices: [{ index: 0, message: { role: "assistant", content: "1 2" }, finish_reason: "length" }] };
    const messages = { ...responseBodies.messages, content: [{ type: "text", text: "1 2" }], stop_reason: "max_tokens" };
    for (const [source, body] of [["chat", chat], ["messages", messages]] as const) {
      const output = convertResponse(source, "responses", body) as Record<string, any>;
      expect(output.status).toBe("incomplete");
      expect(output.incomplete_details).toEqual({ reason: "max_output_tokens" });
    }
  });

  it("converts all six response directions with usage and finish reason", () => {
    for (const source of ["messages", "chat", "responses"] as const) {
      for (const target of ["messages", "chat", "responses"] as const) {
        if (source === target) continue;
        const converted = convertResponse(source, target, responseBodies[source]) as Record<string, any>;
        expect(converted).toBeTypeOf("object");
        if (target === "chat") expect(converted.choices[0].finish_reason).toBe("tool_calls");
        if (target === "messages") expect(converted.stop_reason).toBe("tool_use");
        if (target === "responses") expect(converted.usage.total_tokens).toBe(source === "messages" ? 10 : 9);
      }
    }
  });

  it("keeps total input semantics while adapting cache fields and Messages stop reasons", () => {
    const chatToMessages = convertResponse("chat", "messages", {
      id: "chat-stop",
      object: "chat.completion",
      model: "demo-model",
      choices: [{ index: 0, message: { role: "assistant", content: "Done" }, finish_reason: "stop" }],
      usage: { prompt_tokens: 8, completion_tokens: 2, total_tokens: 10, prompt_tokens_details: { cached_tokens: 2 } },
    }) as Record<string, any>;
    expect(chatToMessages.stop_reason).toBe("end_turn");
    expect(chatToMessages.usage).toEqual({ input_tokens: 6, output_tokens: 2, cache_read_input_tokens: 2 });

    const messagesToChat = convertResponse("messages", "chat", responseBodies.messages) as Record<string, any>;
    expect(messagesToChat.usage).toEqual({ prompt_tokens: 5, completion_tokens: 5, total_tokens: 10, prompt_tokens_details: { cached_tokens: 1 } });
    const responsesWithNullError = convertResponse("responses", "chat", { ...responseBodies.responses, error: null }) as Record<string, any>;
    expect(responsesWithNullError.choices[0].finish_reason).toBe("tool_calls");
  });
});

describe("SSE conversion", () => {
  const streamFixtures = {
    messages: [
      `event: message_start\ndata: ${JSON.stringify({ type: "message_start", message: { id: "msg-stream", type: "message", role: "assistant", model: "demo", content: [], stop_reason: null, usage: { input_tokens: 2, output_tokens: 0 } } })}\n\n`,
      `event: content_block_start\ndata: ${JSON.stringify({ type: "content_block_start", index: 0, content_block: { type: "text", text: "" } })}\n\n`,
      `event: content_block_delta\ndata: ${JSON.stringify({ type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "Hello" } })}\n\n`,
      `event: content_block_stop\ndata: ${JSON.stringify({ type: "content_block_stop", index: 0 })}\n\n`,
      `event: message_delta\ndata: ${JSON.stringify({ type: "message_delta", delta: { stop_reason: "end_turn", stop_sequence: null }, usage: { output_tokens: 1 } })}\n\n`,
      `event: message_stop\ndata: ${JSON.stringify({ type: "message_stop" })}\n\n`,
    ],
    chat: [
      `data: ${JSON.stringify({ id: "chat-stream", object: "chat.completion.chunk", model: "demo", choices: [{ index: 0, delta: { role: "assistant" }, finish_reason: null }] })}\n\n`,
      `data: ${JSON.stringify({ id: "chat-stream", object: "chat.completion.chunk", model: "demo", choices: [{ index: 0, delta: { content: "Hello" }, finish_reason: null }] })}\n\n`,
      `data: ${JSON.stringify({ id: "chat-stream", object: "chat.completion.chunk", model: "demo", choices: [{ index: 0, delta: {}, finish_reason: "stop" }], usage: { prompt_tokens: 2, completion_tokens: 1, total_tokens: 3 } })}\n\n`,
      "data: [DONE]\n\n",
    ],
    responses: [
      `event: response.created\ndata: ${JSON.stringify({ type: "response.created", response: { id: "resp-stream", object: "response", model: "demo", status: "in_progress", output: [] } })}\n\n`,
      `event: response.output_item.added\ndata: ${JSON.stringify({ type: "response.output_item.added", output_index: 0, item: { id: "item-stream", type: "message", role: "assistant", status: "in_progress", content: [] } })}\n\n`,
      `event: response.content_part.added\ndata: ${JSON.stringify({ type: "response.content_part.added", item_id: "item-stream", output_index: 0, content_index: 0, part: { type: "output_text", text: "", annotations: [] } })}\n\n`,
      `event: response.output_text.delta\ndata: ${JSON.stringify({ type: "response.output_text.delta", item_id: "item-stream", output_index: 0, content_index: 0, delta: "Hello" })}\n\n`,
      `event: response.output_text.done\ndata: ${JSON.stringify({ type: "response.output_text.done", item_id: "item-stream", output_index: 0, content_index: 0, text: "Hello" })}\n\n`,
      `event: response.completed\ndata: ${JSON.stringify({ type: "response.completed", response: { id: "resp-stream", object: "response", model: "demo", status: "completed", output: [{ id: "item-stream", type: "message", role: "assistant", status: "completed", content: [{ type: "output_text", text: "Hello", annotations: [] }] }], usage: { input_tokens: 2, output_tokens: 1, total_tokens: 3 } } })}\n\n`,
    ],
  } as const;

  it("converts all six streaming directions with text and a protocol-native terminal event", async () => {
    for (const source of ["messages", "chat", "responses"] as const) {
      for (const target of ["messages", "chat", "responses"] as const) {
        if (source === target) continue;
        const input = new ReadableStream<Uint8Array>({
          start(controller) {
            for (const frame of streamFixtures[source]) controller.enqueue(new TextEncoder().encode(frame));
            controller.close();
          },
        });
        const output = convertSseStream(source, target, input);
        const text = await new Response(output).text();
        const events = parseSseChunked([text]);
        expect(text, `${source} -> ${target} text`).toContain("Hello");
        if (target === "messages") expect(events.at(-1)?.event, `${source} -> messages terminal`).toBe("message_stop");
        if (target === "chat") expect(events.at(-1)?.data, `${source} -> chat terminal`).toBe("[DONE]");
        if (target === "responses") expect(events.at(-1)?.event, `${source} -> responses terminal`).toBe("response.completed");
        if (target !== "chat") expect(events.some((event) => event.data === "[DONE]"), `${source} -> ${target} must not leak Chat DONE`).toBe(false);
        if (target === "responses") {
          const sequenceNumbers = events.map((event) => {
            try { return JSON.parse(event.data).sequence_number; } catch { return undefined; }
          }).filter((value): value is number => typeof value === "number");
          expect(sequenceNumbers).toEqual(sequenceNumbers.map((_, index) => index));
        }
      }
    }
  });

  it("parses UTF-8 code points split across network chunks and merged events", () => {
    const source = `event: message\ndata: {"text":"中"}\n\ndata: {"text":"文"}\n\n`;
    const bytes = new TextEncoder().encode(source);
    const events = parseSseChunked(Array.from({ length: bytes.length }, (_, index) => bytes.slice(index, index + 1)));
    expect(events).toHaveLength(2);
    expect(JSON.parse(events[0]?.data ?? "{}").text).toBe("中");
    expect(JSON.parse(events[1]?.data ?? "{}").text).toBe("文");
    expect(events[0]?.event).toBe("message");
  });

  it("keeps Chat deltas, Responses done events and final output text identical", async () => {
    const input = new ReadableStream<Uint8Array>({
      start(controller) {
        for (const frame of streamFixtures.chat) controller.enqueue(new TextEncoder().encode(frame));
        controller.close();
      },
    });
    const events = parseSseChunked([await new Response(convertSseStream("chat", "responses", input)).text()]);
    const payloads = events.map(event => JSON.parse(event.data));
    const deltas = payloads.filter(event => event.type === "response.output_text.delta").map(event => event.delta).join("");
    expect(deltas).toBe("Hello");
    expect(payloads.find(event => event.type === "response.output_text.done").text).toBe(deltas);
    expect(payloads.find(event => event.type === "response.content_part.done").part.text).toBe(deltas);
    expect(payloads.find(event => event.type === "response.output_item.done").item.content[0].text).toBe(deltas);
    expect(payloads.at(-1).response.output[0].content[0].text).toBe(deltas);
  });

  it("converts a Chat stream to a Messages stream with text, usage, stop and DONE semantics", async () => {
    const source = [
      `data: ${JSON.stringify({ id: "chat-1", object: "chat.completion.chunk", created: 1, model: "demo", choices: [{ index: 0, delta: { role: "assistant" }, finish_reason: null }] })}\n\n`,
      `data: ${JSON.stringify({ id: "chat-1", object: "chat.completion.chunk", created: 1, model: "demo", choices: [{ index: 0, delta: { content: "中" }, finish_reason: null }] })}\n\n`,
      `data: ${JSON.stringify({ id: "chat-1", object: "chat.completion.chunk", created: 1, model: "demo", choices: [{ index: 0, delta: {}, finish_reason: "stop" }], usage: { prompt_tokens: 2, completion_tokens: 1, total_tokens: 3 } })}\n\n`,
      "data: [DONE]\n\n",
    ];
    const input = new ReadableStream<Uint8Array>({
      start(controller) {
        const encoder = new TextEncoder();
        for (const chunk of source) controller.enqueue(encoder.encode(chunk));
        controller.close();
      },
    });
    const output = convertSseStream("chat", "messages", input);
    const text = new TextDecoder().decode(await new Response(output).arrayBuffer());
    const events = parseSseChunked([text]);
    expect(events.map((event) => event.event)).toEqual(["message_start", "content_block_start", "content_block_delta", "content_block_stop", "message_delta", "message_stop"]);
    expect(events.some((event) => event.data.includes("中"))).toBe(true);
    expect(events.at(-1)?.data).toContain("message_stop");
  });

  it("buffers a delayed Chat tool name until the first complete tool block", async () => {
    const encoder = new TextEncoder();
    const chunks = [
      `data: ${JSON.stringify({ id: "chat-tool", model: "demo", choices: [{ index: 0, delta: { role: "assistant" }, finish_reason: null }] })}\n\n`,
      `data: ${JSON.stringify({ id: "chat-tool", model: "demo", choices: [{ index: 0, delta: { tool_calls: [{ index: 0, id: "call-1", type: "function", function: { arguments: '{"city":"' } }] }, finish_reason: null }] })}\n\n`,
      `data: ${JSON.stringify({ id: "chat-tool", model: "demo", choices: [{ index: 0, delta: { tool_calls: [{ index: 0, function: { name: "weather", arguments: "Shanghai\"}" } }] }, finish_reason: null }] })}\n\n`,
      `data: ${JSON.stringify({ id: "chat-tool", model: "demo", choices: [{ index: 0, delta: {}, finish_reason: "tool_calls" }] })}\n\n`,
      "data: [DONE]\n\n",
    ];
    const input = new ReadableStream<Uint8Array>({
      start(controller) {
        for (const chunk of chunks) controller.enqueue(encoder.encode(chunk));
        controller.close();
      },
    });
    const output = convertSseStream("chat", "messages", input);
    const events = parseSseChunked([new TextDecoder().decode(await new Response(output).arrayBuffer())]);
    const start = events.find((event) => event.event === "content_block_start");
    expect(JSON.parse(start?.data ?? "{}").content_block.name).toBe("weather");
    expect(events.some((event) => event.data.includes("Shanghai"))).toBe(true);
  });

  it("uses Chat tool_calls.index instead of the delta array position", async () => {
    const chunks = [
      `data: ${JSON.stringify({ id: "indexed-tools", model: "demo", choices: [{ index: 0, delta: { role: "assistant", tool_calls: [{ index: 3, id: "call-3", type: "function", function: { name: "three", arguments: '{"n":' } }, { index: 1, id: "call-1", type: "function", function: { name: "one", arguments: '{"n":' } }] }, finish_reason: null }] })}\n\n`,
      `data: ${JSON.stringify({ id: "indexed-tools", model: "demo", choices: [{ index: 0, delta: { tool_calls: [{ index: 1, function: { arguments: "1}" } }, { index: 3, function: { arguments: "3}" } }] }, finish_reason: null }] })}\n\n`,
      `data: ${JSON.stringify({ id: "indexed-tools", model: "demo", choices: [{ index: 0, delta: {}, finish_reason: "tool_calls" }] })}\n\n`,
      "data: [DONE]\n\n",
    ];
    const makeInput = () => new ReadableStream<Uint8Array>({
      start(controller) {
        const encoder = new TextEncoder();
        for (const chunk of chunks) controller.enqueue(encoder.encode(chunk));
        controller.close();
      },
    });
    const output = convertSseStream("chat", "messages", makeInput());
    const events = parseSseChunked([new TextDecoder().decode(await new Response(output).arrayBuffer())]);
    const starts = events.filter((event) => event.event === "content_block_start").map((event) => JSON.parse(event.data).content_block);
    expect(starts.map((block: { name: string }) => block.name)).toEqual(["three", "one"]);
    const argumentDeltas = new Map<number, string>();
    for (const event of events.filter((item) => item.event === "content_block_delta")) {
      const payload = JSON.parse(event.data);
      argumentDeltas.set(payload.index, `${argumentDeltas.get(payload.index) ?? ""}${payload.delta.partial_json}`);
    }
    expect([...argumentDeltas.values()]).toEqual(['{"n":3}', '{"n":1}']);

    const responsesEvents = parseSseChunked([new TextDecoder().decode(await new Response(convertSseStream("chat", "responses", makeInput())).arrayBuffer())]);
    const terminal = responsesEvents.find((event) => event.event === "response.completed");
    const outputItems = JSON.parse(terminal?.data ?? "{}").response.output;
    expect(outputItems.map((item: { id: string }) => item.id)).toEqual(["call-3", "call-1"]);
  });

  it("waits for Chat DONE and preserves an independent cached-usage chunk", async () => {
    const chunks = [
      `data: ${JSON.stringify({ id: "usage-after-finish", model: "demo", choices: [{ index: 0, delta: { role: "assistant", content: "ok" }, finish_reason: null }] })}\n\n`,
      `data: ${JSON.stringify({ id: "usage-after-finish", model: "demo", choices: [{ index: 0, delta: {}, finish_reason: "stop" }], usage: null })}\n\n`,
      `data: ${JSON.stringify({ id: "usage-after-finish", model: "demo", choices: [], usage: { prompt_tokens: 8, completion_tokens: 2, total_tokens: 10, prompt_tokens_details: { cached_tokens: 5 } } })}\n\n`,
      "data: [DONE]\n\n",
    ];
    const input = new ReadableStream<Uint8Array>({
      start(controller) {
        const encoder = new TextEncoder();
        for (const chunk of chunks) controller.enqueue(encoder.encode(chunk));
        controller.close();
      },
    });
    const output = convertSseStream("chat", "responses", input);
    const events = parseSseChunked([new TextDecoder().decode(await new Response(output).arrayBuffer())]);
    const terminal = events.at(-1);
    expect(terminal?.event).toBe("response.completed");
    expect(JSON.parse(terminal?.data ?? "{}").response.usage).toEqual({ input_tokens: 8, output_tokens: 2, total_tokens: 10, input_tokens_details: { cached_tokens: 5 } });

    const messagesOutput = new ReadableStream<Uint8Array>({
      start(controller) {
        const encoder = new TextEncoder();
        for (const chunk of chunks) controller.enqueue(encoder.encode(chunk));
        controller.close();
      },
    });
    const messagesEvents = parseSseChunked([new TextDecoder().decode(await new Response(convertSseStream("chat", "messages", messagesOutput)).arrayBuffer())]);
    expect(messagesEvents.filter((event) => event.event === "message_stop")).toHaveLength(1);
    const messageDelta = messagesEvents.find((event) => event.event === "message_delta");
    expect(JSON.parse(messageDelta?.data ?? "{}").usage).toMatchObject({ input_tokens: 3, cache_read_input_tokens: 5 });
  });

  it("adds Messages cache tokens before conversion and reconstructs partial totals", async () => {
    const chunks = [
      `event: message_start\ndata: ${JSON.stringify({ type: "message_start", message: { id: "partial-usage", model: "demo", role: "assistant", content: [], usage: { input_tokens: 4, output_tokens: 0, cache_read_input_tokens: 2 } } })}\n\n`,
      `event: message_delta\ndata: ${JSON.stringify({ type: "message_delta", delta: { stop_reason: "end_turn" }, usage: { output_tokens: 3 } })}\n\n`,
      "event: message_stop\ndata: {\"type\":\"message_stop\"}\n\n",
    ];
    const input = new ReadableStream<Uint8Array>({
      start(controller) {
        const encoder = new TextEncoder();
        for (const chunk of chunks) controller.enqueue(encoder.encode(chunk));
        controller.close();
      },
    });
    const events = parseSseChunked([new TextDecoder().decode(await new Response(convertSseStream("messages", "chat", input)).arrayBuffer())]);
    const terminal = events.find((event) => event.data.includes('"finish_reason":"stop"'));
    expect(JSON.parse(terminal?.data ?? "{}").usage).toEqual({ prompt_tokens: 6, completion_tokens: 3, total_tokens: 9, prompt_tokens_details: { cached_tokens: 2 } });
  });

  it("uses Responses incomplete terminal semantics for output truncation", async () => {
    const chunks = [
      `data: ${JSON.stringify({ id: "length-stream", model: "demo", choices: [{ index: 0, delta: { role: "assistant", content: "partial" }, finish_reason: null }] })}\n\n`,
      `data: ${JSON.stringify({ id: "length-stream", model: "demo", choices: [{ index: 0, delta: {}, finish_reason: "length" }] })}\n\n`,
      "data: [DONE]\n\n",
    ];
    const input = new ReadableStream<Uint8Array>({
      start(controller) {
        const encoder = new TextEncoder();
        for (const chunk of chunks) controller.enqueue(encoder.encode(chunk));
        controller.close();
      },
    });
    const events = parseSseChunked([new TextDecoder().decode(await new Response(convertSseStream("chat", "responses", input)).arrayBuffer())]);
    const terminal = events.at(-1);
    expect(terminal?.event).toBe("response.incomplete");
    const payload = JSON.parse(terminal?.data ?? "{}");
    expect(payload.type).toBe("response.incomplete");
    expect(payload.response.status).toBe("incomplete");
    expect(payload.response.incomplete_details).toEqual({ reason: "max_output_tokens" });
    expect(events.some((event) => event.event === "response.completed")).toBe(false);
  });

  it("does not emit a success terminal before the source terminal frame", async () => {
    const incomplete = [
      `data: ${JSON.stringify({ id: "truncated", model: "demo", choices: [{ index: 0, delta: { role: "assistant", content: "partial" }, finish_reason: null }] })}\n\n`,
      `data: ${JSON.stringify({ id: "truncated", model: "demo", choices: [{ index: 0, delta: {}, finish_reason: "stop" }] })}\n\n`,
    ];
    const input = new ReadableStream<Uint8Array>({
      start(controller) {
        const encoder = new TextEncoder();
        for (const chunk of incomplete) controller.enqueue(encoder.encode(chunk));
        controller.close();
      },
    });
    const events = parseSseChunked([new TextDecoder().decode(await new Response(convertSseStream("chat", "messages", input)).arrayBuffer())]);
    expect(events.some((event) => event.event === "message_stop")).toBe(false);
    expect(events.some((event) => event.event === "response.completed")).toBe(false);
  });

  it("keeps Responses terminal content when the completed envelope is the only text payload", async () => {
    const chunks = [
      `event: response.created\ndata: ${JSON.stringify({ type: "response.created", response: { id: "terminal-content", model: "demo", status: "in_progress", output: [] } })}\n\n`,
      `event: response.completed\ndata: ${JSON.stringify({ type: "response.completed", response: { id: "terminal-content", model: "demo", status: "completed", output: [{ id: "item-1", type: "message", role: "assistant", status: "completed", content: [{ type: "output_text", text: "terminal text", annotations: [] }] }], usage: { input_tokens: 3, output_tokens: 2, total_tokens: 5, input_tokens_details: { cached_tokens: 2 } } } })}\n\n`,
    ];
    const input = new ReadableStream<Uint8Array>({
      start(controller) {
        const encoder = new TextEncoder();
        for (const chunk of chunks) controller.enqueue(encoder.encode(chunk));
        controller.close();
      },
    });
    const events = parseSseChunked([new TextDecoder().decode(await new Response(convertSseStream("responses", "chat", input)).arrayBuffer())]);
    expect(events.some((event) => event.data.includes("terminal text"))).toBe(true);
    const terminal = events.find((event) => event.data.includes('"finish_reason":"stop"'));
    expect(terminal).toBeDefined();
    expect(JSON.parse(terminal?.data ?? "{}").usage.prompt_tokens_details.cached_tokens).toBe(2);
  });

  it("forwards a stream error without a synthetic success terminal", async () => {
    const chunks = [
      `data: ${JSON.stringify({ id: "stream-error", model: "demo", choices: [{ index: 0, delta: { role: "assistant", content: "before error" }, finish_reason: null }] })}\n\n`,
      `data: ${JSON.stringify({ error: { type: "server_error", message: "upstream failed" } })}\n\n`,
    ];
    const input = new ReadableStream<Uint8Array>({
      start(controller) {
        const encoder = new TextEncoder();
        for (const chunk of chunks) controller.enqueue(encoder.encode(chunk));
        controller.close();
      },
    });
    const events = parseSseChunked([new TextDecoder().decode(await new Response(convertSseStream("chat", "messages", input)).arrayBuffer())]);
    expect(events.some((event) => event.event === "error")).toBe(true);
    expect(events.some((event) => event.event === "message_stop")).toBe(false);
  });

  it("propagates an interrupted upstream stream instead of completing it", async () => {
    const input = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new TextEncoder().encode(`data: ${JSON.stringify({ id: "interrupted", model: "demo", choices: [{ index: 0, delta: { role: "assistant", content: "partial" }, finish_reason: null }] })}\n\n`));
        controller.error(new Error("connection reset"));
      },
    });
    const output = convertSseStream("chat", "messages", input);
    const reader = output.getReader();
    const chunks: Uint8Array[] = [];
    while (true) {
      const result = await reader.read();
      if (result.done) break;
      if (result.value) chunks.push(result.value);
    }
    const events = parseSseChunked([new TextDecoder().decode(concatBytes(chunks))]);
    expect(events.some((event) => event.event === "error")).toBe(true);
    expect(events.some((event) => event.event === "message_stop")).toBe(false);
  });

  it("rejects provider-native reasoning stream content instead of dropping it", () => {
    expect(() => decodeProtocolSseEvent("responses", {
      event: "response.output_item.added",
      data: JSON.stringify({ type: "response.output_item.added", output_index: 0, item: { type: "reasoning", id: "reason-1", content: [{ type: "reasoning_text", text: "internal" }] } }),
    })).toThrow(/reasoning/);
    expect(() => decodeProtocolSseEvent("messages", {
      event: "content_block_start",
      data: JSON.stringify({ type: "content_block_start", index: 0, content_block: { type: "thinking", thinking: "internal" } }),
    })).toThrow(/reasoning/);
    expect(decodeProtocolSseEvent("chat", {
      data: JSON.stringify({ choices: [{ index: 0, delta: { reasoning_content: null }, finish_reason: null }] }),
    })).toEqual([]);
    expect(decodeProtocolSseEvent("responses", {
      event: "response.output_item.added",
      data: JSON.stringify({ type: "response.output_item.added", output_index: 0, item: { type: "reasoning", id: "reason-empty", content: [], summary: [], encrypted_content: null } }),
    })).toEqual([]);
  });

  it("returns a readable error for Chat reasoning chunks and usage:null", async () => {
    const chunks = [
      `data: ${JSON.stringify({ id: "deepseek-chat", model: "demo", choices: [{ index: 0, delta: { role: "assistant" }, finish_reason: null }], usage: null })}\n\n`,
      `data: ${JSON.stringify({ id: "deepseek-chat", model: "demo", choices: [{ index: 0, delta: { reasoning_content: "internal" }, finish_reason: null }], usage: null })}\n\n`,
    ];
    const input = new ReadableStream<Uint8Array>({
      start(controller) {
        const encoder = new TextEncoder();
        for (const chunk of chunks) controller.enqueue(encoder.encode(chunk));
        controller.close();
      },
    });
    const events = parseSseChunked([new TextDecoder().decode(await new Response(convertSseStream("chat", "messages", input)).arrayBuffer())]);
    expect(events.some((event) => event.event === "error" && event.data.includes("reasoning"))).toBe(true);
    expect(events.some((event) => event.event === "message_stop")).toBe(false);
  });
});

function concatBytes(chunks: Uint8Array[]): Uint8Array {
  const size = chunks.reduce((total, chunk) => total + chunk.byteLength, 0);
  const output = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    output.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return output;
}
