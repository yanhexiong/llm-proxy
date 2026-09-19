import type { Protocol } from "./types";

const JSON_HEADERS = { "content-type": "application/json; charset=utf-8" };

export class GatewayError extends Error {
  constructor(
    public readonly status: number,
    public readonly code: string,
    message: string,
    public readonly field?: string,
  ) {
    super(message);
  }
}

export function errorResponse(
  protocol: Protocol | undefined,
  error: GatewayError,
  requestId?: string,
): Response {
  const message = error.field ? `${error.message} (field: ${error.field})` : error.message;
  const headers = new Headers(JSON_HEADERS);
  if (requestId) headers.set("x-request-id", requestId);

  if (protocol === "messages") {
    return Response.json(
      { type: "error", error: { type: error.code, message }, request_id: requestId },
      { status: error.status, headers },
    );
  }

  return Response.json(
    { error: { message, type: error.code, param: error.field ?? null, code: error.code } },
    { status: error.status, headers },
  );
}

export function parseJsonObject(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new GatewayError(400, "invalid_request_error", "Request body must be a JSON object");
  }
  return value as Record<string, unknown>;
}

export function forwardableResponseHeaders(source: Headers): Headers {
  const result = new Headers();
  for (const name of [
    "content-type",
    "retry-after",
    "request-id",
    "x-request-id",
    "openai-processing-ms",
    "anthropic-ratelimit-requests-limit",
    "anthropic-ratelimit-requests-remaining",
    "anthropic-ratelimit-tokens-limit",
    "anthropic-ratelimit-tokens-remaining",
  ]) {
    const value = source.get(name);
    if (value) result.set(name, value);
  }
  return result;
}
