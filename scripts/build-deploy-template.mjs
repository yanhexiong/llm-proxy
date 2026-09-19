#!/usr/bin/env node

import { execFileSync } from "node:child_process";
import { copyFileSync, cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { ROOT, readWranglerConfig, runPnpm, runWrangler } from "./lib/common.mjs";
import { createUpdateManifest } from "./update-deploy-template.mjs";

// Maintainer-only: button users receive these already compiled files.
const output = resolve(process.argv[2] || join(ROOT, ".deploy-template"));
if (existsSync(output) && readdirSync(output).length) {
  throw new Error("输出目录必须为空，请选择一个新目录，避免覆盖已有部署配置。");
}
const bundle = mkdtempSync(join(tmpdir(), "gateway-template-bundle-"));
try {
  runPnpm(["run", "typecheck"], { inherit: true });
  runPnpm(["run", "build"], { inherit: true });
  runWrangler(["deploy", "--dry-run", "--minify", "--outdir", bundle], {
    configPath: join(ROOT, "wrangler.jsonc"), inherit: true,
  });

  mkdirSync(join(output, "lib"), { recursive: true });
  copyFileSync(join(bundle, "index.js"), join(output, "worker.js"));
  cpSync(join(ROOT, "web/dist"), join(output, "public"), {
    recursive: true,
    filter: (source) => !source.endsWith(".map"),
  });
  cpSync(join(ROOT, "migrations"), join(output, "migrations"), { recursive: true });
  copyFileSync(join(ROOT, "scripts/cloudflare-deploy.mjs"), join(output, "deploy.mjs"));
  copyFileSync(join(ROOT, "scripts/lib/cloudflare-secrets.mjs"), join(output, "lib/cloudflare-secrets.mjs"));
  copyFileSync(join(ROOT, ".dev.vars.example"), join(output, ".dev.vars.example"));
  copyFileSync(join(ROOT, ".node-version"), join(output, ".node-version"));
  copyFileSync(join(ROOT, "scripts/update-deploy-template.mjs"), join(output, "update-deploy-template.mjs"));
  mkdirSync(join(output, ".github/workflows"), { recursive: true });
  copyFileSync(join(ROOT, ".github/workflows/update-worker.yml"), join(output, ".github/workflows/update-worker.yml"));

  const sourcePackage = JSON.parse(readFileSync(join(ROOT, "package.json"), "utf8"));
  const sourceCommit = execFileSync("git", ["rev-parse", "HEAD"], { cwd: ROOT, encoding: "utf8" }).trim();
  const sourceConfig = readWranglerConfig(join(ROOT, "wrangler.jsonc"));
  const config = {
    ...sourceConfig,
    main: "worker.js",
    no_bundle: true,
    find_additional_modules: false,
    assets: { ...sourceConfig.assets, directory: "./public" },
  };
  // Account-specific values never belong in the reusable template.
  delete config.account_id;
  delete config.routes;
  delete config.route;
  delete config.vars;
  config.d1_databases = [{
    binding: "DB", database_name: "llm-proxy",
    database_id: "00000000-0000-0000-0000-000000000000", migrations_dir: "migrations",
  }];
  writeFileSync(join(output, "wrangler.jsonc"), `${JSON.stringify(config, null, 2)}\n`);
  writeFileSync(join(output, "package.json"), `${JSON.stringify({
    name: "llm-proxy-deploy", version: sourcePackage.version,
    private: true, type: "module", engines: { node: ">=22" },
    scripts: { deploy: "node deploy.mjs" },
    dependencies: { wrangler: sourcePackage.devDependencies.wrangler },
    cloudflare: sourcePackage.cloudflare,
  }, null, 2)}\n`);
  writeFileSync(join(output, ".gitignore"), "node_modules/\n.wrangler/\n.dev.vars\n.env\n.env.*\n");
  writeFileSync(join(output, "template-version.json"), `${JSON.stringify({
    version: sourcePackage.version, source_commit: sourceCommit,
    source: "https://github.com/yanhexiong/llm-proxy",
  }, null, 2)}\n`);
  writeFileSync(join(output, "update-manifest.json"), `${JSON.stringify(createUpdateManifest({
    directory: output, version: sourcePackage.version, sourceCommit,
  }), null, 2)}\n`);
  writeFileSync(join(output, "README.md"), `# LLM Proxy — 一键部署版

[![Deploy to Cloudflare](https://deploy.workers.cloudflare.com/button)](https://deploy.workers.cloudflare.com/?url=https%3A%2F%2Fgithub.com%2Fyanhexiong%2Fllm-proxy%2Ftree%2Fdeploy)

1. 点击按钮，登录 Cloudflare 并授权 GitHub。资源名称可保留默认值。
2. 只填写管理员账号 \`ADMIN_USERNAME\` 和密码 \`ADMIN_PASSWORD\`（至少 8 个字符），点击部署。
3. 部署成功后，在 Worker → Settings → Domains & Routes → Add → Custom domain 中绑定域名。
4. 打开该域名，用刚才的账号密码登录。

这个分支已经包含编译好的 Worker 和管理页面。构建命令自动留空，部署命令自动使用 \`npm run deploy\`；无需下载源码、安装 Node.js、运行本地命令或手动生成密钥。Cloudflare 会安装发布工具、自动创建 D1、建表并生成链接签名密钥。再次部署保留原密钥和原链接。

密码加密保存在 Cloudflare Worker Secret 中，不写入代码、D1 或构建日志。重置密码只需在 Worker 的 Variables and Secrets 中修改 \`ADMIN_PASSWORD\`。

## 一键更新

在你自己的 GitHub 部署仓库打开 **Actions → Update Worker → Run workflow**，选择 Cloudflare 连接的生产分支，再点击绿色 **Run workflow**。首次使用 Actions 时按 GitHub 提示启用。

更新会拉取最新预编译包，校验文件完整性，保留你自己的 Worker 名称、数据库 ID、域名、变量配置和原有 Secrets，然后提交新版文件。Cloudflare Builds 根据这次提交自动部署，无需添加 Token 或本地编译。GitHub 工作流成功表示仓库同步成功，线上发布结果请在 Cloudflare 的 Deployments 查看。已经是最新版时不会创建新提交。

只有预编译部署仓库适用；保持生产分支与 Cloudflare 设置一致。受分支保护或组织 Actions 策略限制的仓库可能需要管理员调整权限。详细说明及旧版接入方法见[更新指南](https://github.com/yanhexiong/llm-proxy/blob/main/docs/updating.md)。

本分支由维护者自动生成；自定义源码请在 [main 分支](https://github.com/yanhexiong/llm-proxy) 修改。更新会替换预编译应用文件，保留仓库其他文件和实例配置。
版本：${sourcePackage.version}；源码提交：[${sourceCommit.slice(0, 7)}](https://github.com/yanhexiong/llm-proxy/commit/${sourceCommit})。
`);
  console.log(`预编译部署包已生成：${output}`);
} finally {
  rmSync(bundle, { recursive: true, force: true });
}
