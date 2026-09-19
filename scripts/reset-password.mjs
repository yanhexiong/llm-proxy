#!/usr/bin/env node

import {
  askSecret,
  commandDetails,
  error,
  findWranglerConfig,
  formatCommandError,
  listSecretNames,
  loadPendingSecrets,
  loadState,
  passwordHash,
  putSecret,
  runWrangler,
  statePath,
  writeGeneratedWranglerConfig,
  writePendingSecrets,
  writeState,
} from "./lib/common.mjs";

function isMissingWorker(result) {
  const text = `${result?.stdout || ""}\n${result?.stderr || ""}`.toLowerCase();
  return /script.?not.?found|worker.?not.?found|does not exist|not found|10090|10095/.test(text);
}

async function main() {
  const state = loadState();
  if (!state?.worker_name || !state.config_path) {
    throw new Error(`缺少部署状态，请先运行 pnpm run setup：${statePath()}`);
  }
  const configPath = findWranglerConfig(state.config_path);
  const generatedConfig = writeGeneratedWranglerConfig(state, configPath);
  const password = process.env.ADMIN_PASSWORD || (await askSecret("新管理员密码（不会显示）"));
  if (!password || password.length < 8) throw new Error("管理员密码至少需要 8 个字符。");
  const digest = passwordHash(password);

  const whoami = runWrangler(["whoami"], {
    configPath: generatedConfig,
    allowFailure: true,
    label: "wrangler whoami",
  });
  if (whoami.status !== 0) {
    throw new Error("Cloudflare 尚未登录，请运行 pnpm exec wrangler login 后重试。");
  }

  const names = listSecretNames(generatedConfig);
  if (!names.ok && isMissingWorker(names.result)) {
    const pending = loadPendingSecrets() || {};
    writePendingSecrets({ ...pending, ADMIN_PASSWORD_HASH: digest });
    console.log("Worker 尚未发布，新密码已暂存；首次运行 pnpm run deploy 时会上传。");
  } else if (!names.ok) {
    throw new Error(
      `无法读取 Worker Secrets，未修改密码。${commandDetails(names.result)}`,
    );
  } else {
    putSecret("ADMIN_PASSWORD_HASH", digest, generatedConfig);
    console.log("管理员密码已更新。旧密码立即失效，现有会话是否失效取决于 Worker 的会话策略。");
  }
  writeState({
    ...state,
    generated_config_path: generatedConfig,
    password_reset_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
  });
}

try {
  await main();
} catch (cause) {
  error(formatCommandError(cause));
  process.exitCode = 1;
}
