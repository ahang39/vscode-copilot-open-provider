const assert = require('node:assert/strict');
const { test } = require('node:test');
const { createServer } = require('node:http');
const { once } = require('node:events');
const Module = require('node:module');
const vscode = require('./vscode.cjs');
const original = Module._load;
Module._load = function(id, ...args) { return id === 'vscode' ? vscode : original.call(this, id, ...args); };
const { discover, normalizeModelId } = require('../out/models.js');
const { apiUrl, events } = require('../out/client.js');
const { convertMessages, estimateTokens } = require('../out/messages.js');
const { streamResponse } = require('../out/stream.js');
const { CompatibleChatProvider } = require('../out/extension.js');
Module._load = original;
const { LanguageModelTextPart: Text, LanguageModelThinkingPart: Thinking, LanguageModelToolCallPart: Call, LanguageModelToolResultPart: Result, LanguageModelDataPart: Data } = vscode;
const token = { isCancellationRequested: false, onCancellationRequested: () => ({ dispose() {} }) };
const msg = (role, ...content) => ({ role, content, name: undefined });
const frame = (delta, finish_reason = null) => `data: ${JSON.stringify({ choices: [{ index: 0, delta, finish_reason }] })}\r\n\r\n`;
function sse(text) {
  const bytes = Buffer.from(text);
  return new Response(new ReadableStream({ start(controller) {
    for (const byte of bytes) controller.enqueue(Uint8Array.of(byte));
    controller.close();
  } }), { headers: { 'content-type': 'text/event-stream; charset=utf-8' } });
}

test('URLs preserve deployment prefixes, normalize /v1, reject credentials and fragments', () => {
  assert.equal(apiUrl('https://example.com/proxy/v1/', 'models'), 'https://example.com/proxy/v1/models');
  assert.equal(apiUrl('http://localhost:3000', 'chat/completions'), 'http://localhost:3000/v1/chat/completions');
  for (const url of ['file:///tmp/key', 'https://u:p@example.com', 'https://example.com?a=1', 'https://example.com#x']) assert.throws(() => apiUrl(url, 'models'));
});

test('discovery uses arbitrary upstream model IDs and efforts without a static model catalog', () => {
  const models = discover({ data: [
    { id: 'new-model-never-seen', capabilities: { imageInput: true, toolCalling: true }, reasoning_efforts: ['minimal', 'low', 'medium', 'high'] },
    { id: 'gpt-5.2', capabilities: { imageInput: false, toolCalling: false, reasoning: false } },
    { id: 'custom', reasoning: true, reasoning_efforts: ['low', 'medium', 'high', 'max', 'ultra'], capabilities: { imageInput: true, toolCalling: true }, limit: { input: 10000, output: 2000 } },
    { id: 'gpt-5' }, { id: 'embedding', supported_endpoint_types: ['embeddings'] },
    { id: 'response-only', supported_endpoint_types: ['openai-response'] },
  ] });
  assert.equal(models.length, 4);
  assert.deepEqual(models[0].efforts, ['minimal', 'low', 'medium', 'high']);
  assert.equal(models[0].capabilities.imageInput, true);
  assert.deepEqual(models[1].capabilities, { imageInput: false, toolCalling: false });
  assert.deepEqual(models[1].efforts, []);
  assert.deepEqual(models[2].configurationSchema.properties.reasoningEffort.enum, ['low', 'medium', 'high', 'max', 'ultra']);
  assert.equal(models[2].maxInputTokens, 10000);
  assert.equal(models[3].capabilities.toolCalling, false);
  assert.equal(models[3].capabilities.imageInput, false);
  assert.deepEqual(models[3].efforts, []);
  assert.throws(() => discover({ data: [{}] }));
  assert.throws(() => discover({ success: false, data: [] }));
});

test('SSE handles UTF-8 byte splits, CRLF splits, comments, multiline JSON and EOF', async () => {
  const result = [];
  for await (const event of events(sse(': ping\r\ndata: {\r\ndata: "text":"中文"}\r\n\r\ndata: [DONE]\r\n\r\n'))) result.push(event);
  assert.deepEqual(result, [{ text: '中文' }, '[DONE]']);
  await assert.rejects(async () => { for await (const _ of events(sse('data: {broken}\n\n'))) {} }, /Invalid JSON/);
});

test('online metadata normalizes only routing prefixes, preserves IDs, respects overrides and rejects conflicts', () => {
  const metadata = { openai: { models: { future: { modalities: { input: ['text', 'image'], output: ['text'] }, tool_call: true, reasoning: true, reasoning_options: [{ type: 'effort', values: ['low', 'high', 'ultra'] }] }, image: { modalities: { output: ['image'] } } } } };
  const payload = { data: [{ id: 'codex-future' }, { id: 'qoder-future', capabilities: { imageInput: false }, reasoning_efforts: [] }, { id: 'other-future' }, { id: 'image' }] };
  const models = discover(payload, metadata);
  assert.equal(models.length, 3);
  assert.equal(models[0].id, 'codex-future');
  assert.equal(models[0].capabilities.toolCalling, true);
  assert.deepEqual(models[0].efforts, ['low', 'high', 'ultra']);
  assert.equal(models[1].capabilities.imageInput, false);
  assert.deepEqual(models[1].efforts, []);
  assert.equal(models[2].capabilities.toolCalling, false);
  assert.equal(normalizeModelId('qoder-future'), 'future');
  assert.equal(normalizeModelId('other-future'), 'other-future');
  metadata.anthropic = { models: { future: { tool_call: false } } };
  assert.equal(discover(payload, metadata)[0].capabilities.toolCalling, false);
});

test('stream assembles interleaved tool arguments and thinking, reports malformed arguments for retry, forwards unknown and id-less calls, validates before any tool emission', async () => {
  const out = [];
  const body = frame({ reasoning_content: '先检查' }) + frame({ tool_calls: [
    { index: 0, id: 'a', function: { name: 'read', arguments: '{"path":' } },
    { index: 1, id: 'b', function: { name: 'read', arguments: '{"path":"b"}' } },
  ] }) + frame({ tool_calls: [{ index: 0, function: { arguments: '"a"}' } }] }, 'tool_calls') + 'data: [DONE]\n\n';
  await streamResponse(sse(body), { report: part => out.push(part) });
  assert(out[0] instanceof Thinking);
  assert.deepEqual(out.slice(1).map(call => [call.callId, call.input]), [['a', { path: 'a' }], ['b', { path: 'b' }]]);
  for (const [invalid, expected] of [
    [frame({ tool_calls: [{ index: 0, id: 'a', function: { name: 'partial', arguments: '{' } }] }, 'tool_calls'), [{ INVALID_JSON: '{' }]],
    [frame({ tool_calls: [{ index: 0, id: 'a', function: { name: 'array', arguments: '[1,2]' } }] }, 'tool_calls'), [{ INVALID_JSON: '[1,2]' }]],
    [frame({ tool_calls: [{ index: 0, id: 'a', function: { name: 'missing', arguments: '' } }] }, 'tool_calls'), [{}]],
  ]) {
    const parts = [];
    await streamResponse(sse(invalid), { report: part => parts.push(part) });
    assert.deepEqual(parts.map(part => part.input), expected);
  }
  const forwarded = [];
  await streamResponse(sse(frame({ tool_calls: [
    { index: 0, function: { name: 'unknown', arguments: '{}' } },
    { index: 1, function: { name: 'unknown', arguments: '{}' } },
  ] }, 'tool_calls')), { report: part => forwarded.push(part) });
  assert.deepEqual(forwarded.map(part => [part.name, part.input]), [['unknown', {}], ['unknown', {}]]);
  assert.equal(new Set(forwarded.map(part => part.callId)).size, 2);
  const refused = [];
  await streamResponse(sse(frame({ refusal: 'I cannot help with that.' }, 'stop')), { report: part => refused.push(part) });
  assert.deepEqual(refused.map(part => part.value), ['I cannot help with that.']);
  for (const invalid of [
    frame({ content: 'cut off' }),
    frame({ content: 'partial' }, 'length'),
    'data: {"error":{"message":"upstream failed"}}\n\n',
  ]) {
    const parts = [];
    await assert.rejects(streamResponse(sse(invalid), { report: part => parts.push(part) }));
    assert(!parts.some(part => part instanceof Call));
  }
});

test('message conversion retains system, images, parallel tool results and reasoning state', () => {
  const history = [msg(0, new Text('system')), msg(1, new Text('look'), new Data(Buffer.from('png'), 'image/png')),
    msg(2, new Thinking('thought', undefined, { newapi: { reasoning_details: [{ type: 'reasoning.encrypted', data: 'opaque' }] } }), new Call('a', 'read', {}), new Call('b', 'read', {})),
    msg(1, new Result('a', [new Text('file A'), new Data(Buffer.from('png'), 'image/png')]), new Result('b', [new Text('file B')]), new Text('continue'))];
  const out = convertMessages(history, true);
  assert.equal(out[0].role, 'system');
  assert.equal(out[1].content[1].image_url.url, 'data:image/png;base64,cG5n');
  assert.equal(out[2].reasoning_content, 'thought');
  assert.equal(out[2].reasoning_details[0].data, 'opaque');
  assert.deepEqual(out.slice(3).map(item => item.role), ['tool', 'tool', 'user']);
  const separated = [...history.slice(0, 3), msg(1, history[3].content[0]), msg(1, ...history[3].content.slice(1))];
  assert.deepEqual(convertMessages(separated, true), out);
  assert.equal(convertMessages([history[1]], false)[0].content, 'look[image omitted: this model has no known image support]');
  assert.throws(() => convertMessages([msg(1, new Result('missing', []))], true), /matching call/);
  const hostMarkers = ['cache_control', 'stateful_marker', 'thinking', 'context_management', 'phase_data', 'usage'];
  assert.deepEqual(convertMessages([msg(1, new Text('keep'), ...hostMarkers.map(mime => new Data(Buffer.from('x'), mime)))], true), [{ role: 'user', content: 'keep' }]);
  const unknown = convertMessages([msg(1, new Text('keep'), { mystery: true })], true);
  assert.equal(unknown.length, 1);
  assert.equal(unknown[0].role, 'user');
  assert.match(unknown[0].content, /^keep\[Unsupported message part: \{"mystery":true\}\]$/);
  assert.match(convertMessages([msg(1, new Data(Buffer.from('pdf'), 'application/pdf'))], true)[0].content, /\[Unsupported attachment: application\/pdf, 3 bytes\]/);
  assert.deepEqual(convertMessages([msg(1, new Thinking('stray')), msg(0, new Thinking('system thought'))], true), [{ role: 'user', content: 'stray' }, { role: 'system', content: 'system thought' }]);
  assert.equal(estimateTokens({ role: 1, content: [new Data(Buffer.from('x'.repeat(3000)), 'stateful_marker')], name: undefined }), 8);
  assert(estimateTokens(history[1]) >= 4096);
});

test('real HTTP provider roundtrip: discovery → reasoning/tool request → tool result → final answer, cancellation and redaction', async t => {
  const realFetch = global.fetch;
  let onlineFailure = false;
  t.mock.method(global, 'fetch', (url, options) => {
    if (url !== 'https://models.dev/api.json') return realFetch(url, options);
    assert.equal(options.headers, undefined);
    return Promise.resolve(onlineFailure ? new Response('', { status: 503 }) : Response.json({ openai: { models: { 'new-model': { tool_call: true, reasoning: true, reasoning_options: [{ type: 'effort', values: ['high'] }] } } } }));
  });
  const requests = [];
  let mode = 'normal';
  const server = createServer(async (req, res) => {
    assert.equal(req.headers.authorization, 'Bearer test-secret');
    if (mode === 'error') { res.writeHead(401); res.end('test-secret invalid'); return; }
    if (mode === 'hang') { res.writeHead(200, { 'content-type': 'text/event-stream' }); res.write(': waiting\n\n'); return; }
    if (req.url === '/v1/models') { res.setHeader('content-type', 'application/json'); res.end(JSON.stringify({ data: [{ id: 'codex-new-model' }] })); return; }
    assert.equal(req.url, '/v1/chat/completions');
    let data = ''; for await (const chunk of req) data += chunk;
    const body = JSON.parse(data); requests.push(body);
    res.setHeader('content-type', 'text/event-stream');
    if (body.messages.some(message => message.role === 'tool')) res.end(frame({ content: '完成' }, 'stop') + 'data: [DONE]\n\n');
    else res.end(frame({ reasoning_content: '检查文件' }) + frame({ tool_calls: [{ index: 0, id: 'call-1', function: { name: 'read_file', arguments: '{"path":"a.ts"}' } }] }, 'tool_calls') + 'data: [DONE]\n\n');
  });
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  t.after(() => { server.closeAllConnections(); server.close(); });
  vscode.settings.baseUrl = `http://127.0.0.1:${server.address().port}`;
  const stored = JSON.stringify({ baseUrl: apiUrl(vscode.settings.baseUrl, ''), apiKey: 'test-secret' });
  const provider = new CompatibleChatProvider({ get: async () => stored });
  t.after(() => provider.dispose());
  const [model] = await provider.provideLanguageModelChatInformation({ silent: true }, token);
  const options = { toolMode: 2, modelConfiguration: { reasoningEffort: 'high' }, tools: [{ name: 'read_file', description: 'Read', inputSchema: { type: 'object', properties: { path: { type: 'string' } } } }] };
  const history = [msg(0, new Text('system')), msg(1, new Text('inspect'))];
  const first = [];
  await provider.provideLanguageModelChatResponse(model, history, options, { report: part => first.push(part) }, token);
  history.push(msg(2, ...first), msg(1, new Result('call-1', [new Text('file contents')])));
  const second = [];
  await provider.provideLanguageModelChatResponse(model, history, options, { report: part => second.push(part) }, token);
  assert.equal(requests[0].reasoning_effort, 'high');
  assert.equal(requests[0].model, 'codex-new-model');
  assert.equal(requests[0].tool_choice, 'required');
  assert.equal(requests[1].messages[2].reasoning_content, '检查文件');
  assert.equal(requests[1].messages[3].tool_call_id, 'call-1');
  assert.equal(second[0].value, '完成');
  onlineFailure = true;
  const [unmatched] = await provider.provideLanguageModelChatInformation({ silent: true }, token);
  assert.equal(unmatched.capabilities.toolCalling, false);
  assert.match(unmatched.tooltip, /在线能力获取失败/);
  mode = 'error';
  await assert.rejects(provider.provideLanguageModelChatInformation({ silent: true }, token), error => error.message.includes('[redacted]') && !error.message.includes('test-secret'));
  mode = 'hang';
  const emitter = new vscode.EventEmitter();
  const cancel = { isCancellationRequested: false, onCancellationRequested: emitter.event };
  const pending = provider.provideLanguageModelChatResponse(model, [msg(1, new Text('wait'))], options, { report() {} }, cancel);
  setTimeout(() => { cancel.isCancellationRequested = true; emitter.fire(); }, 50);
  await assert.rejects(pending, vscode.CancellationError);
  vscode.settings.baseUrl = 'https://different-server.invalid';
  assert.deepEqual(await provider.provideLanguageModelChatInformation({ silent: true }, token), []);
});
