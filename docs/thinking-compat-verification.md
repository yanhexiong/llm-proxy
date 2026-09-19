# 跨协议思考兼容验收

日期：2026-09-19。版本：0.1.4。公网：`https://converter.yahenix.top`。

## 问题和修复

部署前，向现有 Messages → Chat 代理链接发送 `thinking: {"type":"disabled"}`，网关返回 HTTP 400：`thinking: provider-native thinking cannot be represented across protocols (field: thinking)`。原有严格校验仅因字段出现就拒绝转换，导致客户端自动附带思考设置时无法调用。

HTTP 网关现默认使用跨协议思考兼容模式。请求、历史消息、JSON 响应和 SSE 流中的已知原生思考控制及私有状态会被过滤，正文、工具调用、工具结果、用量和结束状态继续经过原有转换。响应头 `x-gateway-thinking-mode: compatible` 标明此行为。原始上游错误及其他不支持的语义仍然保留校验。

同协议调用和通用 HTTP 透传不经过思考过滤。转换库自身仍默认严格模式；HTTP 网关可通过 `CROSS_PROTOCOL_THINKING=strict` 恢复原有拒绝行为。

## 本地验证

- Workers 运行时测试 **75/75**，部署脚本测试 **14/14**；后端及前端类型检查、构建、Wrangler 打包和部署健康检查通过。
- 请求与 JSON/SSE 响应覆盖三种协议之间的六种跨协议方向，确认思考与签名字段被过滤，正文、工具参数、用量和结束事件保留。
- 检查工具参数、工具结果和用户内容中同名字段不会被误删；同协议保留原对象／流；严格模式仍拒绝不可映射字段。
- 流式测试覆盖思考与正文／工具调用混合出现、仅终态的 Responses 响应、真实上游错误，以及 `error: null` 的兼容情况。

## 公网验证

使用 `test_env` 中已有的 DeepSeek 凭据、`deepseek-flash` 模型和已有签名链接，在部署后的域名上运行 `pnpm run test:live thinking`。

| 场景 | 结果 |
| --- | --- |
| Messages → Chat：disabled / enabled / adaptive × JSON / SSE | 6/6 返回 HTTP 200、正文 OK 和兼容模式响应头 |
| Messages → Responses：disabled / enabled / adaptive × JSON / SSE | 6/6 返回 HTTP 200、正文 OK 和兼容模式响应头 |
| 两种上游 × JSON / SSE 工具调用首轮，再提交工具结果续轮 | 4/4 完成两次并行工具调用，并返回 TOOL_OK |
| 合计 | **16/16 通过** |

工具续轮测试在 assistant 历史中插入测试用 `thinking`、`redacted_thinking` 和不透明签名，确认这些原生状态不再导致网关拒绝续轮。详细报告位于被 Git 忽略的 `test-results/live-thinking.json`，不记录 API Key、登录密码或完整签名链接。

## 验证边界

兼容模式不保留跨供应商的原生思考预算、过程或签名，不代表实现了完整原生思考转换。真实上游验证覆盖 Messages 客户端到 DeepSeek Chat／Responses；其余跨协议方向及上游原生思考流的过滤由 Workers 运行时构造测试覆盖。没有运行 Claude Code 或 CC Switch 桌面程序本身。

保留已有的 DeepSeek 跨协议工具适配：请求显式关闭该上游原生思考，以避免工具续轮依赖专有推理状态。其他供应商仍可能按自身默认设置进行内部推理。需要完整原生思考能力时，应使用与上游相同协议的链接。详细行为见[协议兼容说明](compatibility.md#思考兼容模式)。
