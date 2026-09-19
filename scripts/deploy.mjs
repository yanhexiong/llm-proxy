#!/usr/bin/env node

import {
  DEFAULT_D1_BINDING,
  REQUIRED_SECRET_NAMES,
  checkHealth,
  clearPendingSecrets,
  commandDetails,
  configuredPublicUrl,
  error,
  extractDeployedUrl,
  findWranglerConfig,
  formatCommandError,
  info,
  isWranglerAuthenticated,
  listSecretNames,
  loadPendingSecrets,
  loadState,
  normalizePublicUrl,
  readWranglerConfig,
  runPnpm,
  runWrangler,
  statePath,
  writeGeneratedWranglerConfig,
  writeState,
} from "./lib/common.mjs";
import { pathToFileURL } from "node:url";
import { resolve } from "node:path";
import {
  ADMIN_PASSWORD_HASH_SECRET,
  ADMIN_PASSWORD_SECRET,
  LINK_SIGNING_SECRET,
  generateLinkSigningSecret,
  missingCredentialSecretNames,
  missingRuntimeSecretNames,
} from "./lib/cloudflare-secrets.mjs";

const D1_DATABASE_ID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const ZERO_D1_DATABASE_ID = "00000000-0000-0000-0000-000000000000";

export function isValidD1DatabaseId(value) {
  return (
    typeof value === "string" &&
    D1_DATABASE_ID_PATTERN.test(value) &&
    value.toLowerCase() !== ZERO_D1_DATABASE_ID
  );
}

export function configuredD1Binding(configPath, binding = DEFAULT_D1_BINDING) {
  const config = readWranglerConfig(configPath);
  const entries = Array.isArray(config.d1_databases) ? config.d1_databases : [];
  const entry = entries.find((candidate) => candidate?.binding === binding);
  return {
    config,
    binding,
    entry,
    databaseName: entry?.database_name || "",
    databaseId: entry?.database_id || "",
  };
}

export function platformD1Target(configPath) {
  const target = configuredD1Binding(configPath, DEFAULT_D1_BINDING);
  if (!target.entry) {
    throw new Error(
      `平台部署要求源配置中的 D1 binding ${DEFAULT_D1_BINDING}；当前未找到该绑定。请确认 Cloudflare Deploy to Cloudflare 已自动配置 D1，或先在本地运行 pnpm run setup。`,
    );
  }
  if (!isValidD1DatabaseId(target.databaseId)) {
    throw new Error(
      `源配置中的 D1 binding ${DEFAULT_D1_BINDING} 仍使用占位或无效 database_id：${target.databaseId || "<空>"}。请先让 Cloudflare Deploy to Cloudflare 自动创建并注入 D1 资源，或在本地运行 pnpm run setup；不会在平台构建中创建新数据库。`,
    );
  }
  if (!target.databaseName) {
    throw new Error(
      `源配置中的 D1 binding ${DEFAULT_D1_BINDING} 缺少 database_name。请先让 Cloudflare Deploy to Cloudflare 自动配置 D1，或在本地运行 pnpm run setup。`,
    );
  }
  return target;
}

export function migrationTarget(configPath, state = null) {
  const binding = state?.d1_binding || DEFAULT_D1_BINDING;
  const target = configuredD1Binding(configPath, binding);
  if (!target.entry || !target.databaseName) {
    throw new Error(
      `Wrangler 配置中缺少 D1 binding ${binding} 的 database_name；已停止迁移，请检查源配置和部署状态。`,
    );
  }
  if (!isValidD1DatabaseId(target.databaseId)) {
    throw new Error(
      `Wrangler 配置中 D1 binding ${binding} 的 database_id 无效：${target.databaseId || "<空>"}；已停止迁移。`,
    );
  }
  return target;
}

function requireState() {
  const state = loadState();
  if (
    !state?.worker_name ||
    !state?.database_name ||
    !isValidD1DatabaseId(state?.database_id)
  ) {
    throw new Error(
      `缺少有效部署状态。请先运行 pnpm run setup；状态文件应包含 Worker 和有效 D1 信息：${statePath()}`,
    );
  }
  return state;
}

export function resolveDeploymentContext() {
  const existingState = loadState();
  if (existingState) {
    const state = requireState();
    const sourceConfigPath = findWranglerConfig(state.config_path);
    const generatedConfig = writeGeneratedWranglerConfig(state, sourceConfigPath);
    const updatedState = {
      ...state,
      config_path: sourceConfigPath,
      generated_config_path: generatedConfig,
      updated_at: new Date().toISOString(),
    };
    writeState(updatedState);
    return {
      mode: "local",
      state: updatedState,
      configPath: generatedConfig,
      sourceConfigPath,
    };
  }

  const sourceConfigPath = findWranglerConfig();
  const d1 = platformD1Target(sourceConfigPath);
  info(
    `检测到 Workers Builds 平台部署：使用源配置中的 D1 ${d1.binding}（${d1.databaseName}），不运行 setup、不生成本地状态或新 Secret。`,
  );
  return {
    mode: "platform",
    state: null,
    configPath: sourceConfigPath,
    sourceConfigPath,
    d1,
  };
}

function runTypecheck() {
  info("检查 TypeScript 和前端类型。");
  const result = runPnpm(["run", "typecheck"], {
    allowFailure: true,
    label: "pnpm run typecheck",
  });
  if (result.status !== 0) {
    throw new Error(
      `类型检查失败，已停止构建、迁移和发布。请先修复类型错误再重试。\n${
        commandDetails(result)
      }`,
    );
  }
}

function runBuild() {
  info("构建 Worker 和前端静态资源。");
  const result = runPnpm(["run", "build"], {
    allowFailure: true,
    label: "pnpm run build",
  });
  if (result.status !== 0) {
    throw new Error(
      `构建失败，已停止迁移和发布。请先修复构建错误再重试。\n${
        commandDetails(result)
      }`,
    );
  }
}

function runDryRun(configPath) {
  info("执行 Wrangler dry-run，确认 Worker、Assets 和 D1 绑定可打包。");
  const result = runWrangler(["deploy", "--dry-run"], {
    configPath,
    allowFailure: true,
    label: "wrangler deploy --dry-run",
  });
  if (result.status !== 0) {
    throw new Error(
      `Wrangler dry-run 失败，已停止迁移和发布。请先修复配置或构建错误。\n${
        commandDetails(result)
      }`,
    );
  }
}

function pendingHas(names) {
  const pending = loadPendingSecrets() || {};
  return names.every((name) => {
    if (name === `${ADMIN_PASSWORD_SECRET} or ${ADMIN_PASSWORD_HASH_SECRET}`) {
      return Boolean(pending[ADMIN_PASSWORD_SECRET] || pending[ADMIN_PASSWORD_HASH_SECRET]);
    }
    return Boolean(pending[name]);
  });
}

function provisionPlatformLinkSecret(configPath, names) {
  if (names.names.has(LINK_SIGNING_SECRET)) return names;
  info("Worker 缺少 LINK_SIGNING_SECRET，生成并上传一次新的随机签名密钥。");
  // The value is supplied through stdin and is never included in logs.
  runWrangler(["secret", "put", LINK_SIGNING_SECRET], {
    configPath,
    input: `${generateLinkSigningSecret()}\n`,
    label: `上传 Worker Secret ${LINK_SIGNING_SECRET}`,
  });
  const verified = listSecretNames(configPath);
  if (!verified.ok || !verified.names.has(LINK_SIGNING_SECRET)) {
    throw new Error(
      "LINK_SIGNING_SECRET 已尝试上传，但无法确认运行时 Secret 名称；已停止迁移和发布。",
    );
  }
  return verified;
}

function assertRequiredSecrets(
  configPath,
  { allowPending = false, platform = false } = {},
) {
  const names = listSecretNames(configPath);
  if (!names.ok) {
    if (allowPending && names.workerMissing && pendingHas(REQUIRED_SECRET_NAMES)) {
      return names;
    }
    throw new Error(
      `无法确认 Worker Secrets；已停止发布。请检查 Worker 名称、账户和 Secret 权限。\n${
        commandDetails(names.result)
      }`,
    );
  }
  const missingCredentials = missingCredentialSecretNames(names.names);
  if (missingCredentials.length > 0) {
    if (allowPending && pendingHas(missingCredentials)) return names;
    throw new Error(
      `Worker 缺少管理员凭据 Secret：${missingCredentials.join(", ")}。请在 Cloudflare Worker 设置中配置 ADMIN_USERNAME 和 ADMIN_PASSWORD，或保留兼容的 ADMIN_PASSWORD_HASH；本地部署可运行 pnpm run setup。已停止发布。`,
    );
  }
  const missing = missingRuntimeSecretNames(names.names);
  if (platform && missing.includes(LINK_SIGNING_SECRET)) {
    return provisionPlatformLinkSecret(configPath, names);
  }
  if (missing.length > 0) {
    if (allowPending && pendingHas(missing)) return names;
    throw new Error(
      `Worker 缺少必要 Secret：${missing.join(", ")}。请在 Cloudflare Worker 设置中补齐运行时 Secret；本地部署可运行 pnpm run setup 或恢复待上传 Secret。已停止发布。`,
    );
  }
  return names;
}

function applyMigrations(state, configPath) {
  const target = migrationTarget(configPath, state);
  info(`应用 D1 迁移：${target.databaseName}（binding ${target.binding}）`);
  const result = runWrangler(
    ["d1", "migrations", "apply", target.binding, "--remote"],
    {
      configPath,
      input: "y\n",
      allowFailure: true,
      label: `D1 迁移 ${target.databaseName}`,
    },
  );
  if (result.status !== 0) {
    throw new Error(
      `D1 迁移失败，已停止发布；不要删除数据库，修复迁移后再次运行 pnpm run deploy。\n${
        commandDetails(result)
      }`,
    );
  }
}

function publish(configPath) {
  info("发布 Worker。");
  const result = runWrangler(["deploy"], {
    configPath,
    allowFailure: true,
    label: "wrangler deploy",
  });
  if (result.status !== 0) {
    throw new Error(
      `Worker 发布失败，数据库未回滚。修复发布错误后可安全重试。\n${
        commandDetails(result)
      }`,
    );
  }
  return result;
}

function syncPendingSecrets(configPath) {
  const pending = loadPendingSecrets();
  if (!pending || Object.keys(pending).length === 0) return;
  info("上传首次部署前暂存的 Worker Secrets。");
  const names = listSecretNames(configPath);
  if (!names.ok) {
    throw new Error(
      `Worker 已发布但无法列出 Secrets；Secret 尚未确认上传。请检查权限后重试 pnpm run deploy。\n${
        commandDetails(names.result)
      }`,
    );
  }
  for (const name of REQUIRED_SECRET_NAMES) {
    if (!pending[name]) continue;
    if (names.names.has(name)) {
      info(`保留已存在 Secret：${name}`);
      continue;
    }
    info(`上传 Secret：${name}`);
    // The value is supplied through stdin and is never included in logs.
    runWrangler(["secret", "put", name], {
      configPath,
      input: `${pending[name]}\n`,
      label: `上传 Worker Secret ${name}`,
    });
  }
  const verified = listSecretNames(configPath);
  if (!verified.ok) {
    throw new Error("Secret 已尝试上传，但无法再次读取 Secret 名称确认结果；请运行 pnpm run doctor。");
  }
  const missing = REQUIRED_SECRET_NAMES.filter((name) => !verified.names.has(name));
  if (missing.length > 0) {
    throw new Error(`Secret 上传后仍缺少：${missing.join(", ")}；部署不会声明成功。`);
  }
  clearPendingSecrets();
  info("暂存 Secret 已上传并清理本地敏感文件。");
}

async function waitForHealth(url, attempts = 6) {
  let last = null;
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    last = await checkHealth(url);
    if (last.ok) return last;
    if (attempt < attempts) {
      info(`健康检查未就绪（${last.status || "网络错误"}），${attempt}/5，等待传播后重试。`);
      await new Promise((resolve) => setTimeout(resolve, 2_000));
    }
  }
  return last;
}

export async function main() {
  const deployment = resolveDeploymentContext();
  const { mode, state, configPath } = deployment;

  if (mode === "local") {
    const whoami = runWrangler(["whoami"], {
      configPath,
      allowFailure: true,
      label: "wrangler whoami",
    });
    if (!isWranglerAuthenticated(whoami)) {
      throw new Error(
        `Cloudflare 尚未登录；请运行 pnpm exec wrangler login 后重试。\n${
          commandDetails(whoami)
        }`,
      );
    }
  }

  runTypecheck();
  runBuild();
  runDryRun(configPath);
  assertRequiredSecrets(configPath, {
    allowPending: mode === "local",
    platform: mode === "platform",
  });
  applyMigrations(state, configPath);
  const published = publish(configPath);
  if (mode === "local") syncPendingSecrets(configPath);
  // Platform mode may initialize a missing signing key before migration. The
  // post-publish check only verifies names; it must never rotate a key again.
  assertRequiredSecrets(configPath);

  const publicUrl = normalizePublicUrl(
    process.env.PUBLIC_URL?.trim() ||
      state?.public_url ||
      configuredPublicUrl(configPath) ||
      extractDeployedUrl(`${published.stdout}\n${published.stderr}`),
  );
  if (!publicUrl) {
    throw new Error(
      "无法确定公开地址，未声明部署成功。请设置 PUBLIC_URL（例如 https://converter.yahenix.top）后重试。",
    );
  } else {
    const health = await waitForHealth(publicUrl);
    if (!health.ok) {
      throw new Error(
        `发布完成但 /health 检查失败（${health.status || "网络错误"}）。请检查 DNS、Worker 路由和 PUBLIC_URL；不要重复创建 D1。`,
      );
    }
    info(`健康检查通过：${publicUrl}/health`);
  }
  if (mode === "local") {
    state.public_url = publicUrl;
    state.last_deploy_at = new Date().toISOString();
    state.last_deploy_status = "ok";
    writeState(state);
    info(`部署完成，状态已更新：${statePath()}`);
  } else {
    info("平台部署完成，未写入本地部署状态。");
  }
}

const isMainModule =
  process.argv[1] &&
  import.meta.url === pathToFileURL(resolve(process.argv[1])).href;

if (isMainModule) {
  try {
    await main();
  } catch (cause) {
    error(formatCommandError(cause));
    process.exitCode = 1;
  }
}
