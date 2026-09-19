#!/usr/bin/env node

import { writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  ROOT,
  ask,
  askSecret,
  error,
  passwordHash,
  randomSecret,
} from "./lib/common.mjs";

try {
  const interactive = Boolean(process.stdin.isTTY && process.stdout.isTTY);
  const username = process.env.ADMIN_USERNAME?.trim() ||
    (interactive ? await ask("管理员用户名", "admin") : "admin");
  const password = process.env.ADMIN_PASSWORD ??
    (interactive ? await askSecret("管理员密码（不会显示）") : "");
  if (!password || password.length < 8) {
    throw new Error("管理员密码至少需要 8 个字符；无交互时请通过 ADMIN_PASSWORD 环境变量提供。");
  }
  if (interactive && !process.env.ADMIN_PASSWORD) {
    const confirmation = await askSecret("再次输入管理员密码");
    if (password !== confirmation) throw new Error("两次输入的密码不一致，未生成配置。");
  }

  const destination = join(ROOT, ".gateway-deploy-secrets.json");
  // Exclusive creation prevents accidental key rotation or following a symlink.
  writeFileSync(destination, `${JSON.stringify({
    ADMIN_USERNAME: username,
    ADMIN_PASSWORD_HASH: passwordHash(password),
    LINK_SIGNING_SECRET: randomSecret(32),
  }, null, 2)}\n`, { encoding: "utf8", mode: 0o600, flag: "wx" });
  console.log(`部署 Secrets 已生成：${destination}`);
  console.log("把 JSON 中的三个字段值分别填入 Cloudflare 部署表单。登录时使用刚才输入的原密码。");
  console.log("文件不含明文密码；它包含签名密钥，请保留用于恢复，不要提交到 Git。");
} catch (cause) {
  error(cause?.code === "EEXIST"
    ? ".gateway-deploy-secrets.json 已存在，未覆盖。请复用现有值；为新实例生成时先将旧文件移到安全位置。"
    : cause.message);
  process.exitCode = 1;
}
