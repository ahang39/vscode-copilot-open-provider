# Changelog

All notable changes to Open Provider will be documented in this file.

## 0.3.0

- Added a **Context Size** picker option for models whose context window differs from the generic default, so Copilot's context-usage indicator reflects the real window.
- Added **token usage reporting** for streaming responses, so Copilot can show how much context each turn used.
- Fixed the extension icon: the previous `assets/icon.png` was a truncated PNG with a broken checksum, so the packaged icon could fail to decode.

## 0.2.7

Initial public GitHub release.

- Renamed the extension to Open Provider.
- Added generic OpenAI-compatible model discovery.
- Added Copilot Chat and Agent tool-calling support.
- Added image input, reasoning output, and reasoning-effort support.
- Added models.dev capability metadata fallback.
- Added secure API-key storage with VS Code SecretStorage.
- Added handling for host metadata, refusals, malformed tool arguments, and non-standard SSE responses.
