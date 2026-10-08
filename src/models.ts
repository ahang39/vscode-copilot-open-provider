import type * as vscode from 'vscode';
import { object, type Json } from './client';

export interface Model extends vscode.LanguageModelChatInformation {
  readonly reasoning: boolean;
  readonly efforts: string[];
}

// Applied when neither the upstream payload nor models.dev describes a model: gateways proxy capable
// models under unrecognized IDs, so assuming the opposite hides working features behind local errors.
const ASSUMED_CONTEXT = 200_000;

function strings(value: unknown): string[] | undefined {
  return Array.isArray(value) && value.every(item => typeof item === 'string') ? [...new Set(value)] : undefined;
}

function positive(...values: unknown[]): number | undefined {
  return values.find(value => typeof value === 'number' && Number.isSafeInteger(value) && value > 0) as number | undefined;
}

function boolean(...values: unknown[]): boolean | undefined {
  return values.find(value => typeof value === 'boolean') as boolean | undefined;
}

function efforts(model: Json): string[] | undefined {
  const direct = strings(model.reasoning_efforts) ?? strings(object(model.capabilities).reasoningEfforts);
  if (direct) return direct;
  const options = model.reasoning_options;
  if (!Array.isArray(options)) return undefined;
  return strings(object(options.find(option => object(option).type === 'effort')).values) ?? [];
}

export function normalizeModelId(id: string): string {
  return id.replace(/^(?:codex|qoder)-/, '');
}

// Context tiers offered in the model picker; each defaults to the tier closest to the model's real window.
const CONTEXT_TIERS = [200_000, 300_000, 500_000, 1_000_000];

function contextTier(context: number): number[] {
  return [...new Set(CONTEXT_TIERS.map(tier => Math.min(tier, context)))].sort((a, b) => a - b);
}

export async function onlineMetadata(signal: AbortSignal): Promise<unknown> {
  const response = await fetch('https://models.dev/api.json', { signal, redirect: 'error', credentials: 'omit' });
  if (!response.ok) throw new Error(`models.dev HTTP ${response.status}`);
  const data: unknown = await response.json();
  if (!Object.values(object(data)).some(value => Object.keys(object(object(value).models)).length)) throw new Error('Invalid models.dev response');
  return data;
}

function lookup(id: string, data: unknown): { model: Json; source: string } {
  const originalProviders = new Set(['openai', 'anthropic', 'google', 'deepseek', 'alibaba', 'moonshotai', 'zhipuai', 'minimax', 'xai', 'mistral']);
  for (const candidate of new Set([id, normalizeModelId(id)])) {
    const matches = Object.entries(object(data)).flatMap(([provider, value]) => {
      const model = object(object(object(value).models)[candidate]);
      return Object.keys(model).length ? [{ provider, model }] : [];
    });
    const originals = matches.filter(match => originalProviders.has(match.provider));
    const choices = originals.length ? originals : matches;
    if (!choices.length) continue;
    const signatures = choices.map(({ model }) => JSON.stringify([model.modalities, model.tool_call, model.reasoning, efforts(model), model.limit]));
    if (new Set(signatures).size > 1) return { model: {}, source: `Conflicting online metadata for ${candidate}; ignored` };
    return { model: choices[0].model, source: `Online metadata: ${choices[0].provider}/${candidate} (gateway support not verified)` };
  }
  return { model: {}, source: 'No online match; using generic capability defaults' };
}

export function discover(payload: unknown, metadata: unknown = {}, metadataError?: string): Model[] {
  const root = object(payload);
  if (root.error || root.success === false || !Array.isArray(root.data)) throw new Error('Invalid Open Provider /v1/models response.');
  const result = new Map<string, Model>();
  for (const value of root.data) {
    const upstream = object(value);
    if (typeof upstream.id !== 'string' || !upstream.id.trim()) throw new Error('Open Provider returned a model without an id.');
    const id = upstream.id;
    const { model: known, source } = lookup(id, metadata);
    const endpoints = strings(upstream.supported_endpoint_types);
    if (endpoints?.length && !endpoints.some(endpoint => ['openai', 'chat-completions', '/v1/chat/completions'].includes(endpoint))) continue;
    const output = strings(object(upstream.modalities).output) ?? strings(object(known.modalities).output);
    if (output && !output.includes('text')) continue;
    const caps = object(upstream.capabilities);
    const input = strings(object(upstream.modalities).input) ?? strings(object(upstream.architecture).input_modalities);
    const imageInput = boolean(caps.imageInput, caps.vision, upstream.vision, input?.includes('image'), strings(object(known.modalities).input)?.includes('image')) ?? true;
    const toolCalling = boolean(caps.toolCalling, caps.tool_calling, upstream.tool_call, known.tool_call) ?? true;
    const upstreamEfforts = efforts(upstream);
    const reasoning = boolean(caps.reasoning, upstream.reasoning, upstreamEfforts ? upstreamEfforts.length > 0 : undefined, known.reasoning) ?? false;
    const levels = (reasoning ? upstreamEfforts ?? efforts(known) ?? [] : []).filter(level => /^[a-z][a-z0-9_-]{0,31}$/.test(level));
    const limit = object(upstream.limit);
    const fallback = object(known.limit);
    const context = positive(upstream.context_length, limit.context, fallback.context) ?? ASSUMED_CONTEXT;
    const maxOutputTokens = positive(upstream.max_output_tokens, limit.output, fallback.output) ?? 4096;
    const maxInputTokens = positive(upstream.max_input_tokens, limit.input, positive(upstream.context_length, limit.context) ? undefined : fallback.input) ?? Math.max(1, context - Math.min(maxOutputTokens, Math.floor(context / 2)));
    const tiers = contextTier(context);
    const nearest = tiers.reduce((best, tier) => Math.abs(tier - context) < Math.abs(best - context) ? tier : best);
    result.set(id, {
      id, name: typeof upstream.name === 'string' ? upstream.name : id, family: id, version: '1', isBYOK: true,
      maxInputTokens, maxOutputTokens, capabilities: { imageInput, toolCalling }, reasoning, efforts: levels,
      detail: 'Open Provider', tooltip: `${id}\nUpstream fields take precedence; ${metadataError ?? source}`,
      ...(levels.length || tiers.length > 1 ? { configurationSchema: { properties: {
        ...(levels.length ? { reasoningEffort: {
          type: 'string', title: 'Thinking Effort', enum: levels, enumItemLabels: levels,
          default: levels.includes('medium') ? 'medium' : levels[0], group: 'navigation',
        } } : {}),
        ...(tiers.length > 1 ? { contextSize: {
          type: 'number', title: 'Context Size', enum: tiers,
          enumItemLabels: tiers.map(tier => tier >= 1_000_000 ? '1M' : `${Math.round(tier / 1000)}K`),
          default: nearest, group: 'tokens',
        } } : {}),
      } } } : {}),
    });
  }
  return [...result.values()];
}
