# 协议兼容性、限制和归属

## 实现边界

网关提供三种协议适配器：Anthropic Messages（`messages`）、OpenAI Responses（`responses`）和 OpenAI Chat Completions（`chat`）。六种跨协议方向和三种同协议透传共用链接授权、上游地址解析和 SSE 流处理。

适配器以内部内容块、工具调用和用量类型表达请求/响应，再由目标协议编码。模型名称原样传给上游；网关不保存对话正文、上游 API Key 或跨协议服务端会话。

## 支持矩阵

| 能力 | 同协议透传 | 跨协议转换 | 处理方式 |
| --- | --- | --- | --- |
| 多轮文本、system/developer/instructions | 保留原 JSON | 在可表达字段间映射 | 保留消息顺序 |
| 非流式响应 | 原样透传 | 支持 | 单个生成结果 |
| SSE 流 | 原样透传 | 支持增量文本、工具参数和结束事件 | 每请求独立状态机 |
| 文本、图片 URL、Base64 图片 | 原样透传 | 支持首版范围 | 网关不主动下载图片 |
| 工具定义、调用 ID、参数、结果 | 原样透传 | 支持常见函数工具和并行调用 | 无法表达时返回协议错误 |
| 采样参数、最大输出、停止原因、用量 | 原样透传 | 按目标协议映射 | 缓存读/写用量不混成普通输入 |
| `n > 1` | 由上游决定 | 拒绝 | 首版只支持一个生成结果 |
| `previous_response_id`、`store:true`、后台任务 | 由上游决定 | 拒绝 | 跨协议不伪造服务端状态 |
| 原生搜索、代码执行、加密推理签名 | 由上游决定 | 拒绝或原样透传 | 不静默丢失关键语义 |

无法表达的关键参数、内容块或工具类型应返回包含字段位置和原因的客户端协议错误，而不是静默删除。请求已经开始流式输出后，上游错误通过目标协议可表达的错误事件或连接异常结束传播，不补造成功事件。

## URL 和认证

代理路径的协议段由链接声明固定，端点不匹配时返回明确错误，不猜测转换方向。上游 Base URL 可带 `/v1` 或 `/api/v1` 等公共前缀，网关只追加目标协议路径，不自动补第二个 `/v1`。上游地址不能带用户名密码、查询参数或 fragment。

客户端的 `Authorization` 或 `x-api-key` 按上游协议转换；管理员 Cookie 和链接凭证不会发送给上游。默认不自动重试生成请求，也不自动跟随重定向，以免重复调用或把凭据带到其他地址。

## 流式和错误约定

SSE 解析必须能处理跨网络分块的 UTF-8、多个事件合并、延迟到达的工具名/参数、空结束事件和意外中断。Responses 的增量和 `done` 事件、Messages 的内容块起止、Chat 的 delta/finish/usage/`[DONE]` 顺序均以对应客户端协议为准。上游 HTTP 错误保留状态码，并尽可能保留 `Retry-After` 等有效信息。

## DeepSeek 兼容配置

DeepSeek 的 `deepseek-flash` 默认开启原生思考模式。思考签名和原生推理状态不在本项目跨协议可转换范围内，工具续轮还可能要求原样回传推理内容。因此，访问 `api.deepseek.com` 的跨协议请求会显式关闭上游思考：Chat/Messages 发送 `thinking: {type: "disabled"}`，Responses 发送 `reasoning: {effort: "none"}`。同协议请求保留全部原始字段和上游默认行为；显式要求跨协议原生思考仍返回兼容性错误。该适配不改变模型名称，也不作用于其他上游域名。

DeepSeek 上游在生成器中的基础地址：Chat 和 Responses 填 `https://api.deepseek.com`；Messages 填 `https://api.deepseek.com/anthropic/v1`。后者包含 `/v1`，因为网关只追加 `messages`，不同于 Anthropic SDK 自行追加 `/v1/messages`。

来源：[DeepSeek 思考模式](https://api-docs.deepseek.com/guides/thinking_mode)、[Anthropic 协议兼容](https://api-docs.deepseek.com/guides/anthropic_api)、[Responses 协议兼容](https://api-docs.deepseek.com/guides/responses_api)。

## 参考项目和许可证边界

设计阶段对照了以下公开项目的字段映射和流式处理思路；本仓库记录本轮参考快照：

- CLIProxyAPI HEAD `05391d7b72cb09bc6a7087a57f58ba9a58b963ff`
- sub2api HEAD `efe9aab1e4ec89a42ba45e8dac20e882c5409a6a`

本实现是独立的 TypeScript 重写，没有直接移植上述项目源码，也不把它们的内部实现当作运行时依赖。若未来复制任何受许可证约束的代码片段，必须在对应源码、NOTICE 和发布说明中保留原项目许可证与归属；仅参考公开协议行为、字段名称或测试场景不等于复制实现。

## 不保证的行为

上游私有扩展字段、未经文档化的 SSE 事件、服务端保存的会话状态、搜索/代码执行结果、加密思考签名和超出表格范围的多结果请求不属于首版兼容承诺。升级时应使用模拟上游测试和实际 SDK 冒烟测试确认行为，不要仅以 HTTP 200 作为兼容结论。
