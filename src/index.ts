import { Hono } from "hono";
import { assertSameOrigin } from "./auth";
import { admin } from "./admin";
import { hasValidAdminPasswordConfiguration } from "./crypto";
import { GatewayError, errorResponse } from "./http";
import { handleProxy } from "./proxy";
import { parseProxyRoute } from "./routes";
import type { Env } from "./types";

const app = new Hono<{ Bindings: Env }>();

app.use("/api/admin/*", async (c, next) => {
  c.header("Cache-Control", "no-store");
  c.header("Referrer-Policy", "no-referrer");
  if (!["GET", "HEAD", "OPTIONS"].includes(c.req.method)) assertSameOrigin(c.req.raw);
  await next();
});

app.route("/api/admin", admin);

app.get("/health", async (c) => {
  try {
    const schema = await c.env.DB.prepare("SELECT COUNT(*) AS n FROM sqlite_master WHERE type = 'table' AND name IN ('aliases', 'links', 'admin_sessions', 'login_attempts')").first<{ n: number }>();
    const configured = schema?.n === 4 && Boolean(c.env.LINK_SIGNING_SECRET && c.env.ADMIN_USERNAME) && hasValidAdminPasswordConfiguration(c.env);
    return c.json({ status: configured ? "ready" : "not_ready" }, configured ? 200 : 503);
  } catch {
    return c.json({ status: "not_ready" }, 503);
  }
});

app.all("*", async (c) => {
  const route = parseProxyRoute(new URL(c.req.url).pathname);
  if (route) {
    try {
      return await handleProxy(c, route);
    } catch (error) {
      if (error instanceof GatewayError) return errorResponse(route.clientProtocol, error, crypto.randomUUID());
      throw error;
    }
  }
  const path = new URL(c.req.url).pathname;
  if (path.startsWith("/api/") || path.includes("/-/") || !["GET", "HEAD"].includes(c.req.method)) {
    return errorResponse(undefined, new GatewayError(404, "not_found", "Unknown API endpoint"));
  }
  return c.env.ASSETS.fetch(c.req.raw);
});

app.notFound((c) => errorResponse(undefined, new GatewayError(404, "not_found", "Route not found")));

app.onError((error, c) => {
  if (error instanceof GatewayError) return errorResponse(undefined, error, crypto.randomUUID());
  console.error(JSON.stringify({ event: "gateway_error", error_type: error.name }));
  return errorResponse(undefined, new GatewayError(500, "internal_error", "Internal gateway error"), crypto.randomUUID());
});

export default app;
