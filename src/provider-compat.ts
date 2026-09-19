import type { Protocol } from "./types";

/** DeepSeek defaults to native thinking, whose signatures cannot cross protocols.
 * Keep cross-protocol calls stateless; same-protocol forwarding bypasses this.
 * See https://api-docs.deepseek.com/guides/thinking_mode
 */
export function prepareConvertedUpstream(
  baseUrl: string,
  protocol: Protocol,
  body: unknown,
): unknown {
  if (new URL(baseUrl).hostname !== "api.deepseek.com") return body;
  const request = body as Record<string, unknown>;
  return protocol === "responses"
    ? { ...request, reasoning: { effort: "none" } }
    : { ...request, thinking: { type: "disabled" } };
}
