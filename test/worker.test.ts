import { env, exports } from "cloudflare:workers";
import { describe, expect, it } from "vitest";

describe("Worker runtime", () => {
  async function loginCookie(): Promise<string> {
    const response = await exports.default.fetch("https://gateway.test/api/admin/login", {
      method: "POST",
      headers: { "content-type": "application/json", origin: "https://gateway.test" },
      body: JSON.stringify({ username: "admin", password: "test-password" }),
    });
    expect(response.status).toBe(200);
    return response.headers.get("set-cookie")?.split(";", 1)[0] ?? "";
  }

  it("reports ready only after D1 and secrets are available", async () => {
    const response = await exports.default.fetch("https://gateway.test/health");
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ status: "ready" });
  });

  it("uses the applied D1 schema", async () => {
    const names = await env.DB.prepare("SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name").all<{
      name: string;
    }>();
    expect(names.results.map((row) => row.name)).toEqual(
      expect.arrayContaining(["admin_sessions", "aliases", "links", "login_attempts"]),
    );
  });

  it("protects management endpoints", async () => {
    const response = await exports.default.fetch("https://gateway.test/api/admin/aliases");
    expect(response.status).toBe(401);
    expect((await response.json()) as object).toMatchObject({ error: { code: "unauthorized" } });
  });

  it("logs in, authenticates the session cookie, and invalidates it on logout", async () => {
    const cookie = await loginCookie();
    expect(cookie).toMatch(/^gateway_session=/u);

    const session = await exports.default.fetch("https://gateway.test/api/admin/session", {
      headers: { cookie },
    });
    expect(session.status).toBe(200);

    const logout = await exports.default.fetch("https://gateway.test/api/admin/logout", {
      method: "POST",
      headers: { cookie, origin: "https://gateway.test" },
    });
    expect(logout.status).toBe(200);

    const expired = await exports.default.fetch("https://gateway.test/api/admin/session", {
      headers: { cookie },
    });
    expect(expired.status).toBe(401);
  });

  it("keeps alias links current, rejects tampering, and revokes links when the alias is deleted", async () => {
    const cookie = await loginCookie();
    const adminHeaders = { cookie, origin: "https://gateway.test", "content-type": "application/json" };
    const aliasResponse = await exports.default.fetch("https://gateway.test/api/admin/aliases", {
      method: "POST",
      headers: adminHeaders,
      body: JSON.stringify({ name: "integration", base_url: "api.old.example/v1" }),
    });
    expect(aliasResponse.status).toBe(201);
    const alias = ((await aliasResponse.json()) as { alias: { id: string } }).alias;

    const linkResponse = await exports.default.fetch("https://gateway.test/api/admin/links", {
      method: "POST",
      headers: adminHeaders,
      body: JSON.stringify({
        client_protocol: "responses",
        upstream_protocol: "messages",
        target_type: "alias",
        alias_id: alias.id,
      }),
    });
    expect(linkResponse.status).toBe(201);
    const link = ((await linkResponse.json()) as { link: { endpoint: string; id: string } }).link;

    const tampered = link.endpoint.replace(/\/([^/]+)\/responses\//u, "/$1x/responses/");
    const tamperedResponse = await exports.default.fetch(tampered, {
      method: "POST",
      headers: { authorization: "Bearer upstream-key", "content-type": "application/json" },
      body: JSON.stringify({ model: "test", input: "hello" }),
    });
    expect(tamperedResponse.status).toBe(403);

    const update = await exports.default.fetch(`https://gateway.test/api/admin/aliases/${alias.id}`, {
      method: "PUT",
      headers: adminHeaders,
      body: JSON.stringify({ base_url: "https://api.new.example/custom" }),
    });
    expect(update.status).toBe(200);
    const listed = await exports.default.fetch("https://gateway.test/api/admin/links", { headers: { cookie } });
    const updatedLink = ((await listed.json()) as { links: Array<{ id: string; upstream_url: string }> }).links.find(
      (item) => item.id === link.id,
    );
    expect(updatedLink?.upstream_url).toBe("https://api.new.example/custom/messages");

    const deleted = await exports.default.fetch(`https://gateway.test/api/admin/aliases/${alias.id}`, {
      method: "DELETE",
      headers: adminHeaders,
    });
    expect(deleted.status).toBe(204);
    const afterDelete = await exports.default.fetch("https://gateway.test/api/admin/links", { headers: { cookie } });
    const revokedLink = ((await afterDelete.json()) as { links: Array<{ id: string; revoked_at: string | null }> }).links.find(
      (item) => item.id === link.id,
    );
    expect(revokedLink?.revoked_at).toBeTruthy();

    const revokedResponse = await exports.default.fetch(link.endpoint, {
      method: "POST",
      headers: { authorization: "Bearer upstream-key", "content-type": "application/json" },
      body: JSON.stringify({ model: "test", input: "hello" }),
    });
    expect(revokedResponse.status).toBe(403);
  });
});
