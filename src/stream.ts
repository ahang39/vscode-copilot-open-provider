import { randomUUID } from 'node:crypto';
import * as vscode from 'vscode';
import { events, object, type Json } from './client';

export type ResponsePart = vscode.LanguageModelResponsePart | vscode.LanguageModelThinkingPart;

const ABNORMAL_FINISH_REASONS = new Set(['content_filter', 'error', 'length']);

export async function streamResponse(response: Response, progress: vscode.Progress<ResponsePart>): Promise<void> {
  const calls = new Map<number, { id: string; name: string; args: string }>();
  const details = new Map<number, Json>();
  let finished = false;
  let received = false;
  let reasoningSeen = false;
  for await (const event of events(response)) {
    if (event === '[DONE]') { finished = true; break; }
    const chunk = object(event);
    if (chunk.error) throw new Error(`Open Provider stream error: ${String(object(chunk.error).message ?? 'unknown error')}`);
    if (!Array.isArray(chunk.choices)) throw new Error('Open Provider stream has no choices.');
    for (const value of chunk.choices) {
      const choice = object(value);
      if (choice.index !== undefined && choice.index !== 0) continue;
      const delta = object(choice.delta);
      const reasoning = delta.reasoning_content ?? delta.reasoning ?? delta.thinking;
      if (typeof reasoning === 'string' && reasoning) {
        progress.report(new vscode.LanguageModelThinkingPart(reasoning));
        received = true;
        reasoningSeen = true;
      }
      if (Array.isArray(delta.reasoning_details)) {
        for (const raw of delta.reasoning_details) {
          const detail = object(raw);
          const index = Number.isInteger(detail.index) ? detail.index as number : details.size;
          const merged: Json = { ...details.get(index), ...detail, index };
          for (const key of ['text', 'summary', 'data', 'signature']) {
            if (typeof detail[key] === 'string') merged[key] = String(details.get(index)?.[key] ?? '') + detail[key];
          }
          details.set(index, merged);
        }
      }
      if (typeof delta.content === 'string' && delta.content) {
        progress.report(new vscode.LanguageModelTextPart(delta.content));
        received = true;
      }
      if (typeof delta.refusal === 'string' && delta.refusal) {
        // A refusal is the model's answer, not a transport failure; surface it instead of failing the turn.
        progress.report(new vscode.LanguageModelTextPart(delta.refusal));
        received = true;
      }
      if (Array.isArray(delta.tool_calls)) {
        for (const raw of delta.tool_calls) {
          const call = object(raw);
          if (!Number.isInteger(call.index) || Number(call.index) < 0) continue;
          const index = call.index as number;
          const current = calls.get(index) ?? { id: '', name: '', args: '' };
          if (typeof call.id === 'string' && call.id) current.id = call.id;
          const fn = object(call.function);
          if (typeof fn.name === 'string' && fn.name) current.name = fn.name;
          if (typeof fn.arguments === 'string') current.args += fn.arguments;
          if (current.args.length > 1024 * 1024 || calls.size > 1024) throw new Error('Tool call exceeds safety limits.');
          calls.set(index, current);
        }
      }
      if (choice.finish_reason) {
        if (ABNORMAL_FINISH_REASONS.has(String(choice.finish_reason))) throw new Error(`Open Provider response incomplete: ${String(choice.finish_reason)}.`);
        finished = true;
      }
    }
  }
  if (!finished) throw new Error('Open Provider stream ended before completion.');
  if (details.size) {
    const raw = [...details.values()];
    const display = reasoningSeen ? '' : raw.map(detail => detail.text ?? detail.summary ?? '').join('');
    progress.report(new vscode.LanguageModelThinkingPart(display, undefined, { openProvider: { reasoning_details: raw } }));
    received = true;
  }
  const complete: vscode.LanguageModelToolCallPart[] = [];
  const ids = new Set<string>();
  for (const call of calls.values()) {
    if (!call.name) continue;
    if (!call.id || ids.has(call.id)) call.id = randomUUID();
    let input: object;
    try {
      const parsed: unknown = JSON.parse(call.args.trim() || '{}');
      if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('Tool arguments must be an object.');
      input = parsed;
    } catch {
      // Hand malformed arguments to Copilot instead of failing the request; schema validation rejects them and the model can retry.
      input = { INVALID_JSON: call.args };
    }
    ids.add(call.id);
    complete.push(new vscode.LanguageModelToolCallPart(call.id, call.name, input));
  }
  if (!received && !complete.length) throw new Error('Open Provider returned an empty response.');
  for (const call of complete) progress.report(call);
}
