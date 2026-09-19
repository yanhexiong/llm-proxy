#!/usr/bin/env node

import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { ROOT } from "./lib/common.mjs";

const output = resolve(process.argv[2] || join(ROOT, ".deploy-template"));
const git = (args, options = {}) => execFileSync("git", args, {
  cwd: ROOT, encoding: "utf8", ...options,
}).trim();
const version = JSON.parse(readFileSync(join(output, "template-version.json"), "utf8"));
if (version.source_commit !== git(["rev-parse", "HEAD"])) {
  throw new Error("部署包不对应当前源码提交，请重新构建后发布。");
}
if (!existsSync(join(output, "worker.js")) || !existsSync(join(output, "public/index.html"))) {
  throw new Error("缺少预编译 Worker 或管理页面，已停止发布。");
}
const temporary = mkdtempSync(join(tmpdir(), "gateway-template-index-"));
try {
  // A separate index publishes generated files without switching main, staging
  // local credentials, rewriting branch history, or touching the user's index.
  const gitDir = git(["rev-parse", "--absolute-git-dir"]);
  const artifactGit = (args) => git([
    "--git-dir", gitDir, "--work-tree", output, ...args,
  ], { cwd: output, env: { ...process.env, GIT_INDEX_FILE: join(temporary, "index") } });
  const remote = git(["ls-remote", "--heads", "origin", "deploy"]);
  let parent = "";
  if (remote) {
    git(["fetch", "origin", "refs/heads/deploy"]);
    parent = git(["rev-parse", "FETCH_HEAD"]);
  }
  artifactGit(["add", "--all", "--", "."]);
  const tree = artifactGit(["write-tree"]);
  if (parent && tree === git(["rev-parse", `${parent}^{tree}`])) {
    console.log("预编译部署分支已经是当前版本。");
  } else {
    const commit = git([
      "commit-tree", tree, ...(parent ? ["-p", parent] : []),
      "-m", `build: publish deployment template from ${version.source_commit.slice(0, 7)}`,
    ]);
    git(["push", "origin", `${commit}:refs/heads/deploy`], { stdio: ["ignore", "pipe", "inherit"] });
    console.log(`预编译部署分支已发布：${commit}`);
  }
} finally {
  rmSync(temporary, { recursive: true, force: true });
}
