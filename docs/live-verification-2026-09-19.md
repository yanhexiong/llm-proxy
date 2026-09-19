# 公网验证记录：2026-09-19

本次使用 `test_env` 提供的 DeepSeek Key 和 `deepseek-flash`，在真实 Cloudflare Worker、D1、Static Assets 和自定义域名上执行。报告不含 API Key、管理员密码、Cookie 或完整链接凭证。

## 发布信息

- 管理地址：<https://converter.yahenix.top>
- 项目版本：`0.1.1`
- Worker：`workers-protocol-gateway`
- D1：`workers-protocol-gateway-d1`
- Cloudflare 部署 ID：`5928b941-13e3-4ed6-a6ed-a1763798aa30`
- Worker 版本 ID：`84449406-dcca-4c2a-ab7c-3d69e512d2f9`，流量比例 `100%`
- 发布时刻：`2026-09-19T03:00:06Z`（北京时间 11:00）
- 发布后 `/health`：HTTP 200，`{"status":"ready"}`

## 验证结果

方向按“客户端协议 → 上游协议”记。三种协议为 Chat Completions、Anthropic Messages、OpenAI Responses；请求最终均由 DeepSeek 执行。

| 验证 | 结果 | 检查内容 |
| --- | --- | --- |
| 直接访问三个上游端点 | 3/3 | 验证 Key、模型和各协议基础路径可用 |
| 公网三协议矩阵 | 18/18 | 9 个方向 × 非流式/流式；包含三种同协议透传 |
| 官方 SDK | 18/18 | OpenAI 7.19.0、Anthropic 0.127.0；含 SDK 流汇总后的最终文本 |
| 双工具完整往返 | 18/18 | 9 个方向 × JSON/流式首轮；校验两个不同调用 ID、Beijing/Shanghai 参数、结果回传和最终 TOOL_OK |
| 图片输入 | 9/9 | 程序生成红色 Base64 PNG，经每个方向传入后识别为 RED |
| 输出长度截断 | 12/12 | 六个跨协议方向 × JSON/流式；校验 length/max_tokens/incomplete 状态和结束事件 |
| 公网管理和授权 | 8/8 | 未登录、登录失败限流、同源写入、凭证篡改、上游 401、store:true 拒绝、别名生命周期、注销失效 |
| 公网浏览器 | 2/2 | 桌面/手机：登录、创建别名、生成链接、退出；已检查截图 |
| Playwright 管理界面模拟测试 | 10/10 | 加上复制失败、重新生成、别名更新、退出失败等状态 |
| Workers 运行时测试 | 46/46 | URL、HMAC、D1、请求头隔离、错误、取消、空闲超时、协议和 SSE 回归 |
| doctor | 12/12 | 登录、权限、D1 绑定、迁移、Secret 名称和公网就绪 |

冻结安装、TypeScript 类型检查、Vite 构建、Wrangler dry-run 均通过。初始化与部署已经重复执行，复用了既有 D1 和 Secrets；最初生成的链接继续可用。浏览器和别名生命周期测试创建的临时别名已删除，对应临时链接已撤销；九种方向的直接链接保留，可登录管理后台再次复制。

## 主要修复

1. DeepSeek 跨协议调用关闭默认原生思考，避免签名或推理状态无法回传；同协议原样透传。详细规则见 [兼容性说明](compatibility.md)。
2. 处理 Chat `usage:null`、finish 后独立 usage、延迟工具名和乱序工具索引，等待实际终止帧后结束转换。
3. SSE 改为按需读取，传播取消；错误事件可被客户端读取，避免 HTTP 200 空流。请求头到达后继续监测响应体空闲超时。
4. Responses 接受正常的 `error:null`，保证 delta、done 和最终内容一致，并提供事件序号及正确的截断状态。
5. 修复 Messages 工具选择对象、data URL → Base64 图片、空文本和并行工具历史的合并。
6. 统一输入 token 总量，按 Messages 与 OpenAI 协议各自定义转换缓存字段，修复部分 usage 更新导致的总量错误。
7. 修复部署预检、首次密码摘要迭代数、重复初始化、doctor 占位绑定误报及错误输出丢失。
8. 管理页补齐重新生成、内联 cURL、复制失败和退出失败处理。

## 验证边界和观察

基础矩阵和 SDK 用例显式使用非思考模式，避免测试预算被模型推理耗尽。直接上游测试及早期同协议用例也验证了原生默认思考响应的透传。跨协议原生思考、签名和加密状态仍不属于支持范围。

调试过程中出现过两次测试客户端 90 秒超时。相同请求单独复测约 2.3 秒返回了正确的 `response.incomplete`；最后串行截断复测为 12/12。未确定两次超时的具体来源，不能以最终通过推断所有网络或上游时段均无延迟。网关不自动重试生成请求，默认上游空闲超时为 120 秒；测试 SDK 的自动重试也被关闭。

所有真实上游验证使用本次提供的 DeepSeek 模型和协议兼容端点。图片验证使用一张简单 PNG；大量图片、长上下文和其他供应商的私有扩展仍需各自验证。缓存写入、HTTP 429/500、网络取消等边界主要通过 Workers 运行时模拟测试覆盖。

## 复现

本地保留机器可读报告：`test-results/live-{matrix,sdk,tools,images,truncate,management}.json`；公网浏览器报告和截图位于 `test-results/live-browser/`。这些报告与运行产物不进入版本控制。

```text
pnpm test
pnpm run test:live matrix
pnpm run test:live sdk
pnpm run test:live tools
pnpm run test:live images
pnpm run test:live truncate
pnpm run test:live management
pnpm run doctor
```

真实测试读取 `test_env`、`.gateway-test-admin.json` 和 `.gateway-live-links.json`；这三个文件的本机权限均为 `0600`，已加入 `.gitignore`。重复运行真实测试会产生上游模型费用。
