import { GatewayError } from "./http";

const HOP_HEADERS = new Set([
  "connection", "keep-alive", "proxy-authenticate", "proxy-authorization",
  "te", "trailer", "transfer-encoding", "upgrade", "content-length",
]);

function hopHeaders(headers: Headers): Set<string> {
  return new Set([...HOP_HEADERS, ...(headers.get("connection") ?? "").split(",").map(name => name.trim().toLowerCase())]);
}

export function passthroughRequestHeaders(request: Request, protocolHeaders: Headers): Headers {
  const excluded = hopHeaders(request.headers);
  for (const name of ["host", "cookie", "cookie2", "origin", "referer", "forwarded", "via", "x-real-ip"]) excluded.add(name);
  const headers = new Headers();
  for (const [name, value] of request.headers) {
    if (excluded.has(name) || /^(?:cf-|x-forwarded-|x-gateway-|sec-)/u.test(name)) continue;
    headers.set(name, value);
  }
  // Keep application headers intact; add only missing upstream authentication
  // and version headers. Cookies and gateway credentials never reach upstream.
  for (const [name, value] of protocolHeaders) {
    if (name === "content-type" || name === "accept" || excluded.has(name)) continue;
    if (!headers.has(name)) headers.set(name, value);
  }
  return headers;
}

export function passthroughResponseHeaders(source: Headers): Headers {
  const headers = new Headers(source);
  for (const name of hopHeaders(source)) headers.delete(name);
  headers.delete("set-cookie");
  headers.delete("set-cookie2");
  headers.set("cache-control", "no-store");
  return headers;
}

export function passthroughUrl(baseUrl: string, clientEndpoint: string, query: string): string {
  // /v1 is the gateway's SDK mount, not an extra upstream path component.
  const suffix = clientEndpoint.replace(/^\/v1(?=\/|$)/u, "") || "/";
  let decoded = suffix;
  for (let attempt = 0; attempt < 8; attempt += 1) {
    if (decoded.includes("\\") || /[\u0000-\u001f\u007f]/u.test(decoded) || decoded.split("/").some(part => part === "." || part === "..")) {
      throw new GatewayError(400, "invalid_proxy_path", "Request path must stay within the bound upstream base URL");
    }
    if (attempt === 0 && /%(?![\da-f]{2})/iu.test(decoded)) {
      throw new GatewayError(400, "invalid_proxy_path", "Request path contains invalid percent encoding");
    }
    // Inspect encoded bytes without all-or-nothing URI decoding: a literal %
    // elsewhere must not hide an encoded slash or dot traversal segment.
    const next = decoded.replace(/%([\da-f]{2})/giu, (_match, hex: string) => String.fromCharCode(Number.parseInt(hex, 16)));
    if (next === decoded) break;
    if (attempt === 7) throw new GatewayError(400, "invalid_proxy_path", "Request path has too many encoding layers");
    decoded = next;
  }
  const base = new URL(baseUrl);
  const target = new URL(`${baseUrl}${suffix}${query}`);
  const prefix = base.pathname.replace(/\/+$/u, "");
  if (target.origin !== base.origin || (prefix && target.pathname !== prefix && !target.pathname.startsWith(`${prefix}/`))) {
    throw new GatewayError(400, "invalid_proxy_path", "Request path must stay within the bound upstream base URL");
  }
  return target.toString();
}
