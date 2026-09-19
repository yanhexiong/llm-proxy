#!/usr/bin/env node

// Runs from the freshly checked out upstream deployment package. No Cloudflare
// credential is needed here: the connected repository remains the deploy source.
import { createHash } from "node:crypto";
import { execFileSync, spawnSync } from "node:child_process";
import { appendFileSync, existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, unlinkSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
// In source this helper is cloudflare-deploy.mjs; in a prebuilt package it is
// deploy.mjs. Both are the same standalone implementation.
const { configuredD1, readConfig } = await import(existsSync(new URL("./cloudflare-deploy.mjs", import.meta.url))
  ? "./cloudflare-deploy.mjs" : "./deploy.mjs");

export const UPDATE_MANIFEST = "update-manifest.json";
export const REQUIRED_FILES = [
  "worker.js", "public/index.html", "deploy.mjs", "lib/cloudflare-secrets.mjs",
  "package.json", "template-version.json", "update-deploy-template.mjs", ".node-version",
];
const FIXED_FILES = new Set(REQUIRED_FILES);
const SOURCE = "https://github.com/yanhexiong/llm-proxy";
const hash = (bytes) => createHash("sha256").update(bytes).digest("hex");
const git = (directory, args) => execFileSync("git", ["-C", directory, ...args], { encoding: "utf8", maxBuffer: 8 * 1024 * 1024 }).trim();

export function isManagedPath(path) {
  if (typeof path !== "string" || !path || path.includes("\\")) return false;
  if (FIXED_FILES.has(path)) return true;
  const segments = path.split("/");
  if (segments.some((part) => !/^[a-zA-Z0-9_@][a-zA-Z0-9_.@-]*$/.test(part))) return false;
  return (segments.length > 1 && ["public", "lib"].includes(segments[0])) ||
    (segments.length === 2 && segments[0] === "migrations" && path.endsWith(".sql"));
}

export function createUpdateManifest({ directory, version, sourceCommit }) {
  const paths = new Set(REQUIRED_FILES);
  const walk = (prefix) => {
    for (const entry of readdirSync(join(directory, prefix), { withFileTypes: true })) {
      const path = `${prefix}/${entry.name}`;
      if (entry.isDirectory()) walk(path);
      else {
        if (!isManagedPath(path)) throw new Error(`部署包包含不允许的文件：${path}`);
        paths.add(path);
      }
    }
  };
  for (const prefix of ["public", "lib", "migrations"]) walk(prefix);
  return {
    schema_version: 1, version, source_commit: sourceCommit,
    files: [...paths].sort().map((path) => ({ path, sha256: hash(safeFile(directory, path)) })),
  };
}

function safeFile(root, path, { optional = false } = {}) {
  const parts = path.split("/");
  let current = root;
  for (const [index, part] of parts.entries()) {
    current = join(current, part);
    let stat;
    try { stat = lstatSync(current); }
    catch (error) {
      if (error.code === "ENOENT" && optional) return null;
      throw new Error(`缺少部署文件：${path}`, { cause: error });
    }
    if (stat.isSymbolicLink()) throw new Error(`拒绝符号链接 symlink：${path}`);
    if (index < parts.length - 1 ? !stat.isDirectory() : !stat.isFile()) {
      throw new Error(`部署路径不是普通文件：${path}`);
    }
  }
  return readFileSync(current);
}

function parseJson(bytes, label) {
  try { return JSON.parse(bytes.toString("utf8")); }
  catch { throw new Error(`${label} 不是有效 JSON`); }
}

function validVersion(value) {
  return typeof value === "string" && /^\d+\.\d+\.\d+$/.test(value);
}

function readManifest(root, optional = false) {
  const bytes = safeFile(root, UPDATE_MANIFEST, { optional });
  if (!bytes) return null;
  const value = parseJson(bytes, UPDATE_MANIFEST);
  if (value?.schema_version !== 1 || !validVersion(value.version) ||
      !/^[a-f0-9]{40}$/.test(value.source_commit) || !Array.isArray(value.files) || !value.files.length) {
    throw new Error("无效的更新清单 manifest 格式或版本");
  }
  const seen = new Set();
  for (const entry of value.files) {
    if (!entry || !isManagedPath(entry.path) || !/^[a-f0-9]{64}$/.test(entry.sha256) || seen.has(entry.path)) {
      throw new Error(`更新清单包含不允许或重复的路径/hash：${entry?.path ?? "<empty>"}`);
    }
    seen.add(entry.path);
  }
  for (const path of REQUIRED_FILES) {
    if (!seen.has(path)) throw new Error(`更新清单缺少必需文件：${path}`);
  }
  if (![...seen].some((path) => path.startsWith("migrations/"))) throw new Error("更新清单缺少数据库迁移 migrations");
  return { value, bytes };
}

function prebuiltConfig(root) {
  safeFile(root, "wrangler.jsonc");
  const config = readConfig(join(root, "wrangler.jsonc"));
  if (!["worker.js", "./worker.js"].includes(config.main) ||
      !["public", "./public"].includes(config.assets?.directory) || config.no_bundle !== true ||
      typeof config.name !== "string" || !config.name) {
    throw new Error("仅支持预编译部署仓库（main: worker.js、no_bundle: true、assets: ./public）；源码 main 请使用源码部署流程");
  }
  if (config.env && Object.keys(config.env).length) throw new Error("不支持包含命名环境 env 的实例，请按环境分别更新");
  return config;
}

function packageInfo(bytes) {
  const value = parseJson(bytes, "package.json");
  if (value?.name !== "llm-proxy-deploy" || !validVersion(value.version) ||
      value.scripts?.deploy !== "node deploy.mjs" || value.scripts?.build) {
    throw new Error("不是有效的预编译部署 package.json");
  }
  return value;
}

/** Validate the complete plan before writing. Only application files from the
 * signed-in user's selected upstream checkout are managed. Instance config,
 * credentials, workflows and unrelated files are never replaced.
 */
export function updateDeployment({ targetDir, upstreamDir }) {
  const target = resolve(targetDir);
  const upstream = resolve(upstreamDir);
  if (target === upstream) throw new Error("更新源不能与目标目录相同");
  if (resolve(git(target, ["rev-parse", "--show-toplevel"])) !== target) throw new Error("目标必须是部署 Git 仓库根目录");
  if (git(target, ["status", "--porcelain", "--untracked-files=all"])) throw new Error("目标仓库存在未提交修改 dirty worktree；请先保存改动再更新");

  const config = prebuiltConfig(target);
  configuredD1(config);
  prebuiltConfig(upstream);
  const currentPackage = packageInfo(safeFile(target, "package.json"));
  const incoming = readManifest(upstream);
  const previous = readManifest(target, true);
  const content = new Map();
  for (const { path, sha256 } of incoming.value.files) {
    const bytes = safeFile(upstream, path);
    if (hash(bytes) !== sha256) throw new Error(`部署文件校验失败 SHA-256：${path}`);
    content.set(path, bytes);
  }
  const nextPackage = packageInfo(content.get("package.json"));
  const version = parseJson(content.get("template-version.json"), "template-version.json");
  if (version.source !== SOURCE || version.version !== incoming.value.version ||
      version.source_commit !== incoming.value.source_commit || nextPackage.version !== version.version) {
    throw new Error("部署包版本、来源或源码提交与清单不一致");
  }
  const oldNumbers = currentPackage.version.split(".").map(Number);
  const newNumbers = version.version.split(".").map(Number);
  const difference = newNumbers.map((value, i) => value - oldNumbers[i]).find((value) => value !== 0);
  if (difference < 0) throw new Error("拒绝自动降级到更旧版本");

  // Existing migration bytes must never change, including instances predating
  // the manifest. D1 already records these files as applied.
  if (existsSync(join(target, "migrations"))) {
    if (lstatSync(join(target, "migrations")).isSymbolicLink()) throw new Error("拒绝符号链接 symlink：migrations");
    for (const name of readdirSync(join(target, "migrations"))) {
      if (!name.endsWith(".sql")) continue;
      const path = `migrations/${name}`;
      const before = safeFile(target, path);
      if (!content.has(path) || !content.get(path).equals(before)) throw new Error(`已有数据库迁移只能保留，不能修改或删除：${path}`);
    }
  }

  const writes = new Map();
  const removals = [];
  for (const [path, bytes] of content) {
    const before = safeFile(target, path, { optional: true });
    if (!before || !before.equals(bytes)) writes.set(path, bytes);
  }
  // Delete only previously tracked package files, never arbitrary user files.
  for (const { path } of previous?.value.files ?? []) {
    if (!content.has(path) && safeFile(target, path, { optional: true })) {
      if (path.startsWith("migrations/")) throw new Error(`不能删除已有数据库迁移：${path}`);
      removals.push(path);
    }
  }
  const beforeManifest = previous?.bytes;
  if (!beforeManifest || !beforeManifest.equals(incoming.bytes)) writes.set(UPDATE_MANIFEST, incoming.bytes);
  // Never stage an ignored private file merely because it appears in a package.
  const paths = [...writes.keys(), ...removals];
  for (const path of paths) {
    const ignored = spawnSync("git", ["-C", target, "check-ignore", "--quiet", "--no-index", "--", path]);
    if (ignored.status === 0) throw new Error(`更新文件被实例 .gitignore 排除，请先检查：${path}`);
    if (ignored.status !== 1) throw new Error(`无法检查实例 .gitignore：${path}`);
  }
  for (const path of removals) unlinkSync(join(target, path));
  for (const [path, bytes] of writes) {
    mkdirSync(dirname(join(target, path)), { recursive: true });
    writeFileSync(join(target, path), bytes);
  }
  return { changed: paths.length > 0, version: version.version, files: paths.sort() };
}

export function main(args = process.argv.slice(2)) {
  let targetDir;
  let upstreamDir;
  let commit = false;
  for (let i = 0; i < args.length; i += 1) {
    if (args[i] === "--target") targetDir = args[++i];
    else if (args[i] === "--upstream") upstreamDir = args[++i];
    else if (args[i] === "--commit") commit = true;
    else throw new Error(`未知参数：${args[i]}`);
  }
  if (!targetDir || !upstreamDir) throw new Error("用法：node update-deploy-template.mjs --target <实例目录> --upstream <新版部署包> [--commit]");
  const result = updateDeployment({ targetDir, upstreamDir });
  if (commit && result.changed) {
    git(targetDir, ["add", "--", ...result.files]);
    git(targetDir, ["commit", "-m", `chore: update gateway to ${result.version}`]);
  }
  console.log(JSON.stringify(result));
  if (process.env.GITHUB_STEP_SUMMARY) appendFileSync(process.env.GITHUB_STEP_SUMMARY,
    result.changed
      ? `已准备 ${result.version} 更新，保留原 Worker、D1、域名和变量配置。后续 push 成功后由已连接的 Cloudflare Builds 发布；请在 Cloudflare 查看部署结果。\n`
      : `当前已是 ${result.version} 的最新部署文件，无需更新。\n`);
  return result;
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  try { main(); }
  catch (error) { console.error(`[update] ${error.message}`); process.exitCode = 1; }
}
