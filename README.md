[English](README.md) | [简体中文](README.zh-CN.md)

# Open Provider

**OpenAI-compatible model provider for VS Code Copilot Chat and Agent.**

Open Provider discovers models from your API, registers them in the VS Code model picker, and forwards chat and agent requests directly to the configured endpoint. It is provider-agnostic and works with services such as DeepSeek, NewAPI/OneAPI, LiteLLM, self-hosted gateways, and other compatible APIs.

## Features

- OpenAI-compatible `/models` discovery and streaming `/chat/completions`
- Native VS Code Copilot Chat and Agent integration
- Tool calling, parallel tool-call streaming, and tool results
- Image input
- Reasoning/thinking content and configurable reasoning effort
- Dynamic model capability detection with optional metadata fallback from [models.dev](https://models.dev)
- API keys stored in VS Code SecretStorage
- No proxy server and no runtime dependencies

## Status

Open Provider currently depends on VS Code proposed APIs for system messages, thinking parts, and model configuration. The repository is suitable for public GitHub and VSIX distribution, but the extension should not be published to the VS Code Marketplace while those proposed API dependencies remain.

VS Code Insiders is the officially supported environment for proposed APIs.

## Requirements

- VS Code 1.137 or newer
- Copilot Chat
- An OpenAI-compatible service that implements:
  - `GET /models`
  - streaming `POST /chat/completions`

## Install

Download the latest `.vsix` from [GitHub Releases](https://github.com/ahang39/vscode-copilot-open-provider/releases), or build it locally:

```bash
npm ci
npm run package
```

Install `open-provider-<version>.vsix`, then launch VS Code with the proposed APIs enabled:

```bash
code-insiders --enable-proposed-api ahang.open-provider
```

You can also add `ahang.open-provider` to the `enable-proposed-api` array in **Preferences: Configure Runtime Arguments**.

## Configure

Run **Open Provider: Configure** and enter:

| Setting | Description |
| --- | --- |
| `baseUrl` | OpenAI-compatible API base URL, including any required path prefix |
| `apiKey` | API key stored securely in VS Code SecretStorage |

Examples:

```text
https://api.deepseek.com/v1
http://localhost:1234/v1
https://example.com/proxy/openai/v1
```

A bare host defaults to `/v1`. If the URL already contains a path, Open Provider appends `/models` and `/chat/completions` to that path.

After configuration, open **Manage Models → Open Provider** and select the models you want to use.

## Model discovery

Open Provider treats the API response as the source of truth. It supports common capability fields for image input, tool calling, reasoning, context limits, and reasoning effort.

If capability metadata is missing, Open Provider can anonymously fetch the public catalog at `https://models.dev/api.json`. This request does not include your API key, model list, prompts, or chat content.

Unknown models remain usable. When neither the upstream API nor models.dev describes a model, Open Provider uses conservative generic limits while assuming image and tool support so custom gateway model IDs are not hidden from Agent mode.

## Protocol notes

Open Provider supports:

- Server-Sent Events (SSE)
- text and image input
- system, user, assistant, and tool messages
- parallel tool calls
- tool results
- `reasoning_content`, `reasoning`, and `thinking`
- `reasoning_effort`

It targets the Chat Completions protocol. Responses-only APIs and vendor-native message APIs are not supported.

Token counts are estimates rather than model-specific tokenizer results.

## Privacy

Chat requests go directly from VS Code to the API endpoint you configure. Open Provider does not operate a relay service and does not collect telemetry.

The only optional third-party network request is the anonymous public model metadata lookup from models.dev.

## Development

```bash
npm ci
npm test
npm run package
```

The test suite covers URL normalization, model discovery, SSE parsing, message conversion, reasoning, tool calls, cancellation, and API-key redaction.

## License

MIT. See [LICENSE](LICENSE).

Minimal VS Code proposed API declarations are derived from Microsoft VS Code sources under the MIT License. See [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md).
