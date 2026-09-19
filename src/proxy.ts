import type { Context } from "hono";
import { verifyCredential } from "./auth";
import { findLink } from "./db";
import { GatewayError, errorResponse, forwardableResponseHeaders, parseJsonObject } from "./http";
import { assertClientEndpoint, displayBaseUrl, isGenerationEndpoint, normalizeBaseUrl, upstreamEndpoint } from "./routes";
import type { Env, Protocol, ProxyRoute } from "./types";
import { convertRequest, convertResponse, convertSseStream, ProtocolConversionError } from "./protocols";
import { fetchUpstream } from "./upstream";
import { prepareConvertedUpstream } from "./provider-compat";
import { passthroughRequestHeaders, passthroughResponseHeaders, passthroughUrl } from "./passthrough";

function extractUpstreamKey(headers: Headers): string {
  const apiKey = headers.get("x-api-key")?.trim();
  if (apiKey) return apiKey;
  const authorization = headers.get("authorization")?.trim() ?? "";
  const match = /^Bearer\s+(.+)$/iu.exec(authorization);
  if (match?.[1]) return match[1].trim();
  throw new GatewayError(401, "authentication_error", "Provide the upstream key in Authorization: Bearer or x-api-key");
}

function upstreamHeaders(request: Request, protocol: Protocol, requestId: string): Headers {
  const key = extractUpstreamKey(request.headers);
  const headers = new Headers({
    accept: request.headers.get("accept") ?? "application/json",
    "content-type": request.headers.get("content-type") ?? "application/json",
    "x-gateway-request-id": requestId,
  });
  if (protocol === "messages") {
    headers.set("x-api-key", key);
    headers.set("anthropic-version", request.headers.get("anthropic-version") ?? "2023-06-01");
    const beta = request.headers.get("anthropic-beta");
    if (beta) headers.set("anthropic-beta", beta);
  } else {
    headers.set("authorization", `Bearer ${key}`);
    const organization = request.headers.get("openai-organization");
    const project = request.headers.get("openai-project");
    if (organization) headers.set("openai-organization", organization);
    if (project) headers.set("openai-project", project);
  }
  return headers;
}

async function boundTarget(c: Context<{ Bindings: Env }>, route: ProxyRoute): Promise<{ linkId: string; baseUrl: string }> {
  const credential = await verifyCredential(route.credential, c.env.LINK_SIGNING_SECRET);
  if (!credential.valid) throw new GatewayError(403, "invalid_link", "Gateway link credential is invalid");
  const link = await findLink(c.env.DB, credential.id);
  if (!link || link.revoked_at) throw new GatewayError(403, "invalid_link", "Gateway link is revoked or unknown");
  if (link.client_protocol !== route.clientProtocol || link.upstream_protocol !== route.upstreamProtocol) {
    throw new GatewayError(403, "link_scope_mismatch", "Gateway link is not valid for this protocol direction");
  }
  if (link.target_type === "direct") {
    if (route.mode !== "u" || displayBaseUrl(link.direct_base_url ?? "") !== route.target) {
      throw new GatewayError(403, "link_scope_mismatch", "Gateway link is not valid for this upstream target");
    }
    return { linkId: link.id, baseUrl: normalizeBaseUrl(link.direct_base_url ?? "") };
  }
  if (route.mode !== "a" || link.alias_name !== route.target || !link.alias_base_url) {
    throw new GatewayError(403, "link_scope_mismatch", "Gateway alias no longer exists or does not match this link");
  }
  return { linkId: link.id, baseUrl: normalizeBaseUrl(link.alias_base_url) };
}

async function convertedUpstreamError(
  upstream: Response,
  clientProtocol: Protocol,
  requestId: string,
): Promise<Response> {
  let message = `Upstream returned HTTP ${upstream.status}`;
  let code = "upstream_error";
  const text = await upstream.text();
  try {
    const value = JSON.parse(text) as Record<string, unknown>;
    const nested = value.error;
    if (nested && typeof nested === "object") {
      const error = nested as Record<string, unknown>;
      if (typeof error.message === "string") message = error.message;
      if (typeof error.type === "string") code = error.type;
      else if (typeof error.code === "string") code = error.code;
    } else if (typeof value.message === "string") message = value.message;
  } catch {
    if (text.trim()) message = text.slice(0, 2_000);
  }
  const response = errorResponse(clientProtocol, new GatewayError(upstream.status, code, message), requestId);
  const headers = new Headers(response.headers);
  for (const [name, value] of forwardableResponseHeaders(upstream.headers)) {
    if (name !== "content-type") headers.set(name, value);
  }
  return new Response(response.body, { status: response.status, headers });
}

function conversionFailure(error: unknown): never {
  if (error instanceof ProtocolConversionError) {
    throw new GatewayError(error.status ?? 400, error.code, error.message, error.field);
  }
  throw error;
}

export async function handleProxy(c: Context<{ Bindings: Env }>, route: ProxyRoute): Promise<Response> {
  const passthrough = !isGenerationEndpoint(route.clientEndpoint);
  if (!passthrough && c.req.method !== "POST") {
    throw new GatewayError(405, "method_not_allowed", "Generation endpoints accept POST only");
  }
  assertClientEndpoint(route);
  const requestId = crypto.randomUUID();
  const started = Date.now();
  let linkId = "unknown";
  let status = 500;
  let errorType: string | undefined;
  try {
    const bound = await boundTarget(c, route);
    linkId = bound.linkId;
    const target = passthrough
      ? passthroughUrl(bound.baseUrl, route.clientEndpoint, new URL(c.req.url).search)
      : upstreamEndpoint(bound.baseUrl, route.upstreamProtocol);
    const protocolHeaders = upstreamHeaders(c.req.raw, route.upstreamProtocol, requestId);
    const headers = passthrough ? passthroughRequestHeaders(c.req.raw, protocolHeaders) : protocolHeaders;
    const sameProtocol = route.clientProtocol === route.upstreamProtocol;
    const thinkingMode = c.env.CROSS_PROTOCOL_THINKING === "strict" ? "strict" : "compatible";
    let body: BodyInit | null;
    let streamingRequested = false;

    if (passthrough || sameProtocol) {
      body = c.req.raw.body;
    } else {
      const clientBody = parseJsonObject(await c.req.json().catch(() => null));
      streamingRequested = clientBody.stream === true;
      try {
        const converted = convertRequest(route.clientProtocol, route.upstreamProtocol, clientBody, {
          thinkingMode,
          defaultMaxTokens: Number(c.env.DEFAULT_MAX_TOKENS ?? "4096"),
        });
        body = JSON.stringify(prepareConvertedUpstream(bound.baseUrl, route.upstreamProtocol, converted));
      } catch (error) {
        return conversionFailure(error);
      }
    }

    const timeoutMs = Math.max(1_000, Number(c.env.UPSTREAM_TIMEOUT_MS ?? "120000") || 120_000);
    const upstream = await fetchUpstream(target, {
        method: passthrough ? c.req.method : "POST",
        headers,
        body,
    }, c.req.raw.signal, timeoutMs);

    status = upstream.status;
    if (!upstream.ok) errorType = `upstream_http_${upstream.status}`;
    if (!upstream.ok && !sameProtocol && !passthrough) {
      return await convertedUpstreamError(upstream, route.clientProtocol, requestId);
    }
    const responseHeaders = passthrough ? passthroughResponseHeaders(upstream.headers) : forwardableResponseHeaders(upstream.headers);
    responseHeaders.set("x-request-id", requestId);
    if (!passthrough && !sameProtocol) responseHeaders.set("x-gateway-thinking-mode", thinkingMode);

    if (passthrough || sameProtocol) {
      if (c.req.method === "HEAD") await upstream.body?.cancel();
      return new Response(c.req.method === "HEAD" ? null : upstream.body, { status: upstream.status, headers: responseHeaders });
    }

    const isEventStream = upstream.headers.get("content-type")?.toLowerCase().includes("text/event-stream");
    if (streamingRequested && !isEventStream) {
      await upstream.body?.cancel();
      throw new GatewayError(502, "upstream_protocol_error", "Streaming request received a non-SSE response");
    }
    if (isEventStream) {
      if (!upstream.body) throw new GatewayError(502, "upstream_stream_error", "Upstream returned an empty stream");
      responseHeaders.set("content-type", "text/event-stream; charset=utf-8");
      responseHeaders.set("cache-control", "no-cache");
      try {
        const stream = convertSseStream(route.upstreamProtocol, route.clientProtocol, upstream.body, {
          thinkingMode,
          maxStateBytes: Number(c.env.MAX_STREAM_STATE_BYTES ?? "8388608"),
          requestId,
          onError: (error) => console.error(JSON.stringify({
            event: "gateway_stream_error", request_id: requestId, link_id: linkId,
            client_protocol: route.clientProtocol, upstream_protocol: route.upstreamProtocol,
            duration_ms: Date.now() - started,
            error_type: error instanceof GatewayError || error instanceof ProtocolConversionError ? error.code : "stream_error",
          })),
        });
        return new Response(stream, { status: upstream.status, headers: responseHeaders });
      } catch (error) {
        return conversionFailure(error);
      }
    }

    const upstreamText = await upstream.text();
    let upstreamBody: Record<string, unknown>;
    try { upstreamBody = parseJsonObject(JSON.parse(upstreamText)); }
    catch { throw new GatewayError(502, "upstream_protocol_error", "Upstream returned invalid JSON"); }
    try {
      const converted = convertResponse(route.upstreamProtocol, route.clientProtocol, upstreamBody, { thinkingMode });
      responseHeaders.set("content-type", "application/json; charset=utf-8");
      return new Response(JSON.stringify(converted), { status: upstream.status, headers: responseHeaders });
    } catch (error) {
      if (error instanceof ProtocolConversionError) {
        throw new GatewayError(502, error.code, error.message, error.field);
      }
      return conversionFailure(error);
    }
  } catch (error) {
    if (error instanceof GatewayError) {
      status = error.status;
      errorType = error.code;
    } else if (error instanceof Error) {
      errorType = error.name;
    } else {
      errorType = "unknown_error";
    }
    throw error;
  } finally {
    console.log(
      JSON.stringify({
        event: "gateway_request",
        request_id: requestId,
        link_id: linkId,
        client_protocol: route.clientProtocol,
        upstream_protocol: route.upstreamProtocol,
        duration_ms: Date.now() - started,
        status,
        ...(errorType ? { error_type: errorType } : {}),
      }),
    );
  }
}
