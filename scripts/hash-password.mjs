#!/usr/bin/env node

import { askSecret, error, formatCommandError, passwordHash } from "./lib/common.mjs";

try {
  const password = process.env.ADMIN_PASSWORD || (await askSecret("管理员密码（不会显示）"));
  if (!password || password.length < 8) throw new Error("管理员密码至少需要 8 个字符。");
  process.stdout.write(`${passwordHash(password)}\n`);
} catch (cause) {
  error(formatCommandError(cause));
  process.exitCode = 1;
}
