#!/usr/bin/env node

import { spawnSync } from "node:child_process";
import {
  existsSync,
  readFileSync,
} from "node:fs";
import { fileURLToPath, pathToFileURL } from "node:url";
import { dirname, join, resolve } from "node:path";
import {
  LINK_SIGNING_SECRET,
  generateLinkSigningSecret,
  missingCredentialSecretNames,
} from "./lib/cloudflare-secrets.mjs";

const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url));
const D1_DATABASE_ID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const ZERO_D1_DATABASE_ID = "00000000-0000-0000-0000-000000000000";
const DEFAULT_D1_BINDING = "DB";

function info(message) {
  console.log(`[gateway] ${message}`);
}

function projectRoot() {
  if (process.env.CLOUDFLARE_PROJECT_ROOT?.trim()) {
    return resolve(process.env.CLOUDFLARE_PROJECT_ROOT);
  }
  return existsSync(join(SCRIPT_DIR, "wrangler.jsonc"))
    ? SCRIPT_DIR
    : resolve(SCRIPT_DIR, "..");
}

function configPathFor(root) {
  const configured = process.env.WRANGLER_CONFIG?.trim();
  return resolve(configured || join(root, "wrangler.jsonc"));
}

function stripJsonComments(text) {
  let output = "";
  let inString = false;
  let escaped = false;
  let lineComment = false;
  let blockComment = false;
  for (let index = 0; index < text.length; index += 1) {
    const character = text[index];
    const next = text[index + 1];
    if (lineComment) {
      if (character === "\n" || character === "\r") {
        lineComment = false;
        output += character;
      } else {
        output += " ";
      }
      continue;
    }
    if (blockComment) {
      if (character === "*" && next === "/") {
        blockComment = false;
        output += "  ";
        index += 1;
      } else {
        output += character === "\n" || character === "\r" ? character : " ";
      }
      continue;
    }
    if (inString) {
      output += character;
      if (escaped) escaped = false;
      else if (character === "\\") escaped = true;
      else if (character === '"') inString = false;
      continue;
    }
    if (character === '"') {
      inString = true;
      output += character;
    } else if (character === "/" && next === "/") {
      lineComment = true;
      output += "  ";
      index += 1;
    } else if (character === "/" && next === "*") {
      blockComment = true;
      output += "  ";
      index += 1;
    } else {
      output += character;
    }
  }
  return output;
}

function stripTrailingCommas(text) {
  let output = "";
  let inString = false;
  let escaped = false;
  for (let index = 0; index < text.length; index += 1) {
    const character = text[index];
    if (inString) {
      output += character;
      if (escaped) escaped = false;
      else if (character === "\\") escaped = true;
      else if (character === '"') inString = false;
      continue;
    }
    if (character === '"') {
      inString = true;
      output += character;
      continue;
    }
    if (character === ",") {
      let lookahead = index + 1;
      while (/\s/.test(text[lookahead] || "")) lookahead += 1;
      if (text[lookahead] === "}" || text[lookahead] === "]") continue;
    }
    output += character;
  }
  return output;
}

export function readConfig(configPath) {
  return JSON.parse(
    stripTrailingCommas(
      stripJsonComments(readFileSync(configPath, "utf8").replace(/^\uFEFF/, "")),
    ),
  );
}

export function isValidD1DatabaseId(value) {
  return (
    typeof value === "string" &&
    D1_DATABASE_ID_PATTERN.test(value) &&
    value.toLowerCase() !== ZERO_D1_DATABASE_ID
  );
}

export function configuredD1(config, binding = DEFAULT_D1_BINDING) {
  const databases = Array.isArray(config.d1_databases) ? config.d1_databases : [];
  const entry = databases.find((candidate) => candidate?.binding === binding);
  if (!entry) {
    throw new Error(
      `源配置中缺少 D1 binding ${binding}；请让 Cloudflare Deploy to Cloudflare 自动创建 D1。`,
    );
  }
  if (!isValidD1DatabaseId(entry.database_id)) {
    throw new Error(
      `源配置中 D1 binding ${binding} 的 database_id 仍是占位或无效值；请让 Cloudflare Deploy to Cloudflare 自动创建并注入 D1，或先在本地 setup。`,
    );
  }
  if (!entry.database_name) {
    throw new Error(`源配置中 D1 binding ${binding} 缺少 database_name。`);
  }
  return {
    binding,
    databaseName: entry.database_name,
    databaseId: entry.database_id,
  };
}

function commandDetails(result) {
  return [result?.stdout, result?.stderr]
    .filter((value) => typeof value === "string" && value.trim())
    .map((value) => value.trim())
    .join("\n");
}

function commandError(label, result) {
  return `${label} 失败${commandDetails(result) ? `：\n${commandDetails(result)}` : "。"}`;
}

function wranglerPath(root) {
  const configured = process.env.CLOUDFLARE_WRANGLER_BIN?.trim();
  const path = resolve(configured || join(root, "node_modules", "wrangler", "bin", "wrangler.js"));
  if (!existsSync(path) && !configured) {
    throw new Error(
      `找不到本地 Wrangler：${path}。请先执行 npm install；按钮部署不需要 pnpm。`,
    );
  }
  return path;
}

export function runWrangler(root, configPath, args, { input = "", label = "Wrangler" } = {}) {
  const executable = wranglerPath(root);
  const result = spawnSync(
    process.execPath,
    [executable, ...args, "--config", configPath],
    {
      cwd: root,
      encoding: "utf8",
      input,
      stdio: ["pipe", "pipe", "pipe"],
      maxBuffer: 8 * 1024 * 1024,
      windowsHide: false,
    },
  );
  if (result.error || result.status !== 0) {
    throw new Error(commandError(label, result));
  }
  return result;
}

function extractJson(output) {
  const text = String(output || "").trim();
  for (let index = 0; index < text.length; index += 1) {
    if (text[index] !== "{" && text[index] !== "[") continue;
    try {
      return JSON.parse(text.slice(index));
    } catch {
      // Wrangler may prefix JSON with progress output.
    }
  }
  return null;
}

function collectSecretNames(value, names = new Set()) {
  if (!value || typeof value !== "object") return names;
  if (Array.isArray(value)) {
    value.forEach((entry) => collectSecretNames(entry, names));
    return names;
  }
  if (typeof value.name === "string") names.add(value.name);
  Object.values(value).forEach((entry) => collectSecretNames(entry, names));
  return names;
}

export function listSecretNames(root, configPath) {
  const result = runWrangler(root, configPath, ["secret", "list", "--format", "json"], {
    label: "Worker Secret 列表",
  });
  return collectSecretNames(extractJson(result.stdout));
}

export function ensureRuntimeSecrets(root, configPath, initialNames = null) {
  let names = initialNames || listSecretNames(root, configPath);
  const missingCredentials = missingCredentialSecretNames(names);
  if (missingCredentials.length > 0) {
    throw new Error(
      `Worker 缺少管理员凭据 Secret：${missingCredentials.join(", ")}。请在 Cloudflare Worker 设置中配置 ADMIN_USERNAME 和 ADMIN_PASSWORD，或兼容的 ADMIN_PASSWORD_HASH；未创建新的签名 Secret。`,
    );
  }
  if (names.has(LINK_SIGNING_SECRET)) {
    info(`保留已有运行时 Secret：${LINK_SIGNING_SECRET}`);
    return names;
  }

  // The generated value is piped to Wrangler and is intentionally never logged.
  info(`缺少运行时 Secret：${LINK_SIGNING_SECRET}；生成并上传一次随机密钥。`);
  runWrangler(root, configPath, ["secret", "put", LINK_SIGNING_SECRET], {
    input: `${generateLinkSigningSecret()}\n`,
    label: `上传 Worker Secret ${LINK_SIGNING_SECRET}`,
  });
  names = listSecretNames(root, configPath);
  if (!names.has(LINK_SIGNING_SECRET)) {
    throw new Error(
      "LINK_SIGNING_SECRET 已上传但未出现在 Worker Secret 列表；已停止迁移和发布。",
    );
  }
  return names;
}

function normalizePublicUrl(value) {
  const raw = String(value || "").trim();
  if (!raw) return "";
  const parsed = new URL(raw);
  if (!/^https?:$/i.test(parsed.protocol) || parsed.username || parsed.password) {
    throw new Error("公开地址必须是 HTTP(S) URL，且不能包含用户名或密码。");
  }
  if (parsed.search || parsed.hash) {
    throw new Error("公开地址不能包含查询参数或 fragment。");
  }
  parsed.pathname = parsed.pathname.replace(/\/+$/u, "") || "/";
  return parsed.toString().replace(/\/$/, "");
}

function configuredPublicUrl(config) {
  const candidates = [];
  for (const route of Array.isArray(config.routes) ? config.routes : []) {
    if (typeof route === "string") candidates.push(route);
    else if (route?.custom_domain && typeof route.pattern === "string") candidates.push(route.pattern);
  }
  for (const domain of Array.isArray(config.domains) ? config.domains : []) {
    if (typeof domain === "string") candidates.push(domain);
  }
  for (const candidate of candidates) {
    const withoutWildcard = candidate.replace(/\/\*$/u, "");
    try {
      return normalizePublicUrl(
        /^https?:\/\//i.test(withoutWildcard)
          ? withoutWildcard
          : `https://${withoutWildcard}`,
      );
    } catch {
      // Ignore non-URL route patterns.
    }
  }
  return "";
}

function extractDeployedUrl(output) {
  const matches = String(output || "").match(/https?:\/\/[^\s`'"<>]+/g) || [];
  const cleaned = matches.map((value) => value.replace(/[),.;]+$/, ""));
  return (
    cleaned.find((value) => /workers\.dev\b/i.test(value)) ||
    cleaned.find((value) => !/dash\.cloudflare\.com/i.test(value)) ||
    ""
  );
}

export async function checkHealth(url, timeoutMs = 15_000) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(`${url}/health`, {
      method: "GET",
      redirect: "manual",
      signal: controller.signal,
      headers: { accept: "application/json" },
    });
    const body = await response.text();
    let payload = null;
    try {
      payload = JSON.parse(body);
    } catch {
      // The status code remains useful in the error below.
    }
    return {
      ok: response.status === 200 && payload?.status === "ready",
      status: response.status,
    };
  } catch {
    return { ok: false, status: 0 };
  } finally {
    clearTimeout(timer);
  }
}

async function waitForHealth(url, attempts = 6) {
  let last = { ok: false, status: 0 };
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    last = await checkHealth(url);
    if (last.ok) return last;
    if (attempt < attempts) await new Promise((resolveDelay) => setTimeout(resolveDelay, 2_000));
  }
  return last;
}

export async function main() {
  const root = projectRoot();
  const configPath = configPathFor(root);
  if (!existsSync(configPath)) throw new Error(`找不到 Wrangler 配置：${configPath}`);
  info("验证 Wrangler 配置和 D1 binding。");
  const config = readConfig(configPath);
  const target = configuredD1(config);

  info("执行 Wrangler dry-run。");
  runWrangler(root, configPath, ["deploy", "--dry-run"], {
    label: "Wrangler dry-run",
  });
  info("检查 Worker 运行时 Secrets。");
  ensureRuntimeSecrets(root, configPath);
  info(`应用 D1 迁移（binding ${target.binding}）。`);
  runWrangler(root, configPath, ["d1", "migrations", "apply", target.binding, "--remote"], {
    input: "y\n",
    label: `D1 迁移 ${target.binding}`,
  });
  info("发布 Worker。");
  const deployment = runWrangler(root, configPath, ["deploy"], {
    label: "Worker 发布",
  });

  const publicUrl = normalizePublicUrl(
    process.env.PUBLIC_URL?.trim() ||
      configuredPublicUrl(config) ||
      extractDeployedUrl(`${deployment.stdout}\n${deployment.stderr}`),
  );
  if (!publicUrl) {
    throw new Error("无法确定公开地址；请在部署环境设置 PUBLIC_URL 或配置自定义域名后重试。");
  }
  info(`检查健康状态：${publicUrl}/health`);
  const health = await waitForHealth(publicUrl);
  if (!health.ok) {
    throw new Error(`发布完成但 /health 检查失败（${health.status || "网络错误"}）。`);
  }
  console.log(`部署完成，健康检查通过：${publicUrl}/health`);
}

const isMainModule =
  process.argv[1] &&
  import.meta.url === pathToFileURL(resolve(process.argv[1])).href;

if (isMainModule) {
  try {
    await main();
  } catch (cause) {
    console.error(`[gateway] 错误：${cause?.message || cause}`);
    process.exitCode = 1;
  }
}
