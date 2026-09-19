import { GatewayError } from "./http";
import { PROTOCOLS, type Protocol, type ProxyRoute } from "./types";

const ENDPOINTS: Record<Protocol, string> = {
  messages: "/v1/messages",
  responses: "/v1/responses",
  chat: "/v1/chat/completions",
};

export function isProtocol(value: string): value is Protocol {
  return (PROTOCOLS as readonly string[]).includes(value);
}

export function normalizeBaseUrl(raw: string): string {
  const candidate = /^[a-z][a-z\d+.-]*:\/\//iu.test(raw.trim()) ? raw.trim() : `https://${raw.trim()}`;
  let url: URL;
  try {
    url = new URL(candidate);
  } catch {
    throw new GatewayError(400, "invalid_base_url", "Upstream base URL is invalid", "base_url");
  }
  if (url.protocol !== "https:") {
    throw new GatewayError(400, "invalid_base_url", "Only HTTPS upstreams are allowed", "base_url");
  }
  if (url.username || url.password || url.search || url.hash) {
    throw new GatewayError(400, "invalid_base_url", "Credentials, query strings and fragments are not allowed", "base_url");
  }
  if (!url.hostname || url.port) {
    throw new GatewayError(400, "invalid_base_url", "A hostname without an explicit port is required", "base_url");
  }
  const path = url.pathname.replace(/\/+$/u, "");
  for (const endpoint of ["/messages", "/responses", "/chat/completions"]) {
    if (path.endsWith(endpoint)) {
      throw new GatewayError(
        400,
        "full_endpoint_not_allowed",
        `Enter the common base URL: https://${url.host}${path.slice(0, -endpoint.length)}`,
        "base_url",
      );
    }
  }
  return `https://${url.host}${path === "/" ? "" : path}`;
}

export function displayBaseUrl(normalized: string): string {
  return normalized.replace(/^https:\/\//u, "");
}

export function upstreamEndpoint(baseUrl: string, protocol: Protocol): string {
  const base = normalizeBaseUrl(baseUrl);
  const suffix: Record<Protocol, string> = {
    messages: "messages",
    responses: "responses",
    chat: "chat/completions",
  };
  return `${base}/${suffix[protocol]}`;
}

export function parseProxyRoute(pathname: string): ProxyRoute | null {
  const matched = (Object.entries(ENDPOINTS) as [Protocol, string][]).find(([, endpoint]) =>
    pathname.endsWith(`/-${endpoint}`),
  );
  if (!matched) return null;
  const [, endpoint] = matched;
  const marker = pathname.length - endpoint.length - 2;
  const prefix = pathname.slice(1, marker).split("/");
  if (prefix.length < 5) return null;
  const [credential, client, upstream, mode, ...targetParts] = prefix;
  if (!credential || !client || !upstream || !mode || targetParts.length === 0) return null;
  if (!isProtocol(client) || !isProtocol(upstream) || (mode !== "u" && mode !== "a")) return null;
  let target: string;
  try {
    target = decodeURIComponent(targetParts.join("/"));
  } catch {
    return null;
  }
  const clientEndpoint = endpoint;
  return {
    credential,
    clientProtocol: client,
    upstreamProtocol: upstream,
    mode,
    target,
    clientEndpoint,
  };
}

export function assertClientEndpoint(route: ProxyRoute): void {
  if (route.clientEndpoint !== ENDPOINTS[route.clientProtocol]) {
    throw new GatewayError(
      404,
      "protocol_endpoint_mismatch",
      `This link accepts only ${ENDPOINTS[route.clientProtocol]}`,
    );
  }
}

export function proxyUrls(
  origin: string,
  credential: string,
  client: Protocol,
  upstream: Protocol,
  mode: "u" | "a",
  target: string,
): { base_url: string; endpoint: string } {
  const encodedTarget = target
    .split("/")
    .map((part) => encodeURIComponent(part))
    .join("/");
  const root = `${origin}/${credential}/${client}/${upstream}/${mode}/${encodedTarget}/-`;
  if (client === "messages") return { base_url: root, endpoint: `${root}/v1/messages` };
  const base = `${root}/v1`;
  return { base_url: base, endpoint: `${base}/${client === "responses" ? "responses" : "chat/completions"}` };
}
