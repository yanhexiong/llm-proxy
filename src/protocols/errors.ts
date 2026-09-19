import type { Protocol } from "./types";

export type ConversionErrorCode =
  | "invalid_request"
  | "invalid_response"
  | "unsupported_field"
  | "unsupported_content"
  | "unsupported_tool"
  | "invalid_json"
  | "stream_error";

/** A client-safe error which always points at the offending input field. */
export class ProtocolConversionError extends Error {
  readonly code: ConversionErrorCode;
  readonly path: string;
  /** Alias used by the proxy layer when returning a protocol error. */
  readonly field: string;
  /** Optional HTTP status selected by the caller (400 by default in adapters). */
  readonly status?: number;
  readonly protocol?: Protocol;
  readonly targetProtocol?: Protocol;

  constructor(
    message: string,
    options: {
      code?: ConversionErrorCode;
      path?: string;
      protocol?: Protocol;
      targetProtocol?: Protocol;
      status?: number;
      cause?: unknown;
    } = {},
  ) {
    super(message);
    this.name = "ProtocolConversionError";
    this.code = options.code ?? "invalid_request";
    this.path = options.path ?? "$";
    this.field = this.path;
    this.status = options.status;
    this.protocol = options.protocol;
    this.targetProtocol = options.targetProtocol;
    if (options.cause !== undefined) {
      (this as Error & { cause?: unknown }).cause = options.cause;
    }
  }

  toJSON(): Record<string, unknown> {
    return {
      type: "invalid_request_error",
      code: this.code,
      message: this.message,
      param: this.path,
    };
  }
}

export function conversionError(
  message: string,
  path: string,
  options: Omit<ConstructorParameters<typeof ProtocolConversionError>[1], "path"> = {},
): ProtocolConversionError {
  return new ProtocolConversionError(message, { ...options, path });
}

export function unsupportedField(
  path: string,
  reason: string,
  protocol?: Protocol,
  targetProtocol?: Protocol,
): ProtocolConversionError {
  return new ProtocolConversionError(`${path}: ${reason}`, {
    code: "unsupported_field",
    path,
    protocol,
    targetProtocol,
  });
}

export function invalidField(
  path: string,
  reason: string,
  protocol?: Protocol,
): ProtocolConversionError {
  return new ProtocolConversionError(`${path}: ${reason}`, {
    code: "invalid_request",
    path,
    protocol,
  });
}

export function invalidResponseField(
  path: string,
  reason: string,
  protocol?: Protocol,
): ProtocolConversionError {
  return new ProtocolConversionError(`${path}: ${reason}`, {
    code: "invalid_response",
    path,
    protocol,
  });
}

export function asProtocolError(
  error: unknown,
  fallbackPath: string,
  protocol?: Protocol,
  response = false,
): ProtocolConversionError {
  if (error instanceof ProtocolConversionError) return error;
  const message = error instanceof Error ? error.message : String(error);
  return new ProtocolConversionError(`${fallbackPath}: ${message}`, {
    code: response ? "invalid_response" : "invalid_json",
    path: fallbackPath,
    protocol,
    cause: error,
  });
}
