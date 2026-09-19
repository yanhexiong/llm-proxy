# 只填账密的预编译部署验收

版本：0.1.2。验收日期：2026-09-19。

按钮使用 `deploy` 分支，内含已编译 `worker.js` 和 `public/` 管理页面。该分支没有 `build` 脚本、TypeScript、React 或 Vite 开发依赖，Wrangler 使用 `no_bundle: true` 直接上传现成 Worker。`.dev.vars.example` 只声明 `ADMIN_USERNAME` 和 `ADMIN_PASSWORD`；资源运行参数使用应用内置默认值。

在独立的临时 Cloudflare Worker 和空 D1 中，模拟平台创建资源并仅写入账号、密码两个运行时 Secrets，然后执行实际预编译包的 `npm run deploy` 对应脚本。运行期间未向构建环境注入管理员凭据，也未调用模型上游。

| 公网检查 | 结果 |
| --- | --- |
| 初始化前只有 `ADMIN_USERNAME`、`ADMIN_PASSWORD` 两个 Secret | 通过 |
| 部署自动完成 D1 迁移和随机 `LINK_SIGNING_SECRET` 初始化 | 通过 |
| `/health` 返回 HTTP 200 和 `{"status":"ready"}` | 通过 |
| 正确账号密码登录成功，错误密码返回 401 | 通过 |
| 再次部署后已有链接的签名和完整端点不变 | 通过 |
| 在 Cloudflare 更新密码后，新密码可用、旧密码失效，链接仍不变 | 通过 |

验收资源 `llm-proxy-button-check-mu7unhg1` 已删除，Worker 和 D1 均清理成功；测试未变更 `converter.yahenix.top` 的 Worker 或数据库。

本地验证：Workers 运行时测试 52/52、部署脚本测试 14/14、TypeScript 检查、前端构建和 Worker 预编译均通过。脚本回归覆盖密钥只初始化一次、失败时停止发布，以及健康检查拒绝 HTML 和非就绪响应。

复现脚本为 `scripts/test-prebuilt-live.mjs`，需要维护者已有 Cloudflare 登录。先构建 `.deploy-template`，再运行该脚本；它创建独立测试资源并在结束时清理，验收报告保存在被 Git 忽略的 `.gateway-button-check-*/verification.json` 中。这些命令属于维护者验收流程，不是部署用户的操作步骤。

验证范围：已实测 Cloudflare 中的资源初始化、真实上传、登录、重复部署和改密；没有代替用户在 Cloudflare 网页中完成 GitHub OAuth 授权，也没有为临时实例绑定新域名。域名使用 Cloudflare 原生 Settings → Domains & Routes → Add → Custom domain 流程。
