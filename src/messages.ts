import * as vscode from 'vscode';
import { object, type Json } from './client';

type Content = { type: 'text'; text: string } | { type: 'image_url'; image_url: { url: string } };

// Metadata VS Code and Copilot Chat attach to history as data parts. It belongs to the host, not to the conversation.
const METADATA_MIME_TYPES = new Set(['cache_control', 'stateful_marker', 'thinking', 'context_management', 'phase_data', 'usage']);

function stringify(value: unknown): string {
  try { return JSON.stringify(value) ?? String(value); } catch { return String(value); }
}

function content(part: unknown, images: boolean): Content | undefined {
  if (part instanceof vscode.LanguageModelTextPart) return { type: 'text', text: part.value };
  if (part instanceof vscode.LanguageModelDataPart) {
    if (METADATA_MIME_TYPES.has(part.mimeType)) return undefined;
    if (part.mimeType.startsWith('image/')) {
      if (!images) return { type: 'text', text: `[image omitted: this model has no known image support]` };
      return { type: 'image_url', image_url: { url: `data:${part.mimeType};base64,${Buffer.from(part.data).toString('base64')}` } };
    }
    if (part.mimeType.startsWith('text/') || part.mimeType === 'application/json') return { type: 'text', text: new TextDecoder().decode(part.data) };
    return { type: 'text', text: `[Unsupported attachment: ${part.mimeType}, ${part.data.byteLength} bytes]` };
  }
  // Forward-compatible fallback: an unrecognized part degrades to text instead of failing the whole request.
  return { type: 'text', text: `[Unsupported message part: ${stringify(part)}]` };
}

function compact(parts: Content[]): string | Content[] {
  return parts.every(part => part.type === 'text') ? parts.map(part => part.text).join('') : parts;
}

export function convertMessages(messages: readonly vscode.LanguageModelChatRequestMessage[], images: boolean): Json[] {
  const converted: Json[] = [];
  const pending = new Set<string>();
  let deferred: Content[] = [];
  for (const message of messages) {
    const role = message.role === vscode.LanguageModelChatMessageRole.User ? 'user' : message.role === vscode.LanguageModelChatMessageRole.Assistant ? 'assistant' : message.role === vscode.LanguageModelChatMessageRole.System ? 'system' : undefined;
    if (!role) throw new Error('Unsupported Copilot message role.');
    if (pending.size && (role !== 'user' || !message.content.some(part => part instanceof vscode.LanguageModelToolResultPart))) throw new Error('Tool results must precede the next message.');
    const parts: Content[] = [];
    const calls: Json[] = [];
    let reasoning = '';
    const details: unknown[] = [];
    for (const part of message.content) {
      if (part instanceof vscode.LanguageModelToolResultPart) {
        if (role !== 'user' || !pending.delete(part.callId)) throw new Error('Tool result has no matching call.');
        const result = part.content.map(item => content(item, images)).filter(item => item !== undefined);
        const attachments = result.filter(item => item.type === 'image_url');
        converted.push({ role: 'tool', tool_call_id: part.callId, content: compact(result.filter(item => item.type === 'text')) || (attachments.length ? '(image result follows)' : '[no content]') });
        for (const image of attachments) {
          parts.push({ type: 'text', text: `Image from tool call ${part.callId}:` }, image);
        }
      } else if (part instanceof vscode.LanguageModelToolCallPart) {
        if (role !== 'assistant' || !part.callId || !part.name || pending.has(part.callId)) throw new Error('Invalid tool call in history.');
        calls.push({ id: part.callId, type: 'function', function: { name: part.name, arguments: JSON.stringify(part.input) } });
        pending.add(part.callId);
      } else if (part instanceof vscode.LanguageModelThinkingPart) {
        const text = Array.isArray(part.value) ? part.value.join('') : part.value;
        // Reasoning belongs to the assistant turn; thinking that arrives on another role is preserved as text rather than failing the request.
        if (role !== 'assistant') {
          if (text) parts.push({ type: 'text', text });
          continue;
        }
        reasoning += text;
        const raw = object(part.metadata?.openProvider).reasoning_details;
        if (Array.isArray(raw)) details.push(...raw);
      } else {
        const item = content(part, images);
        if (item) parts.push(item);
      }
    }
    if (role === 'user') {
      parts.unshift(...deferred);
      deferred = [];
      if (pending.size) { deferred = parts; continue; }
    }
    if (parts.length || calls.length || reasoning || details.length) {
      converted.push({
        role, content: parts.length ? compact(parts) : null,
        ...(message.name ? { name: message.name } : {}),
        ...(calls.length ? { tool_calls: calls } : {}),
        ...(reasoning ? { reasoning_content: reasoning } : {}),
        ...(details.length ? { reasoning_details: details } : {}),
      });
    }
  }
  if (pending.size) throw new Error('Missing tool results in Copilot history.');
  return converted;
}

export function estimateTokens(text: string | vscode.LanguageModelChatRequestMessage): number {
  if (typeof text === 'string') return Math.ceil(Buffer.byteLength(text, 'utf8') / 3);
  let count = 8;
  for (const part of text.content) {
    if (part instanceof vscode.LanguageModelDataPart && METADATA_MIME_TYPES.has(part.mimeType)) continue;
    if (part instanceof vscode.LanguageModelDataPart && part.mimeType.startsWith('image/')) count += 4096;
    else if (part instanceof vscode.LanguageModelToolResultPart) {
      count += estimateTokens({ role: vscode.LanguageModelChatMessageRole.User, content: part.content, name: undefined });
    } else count += estimateTokens(JSON.stringify(part) ?? '');
  }
  return count;
}
