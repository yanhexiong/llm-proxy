import assert from "node:assert/strict";
import { pbkdf2Sync } from "node:crypto";
import { spawnSync } from "node:child_process";
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { ROOT, readWranglerConfig, writeGeneratedWranglerConfig } from "../scripts/lib/common.mjs";

test("public template has only runtime secret fields and no personal resource IDs or routes", () => {
  const config = readWranglerConfig(join(ROOT, "wrangler.jsonc"));
  assert.equal(config.account_id, undefined);
  assert.equal(config.routes, undefined);
  assert.equal(config.route, undefined);
  assert.equal(config.d1_databases[0].binding, "DB");
  assert.equal(config.d1_databases[0].database_id, "00000000-0000-0000-0000-000000000000");
  const example = readFileSync(join(ROOT, ".dev.vars.example"), "utf8");
  const keys = example.split(/\r?\n/).filter((line) => /^[A-Z_]+=/.test(line)).map((line) => line.split("=")[0]);
  assert.deepEqual(keys.sort(), ["ADMIN_PASSWORD_HASH", "ADMIN_USERNAME", "LINK_SIGNING_SECRET"]);
  assert.equal(existsSync(join(ROOT, ".env.example")), false);
});

test("local generated config preserves custom domains without contaminating public template", () => {
  const directory = mkdtempSync(join(tmpdir(), "gateway-routes-"));
  const previous = process.env.GATEWAY_GENERATED_CONFIG;
  try {
    process.env.GATEWAY_GENERATED_CONFIG = join(directory, "wrangler.jsonc");
    const state = {
      worker_name: "my-gateway",
      database_name: "my-renamed-db",
      database_id: "f0b4d317-7887-405c-a3d5-a2f39c134d9a",
      d1_binding: "DB",
      routes: [{ pattern: "gateway.example.com", custom_domain: true }],
    };
    const output = readWranglerConfig(writeGeneratedWranglerConfig(state));
    assert.deepEqual(output.routes, state.routes);
    assert.equal(output.name, "my-gateway");
    assert.equal(output.d1_databases[0].database_name, "my-renamed-db");
    assert.equal(output.d1_databases[0].database_id, state.database_id);
    assert.equal(readWranglerConfig(join(ROOT, "wrangler.jsonc")).routes, undefined);
  } finally {
    if (previous === undefined) delete process.env.GATEWAY_GENERATED_CONFIG;
    else process.env.GATEWAY_GENERATED_CONFIG = previous;
    rmSync(directory, { recursive: true, force: true });
  }
});

test("button initializer saves a verifiable hash and random key privately, without overwriting or logging secrets", () => {
  const directory = mkdtempSync(join(tmpdir(), "gateway-button-secrets-"));
  try {
    mkdirSync(join(directory, "scripts/lib"), { recursive: true });
    for (const name of ["scripts/generate-deploy-secrets.mjs", "scripts/lib/common.mjs"]) {
      copyFileSync(join(ROOT, name), join(directory, name));
    }
    const run = (password) => spawnSync(process.execPath, ["scripts/generate-deploy-secrets.mjs"], {
      cwd: directory,
      encoding: "utf8",
      env: { ...process.env, ADMIN_USERNAME: "tester", ADMIN_PASSWORD: password },
    });
    const destination = join(directory, ".gateway-deploy-secrets.json");
    const invalid = run("short");
    assert.equal(invalid.status, 1);
    assert.equal(existsSync(destination), false);

    const password = " test-password-with-spaces ";
    const generated = run(password);
    assert.equal(generated.status, 0, generated.stderr);
    const original = readFileSync(destination, "utf8");
    const secrets = JSON.parse(original);
    assert.equal(secrets.ADMIN_USERNAME, "tester");
    const [scheme, iterations, salt, hash] = secrets.ADMIN_PASSWORD_HASH.split("$");
    assert.equal(scheme, "pbkdf2_sha256");
    assert.equal(iterations, "100000");
    assert.equal(pbkdf2Sync(password, Buffer.from(salt, "base64url"), Number(iterations), 32, "sha256").toString("base64url"), hash);
    assert.equal(Buffer.from(secrets.LINK_SIGNING_SECRET, "base64url").length, 32);
    assert.ok(!original.includes(password));
    for (const value of [password, secrets.ADMIN_PASSWORD_HASH, secrets.LINK_SIGNING_SECRET]) {
      assert.ok(!`${generated.stdout}${generated.stderr}`.includes(value));
    }
    if (process.platform !== "win32") assert.equal(statSync(destination).mode & 0o777, 0o600);
    const repeated = run("different-password");
    assert.equal(repeated.status, 1);
    assert.equal(readFileSync(destination, "utf8"), original);
    assert.ok(!`${repeated.stdout}${repeated.stderr}`.includes(secrets.LINK_SIGNING_SECRET));
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});
