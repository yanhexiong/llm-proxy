import { spawnSync } from "node:child_process";
import { createHash, pbkdf2Sync, randomBytes } from "node:crypto";
import { fileURLToPath } from "node:url";
import {
  chmodSync,
  existsSync,
  readFileSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { dirname, join, resolve } from "node:path";
import { createInterface } from "node:readline/promises";
import { stdin as input, stdout as output } from "node:process";

export const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
export const DEFAULT_STATE_FILE = join(ROOT, ".gateway-state.json");
export const DEFAULT_GENERATED_CONFIG = join(ROOT, ".gateway-wrangler.jsonc");
export const DEFAULT_PENDING_SECRETS_FILE = join(ROOT, ".gateway-pending-secrets.json");
export const DEFAULT_D1_BINDING = "DB";
export const REQUIRED_SECRET_NAMES = [
  "ADMIN_USERNAME",
  "ADMIN_PASSWORD_HASH",
  "LINK_SIGNING_SECRET",
];

export class CommandError extends Error {
  constructor(message, details = {}) {
    super(message);
    this.name = "CommandError";
    Object.assign(this, details);
  }
}

export function statePath() {
  return resolve(process.env.GATEWAY_STATE_FILE || DEFAULT_STATE_FILE);
}

export function generatedConfigPath() {
  return resolve(process.env.GATEWAY_GENERATED_CONFIG || DEFAULT_GENERATED_CONFIG);
}

export function pendingSecretsPath() {
  return resolve(process.env.GATEWAY_PENDING_SECRETS_FILE || DEFAULT_PENDING_SECRETS_FILE);
}

export function info(message) {
  console.log(`[gateway] ${message}`);
}

export function warn(message) {
  console.warn(`[gateway] 警告：${message}`);
}

export function error(message) {
  console.error(`[gateway] 错误：${message}`);
}

export function commandOutput(result) {
  return `${result?.stdout || ""}\n${result?.stderr || ""}`;
}

export function commandDetails(result) {
  return [result?.stdout, result?.stderr]
    .filter((value) => typeof value === "string" && value.trim())
    .map((value) => value.trim())
    .join("\n");
}

function stripAnsi(text) {
  return String(text || "").replace(/\u001b\[[0-?]*[ -/]*[@-~]/g, "");
}

export function isWranglerAuthenticated(result) {
  if (!result || result.status !== 0) return false;
  const text = stripAnsi(commandOutput(result)).toLowerCase();
  if (
    /not authenticated|not logged in|login required|run [`']?wrangler login|api token.*required|necessary to set .*api token|no account|account.*not found/.test(
      text,
    )
  ) {
    return false;
  }
  // `whoami` has no JSON mode. Require an identity/account signal instead of
  // treating an empty successful process as proof of authentication.
  return /you are logged in|oauth token|credentials are stored|token permissions|account name|account id/.test(
    text,
  );
}

export function isMissingWorkerError(result) {
  const text = stripAnsi(commandOutput(result)).toLowerCase();
  return (
    /worker["' ]?[^\n]*not found|script["' ]?[^\n]*not found|worker not found|script not found|does not exist|not found/.test(
      text,
    ) ||
    /\b(?:10007|10090)\b/.test(text)
  );
}

export function normalizePublicUrl(value) {
  const raw = String(value || "").trim();
  if (!raw) return "";
  let parsed;
  try {
    parsed = new URL(raw);
  } catch {
    throw new Error(`公开地址无效：${raw}`);
  }
  if (!/^https?:$/i.test(parsed.protocol) || parsed.username || parsed.password) {
    throw new Error("公开地址必须是 HTTPS/HTTP URL，且不能包含用户名或密码。");
  }
  if (parsed.search || parsed.hash) {
    throw new Error("公开地址不能包含查询参数或 fragment。");
  }
  let pathname = parsed.pathname.replace(/\/+$/u, "");
  if (pathname.endsWith("/health")) pathname = pathname.slice(0, -"/health".length);
  parsed.pathname = pathname || "/";
  parsed.search = "";
  parsed.hash = "";
  return parsed.toString().replace(/\/$/, "");
}

export function configuredPublicUrl(configPath) {
  if (!configPath) return "";
  let config;
  try {
    config = readWranglerConfig(configPath);
  } catch {
    return "";
  }
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
        /^https?:\/\//i.test(withoutWildcard) ? withoutWildcard : `https://${withoutWildcard}`,
      );
    } catch {
      // Ignore non-HTTP route patterns and continue with the next candidate.
    }
  }
  return "";
}

export function parseArgs(argv = process.argv.slice(2)) {
  const values = {};
  const positional = [];
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    if (!token.startsWith("--")) {
      positional.push(token);
      continue;
    }
    const withoutPrefix = token.slice(2);
    const equalsIndex = withoutPrefix.indexOf("=");
    if (equalsIndex !== -1) {
      values[withoutPrefix.slice(0, equalsIndex)] = withoutPrefix.slice(
        equalsIndex + 1,
      );
      continue;
    }
    const next = argv[index + 1];
    if (next && !next.startsWith("--")) {
      values[withoutPrefix] = next;
      index += 1;
    } else {
      values[withoutPrefix] = true;
    }
  }
  return { values, positional };
}

export function readJson(path) {
  return JSON.parse(readFileSync(path, "utf8"));
}

export function loadState() {
  const path = statePath();
  if (!existsSync(path)) return null;
  const state = readJson(path);
  if (!state || typeof state !== "object") {
    throw new Error(`状态文件不是 JSON 对象：${path}`);
  }
  return state;
}

export function loadPendingSecrets() {
  const path = pendingSecretsPath();
  if (!existsSync(path)) return null;
  const pending = readJson(path);
  if (!pending || typeof pending !== "object") {
    throw new Error(`待上传 Secret 文件不是 JSON 对象：${path}`);
  }
  return pending;
}

export function writePendingSecrets(secrets) {
  const path = pendingSecretsPath();
  writeFileSync(path, `${JSON.stringify(secrets, null, 2)}\n`, {
    encoding: "utf8",
    mode: 0o600,
  });
  chmodSync(path, 0o600);
}

export function clearPendingSecrets() {
  const path = pendingSecretsPath();
  if (existsSync(path)) unlinkSync(path);
}

export function writeState(state) {
  const path = statePath();
  const temporary = `${path}.${process.pid}.tmp`;
  writeFileSync(temporary, `${JSON.stringify(state, null, 2)}\n`, {
    encoding: "utf8",
    mode: 0o600,
  });
  chmodSync(temporary, 0o600);
  // rename is atomic on the supported platforms. Windows does not replace an
  // existing destination, so remove only this known state file first there.
  if (process.platform === "win32" && existsSync(path)) unlinkSync(path);
  renameSync(temporary, path);
}

export function findWranglerConfig(requested) {
  const candidates = [
    requested,
    process.env.WRANGLER_CONFIG,
    join(ROOT, "wrangler.jsonc"),
    join(ROOT, "wrangler.json"),
    join(ROOT, "wrangler.toml"),
  ].filter(Boolean);
  const path = candidates.find((candidate) => existsSync(resolve(candidate)));
  if (!path) {
    throw new Error(
      "找不到 wrangler.jsonc、wrangler.json 或 wrangler.toml；请先创建 Worker 配置文件。",
    );
  }
  return resolve(path);
}

function stripJsonComments(text) {
  let result = "";
  let inString = false;
  let escaped = false;
  let inLineComment = false;
  let inBlockComment = false;
  for (let index = 0; index < text.length; index += 1) {
    const character = text[index];
    const next = text[index + 1];
    if (inLineComment) {
      if (character === "\n" || character === "\r") {
        inLineComment = false;
        result += character;
      } else {
        result += " ";
      }
      continue;
    }
    if (inBlockComment) {
      if (character === "*" && next === "/") {
        inBlockComment = false;
        result += "  ";
        index += 1;
      } else {
        result += character === "\n" || character === "\r" ? character : " ";
      }
      continue;
    }
    if (inString) {
      result += character;
      if (escaped) escaped = false;
      else if (character === "\\") escaped = true;
      else if (character === '"') inString = false;
      continue;
    }
    if (character === '"') {
      inString = true;
      result += character;
    } else if (character === "/" && next === "/") {
      inLineComment = true;
      result += "  ";
      index += 1;
    } else if (character === "/" && next === "*") {
      inBlockComment = true;
      result += "  ";
      index += 1;
    } else {
      result += character;
    }
  }
  return result;
}

function stripTrailingCommas(text) {
  let result = "";
  let inString = false;
  let escaped = false;
  for (let index = 0; index < text.length; index += 1) {
    const character = text[index];
    if (inString) {
      result += character;
      if (escaped) escaped = false;
      else if (character === "\\") escaped = true;
      else if (character === '"') inString = false;
      continue;
    }
    if (character === '"') {
      inString = true;
      result += character;
      continue;
    }
    if (character === ",") {
      let lookahead = index + 1;
      while (/\s/.test(text[lookahead] || "")) lookahead += 1;
      if (text[lookahead] === "}" || text[lookahead] === "]") continue;
    }
    result += character;
  }
  return result;
}

export function parseJsonc(text) {
  return JSON.parse(stripTrailingCommas(stripJsonComments(text.replace(/^\uFEFF/, ""))));
}

export function readWranglerConfig(path) {
  const resolved = resolve(path);
  if (resolved.endsWith(".toml")) {
    throw new Error(
      "当前部署脚本需要 JSON/JSONC 格式的 Wrangler 配置，以便安全注入 D1 ID；请使用 wrangler.jsonc。",
    );
  }
  return parseJsonc(readFileSync(resolved, "utf8"));
}

export function writeGeneratedWranglerConfig(state, sourcePath) {
  const source = sourcePath || findWranglerConfig(state?.config_path);
  const base = readWranglerConfig(source);
  const config = JSON.parse(JSON.stringify(base));
  if (state.worker_name) config.name = state.worker_name;
  if (state.account_id) config.account_id = state.account_id;
  // Keep account-specific routes in ignored local state, not in the public
  // template cloned by Deploy to Cloudflare users.
  if (Array.isArray(state.routes)) {
    delete config.route;
    config.routes = structuredClone(state.routes);
  }

  const d1Databases = Array.isArray(config.d1_databases)
    ? config.d1_databases.map((entry) => ({ ...entry }))
    : [];
  const binding = state.d1_binding || d1Databases[0]?.binding || DEFAULT_D1_BINDING;
  const index = d1Databases.findIndex((entry) => entry.binding === binding);
  const d1Entry = {
    ...(index >= 0 ? d1Databases[index] : {}),
    binding,
    database_name: state.database_name,
    database_id: state.database_id,
  };
  if (!d1Entry.migrations_dir && !config.migrations_dir) {
    d1Entry.migrations_dir = state.migrations_dir || "migrations";
  }
  if (index >= 0) d1Databases[index] = d1Entry;
  else d1Databases.push(d1Entry);
  config.d1_databases = d1Databases;

  const destination = generatedConfigPath();
  writeFileSync(destination, `${JSON.stringify(config, null, 2)}\n`, {
    encoding: "utf8",
    mode: 0o600,
  });
  chmodSync(destination, 0o600);
  return destination;
}

export function pnpmExecutable() {
  if (process.env.PNPM_BIN) return process.env.PNPM_BIN;
  return process.platform === "win32" ? "pnpm.cmd" : "pnpm";
}

export function runCommand(command, args, options = {}) {
  const {
    cwd = ROOT,
    input: stdin,
    inherit = false,
    allowFailure = false,
    env = {},
    label = `${command} ${args.join(" ")}`,
  } = options;
  const result = spawnSync(command, args, {
    cwd,
    env: { ...process.env, ...env },
    encoding: "utf8",
    input: stdin,
    stdio: inherit ? "inherit" : ["pipe", "pipe", "pipe"],
    maxBuffer: 8 * 1024 * 1024,
    windowsHide: false,
  });
  const stdout = typeof result.stdout === "string" ? result.stdout : "";
  const stderr = typeof result.stderr === "string" ? result.stderr : "";
  const status = result.status ?? 1;
  if (result.error) {
    if (!allowFailure) {
      throw new CommandError(`${label} 执行失败：${result.error.message}`, {
        command,
        args,
        stdout,
        stderr,
        cause: result.error,
      });
    }
    return { status, stdout, stderr, error: result.error };
  }
  if (status !== 0 && !allowFailure) {
    const details = commandDetails({ stdout, stderr }) || `退出码 ${status}`;
    throw new CommandError(`${label} 执行失败：${details}`, {
      command,
      args,
      stdout,
      stderr,
        status,
      });
  }
  return { status, stdout, stderr };
}

export function runPnpm(args, options = {}) {
  return runCommand(pnpmExecutable(), args, options);
}

export function runWrangler(args, options = {}) {
  const configPath = options.configPath;
  const finalArgs = [...args];
  if (configPath && !finalArgs.includes("--config")) {
    finalArgs.push("--config", configPath);
  }
  return runPnpm(["exec", "wrangler", ...finalArgs], {
    ...options,
    label: options.label || `wrangler ${args.join(" ")}`,
  });
}

export function extractJson(output) {
  const text = String(output || "").trim();
  for (let index = 0; index < text.length; index += 1) {
    if (text[index] !== "{" && text[index] !== "[") continue;
    try {
      return JSON.parse(text.slice(index));
    } catch {
      // Wrangler can prefix JSON with log lines. Try the next possible start.
    }
  }
  return null;
}

export function extractDatabaseId(output) {
  const data = extractJson(output);
  const candidates = [];
  const collect = (value) => {
    if (!value || typeof value !== "object") return;
    if (Array.isArray(value)) {
      value.forEach(collect);
      return;
    }
    for (const key of ["database_id", "databaseId", "uuid", "id"]) {
      if (typeof value[key] === "string") candidates.push(value[key]);
    }
    Object.values(value).forEach((entry) => {
      if (entry && typeof entry === "object") collect(entry);
    });
  };
  collect(data);
  const uuid = candidates.find((candidate) => /^[0-9a-f]{8}-[0-9a-f-]{27,}$/i.test(candidate));
  if (uuid) return uuid;
  const fromText = String(output || "").match(/\b[0-9a-f]{8}-[0-9a-f-]{27,}\b/i);
  return fromText?.[0] || null;
}

export function extractDeployedUrl(output) {
  const matches = String(output || "").match(/https?:\/\/[^\s`'"<>]+/g) || [];
  const cleaned = matches.map((value) => value.replace(/[),.;]+$/, ""));
  return (
    cleaned.find((value) => /workers\.dev\b/i.test(value)) ||
    cleaned.find((value) => !/dash\.cloudflare\.com/i.test(value)) ||
    null
  );
}

export function listSecretNames(configPath) {
  const result = runWrangler(["secret", "list", "--format", "json"], {
    configPath,
    allowFailure: true,
    label: "wrangler secret list",
  });
  if (result.status !== 0) {
    return { ok: false, names: new Set(), workerMissing: isMissingWorkerError(result), result };
  }
  const data = extractJson(result.stdout);
  const names = new Set();
  const collect = (value) => {
    if (!value || typeof value !== "object") return;
    if (Array.isArray(value)) {
      value.forEach(collect);
      return;
    }
    if (typeof value.name === "string") names.add(value.name);
    Object.values(value).forEach((entry) => {
      if (entry && typeof entry === "object") collect(entry);
    });
  };
  collect(data);
  if (names.size === 0) {
    for (const line of `${result.stdout}\n${result.stderr}`.split(/\r?\n/)) {
      const match = line.match(/\b[A-Z][A-Z0-9_]{2,}\b/);
      if (match && !["NAME", "TYPE", "VERSION"].includes(match[0])) names.add(match[0]);
    }
  }
  return { ok: true, names, workerMissing: false, result };
}

export function putSecret(name, value, configPath) {
  if (!value) throw new Error(`${name} 不能为空。`);
  return runWrangler(["secret", "put", name], {
    configPath,
    input: `${value}\n`,
    label: `写入 Worker Secret ${name}`,
  });
}

export function passwordHash(password, options = {}) {
  const iterations = options.iterations || 100_000;
  const salt = randomBytes(16);
  const digest = pbkdf2Sync(password, salt, iterations, 32, "sha256");
  return [
    "pbkdf2_sha256",
    String(iterations),
    salt.toString("base64url"),
    digest.toString("base64url"),
  ].join("$");
}

export function randomSecret(bytes = 32) {
  return randomBytes(bytes).toString("base64url");
}

export function hashToken(token) {
  return createHash("sha256").update(token).digest("hex");
}

export async function ask(question, defaultValue = "") {
  const suffix = defaultValue ? ` [${defaultValue}]` : "";
  const rl = createInterface({ input, output });
  try {
    const answer = await rl.question(`${question}${suffix}: `);
    return answer.trim() || defaultValue;
  } finally {
    rl.close();
  }
}

export async function askSecret(question) {
  if (!input.isTTY || !output.isTTY || typeof input.setRawMode !== "function") {
    const rl = createInterface({ input, output });
    return new Promise((resolveAnswer, reject) => {
      let settled = false;
      const finish = (callback, value) => {
        if (settled) return;
        settled = true;
        rl.removeListener("close", onClose);
        rl.close();
        callback(value);
      };
      const onClose = () => finish(reject, new Error("无法读取密码输入，请设置 ADMIN_PASSWORD 或使用交互终端。"));
      rl.once("close", onClose);
      rl.question(`${question}: `)
        .then((answer) => finish(resolveAnswer, answer.trim()))
        .catch((cause) => finish(reject, cause));
    });
  }
  return new Promise((resolveAnswer, reject) => {
    let answer = "";
    const onData = (chunk) => {
      const text = String(chunk);
      for (const character of text) {
        if (character === "\u0003") {
          cleanup();
          reject(new Error("用户取消输入。"));
          return;
        }
        if (character === "\r" || character === "\n") {
          cleanup();
          output.write("\n");
          resolveAnswer(answer);
          return;
        }
        if (character === "\u0008" || character === "\u007f") {
          answer = answer.slice(0, -1);
        } else if (character === "\u0015") {
          answer = "";
        } else {
          answer += character;
        }
      }
    };
    const cleanup = () => {
      input.removeListener("data", onData);
      input.setRawMode(false);
      input.pause();
    };
    output.write(`${question}: `);
    input.setRawMode(true);
    input.resume();
    input.on("data", onData);
  });
}

export async function askYesNo(question, defaultValue = true) {
  const hint = defaultValue ? "Y/n" : "y/N";
  const answer = (await ask(`${question} (${hint})`)).toLowerCase();
  if (!answer) return defaultValue;
  return answer === "y" || answer === "yes" || answer === "是";
}

export function compareNodeMajor(requiredMajor = 20) {
  const match = process.versions.node.match(/^(\d+)/);
  return Number(match?.[1] || 0) >= requiredMajor;
}

export async function checkHealth(url, timeoutMs = 15_000) {
  const normalized = normalizePublicUrl(url);
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(`${normalized}/health`, {
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
      // A non-JSON 2xx response is still useful for generic health endpoints.
    }
    const ready = payload?.status === "not_ready" ? false : true;
    return {
      ok: response.status >= 200 && response.status < 300 && ready,
      status: response.status,
      body,
    };
  } catch (cause) {
    return { ok: false, status: 0, body: "", error: cause };
  } finally {
    clearTimeout(timer);
  }
}

export function formatCommandError(cause) {
  if (!(cause instanceof CommandError)) return cause?.message || String(cause);
  const details = commandDetails(cause);
  return details ? `${cause.message}\n${details}` : cause.message;
}
