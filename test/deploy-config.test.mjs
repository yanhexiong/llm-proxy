import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { ROOT, readWranglerConfig, writeGeneratedWranglerConfig } from "../scripts/lib/common.mjs";

test("public template has only runtime secret fields and no personal resource IDs or routes", () => {
  const config = readWranglerConfig(join(ROOT, "wrangler.jsonc"));
  assert.equal(config.account_id, undefined);
  assert.equal(config.routes, undefined);
  assert.equal(config.route, undefined);
  assert.equal(config.vars, undefined);
  assert.equal(config.d1_databases[0].binding, "DB");
  assert.equal(config.d1_databases[0].database_id, "00000000-0000-0000-0000-000000000000");
  const example = readFileSync(join(ROOT, ".dev.vars.example"), "utf8");
  const keys = example.split(/\r?\n/).filter((line) => /^[A-Z_]+=/.test(line)).map((line) => line.split("=")[0]);
  assert.deepEqual(keys.sort(), ["ADMIN_PASSWORD", "ADMIN_USERNAME"]);
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
