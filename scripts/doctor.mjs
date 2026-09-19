#!/usr/bin/env node

import {
  REQUIRED_SECRET_NAMES,
  checkHealth,
  commandDetails,
  compareNodeMajor,
  configuredPublicUrl,
  error,
  findWranglerConfig,
  formatCommandError,
  info,
  isWranglerAuthenticated,
  listSecretNames,
  loadState,
  normalizePublicUrl,
  parseArgs,
  readWranglerConfig,
  runPnpm,
  runWrangler,
  statePath,
  writeGeneratedWranglerConfig,
} from "./lib/common.mjs";

let failures = 0;
let checks = 0;

function pass(label, detail = "") {
  checks += 1;
  console.log(`  [OK]   ${label}${detail ? `：${detail}` : ""}`);
}

function fail(label, detail = "") {
  checks += 1;
  failures += 1;
  console.log(`  [FAIL] ${label}${detail ? `：${detail}` : ""}`);
}

function skip(label, detail = "") {
  console.log(`  [SKIP] ${label}${detail ? `：${detail}` : ""}`);
}

function commandDetail(result) {
  return commandDetails(result).replace(/\r?\n/g, " ").trim();
}

function checkTooling() {
  if (compareNodeMajor(22)) pass("Node.js", process.versions.node);
  else fail("Node.js", `需要 Node.js 22+，当前为 ${process.versions.node}`);

  const pnpm = runPnpm(["--version"], { allowFailure: true, label: "pnpm --version" });
  if (pnpm.status === 0) pass("pnpm", pnpm.stdout.trim());
  else fail("pnpm", commandDetail(pnpm) || "未找到 pnpm");

  const wrangler = runPnpm(["exec", "wrangler", "--version"], {
    allowFailure: true,
    label: "wrangler --version",
  });
  if (wrangler.status === 0) pass("Wrangler", wrangler.stdout.trim());
  else fail("Wrangler", commandDetail(wrangler) || "请先 pnpm install");
}

function checkStateAndConfig(requestedConfig) {
  const state = loadState();
  let configPath;
  let generatedConfig;
  if (!state) {
    fail("本地部署状态", `${statePath()} 不存在；先运行 pnpm run setup`);
  }
  else pass("本地部署状态", statePath());
  try {
    configPath = findWranglerConfig(requestedConfig || state?.config_path);
    const config = readWranglerConfig(configPath);
    pass("Wrangler 配置", configPath);
    if (state && (!state.database_id || !state.database_name || !state.worker_name)) {
      fail("状态字段", "缺少 worker_name、database_name 或 database_id");
    } else if (state) {
      pass("状态字段", `${state.worker_name} / ${state.database_name}`);
    }
    if (state) {
      generatedConfig = writeGeneratedWranglerConfig(state, configPath);
      const generated = readWranglerConfig(generatedConfig);
      const expectedBinding = state.d1_binding || "DB";
      const binding = (generated.d1_databases || []).find(
        (entry) => entry.binding === expectedBinding,
      );
      if (!binding) {
        fail("D1 绑定", `生成配置缺少 binding ${expectedBinding}`);
      } else if (binding.database_id !== state.database_id) {
        fail("D1 绑定", "生成配置中的 database_id 与状态不一致");
      } else if (binding.database_name !== state.database_name) {
        fail("D1 绑定", "生成配置中的 database_name 与状态不一致");
      } else {
        pass("D1 绑定", `${expectedBinding} -> ${state.database_name}`);
      }
    }
  } catch (cause) {
    fail("Wrangler 配置", cause.message);
  }
  return { state, configPath, generatedConfig };
}

function checkCloudflare(state, generatedConfig, configPath) {
  const activeConfig = generatedConfig || configPath;
  if (!activeConfig) return;
  const whoami = runWrangler(["whoami"], {
    configPath: activeConfig,
    allowFailure: true,
    label: "wrangler whoami",
  });
  if (isWranglerAuthenticated(whoami)) pass("Cloudflare 登录与账户权限");
  else fail("Cloudflare 登录与账户权限", commandDetail(whoami) || "请运行 pnpm exec wrangler login");
  if (!state || !generatedConfig) return;

  const d1Info = runWrangler(["d1", "info", state.database_name, "--json"], {
    configPath: generatedConfig,
    allowFailure: true,
    label: `D1 info ${state.database_name}`,
  });
  if (d1Info.status === 0) pass("D1 数据库可访问", state.database_name);
  else fail("D1 数据库可访问", commandDetail(d1Info));

  const migration = runWrangler(
    ["d1", "migrations", "list", state.database_name, "--remote"],
    {
      configPath: generatedConfig,
      allowFailure: true,
      label: `D1 migrations list ${state.database_name}`,
    },
  );
  const migrationText = `${migration.stdout}\n${migration.stderr}`.replace(/\u001b\[[0-?]*[ -/]*[@-~]/g, "");
  if (migration.status === 0 && /no migrations to apply/i.test(migrationText)) {
    pass("D1 迁移状态", "没有待应用迁移");
  } else if (migration.status === 0 && /migrations to be applied/i.test(migrationText)) {
    fail("D1 迁移状态", "远端存在待应用迁移；请运行 pnpm run deploy");
  } else {
    fail("D1 迁移状态", commandDetail(migration) || "无法确认迁移是否已全部应用");
  }

  const secrets = listSecretNames(generatedConfig);
  if (!secrets.ok) {
    fail("Worker Secrets", commandDetail(secrets.result) || "无法读取 Secret 名称");
  } else {
    const missing = REQUIRED_SECRET_NAMES.filter((name) => !secrets.names.has(name));
    if (missing.length > 0) fail("Worker Secrets", `缺少：${missing.join(", ")}`);
    else pass("Worker Secrets", "已配置必要名称（值不会显示）");
  }
}

async function checkPublicHealth(state, configPath) {
  if (!state) return;
  const rawUrl = process.env.PUBLIC_URL?.trim() || state.public_url || configuredPublicUrl(configPath);
  if (!rawUrl) {
    skip("公开健康检查", "未设置 PUBLIC_URL，首次发布后可运行 PUBLIC_URL=https://... pnpm run doctor");
    return;
  }
  let url;
  try {
    url = normalizePublicUrl(rawUrl);
  } catch (cause) {
    fail("公开健康检查", cause.message);
    return;
  }
  const result = await checkHealth(url);
  if (result.ok) pass("公开健康检查", `${url}/health (${result.status})`);
  else fail("公开健康检查", `${url}/health 返回 ${result.status || "网络错误"}`);
}

async function main() {
  const { values } = parseArgs();
  console.log("Workers API Gateway doctor");
  console.log("只检查账户、绑定、迁移和 Secret 名称，不会显示 Secret 值。\n");
  checkTooling();
  const { state, configPath, generatedConfig } = checkStateAndConfig(values.config);
  checkCloudflare(state, generatedConfig, configPath);
  await checkPublicHealth(state, generatedConfig || configPath);
  console.log(`\n检查完成：${checks} 项，${failures} 项失败。`);
  if (failures > 0) process.exitCode = 1;
}

try {
  await main();
} catch (cause) {
  error(formatCommandError(cause));
  process.exitCode = 1;
}
