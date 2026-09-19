#!/usr/bin/env node

import {
  DEFAULT_D1_BINDING,
  REQUIRED_SECRET_NAMES,
  ask,
  askSecret,
  commandDetails,
  error,
  extractDatabaseId,
  extractJson,
  findWranglerConfig,
  formatCommandError,
  info,
  isMissingWorkerError,
  isWranglerAuthenticated,
  loadPendingSecrets,
  loadState,
  listSecretNames,
  parseArgs,
  passwordHash,
  putSecret,
  randomSecret,
  readWranglerConfig,
  runWrangler,
  statePath,
  warn,
  writeGeneratedWranglerConfig,
  writePendingSecrets,
  writeState,
} from "./lib/common.mjs";

function envOrArg(values, name, environmentName) {
  return values[name] || process.env[environmentName] || "";
}

function d1Records(value, records = []) {
  if (!value || typeof value !== "object") return records;
  if (Array.isArray(value)) {
    value.forEach((entry) => d1Records(entry, records));
    return records;
  }
  const name = value.database_name || value.databaseName || value.name;
  const id = value.database_id || value.databaseId || value.uuid || value.id;
  if (typeof name === "string" && typeof id === "string") records.push({ name, id });
  Object.values(value).forEach((entry) => {
    if (entry && typeof entry === "object") d1Records(entry, records);
  });
  return records;
}

function listD1Databases(configPath) {
  const result = runWrangler(["d1", "list", "--json"], {
    configPath,
    allowFailure: true,
    label: "wrangler d1 list",
  });
  if (result.status !== 0) {
    throw new Error(
      `无法读取 Cloudflare D1 列表。请确认已登录并有 D1 权限。\n${
        commandDetails(result)
      }`,
    );
  }
  return d1Records(extractJson(result.stdout));
}

function createD1Database(name, configPath) {
  const result = runWrangler(["d1", "create", name], {
    configPath,
    label: `创建 D1 数据库 ${name}`,
  });
  const id = extractDatabaseId(`${result.stdout}\n${result.stderr}`);
  if (!id) {
    throw new Error(
      `D1 已创建但无法从 Wrangler 输出解析 database_id。请保留终端输出并在状态文件中补充 ID：${statePath()}`,
    );
  }
  return id;
}

async function collectMissingSecrets({ names, workerExists, pending, adminUsername, nonInteractive }) {
  const values = { ...pending };
  if (!names.has("ADMIN_USERNAME") && !values.ADMIN_USERNAME) {
    const entered = adminUsername ||
      (nonInteractive ? "" : await ask("管理员用户名", "admin"));
    if (!entered) throw new Error("管理员用户名不能为空。");
    values.ADMIN_USERNAME = entered;
  }
  if (!names.has("ADMIN_PASSWORD_HASH") && !values.ADMIN_PASSWORD_HASH) {
    const password = process.env.ADMIN_PASSWORD || "";
    const entered = password ||
      (nonInteractive ? "" : await askSecret("管理员密码（不会显示）"));
    if (!entered || entered.length < 8) {
      throw new Error(
        nonInteractive
          ? "非交互 setup 缺少有效管理员密码；请设置 ADMIN_PASSWORD（至少 8 个字符）后重试。"
          : "管理员密码至少需要 8 个字符；请通过 ADMIN_PASSWORD 或交互输入提供。",
      );
    }
    values.ADMIN_PASSWORD_HASH = passwordHash(entered);
  }
  if (!names.has("LINK_SIGNING_SECRET") && !values.LINK_SIGNING_SECRET) {
    values.LINK_SIGNING_SECRET = randomSecret(32);
  }
  if (!workerExists) {
    writePendingSecrets(values);
    info("Worker 尚未发布，Secret 已安全暂存到本地待上传文件；首次 deploy 后会自动上传。");
  }
  return values;
}

async function ensureSecrets({ configPath, names, state, adminUsername, nonInteractive }) {
  const pending = loadPendingSecrets() || {};
  if (!names.ok) {
    if (!names.workerMissing && !isMissingWorkerError(names.result)) {
      throw new Error(
        `无法列出 Worker Secrets；未修改任何 Secret。\n${
          commandDetails(names.result)
        }`,
      );
    }
    const values = await collectMissingSecrets({
      names: new Set(),
      workerExists: false,
      pending,
      adminUsername,
      nonInteractive,
    });
    state.pending_secret_names = REQUIRED_SECRET_NAMES;
    return { state, uploaded: false };
  }

  const values = await collectMissingSecrets({
    names: names.names,
    workerExists: true,
    pending,
    adminUsername,
    nonInteractive,
  });
  const remaining = { ...pending };
  let deferred = false;
  for (const name of REQUIRED_SECRET_NAMES) {
    if (names.names.has(name)) {
      if (remaining[name]) delete remaining[name];
      info(`保留已有 Secret：${name}`);
      continue;
    }
    if (!values[name]) throw new Error(`无法生成 ${name}。`);
    info(`写入 Secret：${name}`);
    try {
      putSecret(name, values[name], configPath);
    } catch (cause) {
      if (!isMissingWorkerError(cause)) throw cause;
      Object.assign(remaining, values);
      deferred = true;
      break;
    }
    delete remaining[name];
  }
  if (deferred) {
    writePendingSecrets(remaining);
    state.pending_secret_names = REQUIRED_SECRET_NAMES;
    info("Worker 尚未发布，Secret 已暂存到本地；首次 deploy 后会自动上传。");
    return { state, uploaded: false };
  }
  if (Object.keys(remaining).length > 0) writePendingSecrets(remaining);
  else if (Object.keys(pending).length > 0) {
    // The deploy script removes this file after the first successful sync. Do
    // not silently unlink it here because setup may be interrupted immediately
    // after the last secret upload.
    writePendingSecrets({});
  }
  state.pending_secret_names = [];
  state.secret_names = REQUIRED_SECRET_NAMES;
  return { state, uploaded: true };
}

async function ensureLogin(configPath, nonInteractive) {
  let result = runWrangler(["whoami"], {
    configPath,
    allowFailure: true,
    label: "wrangler whoami",
  });
  if (isWranglerAuthenticated(result)) return;
  if (nonInteractive) {
    throw new Error(
      `Cloudflare 尚未登录。请先运行 pnpm exec wrangler login，或在交互终端运行 pnpm run setup。\n${
        commandDetails(result)
      }`,
    );
  }
  info("需要 Cloudflare 授权，浏览器将打开 Wrangler 登录页面。");
  runWrangler(["login"], { configPath, inherit: true, label: "wrangler login" });
  result = runWrangler(["whoami"], {
    configPath,
    allowFailure: true,
    label: "wrangler whoami",
  });
  if (!isWranglerAuthenticated(result)) {
    throw new Error("Cloudflare 登录未完成，请再次运行 pnpm run setup。");
  }
}

async function main() {
  const { values } = parseArgs();
  const nonInteractive = Boolean(values["non-interactive"] || process.env.CI === "true");
  const existingState = loadState() || {};
  const configPath = findWranglerConfig(values.config || existingState.config_path);
  const config = readWranglerConfig(configPath);
  await ensureLogin(configPath, nonInteractive);

  const workerDefault =
    envOrArg(values, "worker-name", "WORKER_NAME") ||
    existingState.worker_name ||
    config.name ||
    "api-gateway";
  const workerName = nonInteractive
    ? workerDefault
    : await ask("Worker 名称", workerDefault);
  if (!workerName) throw new Error("Worker 名称不能为空。");

  const accountId =
    envOrArg(values, "account-id", "CLOUDFLARE_ACCOUNT_ID") ||
    existingState.account_id ||
    config.account_id ||
    (nonInteractive ? "" : await ask("Cloudflare Account ID（可留空，使用当前默认账户）"));
  const databaseNameDefault =
    envOrArg(values, "database-name", "D1_DATABASE_NAME") ||
    existingState.database_name ||
    `${workerName}-d1`;
  const databaseName = nonInteractive
    ? databaseNameDefault
    : await ask("D1 数据库名称", databaseNameDefault);
  if (!databaseName) throw new Error("D1 数据库名称不能为空。");

  const binding =
    envOrArg(values, "d1-binding", "D1_BINDING") ||
    existingState.d1_binding ||
    config.d1_databases?.[0]?.binding ||
    DEFAULT_D1_BINDING;

  info(`正在查找 D1 数据库：${databaseName}`);
  const records = listD1Databases(configPath);
  const matching = records.find((record) => record.name === databaseName);
  let databaseId = matching?.id || "";
  if (databaseId) {
    info(`复用已有 D1：${databaseName}`);
  } else {
    info(`未找到 ${databaseName}，创建新的 D1 数据库。`);
    databaseId = createD1Database(databaseName, configPath);
    info(`D1 创建完成：${databaseId}`);
  }

  const state = {
    ...existingState,
    state_version: 1,
    config_path: configPath,
    worker_name: workerName,
    account_id: accountId || undefined,
    d1_binding: binding,
    database_name: databaseName,
    database_id: databaseId,
    migrations_dir: "migrations",
    setup_at: existingState.setup_at || new Date().toISOString(),
    updated_at: new Date().toISOString(),
  };
  writeState(state);
  const generatedConfig = writeGeneratedWranglerConfig(state, configPath);
  state.generated_config_path = generatedConfig;
  writeState(state);
  info(`本地部署状态已写入：${statePath()}`);

  const names = listSecretNames(generatedConfig);
  const adminUsername = envOrArg(values, "admin-username", "ADMIN_USERNAME");
  const result = await ensureSecrets({
    configPath: generatedConfig,
    names,
    state,
    adminUsername,
    nonInteractive,
  });
  writeState({ ...result.state, updated_at: new Date().toISOString() });
  info("setup 完成。下一步运行 pnpm run deploy；该命令会执行迁移、发布并检查 /health。 ");
}

try {
  await main();
} catch (cause) {
  error(formatCommandError(cause));
  process.exitCode = 1;
}
