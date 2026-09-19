import { env } from "cloudflare:workers";
import { afterEach, describe, expect, it, vi } from "vitest";
import app from "../src/index";
import { signCredential } from "../src/auth";
import type { Env, Protocol } from "../src/types";

const bindings = env as unknown as Env;
const protocols = ["messages", "responses", "chat"] as const;
const upstreamKey = "models-upstream-key";
const baseUrl = "https://upstream.example/custom/prefix";

afterEach(() => vi.restoreAllMocks());

async function directLink(
  clientProtocol: Protocol,
  upstreamProtocol: Protocol,
  targetBaseUrl = baseUrl,
): Promise<{ id: string; credential: string; root: string }> {
  const id = crypto.randomUUID();
  await env.DB.prepare(
    "INSERT INTO links(id, client_protocol, upstream_protocol, target_type, direct_base_url) VALUES (?, ?, ?, 'direct', ?)",
  )
    .bind(id, clientProtocol, upstreamProtocol, targetBaseUrl)
    .run();
  const credential = await signCredential(id, env.LINK_SIGNING_SECRET);
  const target = targetBaseUrl.replace(/^https:\/\//u, "");
  return {
    id,
    credential,
    root: `https://gateway.test/${credential}/${clientProtocol}/${upstreamProtocol}/u/${target}/-`,
  };
}

function proxyUrl(root: string, path = "/v1/models", query = ""): string {
  return `${root}${path}${query}`;
}

function clientKeyHeaders(protocol: Protocol, key = upstreamKey): Record<string, string> {
  return protocol === "messages" ? { "x-api-key": key } : { authorization: `Bearer ${key}` };
}

async function request(url: string, init: RequestInit = {}): Promise<Response> {
  return app.request(url, init, bindings);
}

async function bodyBytes(body: BodyInit | null | undefined): Promise<Uint8Array> {
  if (body === null || body === undefined) return new Uint8Array();
  return new Uint8Array(await new Response(body).arrayBuffer());
}

describe("generic signed passthrough", () => {
  it("proxies /v1/models to base/models for all nine protocol directions", async () => {
    const calls: Array<{ url: string; init: RequestInit }> = [];
    const upstream = vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
      calls.push({ url: String(input), init: init ?? {} });
      const body = JSON.stringify({
        object: "list",
        data: [{ id: "model-one", object: "model", custom: { untouched: true } }],
        marker: "raw-list",
      });
      return new Response(body, {
        status: 200,
        headers: {
          "content-type": "application/json",
          "cache-control": "upstream-cache-value",
          "x-ratelimit-limit": "42",
          "set-cookie": "upstream-secret=must-not-forward",
        },
      });
    });

    for (const clientProtocol of protocols) {
      for (const upstreamProtocol of protocols) {
        const link = await directLink(clientProtocol, upstreamProtocol);
        const response = await request(
          proxyUrl(link.root, "/v1/models", "?after=one&after=two&filter=a%2Fb%20c"),
          {
            method: "GET",
            headers: {
              ...clientKeyHeaders(upstreamProtocol),
              cookie: "gateway_session=do-not-forward",
              origin: "https://caller.example",
              referer: "https://caller.example/docs",
            },
          },
        );
        expect(response.status, `${clientProtocol}->${upstreamProtocol}`).toBe(200);
        expect(await response.text(), `${clientProtocol}->${upstreamProtocol}`).toBe(
          '{"object":"list","data":[{"id":"model-one","object":"model","custom":{"untouched":true}}],"marker":"raw-list"}',
        );
        expect(response.headers.get("cache-control"), `${clientProtocol}->${upstreamProtocol}`).toBe("no-store");
        expect(response.headers.get("x-ratelimit-limit"), `${clientProtocol}->${upstreamProtocol}`).toBe("42");
        expect(response.headers.has("set-cookie"), `${clientProtocol}->${upstreamProtocol}`).toBe(false);
      }
    }

    expect(upstream).toHaveBeenCalledTimes(9);
    expect(calls).toHaveLength(9);
    for (const [index, call] of calls.entries()) {
      const upstreamProtocol = protocols[index % 3];
      const direction = `${protocols[Math.floor(index / 3)]}->${upstreamProtocol}`;
      expect(call.url, direction).toBe("https://upstream.example/custom/prefix/models?after=one&after=two&filter=a%2Fb%20c");
      expect(call.init.method, direction).toBe("GET");
      expect(call.init.body == null, direction).toBe(true);
      expect(call.init.redirect, direction).toBe("manual");
      const headers = new Headers(call.init.headers);
      expect(headers.has("cookie"), direction).toBe(false);
      expect(headers.has("origin"), direction).toBe(false);
      expect(headers.has("referer"), direction).toBe(false);
      if (upstreamProtocol === "messages") {
        expect(headers.get("x-api-key"), direction).toBe(upstreamKey);
      } else {
        expect(headers.get("authorization"), direction).toBe(`Bearer ${upstreamKey}`);
      }
    }
  });

  it("maps /models to the same base, preserves trailing slash, query encoding, and unknown vendor paths", async () => {
    const link = await directLink("responses", "chat");
    const calls: string[] = [];
    const upstream = vi.spyOn(globalThis, "fetch").mockImplementation(async input => {
      calls.push(String(input));
      return new Response('{"object":"list","data":[]}', { headers: { "content-type": "application/json" } });
    });

    for (const path of ["/models", "/models/", "/v1/models", "/v1/models/"]) {
      const response = await request(proxyUrl(link.root, path, "?page=2&page=3&cursor=%E4%B8%AD%2F1"), {
        method: "GET",
        headers: { authorization: `Bearer ${upstreamKey}` },
      });
      expect(response.status, path).toBe(200);
    }

    const unknown = await request(proxyUrl(link.root, "/v1/not-a-special-vendor-path", "?a=1&a=2"), {
      method: "GET",
      headers: { authorization: `Bearer ${upstreamKey}` },
    });
    expect(unknown.status).toBe(200);

    expect(upstream).toHaveBeenCalledTimes(5);
    expect(calls).toEqual([
      "https://upstream.example/custom/prefix/models?page=2&page=3&cursor=%E4%B8%AD%2F1",
      "https://upstream.example/custom/prefix/models/?page=2&page=3&cursor=%E4%B8%AD%2F1",
      "https://upstream.example/custom/prefix/models?page=2&page=3&cursor=%E4%B8%AD%2F1",
      "https://upstream.example/custom/prefix/models/?page=2&page=3&cursor=%E4%B8%AD%2F1",
      "https://upstream.example/custom/prefix/not-a-special-vendor-path?a=1&a=2",
    ]);
  });

  it("passes unknown token_usage methods, bytes, headers, query strings, and responses unchanged", async () => {
    const link = await directLink("chat", "responses");
    const calls: Array<{ url: string; init: RequestInit; body: Uint8Array }> = [];
    const upstream = vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
      const requestInit = init ?? {};
      calls.push({ url: String(input), init: requestInit, body: await bodyBytes(requestInit.body) });
      const method = requestInit.method;
      if (method === "HEAD") return new Response(null, { status: 204, headers: { "x-quota-remaining": "7" } });
      return new Response(new Uint8Array([0, 255, 1, 2, 3, 4]), {
        status: method === "DELETE" ? 207 : 201,
        headers: {
          "content-type": "application/octet-stream",
          "x-quota-remaining": "7",
          "retry-after": "9",
          "set-cookie": "vendor-secret=hidden",
        },
      });
    });
    const commonHeaders = {
      authorization: `Bearer ${upstreamKey}`,
      "new-api-user": "user-123",
      "content-type": "application/octet-stream",
      cookie: "secret=hidden",
      origin: "https://caller.example",
      "x-forwarded-for": "198.51.100.4",
    };
    const postBody = new Uint8Array([0, 255, 10, 13, 1]);
    const deleteBody = new Uint8Array([8, 7, 6, 5]);

    const post = await request(proxyUrl(link.root, "/v1/token_usage", "?id=one&id=two&encoded=a%2Fb"), {
      method: "POST",
      headers: commonHeaders,
      body: postBody,
    });
    expect(post.status).toBe(201);
    expect(new Uint8Array(await post.arrayBuffer())).toEqual(new Uint8Array([0, 255, 1, 2, 3, 4]));
    expect(post.headers.get("x-quota-remaining")).toBe("7");
    expect(post.headers.get("retry-after")).toBe("9");
    expect(post.headers.has("set-cookie")).toBe(false);

    const deleted = await request(proxyUrl(link.root, "/api/usage/token", "?id=delete"), {
      method: "DELETE",
      headers: commonHeaders,
      body: deleteBody,
    });
    expect(deleted.status).toBe(207);

    const head = await request(proxyUrl(link.root, "/api/usage/token/", "?id=head&id=again"), {
      method: "HEAD",
      headers: commonHeaders,
    });
    expect(head.status).toBe(204);
    expect(head.headers.get("x-quota-remaining")).toBe("7");

    expect(upstream).toHaveBeenCalledTimes(3);
    expect(calls[0]?.url).toBe("https://upstream.example/custom/prefix/token_usage?id=one&id=two&encoded=a%2Fb");
    expect(calls[1]?.url).toBe("https://upstream.example/custom/prefix/api/usage/token?id=delete");
    expect(calls[2]?.url).toBe("https://upstream.example/custom/prefix/api/usage/token/?id=head&id=again");
    expect(calls[0]?.init.method).toBe("POST");
    expect(calls[1]?.init.method).toBe("DELETE");
    expect(calls[2]?.init.method).toBe("HEAD");
    expect(calls[0]?.body).toEqual(postBody);
    expect(calls[1]?.body).toEqual(deleteBody);
    expect(calls[2]?.body).toEqual(new Uint8Array());
    for (const call of calls) {
      const headers = new Headers(call.init.headers);
      expect(headers.get("new-api-user")).toBe("user-123");
      expect(headers.get("content-type")).toBe("application/octet-stream");
      expect(headers.has("cookie")).toBe(false);
      expect(headers.has("origin")).toBe(false);
      expect(headers.has("x-forwarded-for")).toBe(false);
      expect(call.init.redirect).toBe("manual");
    }
  });

  it("preserves supplied auth headers and only fills missing target authentication/version", async () => {
    const supplied = await directLink("chat", "messages");
    const missing = await directLink("chat", "responses");
    const calls: Array<{ url: string; headers: Headers }> = [];
    const upstream = vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
      calls.push({ url: String(input), headers: new Headers(init?.headers) });
      return new Response('{"ok":true}', { headers: { "content-type": "application/json" } });
    });

    await request(proxyUrl(supplied.root, "/models"), {
      method: "GET",
      headers: {
        authorization: "Bearer client-bearer",
        "x-api-key": "client-x-key",
        "anthropic-version": "2024-01-01",
        "new-api-user": "keep-me",
        cookie: "no",
      },
    });
    await request(proxyUrl(missing.root, "/models"), {
      method: "GET",
      headers: { "x-api-key": "fallback-key", "new-api-user": "keep-me" },
    });

    expect(upstream).toHaveBeenCalledTimes(2);
    expect(calls[0]?.url).toBe("https://upstream.example/custom/prefix/models");
    expect(calls[0]?.headers.get("authorization")).toBe("Bearer client-bearer");
    expect(calls[0]?.headers.get("x-api-key")).toBe("client-x-key");
    expect(calls[0]?.headers.get("anthropic-version")).toBe("2024-01-01");
    expect(calls[0]?.headers.get("new-api-user")).toBe("keep-me");
    expect(calls[0]?.headers.has("cookie")).toBe(false);

    expect(calls[1]?.headers.get("x-api-key")).toBe("fallback-key");
    expect(calls[1]?.headers.get("authorization")).toBe("Bearer fallback-key");
    expect(calls[1]?.headers.get("new-api-user")).toBe("keep-me");
  });

  it("keeps upstream error status, body, retry headers, and no-store without generation conversion", async () => {
    const link = await directLink("messages", "chat");
    const upstream = vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response('{"error":{"vendor_code":"quota_exhausted","message":"raw vendor error"}}', {
        status: 429,
        headers: {
          "content-type": "application/json",
          "retry-after": "23",
          "x-quota-reset": "tomorrow",
          "set-cookie": "vendor=secret",
        },
      }),
    );

    const response = await request(proxyUrl(link.root, "/v1/token_usage"), {
      method: "POST",
      headers: { authorization: `Bearer ${upstreamKey}`, "content-type": "application/json" },
      body: '{"raw":true}',
    });
    expect(response.status).toBe(429);
    expect(await response.text()).toBe('{"error":{"vendor_code":"quota_exhausted","message":"raw vendor error"}}');
    expect(response.headers.get("retry-after")).toBe("23");
    expect(response.headers.get("x-quota-reset")).toBe("tomorrow");
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(response.headers.has("set-cookie")).toBe(false);
    expect(upstream).toHaveBeenCalledTimes(1);
  });

  it("follows an updated alias but does not accept the old base as a signed target", async () => {
    const aliasId = crypto.randomUUID();
    const linkId = crypto.randomUUID();
    const aliasName = `passthrough-${aliasId}`;
    await env.DB.batch([
      env.DB.prepare("INSERT INTO aliases(id, name, base_url) VALUES (?, ?, ?)").bind(aliasId, aliasName, "https://old.example/api/v1"),
      env.DB.prepare("INSERT INTO links(id, client_protocol, upstream_protocol, target_type, alias_id) VALUES (?, 'chat', 'responses', 'alias', ?)").bind(linkId, aliasId),
      env.DB.prepare("UPDATE aliases SET base_url = ? WHERE id = ?").bind("https://new.example/custom", aliasId),
    ]);
    const credential = await signCredential(linkId, env.LINK_SIGNING_SECRET);
    const root = `https://gateway.test/${credential}/chat/responses/a/${aliasName}/-`;
    const upstream = vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response('{"alias":true}', { headers: { "content-type": "application/json" } }),
    );

    const current = await request(proxyUrl(root, "/v1/models"), {
      method: "GET",
      headers: { authorization: `Bearer ${upstreamKey}` },
    });
    expect(current.status).toBe(200);
    expect(String(upstream.mock.calls[0]?.[0])).toBe("https://new.example/custom/models");

    const oldTarget = await request(
      `https://gateway.test/${credential}/chat/responses/u/old.example/api/v1/-/v1/models`,
      { method: "GET", headers: { authorization: `Bearer ${upstreamKey}` } },
    );
    expect(oldTarget.status).toBe(403);
    expect(upstream).toHaveBeenCalledTimes(1);
  });

  it("rejects missing keys, invalid scope, tampering, revocation, and encoded base escapes before fetch", async () => {
    const link = await directLink("responses", "chat");
    const upstream = vi.spyOn(globalThis, "fetch");
    const auth = { authorization: `Bearer ${upstreamKey}` };

    const missingKey = await request(proxyUrl(link.root), { method: "GET" });
    expect(missingKey.status).toBe(401);

    const wrongScope = await request(
      proxyUrl(link.root.replace("/responses/chat/", "/messages/chat/")),
      { method: "GET", headers: { "x-api-key": upstreamKey } },
    );
    expect(wrongScope.status).toBe(403);

    const tamperedCredential = await request(
      proxyUrl(link.root.replace(/\.[^/]+(?=\/responses)/u, ".tampered")),
      { method: "GET", headers: auth },
    );
    expect(tamperedCredential.status).toBe(403);

    const tamperedTarget = await request(
      proxyUrl(link.root.replace("upstream.example/custom/prefix", "other.example/custom/prefix")),
      { method: "GET", headers: auth },
    );
    expect(tamperedTarget.status).toBe(403);

    const encodedParent = await request(
      proxyUrl(link.root.replace("upstream.example/custom/prefix", "upstream.example/custom/prefix/%2e%2e/escape")),
      { method: "GET", headers: auth },
    );
    expect(encodedParent.status).toBe(403);

    const encodedBackslash = await request(
      proxyUrl(link.root.replace("upstream.example/custom/prefix", "upstream.example/custom/prefix%5cescape")),
      { method: "GET", headers: auth },
    );
    expect(encodedBackslash.status).toBe(403);

    await env.DB.prepare("UPDATE links SET revoked_at = datetime('now') WHERE id = ?").bind(link.id).run();
    const revoked = await request(proxyUrl(link.root), { method: "GET", headers: auth });
    expect(revoked.status).toBe(403);
    expect(upstream).not.toHaveBeenCalled();
  });

  it("keeps known generation endpoints POST-only and prevents generic fallback", async () => {
    const link = await directLink("responses", "chat");
    const upstream = vi.spyOn(globalThis, "fetch");
    const headers = { authorization: `Bearer ${upstreamKey}` };

    const getWithV1 = await request(proxyUrl(link.root, "/v1/responses"), { method: "GET", headers });
    expect(getWithV1.status).toBe(405);

    const getWithoutV1 = await request(proxyUrl(link.root, "/responses"), { method: "GET", headers });
    expect(getWithoutV1.status).toBe(405);

    const mismatched = await request(proxyUrl(link.root, "/v1/messages"), {
      method: "POST",
      headers: { "x-api-key": upstreamKey },
      body: "{}",
    });
    expect(mismatched.status).toBe(404);
    expect(upstream).not.toHaveBeenCalled();
  });

  it("returns ordinary vendor 404 responses unchanged and does not special-case hosts", async () => {
    const link = await directLink("chat", "chat", "https://api.deepseek.com/anthropic/v1");
    const upstream = vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response('{"detail":"vendor path does not exist"}', {
        status: 404,
        headers: { "content-type": "application/json" },
      }),
    );

    const response = await request(proxyUrl(link.root, "/v1/not-models"), {
      method: "GET",
      headers: { authorization: `Bearer ${upstreamKey}` },
    });
    expect(response.status).toBe(404);
    expect(await response.text()).toBe('{"detail":"vendor path does not exist"}');
    expect(String(upstream.mock.calls[0]?.[0])).toBe("https://api.deepseek.com/anthropic/v1/not-models");
  });
});
