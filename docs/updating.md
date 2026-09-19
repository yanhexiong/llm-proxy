# 一键更新已有 Worker

从 0.1.5 起，按钮部署包自带 `Update Worker` GitHub Actions 工作流。它更新你自己的预编译部署仓库，已连接该仓库的 Cloudflare Builds 随后发布到原 Worker。无需本地编译、重新绑定域名或额外填写 Cloudflare API Token。

## 已包含更新工作流的实例

1. 打开**你自己的部署仓库**，选择 **Actions → Update Worker → Run workflow**。首次使用 Actions 时按 GitHub 提示启用。
2. 选择 Cloudflare 连接的生产分支，再点击绿色 **Run workflow**。分支可在 Cloudflare → Workers & Pages → 你的 Worker → Settings → Builds 中确认。
3. 等待工作流成功，再到 Cloudflare 的 **Deployments → View build history** 确认发布成功。

工作流自动下载 `yanhexiong/llm-proxy` 的最新 `deploy` 分支，验证完整部署包，更新应用文件并提交到选定分支。它不使用源码 `main` 分支，也不执行 TypeScript／React 编译。已是最新文件时不会创建重复提交；如果上一次 Cloudflare 发布失败而仓库已更新，请在 Cloudflare 重试对应构建。

GitHub 工作流成功表示**部署仓库同步成功**，不表示 Cloudflare 已完成发布。Cloudflare 仍需要保留原有 Git 集成，生产分支必须匹配，预编译版构建命令留空、部署命令为 `npm run deploy`。[Cloudflare Git 集成](https://developers.cloudflare.com/workers/ci-cd/builds/)

## 0.1.2–0.1.4 旧按钮实例：只需接入一次

旧仓库没有更新工作流，按以下步骤添加一个文件即可，无需先手动搬运整套部署文件：

1. 打开[工作流文件](https://github.com/yanhexiong/llm-proxy/blob/main/.github/workflows/update-worker.yml)，复制完整内容。
2. 打开**你自己的部署仓库**，选择 **Add file → Create new file**。
3. 文件名填写 `.github/workflows/update-worker.yml`，粘贴内容并提交到默认分支。若 Cloudflare 使用不同的生产分支，也把该文件加入生产分支。
4. 打开 **Actions → Update Worker → Run workflow**，选择生产分支并运行。

GitHub 要求手动触发的工作流存在于默认分支，才会显示运行入口；选定的运行分支也需要包含该工作流。[GitHub 手动工作流规则](https://docs.github.com/en/actions/how-tos/write-workflows/choose-when-workflows-run/trigger-a-workflow#defining-inputs-for-manually-triggered-workflows)

这一步只是让旧仓库具备更新入口。后续每次升级直接运行工作流，无需重新复制文件。此方案面向 GitHub 按钮部署仓库；GitLab 实例需要使用其对应 CI 流程。

## 更新时保留什么

- `wrangler.jsonc` 原始内容完全保留：包括 Worker 名称、实际 D1 ID、域名、普通变量和已有资源绑定。
- 管理员密码、`LINK_SIGNING_SECRET` 等仍存放在原 Worker 的 Secrets 中，更新脚本不读取或修改它们。正常发布复用原密钥，因此已有链接继续有效。
- D1 数据不被替换；新版可以追加迁移，不能修改或删除已有 SQL 迁移。
- README、其他工作流、仓库自定义文件和本地凭据文件不属于自动覆盖范围。

Worker、管理页面、部署脚本、依赖声明及发布清单属于自动管理的应用文件，会更新到上游版本。新清单带有每个文件的 SHA-256；对于之前已有清单的实例，旧清单中已被新版移除的应用文件也会删除，其他用户文件保留。首次从没有清单的旧版本更新时，不猜测哪些未知旧文件可以删除。

脚本在写入前验证整个部署包，拒绝路径越界、符号链接、缺失文件、校验失败、数据库占位 ID、自动降级及迁移改写。同步失败不会推送，推送采用普通快进方式，不会强制覆盖并发提交。

工作流只用 GitHub 自带的短期仓库令牌，不要求配置个人访问令牌。应用同步不修改 `.github/workflows`，避免扩大更新权限；每次运行都执行上游最新版同步程序，因此通常无需更新工作流文件本身。

## 常见情况

| 情况 | 处理 |
| --- | --- |
| Actions 没有 Update Worker | 将工作流加入仓库默认分支；按 GitHub 提示启用 Actions。 |
| 提示不是预编译部署仓库 | 当前是源码部署，不能直接套用此更新方式。源码实例使用原目录中的 `git pull --ff-only`、`pnpm install --frozen-lockfile`、`pnpm run deploy`。 |
| 分支保护或组织策略拒绝写入 | 由仓库管理员配置适合部署分支的权限；本工作流不会绕过保护或强制推送。 |
| 更新成功但 Cloudflare 没有开始发布 | 确认仓库、生产分支、自动构建和监控路径配置；也可在 Cloudflare 手动触发该分支最新提交的构建。 |
| 已是最新版但线上仍是旧版 | 到 Cloudflare 查看并重试失败的部署；再次同步不会创建无意义提交。 |
| 配置或迁移不兼容 | 工作流停止并指出问题，按对应版本的迁移说明处理后重试。 |

对于本仓库维护者：`main` 仍是源码，`deploy` 是公共模板，均不是绑定实际数据库的用户部署实例。不要对公共模板运行用户更新流程。发布模板新增／修改工作流文件时，首次使用具有 GitHub `workflow` 权限的维护者身份发布；后续应用文件的自动发布和用户同步不需要扩大默认令牌权限。
