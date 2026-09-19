import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import app from "../src/index";
import type { Env } from "../src/types";

const LEGACY_HASH = "pbkdf2_sha256$100000$dGVzdA$W4Tnq8EZ1Jegj2ii8LuLBHIUv9UBa9FiSS-7m3lDqyI";
const baseBindings = env as unknown as Record<string, unknown>;

function bindings(overrides: Record<string, unknown> = {}): Env {
  const cloned = { ...baseBindings, ...overrides };
  if (!("ADMIN_PASSWORD" in overrides)) delete cloned.ADMIN_PASSWORD;
  return cloned as unknown as Env;
}

async function fetchWithBindings(bindings: Env, path: string, init?: RequestInit): Promise<Response> {
  return app.fetch(new Request(`https://gateway.test${path}`, init), bindings);
}

async function login(bindings: Env, password: string): Promise<Response> {
  return fetchWithBindings(bindings, "/api/admin/login", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      origin: "https://gateway.test",
      // Keep failed-login rate limits isolated between cases.
      "cf-connecting-ip": crypto.randomUUID(),
    },
    body: JSON.stringify({ username: "admin", password }),
  });
}

function sessionCookie(response: Response): string {
  return response.headers.get("set-cookie")?.split(";", 1)[0] ?? "";
}

describe("bootstrap administrator authentication", () => {
  it("logs in with the raw ADMIN_PASSWORD, preserves surrounding spaces, and logs out", async () => {
    const configured = bindings({ ADMIN_PASSWORD: "  new-password  ", ADMIN_PASSWORD_HASH: undefined });
    const loginResponse = await login(configured, "  new-password  ");
    expect(loginResponse.status).toBe(200);
    const cookie = sessionCookie(loginResponse);
    expect(cookie).toMatch(/^gateway_session=/u);

    const session = await fetchWithBindings(configured, "/api/admin/session", { headers: { cookie } });
    expect(session.status).toBe(200);

    const logout = await fetchWithBindings(configured, "/api/admin/logout", {
      method: "POST",
      headers: { cookie, origin: "https://gateway.test" },
    });
    expect(logout.status).toBe(200);

    const expired = await fetchWithBindings(configured, "/api/admin/session", { headers: { cookie } });
    expect(expired.status).toBe(401);
  });

  it("rejects a wrong password", async () => {
    const response = await login(bindings({ ADMIN_PASSWORD: "new-password" }), "different-password");
    expect(response.status).toBe(401);
  });

  it("fails closed for empty or weak ADMIN_PASSWORD instead of falling back to the legacy hash", async () => {
    for (const configuredPassword of ["", "short"]) {
      const configured = bindings({ ADMIN_PASSWORD: configuredPassword, ADMIN_PASSWORD_HASH: LEGACY_HASH });
      const response = await login(configured, "test-password");
      expect(response.status).toBe(401);
      const health = await fetchWithBindings(configured, "/health");
      expect(health.status).toBe(503);
      expect(await health.json()).toEqual({ status: "not_ready" });
    }
  });

  it("treats a valid ADMIN_PASSWORD as authoritative when both password fields exist", async () => {
    const configured = bindings({ ADMIN_PASSWORD: "new-password", ADMIN_PASSWORD_HASH: LEGACY_HASH });
    expect((await login(configured, "test-password")).status).toBe(401);
    expect((await login(configured, "new-password")).status).toBe(200);
  });

  it("keeps existing legacy ADMIN_PASSWORD_HASH deployments working", async () => {
    const configured = bindings({ ADMIN_PASSWORD_HASH: LEGACY_HASH });
    const response = await login(configured, "test-password");
    expect(response.status).toBe(200);
  });

  it("reports ready for either valid password configuration and not_ready for invalid configurations", async () => {
    const cases: Array<[string, Env, number]> = [
      ["new password", bindings({ ADMIN_PASSWORD: "new-password", ADMIN_PASSWORD_HASH: undefined }), 200],
      ["legacy hash", bindings({ ADMIN_PASSWORD: undefined, ADMIN_PASSWORD_HASH: LEGACY_HASH }), 200],
      ["both fields", bindings({ ADMIN_PASSWORD: "new-password", ADMIN_PASSWORD_HASH: LEGACY_HASH }), 200],
      ["empty preferred password", bindings({ ADMIN_PASSWORD: "", ADMIN_PASSWORD_HASH: LEGACY_HASH }), 503],
      ["weak preferred password", bindings({ ADMIN_PASSWORD: "short", ADMIN_PASSWORD_HASH: LEGACY_HASH }), 503],
      ["malformed legacy hash", bindings({ ADMIN_PASSWORD: undefined, ADMIN_PASSWORD_HASH: "not-a-hash" }), 503],
    ];

    for (const [name, configured, expectedStatus] of cases) {
      const response = await fetchWithBindings(configured, "/health");
      expect(response.status, name).toBe(expectedStatus);
      expect(await response.json(), name).toEqual({ status: expectedStatus === 200 ? "ready" : "not_ready" });
    }
  });
});
