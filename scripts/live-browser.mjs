import { chromium, devices, expect } from "@playwright/test";
import { readFileSync, mkdirSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { resolve } from "node:path";

const root = fileURLToPath(new URL("../", import.meta.url));
const credentials = JSON.parse(readFileSync(resolve(root, ".gateway-test-admin.json"), "utf8"));
const origin = process.env.GATEWAY_ORIGIN || credentials.origin;
const browser = await chromium.launch({ executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH || undefined });
const results = [];
mkdirSync(resolve(root, "test-results/live-browser"), { recursive: true });
try {
  for (const mobile of [false, true]) {
    const context = await browser.newContext(mobile ? devices["Pixel 7"] : { viewport: { width: 1440, height: 1000 } });
    const page = await context.newPage();
    const errors = [];
    page.on("pageerror", error => errors.push(error.message));
    let aliasId, linkId;
    try {
      await page.goto(origin);
      await expect(page.getByRole("heading", { name: "管理员登录" })).toBeVisible();
      await page.getByLabel("用户名").fill(credentials.username);
      await page.getByLabel("密码").fill(credentials.password);
      await page.getByRole("button", { name: "登录控制台" }).click();
      await expect(page.getByRole("heading", { name: "生成代理链接" })).toBeVisible();
      await page.screenshot({ path: resolve(root, `test-results/live-browser/${mobile ? "mobile" : "desktop"}.png`), fullPage: true });
      await page.getByRole("button", { name: "别名管理", exact: true }).click();
      const name = `browser-${mobile ? "m" : "d"}-${Date.now()}`;
      await page.getByPlaceholder("例如 production").fill(name);
      await page.getByPlaceholder("例如 api.example.com/v1").fill("https://api.deepseek.com");
      const created = page.waitForResponse(response => response.url() === `${origin}/api/admin/aliases` && response.request().method() === "POST");
      await page.getByRole("button", { name: "创建别名" }).click();
      const aliasResult = await (await created).json();
      aliasId = aliasResult.alias.id;
      await expect(page.getByText(name, { exact: true })).toBeVisible();
      await page.getByRole("button", { name: "生成器", exact: true }).click();
      await page.getByRole("button", { name: "使用别名" }).click();
      await page.getByLabel("选择别名").selectOption(aliasId);
      const generated = page.waitForResponse(response => response.url() === `${origin}/api/admin/links` && response.request().method() === "POST");
      await page.getByRole("button", { name: "生成链接", exact: true }).click();
      const { link } = await (await generated).json();
      linkId = link.id;
      if (!link.base_url.startsWith(origin + "/") || !link.base_url.endsWith("/-/v1")) throw new Error("Generated Base URL has wrong origin or suffix");
      await expect(page.getByRole("heading", { name: "链接已生成" })).toBeVisible();
      if (errors.length) throw new Error("Browser page error: " + errors.join("; "));
      results.push({ viewport: mobile ? "mobile" : "desktop", passed: true, login: true, alias_create: true, link_generate: true });
    } finally {
      if (linkId) await context.request.post(`${origin}/api/admin/links/${linkId}/revoke`, { headers: { origin } });
      if (aliasId) await context.request.delete(`${origin}/api/admin/aliases/${aliasId}`, { headers: { origin } });
      await page.getByRole("button", { name: "退出登录" }).click();
      await expect(page.getByRole("heading", { name: "管理员登录" })).toBeVisible();
      await context.close();
    }
  }
  console.log(JSON.stringify(results));
} finally {
  await browser.close();
  writeFileSync(resolve(root, "test-results/live-browser/report.json"), JSON.stringify(results, null, 2));
}
