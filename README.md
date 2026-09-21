# Open Chat Bridge

将 **OpenAI 兼容 API** 接入 VS Code Copilot Chat / Agent。可连接 DeepSeek 等公共 API、兼容网关和自托管服务，TypeScript、零运行时依赖。

## 安装与配置

需要 VS Code 1.137+ 和可用的 Copilot Chat。安装 `newapi-copilot-0.2.6.vsix`，完全退出 VS Code 后启动：

```sh
code --enable-proposed-api ahang.newapi-copilot
```

原生 thinking、思考强度菜单与 system 消息使用 `chatProvider`、`languageModelThinkingPart`、`languageModelSystem` 实验 API。扩展不会自行修改系统参数。若要永久启用，可在 **Preferences: Configure Runtime Arguments** 的 `enable-proposed-api` 数组中添加上述扩展 ID，保留其他字段并重启。

运行 **Open Chat Bridge: Configure**，仅输入两个值：

| 配置 | 说明 |
|---|---|
| `baseUrl` | API 基址，包含服务要求的路径前缀 |
| `apiKey` | 对应服务的 Key，加密保存到 VS Code SecretStorage |

基址只填写主机时默认使用 `/v1`；若已有路径，则在该路径后直接追加 `/models` 或 `/chat/completions`，不重复插入版本号。例如 DeepSeek 可填写 `https://api.deepseek.com/v1`，自托管服务可填写 `http://localhost:1234/v1`，自定义网关可填写 `https://example.com/proxy/openai/v1`。

Key 与服务器地址绑定；更换地址后重新 Configure。设置项为 `openChatBridge.baseUrl`，不把 Key 写进 settings.json。单次配置连接一个兼容服务，不管理多账号。

在 Copilot 的 **Manage Models → Open Chat Bridge** 中选择模型。Agent 模式需要模型支持工具调用；本扩展不提供 Tab 补全。

为直接升级旧安装，保留内部扩展 ID `ahang.newapi-copilot`、Provider ID 和历史数据标识；旧 `newapi.baseUrl` 与加密 Key 会自动迁移。它们是升级兼容标识，不限制 API 服务。

## 模型发现与更新

- 启动后自动发现；窗口重新聚焦、每 5 分钟及配置变化时通知 VS Code 重新拉取。
- 命令面板搜索 **Open Chat Bridge: 刷新模型列表 / Refresh Models** 可立即刷新；也可从模型选择器的 **Manage Models → Open Chat Bridge** 管理入口选择 **刷新模型列表**。显示刷新进度、聊天模型数量及工具能力数量；失败会明确提示。
- 每次拉取完整 `/models` 列表；上游使用 `has_more` / `last_id` 游标时，继续请求 `after` 分页，直到结束。重复或无效游标直接报错，不假装已取全。
- 新增、删除模型及能力变化随刷新同步，不内置静态模型表。
- 全部返回条目都会参与发现；明确不支持 Chat Completions 或只输出图片等非文本内容的模型不放入聊天列表。未知模型保留，但工具能力未知时，Copilot 的 Agent 选择器可能不显示它；可在模型管理界面查看。

模型名称、可用性和原始请求 ID 以你的 API 为准。图片、工具、上下文与思考档位优先使用上游元数据；缺失项实时从 `https://models.dev/api.json` 补充。只匿名下载公开目录，不发送 Key、模型列表或聊天内容。

在线查询先匹配完整 ID，再去掉一次 `codex-` / `qoder-` 路由前缀匹配；请求仍使用原始 ID。不做模糊匹配。优先使用在线目录的原厂条目；其他来源必须在能力和限额上达成一致。冲突或未匹配保持未知。在线请求 10 秒超时或失败会在模型悬停说明中标明，随后只采用上游字段，刷新可重试。

可识别上游 `capabilities.imageInput/toolCalling/reasoning`、`modalities.input/output`、`tool_call`、`reasoning`、`reasoning_efforts`、`reasoning_options`、`limit`、`context_length` 等字段。这些扩展元数据不是每个兼容服务都会提供。

## 协议边界

支持 Chat Completions SSE、取消、文本和图片输入、并行工具参数分片、工具结果回传，以及 `reasoning_content` / `reasoning` / `thinking`。`reasoning_details` 在缺失 `index` 时按出现顺序补位，并保留到历史。

历史消息中的宿主元数据（`cache_control` / `stateful_marker` / `thinking` / `context_management` / `phase_data` / `usage` 等 DataPart）不发送给 API；未知部件降级为文本保留，不中断请求。从其他 Provider 切换过来时会带上这些标记，本扩展不会因此失败。

模型拒答（`finish_reason` 正常、`content` 为空、`refusal` 有内容）不算传输失败，refusal 文本作为回答交给 Copilot；只有 refusal 或截断伴随 `content_filter` / `error` / `length` 时才按异常终止。

工具调用与工具结果的配对、调用的 id 与 name 仍会被校验：这些是 Chat Completions 的硬约束，违反会被上游以 400 拒绝，放行只会把明确报错变成远端错误。历史上出现无对应结果的工具调用时，请求会明确失败而不是被静默改写。

思考强度取上游或在线元数据中的全部档位，发送为 `reasoning_effort`；不会为仅支持 token 预算的模型编造档位。工具由 Copilot 执行。非法参数、流截断和 API 错误不会被当成成功；单个工具调用的问题不终止整轮请求。

“OpenAI 兼容”指实现 `/models` 和流式 `/chat/completions` 的服务；不等于所有服务都支持图片、工具或相同的推理参数。Responses-only、厂商原生 Messages 接口不在本扩展范围。在线记录反映模型公开能力，不保证你的网关完整透传；别名如 `Lite`、`Efficient` 无法可靠推断实际模型。

Token 数采用 UTF-8 字节估算，图片按 4096 tokens 估算，非精确 tokenizer。上游和在线目录均无上下文信息时，暂用 32K 上下文、4K 输出估值。

## 开发

```sh
npm ci
npm run compile
npm run package
```

可选 `npm test` 与 `test/host.cjs` 检查协议和扩展宿主；0.2.1 按用户要求未运行测试，仅编译打包。协议检查不能代替实际 Copilot UI 与具体服务的完整验收。

0.2.1 修正工具流合并：按工具索引采用最新非空 ID 和函数名，忽略空字段，只累加参数片段，与 Unify 的 Chat Completions 合并方式一致；最终仍验证 ID 唯一性、工具名称和参数 JSON。

0.2.2 参考 Unify 的错误反馈方式：参数无法解析为 JSON 对象时用 `INVALID_JSON` 保存原参数，让 Copilot 的校验拒绝该次调用并向模型反馈，以便重试。该版本仅在工具 schema 有必填字段时才反馈，其余情况仍报错。

0.2.3 完整对齐 Unify 的 `parseToolArguments` 默认行为：任何无法解析为 JSON 对象的参数一律转为 `{ INVALID_JSON: <原始串> }` 交给 Copilot 校验，不再因单个工具调用而让整个请求失败；工具名白名单与流结构校验保持不变。复跑 `npm test`，7 项通过。

0.2.4 收敛其余过严校验：`finish_reason` 改为只拦截 `content_filter` / `error` / `length`，未知值放行；`reasoning_details` 缺 `index` 时按出现顺序补位而非报错；移除工具名白名单与工具 ID 完整性检查，未知工具、缺失或重复 ID 交给 Copilot 处理，缺失或重复 ID 用随机 UUID 补全。请求不再因上游非标响应中断。`npm test` 7 项通过。

0.2.5 修复输入侧同源问题：转换历史消息时，VS Code 与 Copilot Chat 附加的宿主元数据 DataPart（`cache_control` / `stateful_marker` / `thinking` / `context_management` / `phase_data` / `usage`）不再导致整轮请求失败——这些标记本就属于宿主而非对话内容，直接跳过（同时不计入 token 估算）；模型无已知图片能力时，历史图片降级为占位文本而非报错；其他未识别的部件降级为文本保留，未知附件标注 mime 与字节数。`npm test` 7 项通过。

0.2.6 对齐 Unify 的 refusal 处理：模型拒答（`finish_reason` 正常、`content` 为空、`refusal` 有内容）时把 refusal 文本作为回答发给 Copilot，不再判定为传输失败；只有 refusal 伴随 `content_filter` / `error` / `length` 时仍按异常终止。非 assistant 消息里的 Thinking 部件降级为文本保留，不再中断请求。协议硬约束（tool call 与 tool result 的配对、call 的 id 与 name）保持拦截——违反配对会被上游以 400 拒绝，放行只会把明确报错变成远端错误。`npm test` 7 项与 `test/host.cjs` 宿主检查通过。

核心模块：`extension.ts` 管理 Provider 与刷新；`client.ts` 处理 URL、分页与 SSE；`models.ts` 归一化和补全；`messages.ts`、`stream.ts` 转换消息与响应。

图标：`assets/icon.png`，内置 imagegen 生成。提示词：独立 API 聊天桥接扩展图标，两个圆角几何括号构成连接符号，青绿与米白、深炭背景、居中、无文字或厂商标识。

参考：[VS Code Provider API](https://code.visualstudio.com/api/extension-guides/ai/language-model-chat-provider)、[DeepSeek API](https://api-docs.deepseek.com/)、[models.dev](https://models.dev)。
