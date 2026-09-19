import { expect, test } from "@playwright/test";

test("shows a usable login screen", async ({ page }) => {
  await page.route("**/api/admin/session", (route) =>
    route.fulfill({ status: 401, contentType: "application/json", body: JSON.stringify({ error: { message: "login required" } }) }),
  );
  await page.goto("/");
  await expect(page.getByRole("heading", { name: "管理员登录" })).toBeVisible();
  await expect(page.getByLabel("用户名")).toBeEditable();
  await expect(page.getByLabel("密码")).toBeEditable();
  await expect(page.getByRole("button", { name: "登录控制台" })).toBeVisible();
});

test("renders the authenticated management workflow", async ({ page }, testInfo) => {
  await page.route("**/api/admin/**", async (route) => {
    const path = new URL(route.request().url()).pathname;
    if (path.endsWith("/session")) {
      await route.fulfill({ json: { authenticated: true, username: "admin" } });
    } else if (path.endsWith("/aliases")) {
      await route.fulfill({ json: { aliases: [{ id: "a1", name: "production", base_url: "https://api.example.com/v1", link_count: 2 }] } });
    } else if (path.endsWith("/links")) {
      await route.fulfill({ json: { links: [] } });
    } else {
      await route.fulfill({ json: {} });
    }
  });
  await page.goto("/");
  await expect(page.getByRole("heading", { name: "生成代理链接" })).toBeVisible();
  await expect(page.getByRole("button", { name: "生成器" })).toBeVisible();
  await page.getByRole("button", { name: "使用别名" }).click();
  await expect(page.getByLabel("选择别名")).toContainText("production");
  await page.screenshot({ path: testInfo.outputPath("dashboard.png"), fullPage: true });
});

test("generates a complete executable curl and exposes copy failures", async ({ page }) => {
  await page.addInitScript(() => {
    Object.defineProperty(navigator, "clipboard", {
      configurable: true,
      value: { writeText: async () => { throw new Error("clipboard denied"); } },
    });
    document.execCommand = () => false;
  });
  await page.route("**/api/admin/**", async (route) => {
    const request = route.request();
    const path = new URL(request.url()).pathname;
    if (path.endsWith("/session")) {
      await route.fulfill({ json: { authenticated: true, username: "admin" } });
    } else if (path.endsWith("/aliases") && request.method() === "GET") {
      await route.fulfill({ json: { aliases: [] } });
    } else if (path.endsWith("/links") && request.method() === "GET") {
      await route.fulfill({ json: { links: [] } });
    } else if (path.endsWith("/links") && request.method() === "POST") {
      expect(request.postDataJSON()).toMatchObject({
        client_protocol: "responses",
        upstream_protocol: "chat",
        target_type: "direct",
        base_url: "https://api.example.com/v1",
      });
      await route.fulfill({
        status: 201,
        json: {
          link: {
            id: "l1",
            client_protocol: "responses",
            upstream_protocol: "chat",
            target_type: "direct",
            direct_base_url: "https://api.example.com/v1",
            base_url: "https://gateway.example/l1/responses/chat/u/api.example.com/v1/-/v1",
            endpoint: "https://gateway.example/l1/responses/chat/u/api.example.com/v1/-/v1/chat/completions",
            upstream_url: "https://api.example.com/v1/chat/completions",
            curl: "curl https://gateway.example/old -d @request.json",
          },
        },
      });
    } else {
      await route.fulfill({ json: {} });
    }
  });

  await page.goto("/");
  await page.getByLabel("上游 Base URL").fill("https://api.example.com/v1");
  await page.getByRole("button", { name: "生成链接" }).click();
  const curlExample = page.locator(".example-block").nth(1);
  await expect(curlExample).toContainText("curl https://gateway.example/l1/responses/chat/u/api.example.com/v1/-/v1/chat/completions");
  await expect(curlExample).toContainText("-d '{");
  await expect(curlExample).not.toContainText("request.json");
  await curlExample.getByRole("button", { name: "复制" }).click();
  await expect(curlExample.getByText("复制失败，请手动复制")).toBeVisible();
});

test("regenerates a link with its original target and refreshes the list", async ({ page }) => {
  let links = [{
    id: "l1",
    client_protocol: "responses",
    upstream_protocol: "chat",
    target_type: "direct",
    direct_base_url: "https://api.example.com/v1",
    base_url: "https://gateway.example/l1/responses/chat/u/api.example.com/v1/-/v1",
    endpoint: "https://gateway.example/l1/responses/chat/u/api.example.com/v1/-/v1/chat/completions",
    upstream_url: "https://api.example.com/v1/chat/completions",
    created_at: "2026-09-19T08:00:00Z",
  }];
  let listRequests = 0;
  await page.route("**/api/admin/**", async (route) => {
    const request = route.request();
    const path = new URL(request.url()).pathname;
    if (path.endsWith("/session")) {
      await route.fulfill({ json: { authenticated: true, username: "admin" } });
    } else if (path.endsWith("/aliases")) {
      await route.fulfill({ json: { aliases: [] } });
    } else if (path.endsWith("/links") && request.method() === "GET") {
      listRequests += 1;
      await route.fulfill({ json: { links } });
    } else if (path.endsWith("/links") && request.method() === "POST") {
      expect(request.postDataJSON()).toMatchObject({
        client_protocol: "responses",
        upstream_protocol: "chat",
        target_type: "direct",
        base_url: "https://api.example.com/v1",
      });
      const created = {
        ...links[0],
        id: "l2",
        base_url: "https://gateway.example/l2/responses/chat/u/api.example.com/v1/-/v1",
        endpoint: "https://gateway.example/l2/responses/chat/u/api.example.com/v1/-/v1/chat/completions",
      };
      links = [created, ...links];
      await route.fulfill({ status: 201, json: { link: created } });
    } else {
      await route.fulfill({ json: {} });
    }
  });
  page.on("dialog", async (dialog) => { await dialog.accept(); });

  await page.goto("/");
  await page.getByRole("button", { name: "链接管理" }).click();
  await expect(page.getByRole("heading", { name: "链接管理" })).toBeVisible();
  await expect(page.getByText("https://gateway.example/l1/responses/chat/u/api.example.com/v1/-/v1")).toBeVisible();
  const beforeRefresh = listRequests;
  await page.getByRole("button", { name: "重新生成链接" }).click();
  await expect(page.getByRole("heading", { name: "链接已生成" })).toBeVisible();
  await expect(page.locator("section.result-panel").getByText("https://gateway.example/l2/responses/chat/u/api.example.com/v1/-/v1", { exact: true })).toBeVisible();
  await expect.poll(() => listRequests).toBeGreaterThan(beforeRefresh);
});

test("keeps the session on logout failure and refreshes links after alias changes", async ({ page }) => {
  let aliases = [{ id: "a1", name: "production", base_url: "https://api.example.com/v1", link_count: 2 }];
  let links = [{
    id: "l1",
    client_protocol: "responses",
    upstream_protocol: "chat",
    target_type: "alias",
    alias_id: "a1",
    alias_name: "production",
    alias_base_url: "https://api.example.com/v1",
    base_url: "https://gateway.example/l1/responses/chat/a/production/-/v1",
    endpoint: "https://gateway.example/l1/responses/chat/a/production/-/v1/chat/completions",
    upstream_url: "https://api.example.com/v1/chat/completions",
  }];
  let linkListRequests = 0;
  let updateDialog = "";
  let deleteDialog = "";
  await page.route("**/api/admin/**", async (route) => {
    const request = route.request();
    const path = new URL(request.url()).pathname;
    if (path.endsWith("/session")) {
      await route.fulfill({ json: { authenticated: true, username: "admin" } });
    } else if (path.endsWith("/logout")) {
      await route.fulfill({ status: 503, json: { error: { message: "logout backend unavailable" } } });
    } else if (path.endsWith("/aliases") && request.method() === "GET") {
      await route.fulfill({ json: { aliases } });
    } else if (path.endsWith("/aliases/a1") && request.method() === "PUT") {
      expect(request.postDataJSON()).toEqual({ base_url: "https://new.example.com/v1" });
      aliases = [{ ...aliases[0], base_url: "https://new.example.com/v1" }];
      await route.fulfill({ json: { alias: aliases[0] } });
    } else if (path.endsWith("/aliases/a1") && request.method() === "DELETE") {
      aliases = [];
      links = [];
      await route.fulfill({ status: 204, body: "" });
    } else if (path.endsWith("/links") && request.method() === "GET") {
      linkListRequests += 1;
      await route.fulfill({ json: { links } });
    } else {
      await route.fulfill({ json: {} });
    }
  });

  await page.goto("/");
  await page.getByRole("button", { name: "别名管理" }).click();
  await expect(page.getByText("production")).toBeVisible();
  await page.getByRole("button", { name: "编辑 production" }).click();
  await page.locator("form.inline-edit-form input[aria-label='上游 Base URL']").fill("https://new.example.com/v1");
  page.once("dialog", async (dialog) => { updateDialog = dialog.message(); await dialog.accept(); });
  const beforeUpdate = linkListRequests;
  await page.getByRole("button", { name: "保存" }).click();
  expect(updateDialog).toContain("2 条关联链接");
  await expect(page.getByText("https://new.example.com/v1")).toBeVisible();
  await expect.poll(() => linkListRequests).toBeGreaterThan(beforeUpdate);

  page.once("dialog", async (dialog) => { deleteDialog = dialog.message(); await dialog.accept(); });
  const beforeDelete = linkListRequests;
  await page.getByRole("button", { name: "删除 production" }).click();
  expect(deleteDialog).toContain("撤销 2 条关联链接");
  await expect(page.getByText("还没有别名")).toBeVisible();
  await expect.poll(() => linkListRequests).toBeGreaterThan(beforeDelete);

  await page.getByTitle("退出登录").click();
  await expect(page.getByText("logout backend unavailable")).toBeVisible();
  await expect(page.getByRole("button", { name: "别名管理" })).toBeVisible();
  await expect(page.getByRole("heading", { name: "别名管理" })).toBeVisible();
  await expect(page.getByRole("heading", { name: "管理员登录" })).not.toBeVisible();
});
