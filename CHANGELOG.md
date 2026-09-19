# Changelog

## Unreleased

- 接入官方 Deploy to Cloudflare 按钮，支持从公开仓库自动创建 D1、配置 Secrets 并完成构建、迁移和健康检查。
- 增加独立的按钮部署凭据生成工具和中文部署字段说明，密码保持盐化摘要格式，生成文件禁止覆盖且排除出版本控制。
- 公共配置移除个人域名，已有实例的自定义域名保留在本地部署状态中；迁移按绑定名执行，允许按钮用户修改数据库名。

## 0.1.1 - 2026-09-19

- 在 `converter.yahenix.top` 部署 Worker、Static Assets 和 D1，并添加真实上游、SDK、图片、并行工具往返和浏览器验证脚本。
- 修复 Messages 工具选择、图片编码、工具历史、SSE 空值、终止时机、工具索引和 Responses 最终内容一致性。
- DeepSeek 跨协议请求显式关闭不能无损转换的默认原生思考；同协议透传保留原生行为。
- 修复流式背压、取消传播、响应体空闲超时和可读的协议错误；管理接口禁用缓存。
- 部署前增加类型检查、打包检查和 Secret 预检，修复诊断命令的占位数据库误报及错误输出丢失。
- 管理页补齐链接重新生成、可直接运行的 cURL、复制失败提示和退出失败处理。

## 0.1.0 - 2026-09-19

- 首次实现 Anthropic Messages、OpenAI Responses 和 Chat Completions 的六个跨协议转换方向与三个同协议透传方向。
- 支持非流式与 SSE 流式文本、图片输入、函数工具、用量和结束原因转换，并对无法安全表达的字段返回显式错误。
- 增加 HMAC 链接凭证、别名跟随、逐条撤销、管理员会话和 D1 增量迁移。
- 增加 React 管理后台、跨平台 setup/deploy/doctor/password 脚本、Workers Static Assets 和中文部署运维文档。
- 验证 Node.js 24.20.0、pnpm 12.4.2、Wrangler 4.134.0、Vitest 4.1.11 和 Playwright 1.63.0。
