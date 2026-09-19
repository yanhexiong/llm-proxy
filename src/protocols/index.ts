import { ProtocolConversionError, unsupportedField } from "./errors";
import { decodeChatRequest, decodeChatResponse, encodeChatRequest, encodeChatResponse } from "./chat";
import { decodeMessagesRequest, decodeMessagesResponse, encodeMessagesRequest, encodeMessagesResponse } from "./messages";
import { decodeResponsesRequest, decodeResponsesResponse, encodeResponsesRequest, encodeResponsesResponse } from "./responses";
import { convertSseStream, type ConvertSseOptions } from "./sse";
import { PROTOCOLS, type ConversionOptions, type ConversionResult, type InternalRequest, type InternalResponse, type PassthroughResult, type Protocol } from "./types";

export * from "./types";
export * from "./errors";
export * from "./common";
export * from "./messages";
export * from "./chat";
export * from "./responses";
export * from "./sse";

export const PASSTHROUGH_MESSAGES = { kind: "passthrough", protocol: "messages" } as const;
export const PASSTHROUGH_RESPONSES = { kind: "passthrough", protocol: "responses" } as const;
export const PASSTHROUGH_CHAT = { kind: "passthrough", protocol: "chat" } as const;

export type PassthroughProtocol = typeof PASSTHROUGH_MESSAGES | typeof PASSTHROUGH_RESPONSES | typeof PASSTHROUGH_CHAT;

export function passthrough(protocol: Protocol, body: unknown): PassthroughResult {
  return { kind: "passthrough", protocol, body };
}

export function isPassthrough(value: unknown, protocol?: Protocol): value is PassthroughResult {
  return typeof value === "object" && value !== null && (value as { kind?: unknown }).kind === "passthrough" && (protocol === undefined || (value as { protocol?: unknown }).protocol === protocol);
}

/**
 * Convert a request from the client's wire protocol to the upstream wire
 * protocol.  Same-protocol calls return a marker containing the original
 * object, so the proxy can forward it without reconstructing JSON.
 */
export function convertRequest(
  client: Protocol,
  upstream: Protocol,
  body: unknown,
  options: ConversionOptions = {},
): unknown {
  assertProtocol(client, "client");
  assertProtocol(upstream, "upstream");
  if (client === upstream) return passthrough(client, body);
  const request = decodeRequest(client, body);
  return encodeRequest(upstream, request, options);
}

/** Envelope form for callers that need source/target labels in logs/tests. */
export function convertRequestResult(
  client: Protocol,
  upstream: Protocol,
  body: unknown,
  options: ConversionOptions = {},
): ConversionResult {
  if (client === upstream) return passthrough(client, body);
  return { kind: "converted", from: client, to: upstream, body: convertRequest(client, upstream, body, options) };
}

export function convertResponse(upstream: Protocol, client: Protocol, body: unknown): unknown {
  assertProtocol(upstream, "upstream");
  assertProtocol(client, "client");
  if (upstream === client) return passthrough(client, body);
  const response = decodeResponse(upstream, body);
  return encodeResponse(client, response);
}

export function convertResponseResult(upstream: Protocol, client: Protocol, body: unknown): ConversionResult {
  if (upstream === client) return passthrough(client, body);
  return { kind: "converted", from: upstream, to: client, body: convertResponse(upstream, client, body) };
}

/** The proxy-facing stream API requested by the gateway plan. */
export { convertSseStream };
export type { ConvertSseOptions };

export function convertRequestInternal(client: Protocol, body: unknown): InternalRequest {
  return decodeRequest(client, body);
}

export function convertResponseInternal(upstream: Protocol, body: unknown): InternalResponse {
  return decodeResponse(upstream, body);
}

// Direction-named aliases keep integrations readable and provide a stable API
// for callers which do not want to carry protocol strings through their code.
export const convertMessagesToChatRequest = (body: unknown, options?: ConversionOptions) => convertRequest("messages", "chat", body, options);
export const convertMessagesToResponsesRequest = (body: unknown, options?: ConversionOptions) => convertRequest("messages", "responses", body, options);
export const convertChatToMessagesRequest = (body: unknown, options?: ConversionOptions) => convertRequest("chat", "messages", body, options);
export const convertChatToResponsesRequest = (body: unknown, options?: ConversionOptions) => convertRequest("chat", "responses", body, options);
export const convertResponsesToMessagesRequest = (body: unknown, options?: ConversionOptions) => convertRequest("responses", "messages", body, options);
export const convertResponsesToChatRequest = (body: unknown, options?: ConversionOptions) => convertRequest("responses", "chat", body, options);

export const convertMessagesToChatResponse = (body: unknown) => convertResponse("messages", "chat", body);
export const convertMessagesToResponsesResponse = (body: unknown) => convertResponse("messages", "responses", body);
export const convertChatToMessagesResponse = (body: unknown) => convertResponse("chat", "messages", body);
export const convertChatToResponsesResponse = (body: unknown) => convertResponse("chat", "responses", body);
export const convertResponsesToMessagesResponse = (body: unknown) => convertResponse("responses", "messages", body);
export const convertResponsesToChatResponse = (body: unknown) => convertResponse("responses", "chat", body);

export const convertStream = convertSseStream;

function decodeRequest(protocol: Protocol, body: unknown): InternalRequest {
  if (protocol === "messages") return decodeMessagesRequest(body);
  if (protocol === "chat") return decodeChatRequest(body);
  return decodeResponsesRequest(body);
}

function encodeRequest(protocol: Protocol, request: InternalRequest, options: ConversionOptions): Record<string, unknown> {
  if (protocol === "messages") return encodeMessagesRequest(request, options);
  if (protocol === "chat") return encodeChatRequest(request, options);
  return encodeResponsesRequest(request, options);
}

function decodeResponse(protocol: Protocol, body: unknown): InternalResponse {
  if (protocol === "messages") return decodeMessagesResponse(body);
  if (protocol === "chat") return decodeChatResponse(body);
  return decodeResponsesResponse(body);
}

function encodeResponse(protocol: Protocol, response: InternalResponse): Record<string, unknown> {
  if (protocol === "messages") return encodeMessagesResponse(response);
  if (protocol === "chat") return encodeChatResponse(response);
  return encodeResponsesResponse(response);
}

function assertProtocol(value: string, path: string): asserts value is Protocol {
  if (!(PROTOCOLS as readonly string[]).includes(value)) {
    throw unsupportedField(path, `unknown protocol ${JSON.stringify(value)}`);
  }
}
