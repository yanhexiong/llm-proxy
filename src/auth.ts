import type { Context, Next } from "hono";
import { getCookie } from "hono/cookie";
import { constantTimeEqual, hmac, sha256 } from "./crypto";
import { GatewayError } from "./http";
import type { Env } from "./types";

export type AppContext = Context<{ Bindings: Env; Variables: { sessionHash: string } }>;

export async function signCredential(id: string, secret: string): Promise<string> {
  return `${id}.${await hmac(id, secret)}`;
}

export async function verifyCredential(
  credential: string,
  secret: string,
): Promise<{ valid: boolean; id: string }> {
  const separator = credential.indexOf(".");
  if (separator <= 0) return { valid: false, id: "" };
  const id = credential.slice(0, separator);
  const supplied = credential.slice(separator + 1);
  const expected = await hmac(id, secret);
  return { valid: constantTimeEqual(supplied, expected), id };
}

export function assertSameOrigin(request: Request): void {
  const origin = request.headers.get("origin");
  if (origin && origin !== new URL(request.url).origin) {
    throw new GatewayError(403, "invalid_origin", "Cross-origin management requests are not allowed");
  }
}

export async function requireAdmin(c: AppContext, next: Next): Promise<Response | void> {
  const token = getCookie(c, "gateway_session");
  if (!token) throw new GatewayError(401, "unauthorized", "Administrator login required");
  const tokenHash = await sha256(token);
  const session = await c.env.DB.prepare(
    "SELECT token_hash FROM admin_sessions WHERE token_hash = ? AND expires_at > datetime('now')",
  )
    .bind(tokenHash)
    .first<{ token_hash: string }>();
  if (!session) throw new GatewayError(401, "unauthorized", "Administrator session is invalid or expired");
  c.set("sessionHash", tokenHash);
  await c.env.DB.prepare("UPDATE admin_sessions SET last_seen_at = datetime('now') WHERE token_hash = ?")
    .bind(tokenHash)
    .run();
  await next();
}
