[English](README.md) | **简体中文**

# Open Provider

**为 VS Code Copilot Chat 与 Agent 接入任意 OpenAI-compatible 模型。**

Open Provider 会从你配置的 API 自动发现模型，将它们注册到 VS Code 的模型选择器，并把 Chat / Agent 请求直接发送到目标服务。它不绑定具体厂商，可用于 DeepSeek、NewAPI / OneAPI、LiteLLM、自托管网关及其他兼容 OpenAI Chat Completions 协议的服务。

## 功能

- 自动通过 `/models` 发现 OpenAI-compatible 模型
- 原生接入 VS Code Copilot Chat 与 Agent
- 支持工具调用、并行工具调用流和工具结果回传
- 支持图片输入
- 支持 reasoning / thinking 内容
- 支持可配置的 `reasoning_effort`
- 动态识别模型能力，并可通过 [models.dev](https://models.dev) 补全缺失元数据
- API Key 保存在 VS Code SecretStorage 中
- 无中转服务器、无运行时依赖

## 当前状态

Open Provider 目前仍依赖部分 VS Code proposed API，用于 System 消息、Thinking 内容和模型配置。

因此当前版本适合：

- GitHub 开源
- 通过 GitHub Releases 分发 VSIX
- 本地或团队内部使用

当前不适合发布到 VS Code Marketplace。VS Code 官方推荐在 **VS Code Insiders** 中使用 proposed API。

## 环境要求

- VS Code 1.137 或更高版本
- Copilot Chat
- 一个实现以下接口的 OpenAI-compatible 服务：
  - `GET /models`
  - 流式 `POST /chat/completions`

## 安装

从 [GitHub Releases](https://github.com/ahang39/vscode-copilot-open-provider/releases) 下载最新版 `.vsix`，或者自行构建：

```bash
npm ci
npm run package
```

安装 `open-provider-<version>.vsix` 后，以启用 proposed API 的方式启动 VS Code：

```bash
code-insiders --enable-proposed-api ahang.open-provider
```

也可以打开 **Preferences: Configure Runtime Arguments**，在 `enable-proposed-api` 数组中加入：

```text
ahang.open-provider
```

然后完整重启 VS Code。

## 配置

运行命令：

**Open Provider: Configure**

然后填写：

| 配置 | 说明 |
| --- | --- |
| `baseUrl` | OpenAI-compatible API 基地址，可包含自定义路径前缀 |
| `apiKey` | API Key，安全保存在 VS Code SecretStorage 中 |

例如：

```text
https://api.deepseek.com/v1
http://localhost:1234/v1
https://example.com/proxy/openai/v1
```

如果只填写主机地址，Open Provider 默认使用 `/v1`。如果 URL 已包含路径，则会直接在该路径后追加 `/models` 与 `/chat/completions`。

配置完成后，在 **Manage Models → Open Provider** 中选择希望在 Copilot 中使用的模型。

## 模型发现与能力识别

Open Provider 优先信任 API `/models` 返回的模型信息，并支持常见的能力字段，包括：

- 图片输入
- 工具调用
- reasoning / thinking
- 上下文长度
- 最大输出长度
- reasoning effort

如果上游没有提供完整能力信息，Open Provider 可以匿名请求公开的 `https://models.dev/api.json` 目录进行补全。

该请求**不会发送**你的：

- API Key
- 模型列表
- Prompt
- 聊天内容

对于无法识别的自定义模型 ID，Open Provider 仍会尽量保持模型可用，避免因为本地缺少静态模型表而把实际可工作的模型排除在 Agent 模式之外。

## 协议支持

当前支持：

- Server-Sent Events（SSE）
- 文本与图片输入
- system / user / assistant / tool 消息
- 并行工具调用
- 工具结果回传
- `reasoning_content`
- `reasoning`
- `thinking`
- `reasoning_effort`

Open Provider 当前面向 **Chat Completions** 协议。

暂不支持：

- Responses-only API
- 各厂商原生 Messages API

Token 数量目前为估算值，不是具体模型 tokenizer 的精确结果。

## 隐私

聊天请求会直接从 VS Code 发往你配置的 API 地址。

Open Provider：

- 不运行中转服务器
- 不收集 telemetry
- 不上传 API Key
- 不上传模型列表、Prompt 或聊天内容

除你主动配置的 API 服务外，唯一可选的第三方网络请求是匿名访问 models.dev 的公开模型元数据。

## 开发

```bash
npm ci
npm test
npm run package
```

测试覆盖：

- URL 规范化
- 模型发现
- SSE 解析
- 消息转换
- reasoning / thinking
- 工具调用
- 请求取消
- API Key 错误信息脱敏

## License

MIT，见 [LICENSE](LICENSE)。

项目中包含少量来自 Microsoft VS Code 的 proposed API 类型声明，原项目采用 MIT License，详见 [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md)。
