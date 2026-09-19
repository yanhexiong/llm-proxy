/**
 * Protocol-neutral values used by the three public API adapters.
 *
 * The types intentionally model only the part of each API which can be
 * represented by all supported adapters.  Protocol-specific metadata remains
 * on the wire and is not silently invented during a conversion.
 */

export type Protocol = "messages" | "responses" | "chat";

export const PROTOCOLS = ["messages", "responses", "chat"] as const;

export type MessageRole = "system" | "developer" | "user" | "assistant" | "tool";

export interface TextBlock {
  type: "text";
  text: string;
}

export interface ImageUrlSource {
  type: "url";
  url: string;
  detail?: "auto" | "low" | "high";
}

export interface ImageBase64Source {
  type: "base64";
  mediaType: string;
  data: string;
}

export type ImageSource = ImageUrlSource | ImageBase64Source;

export interface ImageBlock {
  type: "image";
  source: ImageSource;
}

export interface ToolUseBlock {
  type: "tool_use";
  id: string;
  name: string;
  input: unknown;
}

export interface ToolResultBlock {
  type: "tool_result";
  toolUseId: string;
  content: ContentBlock[];
  isError?: boolean;
}

export type ContentBlock = TextBlock | ImageBlock | ToolUseBlock | ToolResultBlock;

export interface InternalMessage {
  role: MessageRole;
  content: ContentBlock[];
  /** Optional protocol-level message id or provider metadata. */
  id?: string;
  name?: string;
}

export interface InternalTool {
  type: "function";
  name: string;
  description?: string;
  parameters?: Record<string, unknown>;
  strict?: boolean;
}

export type ToolChoice =
  | { type: "auto" }
  | { type: "none" }
  | { type: "required" }
  | { type: "function"; name: string };

export interface InternalUsage {
  inputTokens: number;
  outputTokens: number;
  totalTokens: number;
  cacheReadInputTokens?: number;
  cacheCreationInputTokens?: number;
}

export type FinishReason =
  | "stop"
  | "length"
  | "tool_call"
  | "content_filter"
  | "stop_sequence"
  | "error"
  | null;

export interface InternalRequest {
  model: string;
  messages: InternalMessage[];
  /** Responses' top-level instructions, kept separate from role messages. */
  instructions?: ContentBlock[];
  tools?: InternalTool[];
  toolChoice?: ToolChoice;
  temperature?: number;
  topP?: number;
  topK?: number;
  maxOutputTokens?: number;
  stop?: string | string[];
  presencePenalty?: number;
  frequencyPenalty?: number;
  seed?: number;
  stream?: boolean;
  /** Chat's opt-in usage trailer for streaming responses. */
  includeUsage?: boolean;
  /** Responses server-side state is intentionally not converted. */
  previousResponseId?: string;
  store?: boolean;
  background?: boolean;
  /** Only one result is supported by the gateway. */
  n?: number;
  user?: string;
  metadata?: Record<string, string>;
}

export interface InternalResponse {
  id: string;
  model: string;
  createdAt?: number;
  messages: InternalMessage[];
  finishReason: FinishReason;
  usage?: InternalUsage;
  status?: "in_progress" | "completed" | "failed" | "incomplete";
  error?: { code?: string; message: string; type?: string };
  /** Responses-specific fields which are meaningful when converting back. */
  incompleteReason?: "max_output_tokens" | "content_filter" | "other";
  stopSequence?: string | null;
}

export interface ConversionOptions {
  /** The HTTP gateway opts into compatible mode; library calls stay strict. */
  thinkingMode?: "strict" | "compatible";
  /** Default used only when encoding a Messages request without a limit. */
  defaultMaxOutputTokens?: number;
  /** Compatibility alias used by the gateway proxy configuration. */
  defaultMaxTokens?: number;
  /** Preserve unknown protocol metadata on the returned envelope if desired. */
  preserveMetadata?: boolean;
}

export interface PassthroughResult {
  kind: "passthrough";
  protocol: Protocol;
  /** The original JSON value; adapters must not clone or rewrite it. */
  body: unknown;
}

export interface ConvertedResult<T = unknown> {
  kind: "converted";
  from: Protocol;
  to: Protocol;
  body: T;
}

export type ConversionResult<T = unknown> = PassthroughResult | ConvertedResult<T>;

export type StreamEvent =
  | { type: "message_start"; id: string; model?: string; role?: "assistant"; usage?: InternalUsage }
  | { type: "text_start"; id?: string; outputIndex?: number; contentIndex?: number; itemId?: string }
  | { type: "text_delta"; text: string; outputIndex?: number; contentIndex?: number; itemId?: string }
  | { type: "text_end"; text?: string; outputIndex?: number; contentIndex?: number; itemId?: string }
  | {
      type: "tool_start";
      id: string;
      name: string;
      input?: unknown;
      outputIndex?: number;
      contentIndex?: number;
      itemId?: string;
    }
  | {
      type: "tool_delta";
      id: string;
      argumentsDelta: string;
      nameDelta?: string;
      outputIndex?: number;
      contentIndex?: number;
      itemId?: string;
    }
  | {
      type: "tool_end";
      id: string;
      input?: unknown;
      outputIndex?: number;
      contentIndex?: number;
      itemId?: string;
    }
  | { type: "usage"; usage: InternalUsage }
  | { type: "message_end"; finishReason: FinishReason; usage?: InternalUsage; stopSequence?: string | null }
  | { type: "error"; error: { message: string; code?: string; type?: string } }
  | { type: "ping" }
  | { type: "raw"; protocol: Protocol; event: string; data: unknown };

export interface SseEvent {
  event?: string;
  data: string;
  id?: string;
  retry?: number;
}
