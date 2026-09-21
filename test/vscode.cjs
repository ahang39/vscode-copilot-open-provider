class Text { constructor(value) { this.value = value; } }
class Thinking { constructor(value, id, metadata) { Object.assign(this, { value, id, metadata }); } }
class ToolCall { constructor(callId, name, input) { Object.assign(this, { callId, name, input }); } }
class ToolResult { constructor(callId, content) { Object.assign(this, { callId, content }); } }
class Data { constructor(data, mimeType) { Object.assign(this, { data, mimeType }); } }
class EventEmitter {
  listeners = new Set();
  event = listener => { this.listeners.add(listener); return { dispose: () => this.listeners.delete(listener) }; };
  fire(value) { for (const listener of this.listeners) listener(value); }
  dispose() { this.listeners.clear(); }
}
const settings = { baseUrl: '' };
module.exports = {
  LanguageModelTextPart: Text, LanguageModelThinkingPart: Thinking,
  LanguageModelToolCallPart: ToolCall, LanguageModelToolResultPart: ToolResult,
  LanguageModelDataPart: Data, LanguageModelChatMessageRole: { System: 0, User: 1, Assistant: 2 },
  LanguageModelChatToolMode: { Auto: 1, Required: 2 }, CancellationError: class extends Error {},
  EventEmitter, settings,
  workspace: { getConfiguration: () => ({ get: (key, fallback) => settings[key] ?? fallback }) },
};
