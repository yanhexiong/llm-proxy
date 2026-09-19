# LLM Proxy — 一键部署版

[![Deploy to Cloudflare](https://deploy.workers.cloudflare.com/button)](https://deploy.workers.cloudflare.com/?url=https%3A%2F%2Fgithub.com%2Fyanhexiong%2Fllm-proxy%2Ftree%2Fdeploy)

1. 点击按钮，登录 Cloudflare 并授权 GitHub。资源名称可保留默认值。
2. 只填写管理员账号 `ADMIN_USERNAME` 和密码 `ADMIN_PASSWORD`（至少 8 个字符），点击部署。
3. 部署成功后，在 Worker → Settings → Domains & Routes → Add → Custom domain 中绑定域名。
4. 打开该域名，用刚才的账号密码登录。

这个分支已经包含编译好的 Worker 和管理页面。构建命令自动留空，部署命令自动使用 `npm run deploy`；无需下载源码、安装 Node.js、运行本地命令或手动生成密钥。Cloudflare 会安装发布工具、自动创建 D1、建表并生成链接签名密钥。再次部署保留原密钥和原链接。

密码加密保存在 Cloudflare Worker Secret 中，不写入代码、D1 或构建日志。重置密码只需在 Worker 的 Variables and Secrets 中修改 `ADMIN_PASSWORD`。

本分支由维护者自动生成，请在 [main 分支](https://github.com/yanhexiong/llm-proxy) 修改源码。
版本：0.1.3；源码提交：[3260e55](https://github.com/yanhexiong/llm-proxy/commit/3260e555d46950eb19d1868d6af6c5fb043aefba)。
