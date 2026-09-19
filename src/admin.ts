import { Hono } from "hono";
import { deleteCookie, setCookie } from "hono/cookie";
import { requireAdmin, signCredential, type AppContext } from "./auth";
import { randomToken, sha256, verifyPbkdf2Password } from "./crypto";
import { executeBatch, findAlias, findLink, listAliases, listLinks } from "./db";
import { GatewayError, parseJsonObject } from "./http";
import { displayBaseUrl, isProtocol, normalizeBaseUrl, proxyUrls, upstreamEndpoint } from "./routes";
import type { Env, LinkRecord, Protocol } from "./types";

type Variables = { sessionHash: string };
export const admin = new Hono<{ Bindings: Env; Variables: Variables }>();

function textField(body: Record<string, unknown>, name: string): string {
  const value = body[name];
  if (typeof value !== "string" || !value.trim()) {
    throw new GatewayError(400, "invalid_request_error", `${name} is required`, name);
  }
  return value.trim();
}

function protocolField(body: Record<string, unknown>, name: string): Protocol {
  const value = textField(body, name);
  if (!isProtocol(value)) throw new GatewayError(400, "invalid_request_error", `Unknown protocol ${value}`, name);
  return value;
}

function sessionTtl(env: Env): number {
  const parsed = Number(env.SESSION_TTL_SECONDS ?? "604800");
  return Number.isFinite(parsed) && parsed > 0 ? Math.floor(parsed) : 604800;
}

async function loginBlocked(db: D1Database, key: string): Promise<boolean> {
  const row = await db
    .prepare("SELECT blocked_until FROM login_attempts WHERE key = ?")
    .bind(key)
    .first<{ blocked_until: string | null }>();
  return Boolean(row?.blocked_until && Date.parse(`${row.blocked_until}Z`) > Date.now());
}

async function recordLoginFailure(db: D1Database, key: string): Promise<void> {
  await db
    .prepare(
      `INSERT INTO login_attempts(key, failures, window_started_at, blocked_until)
       VALUES (?, 1, datetime('now'), NULL)
       ON CONFLICT(key) DO UPDATE SET
         failures = CASE
           WHEN window_started_at < datetime('now', '-15 minutes') THEN 1
           ELSE failures + 1 END,
         window_started_at = CASE
           WHEN window_started_at < datetime('now', '-15 minutes') THEN datetime('now')
           ELSE window_started_at END,
         blocked_until = CASE
           WHEN window_started_at >= datetime('now', '-15 minutes') AND failures + 1 >= 5
           THEN datetime('now', '+15 minutes') ELSE NULL END`,
    )
    .bind(key)
    .run();
}

admin.post("/login", async (c) => {
  const body = parseJsonObject(await c.req.json().catch(() => null));
  const username = textField(body, "username");
  const password = body.password;
  if (typeof password !== "string" || !password) throw new GatewayError(400, "invalid_request_error", "password is required", "password");
  const address = c.req.header("cf-connecting-ip") ?? "unknown";
  const attemptKey = await sha256(`${address}:${username.toLocaleLowerCase()}`);
  if (await loginBlocked(c.env.DB, attemptKey)) {
    throw new GatewayError(429, "rate_limit_error", "Too many failed login attempts; try again later");
  }
  const usernameValid = username === c.env.ADMIN_USERNAME;
  const passwordValid = await verifyPbkdf2Password(password, c.env.ADMIN_PASSWORD_HASH);
  if (!usernameValid || !passwordValid) {
    await recordLoginFailure(c.env.DB, attemptKey);
    throw new GatewayError(401, "invalid_credentials", "Invalid username or password");
  }

  await c.env.DB.prepare("DELETE FROM login_attempts WHERE key = ?").bind(attemptKey).run();
  const token = randomToken();
  const tokenHash = await sha256(token);
  const ttl = sessionTtl(c.env);
  await c.env.DB.prepare(
    "INSERT INTO admin_sessions(token_hash, expires_at, created_at, last_seen_at) VALUES (?, datetime('now', ?), datetime('now'), datetime('now'))",
  )
    .bind(tokenHash, `+${ttl} seconds`)
    .run();
  setCookie(c, "gateway_session", token, {
    httpOnly: true,
    secure: true,
    sameSite: "Strict",
    path: "/",
    maxAge: ttl,
  });
  return c.json({ authenticated: true, username: c.env.ADMIN_USERNAME });
});

admin.use("/*", requireAdmin);

admin.get("/session", (c) => c.json({ authenticated: true, username: c.env.ADMIN_USERNAME }));

admin.post("/logout", async (c) => {
  await c.env.DB.prepare("DELETE FROM admin_sessions WHERE token_hash = ?").bind(c.get("sessionHash")).run();
  deleteCookie(c, "gateway_session", { path: "/", secure: true });
  return c.json({ authenticated: false });
});

admin.get("/aliases", async (c) => c.json({ aliases: await listAliases(c.env.DB) }));

admin.post("/aliases", async (c) => {
  const body = parseJsonObject(await c.req.json().catch(() => null));
  const name = textField(body, "name");
  if (!/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,63}$/u.test(name)) {
    throw new GatewayError(400, "invalid_alias", "Alias must use 1-64 letters, numbers, underscores or hyphens", "name");
  }
  const baseUrl = normalizeBaseUrl(textField(body, "base_url"));
  const id = crypto.randomUUID();
  try {
    await c.env.DB.prepare(
      "INSERT INTO aliases(id, name, base_url, created_at, updated_at) VALUES (?, ?, ?, datetime('now'), datetime('now'))",
    )
      .bind(id, name, baseUrl)
      .run();
  } catch {
    throw new GatewayError(409, "alias_exists", "An alias with this name already exists", "name");
  }
  return c.json({ alias: await findAlias(c.env.DB, id) }, 201);
});

admin.put("/aliases/:id", async (c) => {
  const alias = await findAlias(c.env.DB, c.req.param("id"));
  if (!alias) throw new GatewayError(404, "not_found", "Alias not found");
  const body = parseJsonObject(await c.req.json().catch(() => null));
  const baseUrl = normalizeBaseUrl(textField(body, "base_url"));
  await c.env.DB.prepare("UPDATE aliases SET base_url = ?, updated_at = datetime('now') WHERE id = ?")
    .bind(baseUrl, alias.id)
    .run();
  return c.json({ alias: await findAlias(c.env.DB, alias.id) });
});

admin.delete("/aliases/:id", async (c) => {
  const alias = await findAlias(c.env.DB, c.req.param("id"));
  if (!alias) throw new GatewayError(404, "not_found", "Alias not found");
  await executeBatch(c.env.DB, [
    c.env.DB.prepare("UPDATE links SET revoked_at = COALESCE(revoked_at, datetime('now')) WHERE alias_id = ?").bind(alias.id),
    c.env.DB.prepare("DELETE FROM aliases WHERE id = ?").bind(alias.id),
  ]);
  return c.body(null, 204);
});

async function presentLink(c: AppContext, link: LinkRecord): Promise<Record<string, unknown>> {
  const credential = await signCredential(link.id, c.env.LINK_SIGNING_SECRET);
  const mode = link.target_type === "direct" ? "u" : "a";
  const baseUrl = link.target_type === "direct" ? link.direct_base_url : link.alias_base_url;
  const target = link.target_type === "direct" ? displayBaseUrl(link.direct_base_url ?? "") : link.alias_name ?? "";
  const urls = proxyUrls(new URL(c.req.url).origin, credential, link.client_protocol, link.upstream_protocol, mode, target);
  const upstream = baseUrl ? upstreamEndpoint(baseUrl, link.upstream_protocol) : null;
  const exampleBody = link.client_protocol === "responses"
    ? { model: "your-model", input: "Hello" }
    : { model: "your-model", ...(link.client_protocol === "messages" ? { max_tokens: 512 } : {}), messages: [{ role: "user", content: "Hello" }] };
  return {
    ...link,
    ...urls,
    upstream_url: upstream,
    flow: `${link.client_protocol} -> ${link.upstream_protocol} -> ${link.client_protocol}`,
    curl: `curl '${urls.endpoint}' -H '${link.client_protocol === "messages" ? "x-api-key: YOUR_API_KEY" : "Authorization: Bearer YOUR_API_KEY"}' -H 'content-type: application/json' --data '${JSON.stringify(exampleBody)}'`,
  };
}

admin.get("/links", async (c) => {
  const links = await Promise.all((await listLinks(c.env.DB)).map((link) => presentLink(c as AppContext, link)));
  return c.json({ links });
});

admin.post("/links", async (c) => {
  const body = parseJsonObject(await c.req.json().catch(() => null));
  const client = protocolField(body, "client_protocol");
  const upstream = protocolField(body, "upstream_protocol");
  const targetType = textField(body, "target_type");
  if (targetType !== "direct" && targetType !== "alias") {
    throw new GatewayError(400, "invalid_request_error", "target_type must be direct or alias", "target_type");
  }
  let directBaseUrl: string | null = null;
  let aliasId: string | null = null;
  if ((targetType === "direct" && body.alias_id !== undefined) || (targetType === "alias" && body.base_url !== undefined)) {
    throw new GatewayError(400, "invalid_request_error", "Provide exactly one of base_url or alias_id", "target_type");
  }
  if (targetType === "direct") directBaseUrl = normalizeBaseUrl(textField(body, "base_url"));
  else {
    aliasId = textField(body, "alias_id");
    if (!(await findAlias(c.env.DB, aliasId))) throw new GatewayError(404, "not_found", "Alias not found", "alias_id");
  }
  const id = randomToken(18);
  await c.env.DB.prepare(
    `INSERT INTO links(id, client_protocol, upstream_protocol, target_type, direct_base_url, alias_id, created_at)
     VALUES (?, ?, ?, ?, ?, ?, datetime('now'))`,
  )
    .bind(id, client, upstream, targetType, directBaseUrl, aliasId)
    .run();
  const link = await findLink(c.env.DB, id);
  if (!link) throw new Error("Created link was not found");
  return c.json({ link: await presentLink(c as AppContext, link) }, 201);
});

async function revoke(c: AppContext): Promise<Response> {
  const id = c.req.param("id");
  const result = await c.env.DB.prepare("UPDATE links SET revoked_at = COALESCE(revoked_at, datetime('now')) WHERE id = ?")
    .bind(id)
    .run();
  if (!result.meta.changes) throw new GatewayError(404, "not_found", "Link not found");
  return c.json({ revoked: true });
}

admin.post("/links/:id/revoke", revoke);
admin.delete("/links/:id", revoke);
