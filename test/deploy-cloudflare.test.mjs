import test from "node:test";
import assert from "node:assert/strict";
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { checkHealth } from "../scripts/cloudflare-deploy.mjs";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const SCRIPT = join(ROOT, "scripts", "cloudflare-deploy.mjs");
const FAKE_D1_ID = "33333333-3333-4333-8333-333333333333";

function writeConfig(directory) {
  const configPath = join(directory, "wrangler.jsonc");
  writeFileSync(
    configPath,
    `${JSON.stringify(
      {
        name: "mock-gateway",
        main: "worker.js",
        assets: { directory: "./public", binding: "ASSETS" },
        d1_databases: [
          {
            binding: "DB",
            database_name: "mock-gateway-db",
            database_id: FAKE_D1_ID,
            migrations_dir: "migrations",
          },
        ],
      },
      null,
      2,
    )}\n`,
  );
  return configPath;
}

function writePreload(directory, logPath) {
  const preloadPath = join(directory, "mock-cloudflare-preload.mjs");
  writeFileSync(
    preloadPath,
    `import childProcess from "node:child_process";
import { syncBuiltinESMExports } from "node:module";
import { appendFileSync } from "node:fs";

const logPath = ${JSON.stringify(logPath)};
const scenario = process.env.MOCK_CLOUDFLARE_SCENARIO || "success";
let hasLinkSecret = process.env.MOCK_HAS_LINK === "true";
const names = () => {
  if (scenario === "missing-credentials") return [{ name: "LINK_SIGNING_SECRET" }];
  const values = [{ name: "ADMIN_USERNAME" }];
  if (process.env.MOCK_CREDENTIAL === "hash") values.push({ name: "ADMIN_PASSWORD_HASH" });
  else values.push({ name: "ADMIN_PASSWORD" });
  if (hasLinkSecret) values.push({ name: "LINK_SIGNING_SECRET" });
  return values;
};
const record = (entry) => appendFileSync(logPath, JSON.stringify(entry) + "\\n");
const result = (status = 0, stdout = "", stderr = "") => ({ status, stdout, stderr });

childProcess.spawnSync = (command, args = [], options = {}) => {
  record({
    command,
    args,
    inputLength: typeof options.input === "string" ? options.input.length : 0,
  });
  if (args.includes("whoami") || args.includes("setup")) {
    return result(97, "", "local-only command must not run");
  }
  if (args.includes("secret") && args.includes("list")) {
    return result(0, JSON.stringify(names()));
  }
  if (args.includes("secret") && args.includes("put")) {
    if (scenario === "secret-put-failure") return result(31, "", "secret put failed");
    hasLinkSecret = true;
    return result();
  }
  if (args.includes("deploy") && args.includes("--dry-run")) {
    if (scenario === "dry-run-failure") return result(32, "", "dry-run failed");
    return result();
  }
  if (args.includes("migrations")) {
    if (scenario === "migration-failure") return result(33, "", "migration failed");
    return result();
  }
  if (args.includes("deploy")) {
    if (scenario === "publish-failure") return result(34, "", "publish failed");
    return result(0, "https://mock-gateway.example.workers.dev\\n");
  }
  return result();
};
syncBuiltinESMExports();
globalThis.fetch = async () => ({
  status: 200,
  text: async () => JSON.stringify({ status: "ready" }),
});
`,
  );
  return preloadPath;
}

function runDeploy(scenario, { credential = "password", hasLink = false } = {}) {
  const directory = mkdtempSync(join(tmpdir(), "gateway-cloudflare-deploy-"));
  const configPath = writeConfig(directory);
  const statePath = join(directory, "state.json");
  const logPath = join(directory, "commands.jsonl");
  const preloadPath = writePreload(directory, logPath);
  const result = spawnSync(
    process.execPath,
    ["--import", preloadPath, SCRIPT],
    {
      cwd: ROOT,
      env: {
        ...process.env,
        CLOUDFLARE_PROJECT_ROOT: directory,
        CLOUDFLARE_WRANGLER_BIN: join(directory, "node_modules", "wrangler", "bin", "wrangler.js"),
        WRANGLER_CONFIG: configPath,
        PUBLIC_URL: "https://mock-gateway.example.test",
        MOCK_CLOUDFLARE_SCENARIO: scenario,
        MOCK_CREDENTIAL: credential,
        MOCK_HAS_LINK: String(hasLink),
      },
      encoding: "utf8",
    },
  );
  const commands = existsSync(logPath)
    ? readFileSync(logPath, "utf8")
        .trim()
        .split(/\r?\n/)
        .filter(Boolean)
        .map((line) => JSON.parse(line))
    : [];
  return { directory, statePath, result, commands };
}

function formalPublish(command) {
  return command.args.includes("deploy") && !command.args.includes("--dry-run");
}

function commandHas(command, ...parts) {
  return parts.every((part) => command.args.includes(part));
}

test("standalone deploy initializes one signing Secret and preserves it on repeat", () => {
  const first = runDeploy("success");
  const second = runDeploy("success", { hasLink: true });
  try {
    assert.equal(first.result.status, 0, `${first.result.stdout}\n${first.result.stderr}`);
    assert.equal(second.result.status, 0, `${second.result.stdout}\n${second.result.stderr}`);
    assert.equal(existsSync(first.statePath), false);
    assert.equal(existsSync(second.statePath), false);

    const firstPuts = first.commands.filter((command) => commandHas(command, "secret", "put"));
    const secondPuts = second.commands.filter((command) => commandHas(command, "secret", "put"));
    assert.equal(firstPuts.length, 1);
    assert.equal(firstPuts[0].args.includes("LINK_SIGNING_SECRET"), true);
    assert.equal(firstPuts[0].inputLength, 44);
    assert.equal(secondPuts.length, 0);

    for (const command of [...first.commands, ...second.commands]) {
      assert.equal(command.args.some((arg) => /typecheck|build|setup|whoami/.test(arg)), false);
    }
    const migration = first.commands.find((command) => commandHas(command, "migrations"));
    assert.deepEqual(
      migration.args.slice(migration.args.indexOf("d1"), migration.args.indexOf("d1") + 5),
      ["d1", "migrations", "apply", "DB", "--remote"],
    );
    assert.equal(first.commands.filter(formalPublish).length, 1);
  } finally {
    rmSync(first.directory, { recursive: true, force: true });
    rmSync(second.directory, { recursive: true, force: true });
  }
});

test("standalone deploy accepts either new password or legacy hash Secret", () => {
  const password = runDeploy("success", { credential: "password", hasLink: true });
  const hash = runDeploy("success", { credential: "hash", hasLink: true });
  try {
    assert.equal(password.result.status, 0, `${password.result.stdout}\n${password.result.stderr}`);
    assert.equal(hash.result.status, 0, `${hash.result.stdout}\n${hash.result.stderr}`);
    assert.equal(password.commands.some((command) => commandHas(command, "secret", "put")), false);
    assert.equal(hash.commands.some((command) => commandHas(command, "secret", "put")), false);
  } finally {
    rmSync(password.directory, { recursive: true, force: true });
    rmSync(hash.directory, { recursive: true, force: true });
  }
});

test("missing credentials fails before signing Secret creation or publish", () => {
  const run = runDeploy("missing-credentials");
  try {
    const output = `${run.result.stdout}\n${run.result.stderr}`;
    assert.notEqual(run.result.status, 0);
    assert.match(output, /缺少管理员凭据 Secret/);
    assert.equal(run.commands.some((command) => commandHas(command, "secret", "put")), false);
    assert.equal(run.commands.some((command) => commandHas(command, "migrations")), false);
    assert.equal(run.commands.some(formalPublish), false);
  } finally {
    rmSync(run.directory, { recursive: true, force: true });
  }
});

test("Secret and migration failures stop before formal publish", () => {
  const secretFailure = runDeploy("secret-put-failure");
  const migrationFailure = runDeploy("migration-failure");
  try {
    assert.notEqual(secretFailure.result.status, 0);
    assert.equal(secretFailure.commands.some((command) => commandHas(command, "migrations")), false);
    assert.equal(secretFailure.commands.some(formalPublish), false);

    assert.notEqual(migrationFailure.result.status, 0);
    assert.equal(migrationFailure.commands.some((command) => commandHas(command, "migrations")), true);
    assert.equal(migrationFailure.commands.some(formalPublish), false);
  } finally {
    rmSync(secretFailure.directory, { recursive: true, force: true });
    rmSync(migrationFailure.directory, { recursive: true, force: true });
  }
});

test("health check rejects HTML and non-ready 2xx responses", async () => {
  const previousFetch = globalThis.fetch;
  try {
    globalThis.fetch = async () => ({
      status: 200,
      text: async () => "<html>temporary platform page</html>",
    });
    const html = await checkHealth("https://mock-gateway.example.test", 100);
    assert.equal(html.ok, false);

    globalThis.fetch = async () => ({
      status: 201,
      text: async () => JSON.stringify({ status: "ready" }),
    });
    const created = await checkHealth("https://mock-gateway.example.test", 100);
    assert.equal(created.ok, false);

    globalThis.fetch = async () => ({
      status: 200,
      text: async () => JSON.stringify({ status: "not_ready" }),
    });
    const notReady = await checkHealth("https://mock-gateway.example.test", 100);
    assert.equal(notReady.ok, false);

    globalThis.fetch = async () => ({
      status: 200,
      text: async () => JSON.stringify({ status: "ready" }),
    });
    const ready = await checkHealth("https://mock-gateway.example.test", 100);
    assert.equal(ready.ok, true);
  } finally {
    globalThis.fetch = previousFetch;
  }
});
