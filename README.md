# Workers API Gateway

[![Deploy to Cloudflare](https://deploy.workers.cloudflare.com/button)](https://deploy.workers.cloudflare.com/?url=https%3A%2F%2Fgithub.com%2Fyanhexiong%2Fllm-proxy)

这是一个部署在 Cloudflare Workers 的轻量协议转换网关。它使用一个 Worker、Workers Static Assets 和一个 D1 数据库；客户端只需修改 Base URL，继续发送原协议请求和原上游 API Key。

## 通过 Cloudflare 按钮部署

按钮会从 [yanhexiong/llm-proxy](https://github.com/yanhexiong/llm-proxy) 创建一份属于你的仓库，并在你的 Cloudflare 账户中创建 Worker 和 D1、构建管理页面、应用数据库迁移。无需填写数据库 ID 或手工执行 SQL。

1. 准备一个 Cloudflare 账户和 GitHub 账户；下载本仓库源码，在本地安装 Node.js 22+。
2. 在源码根目录运行 `node scripts/generate-deploy-secrets.mjs`。输入管理员用户名和密码后，会生成 `.gateway-deploy-secrets.json`；这一步不需要安装依赖，也不访问 Cloudflare。
3. 点击上方 **Deploy to Cloudflare** 按钮，授权 GitHub，选择账户和新仓库／Worker／D1 名称。
4. 将初始化文件中的三个值分别填入部署表单的 Secrets：

   | 字段 | 填写内容 |
   | --- | --- |
   | `ADMIN_USERNAME` | 管理员用户名，默认 `admin` |
   | `ADMIN_PASSWORD_HASH` | 工具生成的完整 `pbkdf2_sha256$...` 密码摘要 |
   | `LINK_SIGNING_SECRET` | 工具生成的随机签名密钥 |

5. 保留项目根目录 `/`，确认构建命令为 `pnpm run build`、部署命令为 `pnpm run deploy`，然后部署。平台自动安装依赖；仓库固定 pnpm 12.4.2，并用 `.node-version` 选择 Node.js 24。若平台要求显式指定 pnpm 版本，在**构建变量**中设置 `PNPM_VERSION=12.4.2`。
6. 打开部署输出的 `workers.dev` 地址，用原始用户名和密码登录；`/health` 应返回 `{"status":"ready"}`。

三个值是 **Worker 运行时 Secrets**，无需再添加为构建环境变量。初始化文件不保存明文密码，但包含签名密钥，已加入 `.gitignore`；再次运行工具不会覆盖它。升级时沿用原来的三个值，尤其不要重新生成签名密钥，否则旧链接会失效。

公共模板不绑定任何个人域名。部署后可在自己的 Worker 设置中添加自定义域名。按钮部署机制及字段来源见 [Cloudflare 官方说明](https://developers.cloudflare.com/workers/platform/deploy-buttons/)，具体流程和排错见 [部署文档](docs/deployment.md#cloudflare-按钮部署)。

## 命令行首次部署

要求：Node.js 22+、pnpm 12.4.2（仓库 `packageManager` 已固定），以及一个有 Workers 和 D1 权限的 Cloudflare 账户。

```text
pnpm install --frozen-lockfile
pnpm run setup
pnpm run deploy
pnpm run doctor
```

pnpm 将 `setup`、`deploy`、`doctor` 保留为自身命令，因此这里必须写 `pnpm run setup/deploy/doctor` 才会执行本项目脚本。`pnpm run setup` 会打开 Cloudflare 登录页，询问 Worker 名称、账户 ID、D1 名称和管理员用户名/密码。默认值可以直接回车接受。首次 Worker 尚未存在时，Secret 会写入权限为 `0600` 的本地待上传文件；第一次 `pnpm run deploy` 发布 Worker 后会自动上传并清理该文件。部署完成后访问输出的地址即可打开管理页面。

不要把 `.gateway-state.json`、`.gateway-pending-secrets.json`、`.gateway-wrangler.jsonc` 或 `.env` 提交到版本库。主仓库应将这些文件加入 `.gitignore`；待上传文件包含管理员密码摘要和链接签名密钥。

## 命令

| 命令 | 作用 | 是否会改 Cloudflare 资源 |
| --- | --- | --- |
| `pnpm run setup:button` | 为按钮部署生成本地密码摘要和随机签名密钥 | 否，仅创建本地凭据文件 |
| `pnpm run setup` | 登录、复用或创建 D1、生成配置和必要 Secrets；可重复运行 | 首次创建 D1，必要时写入 Secrets |
| `pnpm run deploy` | 构建、应用远端迁移、发布 Worker、上传首次 Secret、检查 `/health` | 发布 Worker、写入迁移和 Secrets |
| `pnpm run doctor` | 检查 Node/pnpm/Wrangler、账户、D1 绑定、迁移、Secret 名称和公开健康状态 | 只写本地生成的配置，不改远端 |
| `pnpm exec node scripts/reset-password.mjs` | 交互式重置管理员密码；旧密码立即不能登录 | 写入 `ADMIN_PASSWORD_HASH` |
| `pnpm exec node scripts/hash-password.mjs` | 输出 PBKDF2 密码摘要，供手工配置时使用 | 不改远端 |

脚本是 Node.js 实现，不依赖 Bash、`sed`、`grep` 或 Linux 专用路径；Windows PowerShell、macOS 和 Linux 使用同一组命令。脚本默认调用 `pnpm exec wrangler`，也可以用 `PNPM_BIN` 指定 pnpm 可执行文件。

## 配置和 Secret

项目配置以仓库中的 `wrangler.jsonc` 为准。命令行向导按 `.gateway-state.json` 生成临时 `.gateway-wrangler.jsonc`，注入实际 D1 ID 和本地自定义域名后供迁移和部署使用。按钮部署则直接使用 Cloudflare 已填写实际 D1 ID 的源码配置，不依赖本地状态文件。两条路径都不会重复创建数据库。

| 名称 | 类型 | 用途 | 默认值/生成方式 | 必填 |
| --- | --- | --- | --- | --- |
| `WORKER_NAME` | 环境变量 | Worker 名称 | 配置中的 `name` 或 `api-gateway` | 首次 setup 可由向导填写 |
| `CLOUDFLARE_ACCOUNT_ID` | 环境变量 | 选择 Cloudflare 账户 | 使用 Wrangler 当前默认账户 | 多账户时建议填写 |
| `D1_DATABASE_NAME` | 环境变量 | D1 显示名称 | `<worker-name>-d1` | 否 |
| `D1_BINDING` | 环境变量 | Worker 中的 D1 binding | `DB` | 否，后端默认使用 `DB` |
| `PUBLIC_URL` | 环境变量 | 部署后的健康检查地址 | Wrangler 输出的 `workers.dev` 地址 | 自定义域名或无法解析输出时填写 |
| `UPSTREAM_TIMEOUT_MS` | Worker 普通变量 | 上游请求超时，毫秒 | `120000` | 否 |
| `ADMIN_USERNAME` | 环境变量/Secret | 管理员用户名 | setup 首次询问，写入 Secret | 首次 setup 必填 |
| `ADMIN_PASSWORD` | 环境变量 | 无交互 setup/reset 的明文密码 | 不保存、不写入状态文件 | 仅无交互时必填 |
| `ADMIN_PASSWORD_HASH` | Worker Secret | PBKDF2-SHA-256 管理员密码摘要 | setup 生成 | 必填 |
| `LINK_SIGNING_SECRET` | Worker Secret | 生成链接凭证的 HMAC 密钥 | setup 随机生成 32 字节 | 必填 |

命令行部署可参考 `.env.setup.example`，但脚本不会自动加载它；CI 中请使用平台的 Secret 存储注入环境变量。`.dev.vars.example` 专供 Cloudflare 按钮识别三个运行时 Secret，请勿把命令行路径、账户信息或明文密码加入该文件。

## 管理页面和代理链接

管理员登录后可以建立别名、生成链接、查看/复制链接和逐条撤销链接。链接生成不访问上游，也不会保存上游 API Key。别名更新会影响已有别名链接；删除别名前后端会先撤销关联链接，数据库保留链接审计记录。

支持的协议标识如下：

| 标识 | 协议 | 客户端端点 |
| --- | --- | --- |
| `messages` | Anthropic Messages | `/v1/messages` |
| `responses` | OpenAI Responses | `/v1/responses` |
| `chat` | OpenAI Chat Completions | `/v1/chat/completions` |

直填地址链接格式为：

```text
https://<gateway>/<credential>/<client-protocol>/<upstream-protocol>/u/<upstream-base>/-
```

别名链接把 `/u/<upstream-base>` 换成 `/a/<alias>`。上游 Base URL 可以省略 `https://`，但不能带用户名密码、查询参数或 fragment；客户端追加的路径由网关按客户端协议匹配。OpenAI SDK 的 Base URL 通常以 `/-/v1` 结尾，Anthropic SDK 的地址通常以 `/-` 结尾，管理页面会同时展示 Base URL 和完整端点。

客户端仍需在自己的请求头中发送原上游 Key。管理员 Cookie 和链接凭证不会转发给上游；运行日志只记录请求 ID、链接 ID、协议方向、耗时、状态和错误类型。

## 自定义域名

首次部署默认使用 Wrangler 输出的 `workers.dev` 地址。需要自定义域名时：

1. 在 Cloudflare Dashboard 的 Workers Routes/Custom Domains 中把域名绑定到该 Worker，并完成 DNS/TLS 配置。
2. 用浏览器访问 `https://你的域名/health`，确认返回就绪状态。
3. 设置 `PUBLIC_URL=https://你的域名` 后运行 `pnpm run doctor`；以后 `pnpm run deploy` 会用它检查发布结果。

使用命令行向导的实例，也可在已忽略的 `.gateway-state.json` 中保存 `"routes": [{ "pattern": "你的域名", "custom_domain": true }]`；生成配置会沿用该路由，Wrangler 将在部署时配置该域名。公共 `wrangler.jsonc` 保持不含个人域名。更换域名不需要重建 D1 或重置 `LINK_SIGNING_SECRET`。

## 密码重置

已发布 Worker：

```text
pnpm exec node scripts/reset-password.mjs
```

脚本交互式读取新密码，不显示输入内容，并直接写入 `ADMIN_PASSWORD_HASH`。无交互环境可设置 `ADMIN_PASSWORD` 后运行同一命令；不要把明文密码放在命令历史中。Worker 尚未发布时，脚本会更新本地待上传 Secret，随后运行 `pnpm run deploy`。

重置密码不会重置链接凭证或 D1 数据。若需要让全部旧管理员会话失效，应在管理页面注销，或按当前后端提供的会话清理接口操作；不要删除整个数据库。

## 升级、回滚和数据库恢复

升级时沿用原 Worker 名称、D1 名称、域名、管理员配置和 `LINK_SIGNING_SECRET`：

```text
git fetch --tags
git checkout <目标版本>
pnpm install --frozen-lockfile
pnpm run deploy
```

迁移是向前兼容的增量 SQL。`pnpm run deploy` 会先构建，再应用迁移；任一步失败都不会发布新 Worker。不要手工删除迁移记录，也不要在普通回滚中逆向执行旧迁移。应用版本回滚和数据库恢复是两件事：在 Cloudflare Dashboard 的 Worker Versions 中回滚代码，数据库则从备份恢复。

建议在升级前导出 D1：

```text
pnpm exec wrangler d1 export <database-name> --remote --output backup-<date>.sql
```

恢复前先停止写入并确认文件来源，再使用 Wrangler 当前版本的远端执行命令：

```text
pnpm exec wrangler d1 execute <database-name> --remote --file backup-<date>.sql
```

恢复会覆盖 SQL 文件中包含的对象/数据，具体行为以 `pnpm exec wrangler d1 export --help` 和 `pnpm exec wrangler d1 execute --help` 为准。恢复后运行 `pnpm run doctor`，再发布与备份匹配的 Worker 版本。D1 备份文件可能包含管理员会话和链接元数据，必须按敏感文件保存，不要提交仓库。

## 常见问题

| 现象 | 处理 |
| --- | --- |
| `找不到 wrangler.jsonc` | 确认在项目根目录运行，或先让项目配置 agent 创建 `wrangler.jsonc`。脚本不支持把 `wrangler.toml` 自动改写为 JSONC。 |
| `Cloudflare 尚未登录` | 运行 `pnpm exec wrangler login`，完成浏览器授权后重试。多账户时填写 `CLOUDFLARE_ACCOUNT_ID`。 |
| setup 报 D1 权限错误 | 确认账户有 D1 创建/读取权限；相同名称的现有数据库会复用，不要反复换名称创建。 |
| 首次 setup 显示 Worker 不存在 | 正常。必要 Secret 会暂存到 `.gateway-pending-secrets.json`，第一次 deploy 成功后上传；不要删除该文件。 |
| 迁移失败 | 保留数据库和迁移记录，修复构建/权限/SQL 后重试 `pnpm run deploy`。不要手工删除 D1 表或迁移表。 |
| 部署成功但 `/health` 失败 | 检查 `PUBLIC_URL`、自定义域名 DNS/TLS、Worker 路由和 Secret；`pnpm run doctor` 会区分本地配置、远端权限和公开网络问题。 |
| `ADMIN_PASSWORD_HASH` 缺失 | 运行 `pnpm run setup` 补齐 Secret，或运行密码重置脚本；Secret 值不会由 doctor 打印。 |
| Windows 找不到 `pnpm` | 安装 pnpm 并重新打开 PowerShell；也可设置 `PNPM_BIN` 指向 `pnpm.cmd`。脚本不依赖 Bash。 |
| SDK 返回 404 | 检查客户端协议是否与链接第一段一致，以及 OpenAI/Anthropic SDK 是否按文档追加 `/-/v1` 或 `/-`。 |

## 费用和资源边界

本项目使用 Cloudflare Workers、Workers Static Assets、D1 和可选的自定义域名。实际费用取决于账户套餐和用量，可能涉及 Worker 请求/CPU、D1 读写与存储、静态资源流量、日志、DNS/TLS 及套餐最低费用；不要把“可用免费额度”当作无限免费。请以部署账户当前的 Cloudflare Pricing、Workers 和 D1 配额页面为准，并为 D1 写入和上游模型调用分别设置预算/告警。

网关不保存上游 Key，不代理模型计费，也不替上游供应商承担额度；每次代理请求仍可能产生上游 API 费用。生成链接本身不访问上游、不消耗模型额度。

## 相关文档

- [协议兼容性和归属说明](docs/compatibility.md)
- [部署与运维细节](docs/deployment.md)
- [版本变更记录](CHANGELOG.md)
- [2026-09-19 公网验收记录](docs/live-verification-2026-09-19.md)

## 真实上游验证

`scripts/live-test.mjs` 从本地 `test_env` 读取 `base_url`、`api_key` 和 `model`，从 `.gateway-test-admin.json` 读取本次部署管理员凭据。两者和生成链接文件均已排除出版本控制。测试仅向给定上游和目标网关发送 Key，报告只保存状态、用量及固定测试输出，不保存 Key、管理员密码或完整链接凭证。

```text
pnpm run test:live matrix
pnpm run test:live sdk
pnpm run test:live tools
pnpm run test:live images
pnpm run test:live truncate
pnpm run test:live management
```

`matrix` 覆盖三种客户端协议和三种上游协议的流式/非流式组合，`sdk` 使用官方 OpenAI/Anthropic SDK 汇总流，`tools` 验证两次并行函数调用和完整续轮，`images` 使用程序生成的红色 PNG 验证图片输入。结果位于 `test-results/live-*.json`。这些命令会实际调用模型并产生上游费用。当前脚本为本轮 DeepSeek 验证配置了 Messages 的 `/anthropic/v1` 基础路径；更换供应商时需调整对应基础路径。
