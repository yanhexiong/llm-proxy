import { describe, expect, it } from "vitest";
import { assertClientEndpoint, normalizeBaseUrl, parseProxyRoute, proxyUrls, upstreamEndpoint } from "../src/routes";
import { passthroughUrl } from "../src/passthrough";

describe("gateway URL handling", () => {
  it("rejects nested traversal even beside a literal percent sign while preserving ordinary encoded paths", () => {
    expect(() => passthroughUrl("https://upstream.example/tenant", "/v1/%252e%252e%252fprivate%25ZZ", "")).toThrow("within the bound");
    expect(passthroughUrl("https://upstream.example/tenant", "/v1/files/name%25", "?cursor=a%2Fb&cursor=c"))
      .toBe("https://upstream.example/tenant/files/name%25?cursor=a%2Fb&cursor=c");
  });
  it("normalizes an HTTPS base URL without inventing /v1", () => {
    expect(normalizeBaseUrl("api.example.com/api/v1/")).toBe("https://api.example.com/api/v1");
    expect(upstreamEndpoint("api.example.com/api/v1", "chat")).toBe(
      "https://api.example.com/api/v1/chat/completions",
    );
  });

  it("rejects unsafe or complete upstream endpoints", () => {
    expect(() => normalizeBaseUrl("http://api.example.com/v1")).toThrow("Only HTTPS");
    expect(() => normalizeBaseUrl("https://a:b@example.com/v1")).toThrow("Credentials");
    expect(() => normalizeBaseUrl("example.com/v1/responses")).toThrow("common base URL");
    expect(() => normalizeBaseUrl("example.com/custom/messages")).toThrow("https://example.com/custom");
    expect(() => normalizeBaseUrl("example.com/responses")).toThrow("common base URL");
  });

  it("parses direct targets with custom path segments", () => {
    expect(
      parseProxyRoute("/id.sig/responses/chat/u/api.example.com/api/v1/-/v1/responses"),
    ).toEqual({
      credential: "id.sig",
      clientProtocol: "responses",
      upstreamProtocol: "chat",
      mode: "u",
      target: "api.example.com/api/v1",
      clientEndpoint: "/v1/responses",
    });
  });

  it("finds the final delimiter when the upstream path itself contains /-", () => {
    expect(parseProxyRoute("/id.sig/messages/chat/u/api.example.com/a/-/b/-/v1/messages")?.target).toBe(
      "api.example.com/a/-/b",
    );
  });

  it("rejects an endpoint that does not match the declared client protocol", () => {
    const route = parseProxyRoute("/id.sig/chat/messages/a/prod/-/v1/responses");
    expect(route).not.toBeNull();
    expect(() => assertClientEndpoint(route!)).toThrow("accepts only /v1/chat/completions");
  });

  it("generates SDK-compatible bases", () => {
    expect(proxyUrls("https://gateway.test", "id.sig", "messages", "responses", "a", "prod")).toEqual({
      base_url: "https://gateway.test/id.sig/messages/responses/a/prod/-",
      endpoint: "https://gateway.test/id.sig/messages/responses/a/prod/-/v1/messages",
    });
    expect(proxyUrls("https://gateway.test", "id.sig", "chat", "messages", "a", "prod").base_url).toMatch(
      /\/-\/v1$/u,
    );
  });
});
