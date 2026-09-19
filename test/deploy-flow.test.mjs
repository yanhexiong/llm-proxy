import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, existsSync, readFileSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { join, resolve } from "node:path";
import { spawnSync } from "node:child_process";

import {
  isValidD1DatabaseId,
  migrationTarget,
  platformD1Target,
  resolveDeploymentContext,
} from "../scripts/deploy.mjs";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const FAKE_D1_ID = "11111111-1111-4111-8111-111111111111";

function makeConfig(directory, d1Databases) {
  const configPath = join(directory, "wrangler.jsonc");
  writeFileSync(
    configPath,
    `${JSON.stringify(
      {
        name: "test-gateway",
        main: "src/index.ts",
        d1_databases: d1Databases,
      },
      null,
      2,
    )}\n`,
  );
  return configPath;
}

function withDeployEnv(values, callback) {
  const previous = new Map();
  for (const [name, value] of Object.entries(values)) {
    previous.set(name, process.env[name]);
    if (value === undefined) delete process.env[name];
    else process.env[name] = value;
  }
  try {
    return callback();
  } finally {
    for (const [name, value] of previous) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
  }
}

test("platform D1 validation rejects the zero placeholder before deployment commands", () => {
  const directory = mkdtempSync(join(tmpdir(), "gateway-deploy-flow-"));
  try {
    const configPath = makeConfig(directory, [
      {
        binding: "DB",
        database_name: "test-gateway",
        database_id: "00000000-0000-0000-0000-000000000000",
      },
    ]);
    assert.equal(isValidD1DatabaseId("00000000-0000-0000-0000-000000000000"), false);
    assert.throws(
      () => platformD1Target(configPath),
      /自动创建并注入 D1|本地运行 pnpm run setup/,
    );
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("platform context uses source config and does not create local state", () => {
  const directory = mkdtempSync(join(tmpdir(), "gateway-deploy-flow-"));
  const statePath = join(directory, "state.json");
  try {
    const configPath = makeConfig(directory, [
      {
        binding: "DB",
        database_name: "test-gateway",
        database_id: FAKE_D1_ID,
      },
    ]);
    const context = withDeployEnv(
      {
        WRANGLER_CONFIG: configPath,
        GATEWAY_STATE_FILE: statePath,
      },
      () => resolveDeploymentContext(),
    );
    assert.equal(context.mode, "platform");
    assert.equal(context.configPath, configPath);
    assert.equal(context.d1.databaseName, "test-gateway");
    assert.equal(existsSync(statePath), false);
    assert.equal(readFileSync(configPath, "utf8").includes(FAKE_D1_ID), true);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("platform failure exits before typecheck/build and leaves no state", () => {
  const directory = mkdtempSync(join(tmpdir(), "gateway-deploy-flow-"));
  const statePath = join(directory, "state.json");
  try {
    const configPath = makeConfig(directory, [
      {
        binding: "DB",
        database_name: "test-gateway",
        database_id: "SET_BY_PNPM_SETUP",
      },
    ]);
    const result = spawnSync(process.execPath, ["scripts/deploy.mjs"], {
      cwd: ROOT,
      env: {
        ...process.env,
        WRANGLER_CONFIG: configPath,
        GATEWAY_STATE_FILE: statePath,
      },
      encoding: "utf8",
    });
    const output = `${result.stdout}\n${result.stderr}`;
    assert.notEqual(result.status, 0);
    assert.match(output, /占位或无效 database_id/);
    assert.doesNotMatch(output, /检查 TypeScript|构建 Worker|wrangler deploy/);
    assert.equal(existsSync(statePath), false);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("migration target follows the configured state binding, not stale state name", () => {
  const directory = mkdtempSync(join(tmpdir(), "gateway-deploy-flow-"));
  try {
    const configPath = makeConfig(directory, [
      {
        binding: "DB",
        database_name: "source-db",
        database_id: FAKE_D1_ID,
      },
      {
        binding: "ARCHIVE",
        database_name: "renamed-archive-db",
        database_id: "22222222-2222-4222-8222-222222222222",
      },
    ]);
    const target = migrationTarget(configPath, {
      d1_binding: "ARCHIVE",
      database_name: "old-archive-db",
      database_id: "22222222-2222-4222-8222-222222222222",
    });
    assert.equal(target.binding, "ARCHIVE");
    assert.equal(target.databaseName, "renamed-archive-db");
    assert.equal(target.databaseId, "22222222-2222-4222-8222-222222222222");
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

function writeCommandPreload(directory, logPath) {
  const preloadPath = join(directory, "mock-deploy-preload.mjs");
  writeFileSync(
    preloadPath,
    `import childProcess from "node:child_process";
import { syncBuiltinESMExports } from "node:module";
import { appendFileSync } from "node:fs";

const logPath = ${JSON.stringify(logPath)};
const scenario = process.env.MOCK_DEPLOY_SCENARIO || "success";
const record = (command, args) => appendFileSync(
  logPath,
  JSON.stringify({ command, args }) + "\\n",
);
const result = (status = 0, stdout = "", stderr = "") => ({
  status,
  stdout,
  stderr,
});

childProcess.spawnSync = (command, args = []) => {
  record(command, args);
  if (args.includes("whoami")) {
    return result(97, "", "whoami must not be called by platform deploy");
  }
  if (args[0] === "run" && (args[1] === "typecheck" || args[1] === "build")) {
    return result();
  }
  if (args.includes("secret") && args.includes("list")) {
    if (scenario === "missing-secret") return result(0, "[]");
    return result(0, JSON.stringify([
      { name: "ADMIN_USERNAME" },
      { name: "ADMIN_PASSWORD_HASH" },
      { name: "LINK_SIGNING_SECRET" },
    ]));
  }
  if (args.includes("d1") && args.includes("migrations")) {
    if (scenario === "migration-failure") {
      return result(1, "", "mock migration failure");
    }
    return result();
  }
  if (args.includes("deploy") && args.includes("--dry-run")) return result();
  if (args.includes("deploy")) {
    return result(0, "https://mock-gateway.example.workers.dev\\n");
  }
  if (args.includes("secret") && args.includes("put")) {
    return result(98, "", "secret put must not be called by platform deploy");
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

function runMockedPlatformDeploy(scenario) {
  const directory = mkdtempSync(join(tmpdir(), "gateway-deploy-flow-"));
  const statePath = join(directory, "state.json");
  const logPath = join(directory, "commands.jsonl");
  const configPath = makeConfig(directory, [
    {
      binding: "DB",
      database_name: "platform-gateway-db",
      database_id: FAKE_D1_ID,
    },
  ]);
  const preloadPath = writeCommandPreload(directory, logPath);
  const result = spawnSync(
    process.execPath,
    ["--import", preloadPath, "scripts/deploy.mjs"],
    {
      cwd: ROOT,
      env: {
        ...process.env,
        WRANGLER_CONFIG: configPath,
        GATEWAY_STATE_FILE: statePath,
        PUBLIC_URL: "https://mock-gateway.example.test",
        MOCK_DEPLOY_SCENARIO: scenario,
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

function isFormalPublish(command) {
  return command.args.includes("deploy") && !command.args.includes("--dry-run");
}

test("platform deployment runs the full command flow without local-only mutations", () => {
  const run = runMockedPlatformDeploy("success");
  try {
    assert.equal(run.result.status, 0, `${run.result.stdout}\n${run.result.stderr}`);
    assert.equal(existsSync(run.statePath), false);
    assert.equal(run.commands.some((command) => command.args.includes("whoami")), false);
    assert.equal(run.commands.some((command) => command.args.includes("setup")), false);
    assert.equal(
      run.commands.some(
        (command) => command.args.includes("secret") && command.args.includes("put"),
      ),
      false,
    );

    const dryRunIndex = run.commands.findIndex(
      (command) => command.args.includes("deploy") && command.args.includes("--dry-run"),
    );
    const secretIndex = run.commands.findIndex(
      (command) => command.args.includes("secret") && command.args.includes("list"),
    );
    const migrationIndex = run.commands.findIndex(
      (command) => command.args.includes("d1") && command.args.includes("migrations"),
    );
    const publishIndex = run.commands.findIndex(isFormalPublish);
    assert.ok(dryRunIndex >= 0);
    assert.ok(secretIndex > dryRunIndex);
    assert.ok(migrationIndex > secretIndex);
    assert.ok(publishIndex > migrationIndex);
    assert.ok(
      run.commands.findIndex(
        (command, index) =>
          index > publishIndex &&
          command.args.includes("secret") &&
          command.args.includes("list"),
      ) > publishIndex,
    );

    const migration = run.commands[migrationIndex].args;
    const d1Index = migration.indexOf("d1");
    assert.deepEqual(
      migration.slice(d1Index, d1Index + 5),
      ["d1", "migrations", "apply", "DB", "--remote"],
    );
  } finally {
    rmSync(run.directory, { recursive: true, force: true });
  }
});

test("missing platform Secret stops before migration and publish", () => {
  const run = runMockedPlatformDeploy("missing-secret");
  try {
    const output = `${run.result.stdout}\n${run.result.stderr}`;
    assert.notEqual(run.result.status, 0);
    assert.match(output, /Worker 缺少必要 Secret/);
    assert.equal(run.commands.some((command) => command.args.includes("whoami")), false);
    assert.equal(
      run.commands.some((command) => command.args.includes("migrations")),
      false,
    );
    assert.equal(run.commands.some(isFormalPublish), false);
    assert.equal(existsSync(run.statePath), false);
  } finally {
    rmSync(run.directory, { recursive: true, force: true });
  }
});

test("migration failure stops before formal publish", () => {
  const run = runMockedPlatformDeploy("migration-failure");
  try {
    const output = `${run.result.stdout}\n${run.result.stderr}`;
    assert.notEqual(run.result.status, 0);
    assert.match(output, /D1 迁移失败/);
    assert.equal(run.commands.some((command) => command.args.includes("whoami")), false);
    assert.equal(run.commands.some(isFormalPublish), false);
    assert.equal(existsSync(run.statePath), false);
  } finally {
    rmSync(run.directory, { recursive: true, force: true });
  }
});
