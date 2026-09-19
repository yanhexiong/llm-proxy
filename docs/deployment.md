# 部署与运维细节

## Cloudflare 按钮部署

[![Deploy to Cloudflare](https://deploy.workers.cloudflare.com/button)](https://deploy.workers.cloudflare.com/?url=https%3A%2F%2Fgithub.com%2Fyanhexiong%2Fllm-proxy%2Ftree%2Fdeploy)

点击按钮，填写 `ADMIN_USERNAME`（账号）和 `ADMIN_PASSWORD`（至少 8 个字符的密码），然后部署。成功后在 Worker → **Settings → Domains & Routes → Add → Custom domain** 中输入域名，打开域名登录即可。Cloudflare 自身的账号授权与资源名称确认保留默认流程，资源名称可使用默认值。

按钮指向 `deploy` 分支，里面已经包含编译好的 Worker JavaScript 和管理页面。用户不需要下载源码、安装开发工具、运行本地脚本、生成密码摘要或签名密钥；构建命令自动留空。平台会自动安装 Wrangler 发布工具，然后执行模板预设的部署命令。

```text
点击按钮，填写管理员账号和密码
   |-- Cloudflare 创建仓库、Worker、D1，填入实际数据库 ID
   |-- Cloudflare 加密保存账号和密码两个 Worker Secrets
   `-- 自动执行 npm run deploy（预编译分支）
         |-- 验证资源、预编译文件和两个凭据字段
         |-- 缺少签名密钥时自动生成并保存；已存在则复用
         |-- 按 DB 绑定自动应用建表迁移
         |-- 上传已编译 Worker 和静态资源
         `-- /health 就绪检查

部署完成 → 在 Cloudflare 绑定域名 → 用刚才的账密登录
```

密码存放在 Cloudflare 加密的 Worker Secret 中，不写入源码、数据库或日志，也不复制到构建环境。签名密钥同样作为 Worker Secret 保存，重新部署不会轮换它，旧链接继续有效。

| 问题 | 处理 |
| --- | --- |
| 仍要求填写摘要、签名密钥或编译命令 | 回到本页使用最新按钮，目标 URL 应包含 `/tree/deploy`。以前创建的旧表单或源码分支仍可能保留旧设置。 |
| 密码填空或不足 8 个字符 | 在 Worker 的 Settings → Variables and Secrets 中修正 `ADMIN_PASSWORD` 并保存部署。 |
| DB 仍然是占位符 | 检查 Cloudflare 的资源创建结果；按钮必须使用预编译 `deploy` 分支。 |
| 自动创建签名密钥或迁移失败 | 检查 Cloudflare 部署凭据的 Worker Secret 写入、D1 和 Worker 发布权限后重试；无需手工生成密钥。 |

更换密码只需在 Cloudflare 修改 `ADMIN_PASSWORD` 并保存部署。更新部署包时保留自己实例的 Worker 名称、实际 D1 ID、域名和原有 Secrets。后文的命令行向导针对开发者和已有源码部署，不是按钮部署的必需步骤。

参考：[Cloudflare 部署按钮](https://developers.cloudflare.com/workers/platform/deploy-buttons/)、[绑定自定义域名](https://developers.cloudflare.com/workers/configuration/routing/custom-domains/)。

## 维护预编译分支

`main` 保存源码，`deploy` 只保存预编译文件、迁移和轻量部署脚本。GitHub Actions 在 `main` 更新后自动检查、编译并发布 `deploy` 分支，部署用户不承担编译步骤。分支的 `template-version.json` 记录对应源码提交。

维护者可在源码提交后手动执行 `pnpm run build:template` 和 `node scripts/publish-deploy-template.mjs`。生成器只接受空输出目录；发布器使用独立 Git index，保留 `main` 的工作区和暂存区，以普通快进提交更新 `deploy`，不强制覆盖历史。

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

`.gateway-state.json` 只保存 Worker/D1 名称和 ID、本地路由、配置路径、公开健康检查地址、时间戳以及 Secret 名称，不保存明文密码或 Secret 值。`.gateway-pending-secrets.json` 只在命令行首次 Worker 尚未存在时产生，包含密码摘要和签名密钥，权限为 `0600`；首次成功上传后删除。以上文件、旧版初始化文件、生成配置和 `.env` 都已加入 `.gitignore`。新版按钮部署不创建本地状态或凭据文件。

如 setup 在上传 Secret 时中断，不要手工生成新数据库或删除待上传文件；修复权限后重跑 `pnpm run setup` 或 `pnpm run deploy`。已有远端 Secret 不会被 setup 覆盖。

## D1 迁移

`migrations/0001_initial.sql` 建立：

- `aliases`：稳定 ID、唯一名称和可更新 Base URL。
- `links`：客户端/上游协议、直接地址或别名引用、撤销时间。
- `admin_sessions`：只保存会话令牌摘要、过期时间和最近使用时间。
- `login_attempts`：登录失败窗口和阻断时间。

别名删除由后端先撤销关联链接，再删除别名；`links.alias_id` 使用 `ON DELETE SET NULL` 保留撤销链接审计记录。迁移只新增对象和索引，未提供自动逆向迁移。

## Secret 和会话

按钮部署使用加密保存的 `ADMIN_PASSWORD` Secret，验证时比较固定长度摘要，避免直接比较密码字符串。该字段一旦存在就优先使用；空值或不足 8 个字符时拒绝登录，不回退旧密码摘要。

命令行旧实例继续兼容 `ADMIN_PASSWORD_HASH`，使用 `pbkdf2_sha256$迭代次数$base64url盐$base64url摘要` 格式、100,000 次 SHA-256 PBKDF2。`LINK_SIGNING_SECRET` 由部署脚本或命令行 setup 自动生成随机 32 字节 base64url 字符串，不在表单中要求用户填写。

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
