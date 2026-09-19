import { env } from "cloudflare:workers";
import { afterEach, describe, expect, it, vi } from "vitest";
import app from "../src/index";
import { signCredential } from "../src/auth";
import type { Env, Protocol } from "../src/types";
import { fetchUpstream } from "../src/upstream";
import { prepareConvertedUpstream } from "../src/provider-compat";

afterEach(() => vi.restoreAllMocks());
const bindings = env as unknown as Env;

async function endpoint(client: Protocol, upstream: Protocol): Promise<string> {
  const id = crypto.randomUUID();
  await env.DB.prepare("INSERT INTO links(id, client_protocol, upstream_protocol, target_type, direct_base_url) VALUES (?, ?, ?, 'direct', 'https://upstream.example/api/v1')")
    .bind(id, client, upstream).run();
  const credential = await signCredential(id, env.LINK_SIGNING_SECRET);
  const suffix = client === "chat" ? "chat/completions" : client;
  return `https://gateway.test/${credential}/${client}/${upstream}/u/upstream.example/api/v1/-/v1/${suffix}`;
}

describe("upstream proxy integration", () => {
  it("only disables DeepSeek native thinking for converted upstream payloads", () => {
    const body = { model: "unchanged", input: "hi" };
    expect(prepareConvertedUpstream("https://another.example/v1", "responses", body)).toBe(body);
    expect(prepareConvertedUpstream("https://api.deepseek.com", "responses", body)).toEqual({ ...body, reasoning: { effort: "none" } });
    expect(prepareConvertedUpstream("https://api.deepseek.com/anthropic/v1", "messages", body)).toEqual({ ...body, thinking: { type: "disabled" } });
  });

  it.each(["chat", "messages", "responses"] as const)("preserves raw %s bodies and streams without forwarding cookies", async protocol => {
    const url = await endpoint(protocol, protocol);
    const requestBody = '{ "model": "demo", "provider_extension": [ 1, 2 ], "stream": true }';
    const responseBody = "data: {\"custom\":true}\n\ndata: [DONE]\n\n";
    const upstream = vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
      expect(String(input)).toBe(`https://upstream.example/api/v1/${protocol === "chat" ? "chat/completions" : protocol}`);
      expect(await new Response(init?.body as BodyInit).text()).toBe(requestBody);
      const headers = new Headers(init?.headers);
      expect(headers.has("cookie")).toBe(false);
      expect(headers.has("origin")).toBe(false);
      expect(headers.get(protocol === "messages" ? "x-api-key" : "authorization")).toBe(protocol === "messages" ? "test-key" : "Bearer test-key");
      expect(init?.redirect).toBe("manual");
      return new Response(responseBody, { headers: { "content-type": "text/event-stream" } });
    });
    const response = await app.request(url, {
      method: "POST", headers: { authorization: "Bearer test-key", cookie: "gateway_session=admin-secret", "content-type": "application/json" }, body: requestBody,
    }, bindings);
    expect(response.status).toBe(200);
    expect(await response.text()).toBe(responseBody);
    expect(upstream).toHaveBeenCalledTimes(1);
  });

  it.each([401, 429, 500])("preserves upstream HTTP %i and Retry-After using the client error shape", async status => {
    const url = await endpoint("messages", "chat");
    vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response(JSON.stringify({ error: { message: "Upstream rejected", type: "api_error" } }), {
      status, headers: { "content-type": "application/json", "retry-after": "7" },
    }));
    const response = await app.request(url, { method: "POST", headers: { "x-api-key": "test-key", "content-type": "application/json" }, body: JSON.stringify({ model: "demo", max_tokens: 32, messages: [{ role: "user", content: "hi" }] }) }, bindings);
    expect(response.status).toBe(status);
    expect(response.headers.get("retry-after")).toBe("7");
    expect(await response.json()).toMatchObject({ type: "error", error: { message: "Upstream rejected" } });
  });

  it("cancels the upstream reader when the downstream client cancels", async () => {
    const url = await endpoint("chat", "chat");
    const cancel = vi.fn();
    let networkSignal: AbortSignal | null | undefined;
    vi.spyOn(globalThis, "fetch").mockImplementation(async (_input, init) => {
      networkSignal = init?.signal;
      return new Response(new ReadableStream({
        start(controller) { controller.enqueue(new TextEncoder().encode("data: first\n\n")); },
        cancel,
      }), { headers: { "content-type": "text/event-stream" } });
    });
    const response = await app.request(url, { method: "POST", headers: { authorization: "Bearer test-key" }, body: "{}" }, bindings);
    const reader = response.body!.getReader();
    await reader.read();
    await reader.cancel("client closed");
    expect(cancel).toHaveBeenCalled();
    expect(networkSignal?.aborted).toBe(true);
  });

  it("reports malformed upstream JSON as a server-side protocol failure", async () => {
    const url = await endpoint("responses", "chat");
    vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response("<html>bad upstream</html>"));
    const response = await app.request(url, { method: "POST", headers: { authorization: "Bearer test-key" }, body: JSON.stringify({ model: "demo", input: "hi" }) }, bindings);
    expect(response.status).toBe(502);
    expect(await response.json()).toMatchObject({ error: { code: "upstream_protocol_error" } });
  });

  it("keeps the timeout active when headers arrive but the response body stalls", async () => {
    vi.spyOn(globalThis, "fetch").mockImplementation(async (_url, init) => new Response(new ReadableStream({
      start(controller) { init!.signal!.addEventListener("abort", () => controller.error(new Error("aborted")), { once: true }); },
    })));
    const response = await fetchUpstream("https://upstream.example", {}, new AbortController().signal, 20);
    await expect(response.text()).rejects.toMatchObject({ status: 504, code: "upstream_timeout" });
  });

  it("propagates incoming cancellation after response headers have arrived", async () => {
    const incoming = new AbortController();
    vi.spyOn(globalThis, "fetch").mockImplementation(async (_url, init) => new Response(new ReadableStream({
      start(controller) { init!.signal!.addEventListener("abort", () => controller.error(new Error("aborted")), { once: true }); },
    })));
    const response = await fetchUpstream("https://upstream.example", {}, incoming.signal, 2000);
    const reading = response.text();
    incoming.abort();
    await expect(reading).rejects.toMatchObject({ status: 499, code: "client_cancelled" });
  });
});
