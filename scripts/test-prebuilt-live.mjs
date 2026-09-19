#!/usr/bin/env node

// Maintainer-only integration test: provisions its own temporary Worker/D1,
// simulates the button supplying only username/password, and removes both.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { cpSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { ROOT } from "./lib/common.mjs";

const directory = mkdtempSync(join(ROOT, ".gateway-button-check-"));
cpSync(join(ROOT, ".deploy-template"), directory, { recursive: true });
const configPath = join(directory, "wrangler.jsonc");
const config = JSON.parse(readFileSync(configPath, "utf8"));
const name = `llm-proxy-button-check-${Date.now().toString(36)}`;
config.name = name;
config.d1_databases[0].database_name = name;
writeFileSync(configPath, JSON.stringify(config, null, 2));
const username = "button-admin";
const password = randomBytes(24).toString("base64url");
const replacement = randomBytes(24).toString("base64url");
const privateValues = [password, replacement];
const clean = (value) => privateValues.reduce((text, secret) => text.replaceAll(secret, "[REDACTED]"), String(value));
const checks = [];
let databaseId = "";
let workerAttempted = false;
let origin = "";

function command(binary, args, input = "") {
  const environment = { ...process.env, CI: "true" };
  // Test the same boundary as the button: runtime Secrets are not build vars.
  for (const key of ["ADMIN_PASSWORD", "ADMIN_PASSWORD_HASH", "LINK_SIGNING_SECRET", "ADMIN_USERNAME", "PUBLIC_URL", "WRANGLER_CONFIG"]) delete environment[key];
  const result = spawnSync(binary, args, {
    cwd: directory, encoding: "utf8", input, env: environment,
    maxBuffer: 8 * 1024 * 1024, timeout: 240_000,
  });
  if (result.error || result.status !== 0) {
    throw new Error(clean(`${binary} ${args.join(" ")} failed: ${result.error?.message || ""}\n${result.stdout}\n${result.stderr}`));
  }
  return `${result.stdout}\n${result.stderr}`;
}
function wrangler(args, input) {
  return command(process.execPath, [join(directory, "node_modules/wrangler/bin/wrangler.js"), ...args, "--config", configPath], input);
}
async function request(path, options = {}) {
  return fetch(`${origin}${path}`, { ...options, signal: AbortSignal.timeout(20_000), redirect: "manual" });
}
async function login(value, expected = 200) {
  const response = await request("/api/admin/login", {
    method: "POST", headers: { "content-type": "application/json", origin },
    body: JSON.stringify({ username, password: value }),
  });
  assert.equal(response.status, expected, `login expected ${expected}, got ${response.status}`);
  await response.body?.cancel();
  return response.headers.get("set-cookie")?.split(";", 1)[0] || "";
}
async function links(cookie) {
  const response = await request("/api/admin/links", { headers: { cookie } });
  assert.equal(response.status, 200);
  return (await response.json()).links;
}

try {
  console.log("[live] 安装预编译包的发布工具（不编译源码）。");
  command(process.platform === "win32" ? "npm.cmd" : "npm", ["install", "--no-audit", "--no-fund"]);
  console.log(`[live] 创建独立验收资源：${name}`);
  const created = wrangler(["d1", "create", name]);
  databaseId = created.match(/\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/i)?.[0] || "";
  assert.ok(databaseId, "D1 create did not return a database ID");
  config.d1_databases[0].database_id = databaseId;
  writeFileSync(configPath, JSON.stringify(config, null, 2));
  workerAttempted = true;
  const bootstrap = wrangler(["deploy"]);
  origin = bootstrap.match(/https:\/\/[a-z0-9.-]+\.workers\.dev/i)?.[0] || "";
  assert.ok(origin, "Worker deploy did not return a workers.dev address");
  wrangler(["secret", "bulk"], JSON.stringify({ ADMIN_USERNAME: username, ADMIN_PASSWORD: password }));
  const initialNames = JSON.parse(wrangler(["secret", "list", "--format", "json"])).map(value => value.name).sort();
  assert.deepEqual(initialNames, ["ADMIN_PASSWORD", "ADMIN_USERNAME"]);
  checks.push("only_username_and_password_supplied");

  console.log("[live] 只提供账号密码，执行预编译包的首次部署。");
  command(process.execPath, ["deploy.mjs"]);
  const health = await request("/health");
  assert.equal(health.status, 200);
  assert.deepEqual(await health.json(), { status: "ready" });
  const names = JSON.parse(wrangler(["secret", "list", "--format", "json"])).map(value => value.name).sort();
  assert.deepEqual(names, ["ADMIN_PASSWORD", "ADMIN_USERNAME", "LINK_SIGNING_SECRET"]);
  checks.push("automatic_migrations_and_signing_secret", "public_health_ready");
  let cookie = await login(password);
  await login("incorrect-password", 401);
  checks.push("correct_password_login_and_wrong_password_rejection");
  const createdLink = await request("/api/admin/links", {
    method: "POST", headers: { cookie, origin, "content-type": "application/json" },
    body: JSON.stringify({ target_type: "direct", base_url: "https://api.example.com/v1", client_protocol: "chat", upstream_protocol: "chat" }),
  });
  assert.equal(createdLink.status, 201);
  const { link } = await createdLink.json();
  privateValues.push(link.endpoint, link.base_url);

  console.log("[live] 重复部署并验证原签名链接继续保持一致。");
  command(process.execPath, ["deploy.mjs"]);
  cookie = await login(password);
  assert.equal((await links(cookie)).find(value => value.id === link.id)?.endpoint, link.endpoint);
  checks.push("repeat_deploy_preserves_signed_links");

  wrangler(["secret", "put", "ADMIN_PASSWORD"], `${replacement}\n`);
  cookie = await login(replacement);
  await login(password, 401);
  assert.equal((await links(cookie)).find(value => value.id === link.id)?.endpoint, link.endpoint);
  checks.push("password_reset_preserves_signed_links");
  console.log(`[live] ${checks.length}/${checks.length} 检查通过。`);
} finally {
  const cleanup = [];
  if (workerAttempted) {
    try { wrangler(["delete", name, "--force"]); cleanup.push("worker_deleted"); }
    catch (error) { console.error(clean(error.message)); process.exitCode = 1; }
  }
  if (databaseId) {
    try { wrangler(["d1", "delete", name, "--skip-confirmation"]); cleanup.push("database_deleted"); }
    catch (error) { console.error(clean(error.message)); process.exitCode = 1; }
  }
  const report = { name, origin, checks, cleanup, tested_at: new Date().toISOString() };
  writeFileSync(join(directory, "verification.json"), JSON.stringify(report, null, 2));
  console.log(`[live] 验收记录：${directory}/verification.json`);
  console.log(`[live] 清理结果：${cleanup.join(", ")}`);
}
