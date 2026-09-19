# 部署与运维细节

## Cloudflare 按钮部署

[![Deploy to Cloudflare](https://deploy.workers.cloudflare.com/button)](https://deploy.workers.cloudflare.com/?url=https%3A%2F%2Fgithub.com%2Fyanhexiong%2Fllm-proxy)

这是 Cloudflare 官方的公开仓库模板部署流程，使用 Workers Builds，不需要在 GitHub Actions 中保存 Cloudflare API Token。

```text
node scripts/generate-deploy-secrets.mjs（本地，仅运行一次）
   `-- 生成 .gateway-deploy-secrets.json，包含用户名、密码摘要和随机签名密钥

点击按钮，在 Cloudflare 表单中选择资源名并填入三个 Secrets
   |-- Cloudflare 创建仓库、Worker、D1，并将实际 D1 ID 写入 wrangler.jsonc
   |-- Cloudflare 配置 .dev.vars.example 声明的 Worker Secrets
   |-- 安装依赖、pnpm run build
   `-- pnpm run deploy（无本地状态文件）
         |-- 验证 DB 绑定已有真实数据库 ID
         |-- 类型检查、构建、Wrangler dry-run、Secret 名称预检
         |-- wrangler d1 migrations apply DB --remote
         |-- wrangler deploy
         `-- GET /health
```

迁移使用固定绑定名 `DB`，因此用户可以在按钮页面更改 D1 的显示名称。部署脚本不会在构建环境里运行交互式 setup、重新生成 Secrets 或再创建数据库。它也不要求把运行时 Secrets 复制到构建变量里；通过 Wrangler 只检查远端 Secret 名称，具体值不会输出。

根配置使用全零数据库 ID 作为模板占位符。只有 Cloudflare 自动配置为真实 ID 后才能进入无状态部署路径；直接下载源码后运行 `pnpm run deploy` 会提示先运行本地 `setup`。公共配置没有账号 ID 和个人域名，每个按钮部署默认获得自己的 `workers.dev` 地址。

构建配置使用仓库根目录、`pnpm run build` 和 `pnpm run deploy`，不要改成裸 `wrangler deploy`，否则会跳过数据库迁移和健康检查。`.node-version` 指定 Node.js 24，`packageManager` 固定 pnpm 12.4.2；如果构建平台没有切换到固定版本，在构建变量中设置 `PNPM_VERSION=12.4.2`。

| 问题 | 处理 |
| --- | --- |
| 表单要求填写密码摘要和签名密钥 | 本地运行初始化工具，从生成的 JSON 文件复制对应值。密码摘要必须完整保留 `$` 分隔符；登录仍输入原密码。 |
| Secret 预检失败 | 检查 Worker 的 Settings → Variables and Secrets，补齐 `ADMIN_USERNAME`、`ADMIN_PASSWORD_HASH`、`LINK_SIGNING_SECRET` 后重新构建。 |
| DB 仍然是占位符 | 检查按钮是否从公开仓库根目录启动、Cloudflare 资源创建是否成功。不要手工复制其他实例的数据库 ID。 |
| 缺少 D1 或 Worker 权限 | 检查该 Worker 的构建部署凭据是否可执行 D1 迁移、读取 Worker Secret 名称和发布 Worker。 |
| 初始化文件已存在 | 工具故意不覆盖已有密钥。升级复用原文件；新建另一实例时先安全保存旧文件，再生成新文件。 |

按钮部署的更新沿用 Cloudflare 创建的仓库与资源；合并上游代码时保留该实例的 Worker 名称、真实 D1 ID、自定义域名和原有 Secrets。更换密码可以本地运行 `node scripts/hash-password.mjs`，然后仅更新 Worker 的 `ADMIN_PASSWORD_HASH` Secret。本文后面的 `setup`、`doctor` 和密码重置向导基于本地状态；按钮实例没有状态文件时，直接使用实际 `wrangler.jsonc` 执行 Wrangler 命令或在 Dashboard 操作。

参考：[Cloudflare 部署按钮](https://developers.cloudflare.com/workers/platform/deploy-buttons/)、[Workers Builds 构建环境](https://developers.cloudflare.com/workers/ci-cd/builds/build-image/)。

## 生命周期

```text
pnpm run setup
   |-- wrangler login / whoami
   |-- d1 list -> 复用同名数据库，或 d1 create
   |-- 生成 .gateway-wrangler.jsonc（不改源码配置）
   `-- secret list -> 写入已有 Worker，或暂存待首次 deploy 上传

pnpm run deploy
   |-- pnpm run typecheck
   |-- pnpm run build
   |-- wrangler deploy --dry-run / 必要 Secret 预检
   |-- d1 migrations apply --remote
   |-- wrangler deploy
   |-- 上传暂存 Secret（如有）
   `-- GET /health
```

脚本按步骤停止：构建失败不会执行迁移，迁移失败不会发布 Worker，发布后的健康检查失败不会删除 D1 或回滚数据库。再次执行会复用状态中的 Worker、D1、域名和 Secret；不会重置管理员密码或 `LINK_SIGNING_SECRET`。

## 本地状态

`.gateway-state.json` 只保存 Worker/D1 名称和 ID、本地路由、配置路径、公开健康检查地址、时间戳以及 Secret 名称，不保存明文密码或 Secret 值。`.gateway-pending-secrets.json` 只在首次 Worker 尚未存在时产生，包含密码摘要和签名密钥，权限为 `0600`；首次成功上传后删除。按钮初始化工具单独生成 `.gateway-deploy-secrets.json`，同样使用 `0600` 权限且禁止覆盖。以上文件、生成的 Wrangler 配置和 `.env` 都已加入 `.gitignore`。

如 setup 在上传 Secret 时中断，不要手工生成新数据库或删除待上传文件；修复权限后重跑 `pnpm run setup` 或 `pnpm run deploy`。已有远端 Secret 不会被 setup 覆盖。

## D1 迁移

`migrations/0001_initial.sql` 建立：

- `aliases`：稳定 ID、唯一名称和可更新 Base URL。
- `links`：客户端/上游协议、直接地址或别名引用、撤销时间。
- `admin_sessions`：只保存会话令牌摘要、过期时间和最近使用时间。
- `login_attempts`：登录失败窗口和阻断时间。

别名删除由后端先撤销关联链接，再删除别名；`links.alias_id` 使用 `ON DELETE SET NULL` 保留撤销链接审计记录。迁移只新增对象和索引，未提供自动逆向迁移。

## Secret 和会话

`ADMIN_PASSWORD_HASH` 使用 `pbkdf2_sha256$迭代次数$base64url盐$base64url摘要` 格式，当前脚本默认 100,000 次 SHA-256 PBKDF2，符合 Workers WebCrypto 的迭代上限。验证逻辑拒绝格式错误并使用恒定时间比较。`LINK_SIGNING_SECRET` 由 setup 随机生成 32 字节 base64url 字符串。不要在日志、Issue、截图或代理 URL 中泄漏它们。

管理员会话令牌只以 SHA-256 摘要存入 D1；Cookie 应由后端设置 `HttpOnly`、`Secure`、`SameSite` 并限制有效期。链接凭证和管理员会话是两套独立授权，不要把管理员 Cookie 作为上游认证头。

## 备份和恢复

在重大升级前：

```text
pnpm exec wrangler d1 export <database-name> --remote --output backup.sql
```

备份文件按敏感文件保存。恢复前先确认目标数据库、Worker 版本和停写窗口：

```text
pnpm exec wrangler d1 execute <database-name> --remote --file backup.sql
```

不同 Wrangler 版本的参数提示可能略有差异，先运行对应 `--help`。恢复后运行 `pnpm run doctor`，确认迁移和 Secret 名称，再发布匹配的代码版本。数据库恢复不会自动恢复被轮换的 `LINK_SIGNING_SECRET`；若 Secret 也丢失，旧链接凭证无法通过新密钥验证，应按业务流程重新生成链接。

## 版本回滚

代码回滚可以使用 Cloudflare Dashboard 的 Worker Versions，或按当前 Wrangler 版本的 `wrangler rollback --help` 操作。回滚 Worker 不会逆向 D1 迁移；如果新版本写入了旧版本不能理解的数据，必须先按该版本的专用恢复说明处理。任何迁移不兼容性都应在发布说明中列出，并在生产前备份。

## 最小排错顺序

1. `pnpm run doctor`，先分辨本地工具、Cloudflare 权限、D1、Secret 和公网健康检查。
2. 确认 `.gateway-state.json` 的 Worker/D1 名称与当前账户一致，不要凭记忆重新创建资源。
3. 运行 `pnpm exec wrangler d1 migrations list <database-name> --remote` 查看远端迁移记录。
4. 检查 `PUBLIC_URL/health` 与自定义域名 DNS/TLS；只在公开健康检查失败时检查路由，不要先删除 D1。
5. 迁移或发布错误修复后重试 `pnpm run deploy`；不要手工修改 Wrangler 迁移表。
