const assert = require('node:assert/strict');
const { createServer } = require('node:http');
const { once } = require('node:events');
const vscode = require('vscode');

exports.run = async function() {
  const extension = vscode.extensions.getExtension('ahang.newapi-copilot');
  assert(extension, 'Extension manifest loaded');
  await extension.activate();
  assert(extension.isActive, 'Production extension activated with proposed APIs');
  assert.equal(typeof vscode.LanguageModelThinkingPart, 'function');
  assert((await vscode.commands.getCommands()).includes('openChatBridge.configure'));
  const { CompatibleChatProvider } = require('../out/extension.js');
  const captured = [];
  const server = createServer(async (req, res) => {
    if (req.url === '/v1/models') {
      res.setHeader('content-type', 'application/json');
      res.end(JSON.stringify({ data: [{ id: 'new-model', capabilities: { imageInput: true, toolCalling: true }, reasoning_efforts: ['minimal', 'low', 'medium', 'high'] }] }));
      return;
    }
    let data = ''; for await (const chunk of req) data += chunk;
    captured.push(JSON.parse(data));
    res.setHeader('content-type', 'text/event-stream');
    const toolRound = captured.length === 1;
    const chunks = toolRound ? [
      { delta: { reasoning_content: '检查输入' } },
      { delta: { tool_calls: [{ index: 0, id: 'native-call', function: { name: 'read_file', arguments: '{"path":"README.md"}' } }] }, finish_reason: 'tool_calls' },
    ] : [{ delta: { content: '已读取' }, finish_reason: 'stop' }];
    for (const chunk of chunks) res.write(`data: ${JSON.stringify({ choices: [{ index: 0, ...chunk }] })}\n\n`);
    res.end('data: [DONE]\n\n');
  });
  const cancellation = new vscode.CancellationTokenSource();
  const provider = new CompatibleChatProvider({ get: async () => JSON.stringify({ baseUrl: `http://127.0.0.1:${server.address().port}/v1/`, apiKey: 'host-test-key' }) });
  try {
    server.listen(0, '127.0.0.1'); await once(server, 'listening');
    await vscode.workspace.getConfiguration('openChatBridge').update('baseUrl', `http://127.0.0.1:${server.address().port}`, vscode.ConfigurationTarget.Global);
    const [model] = await provider.provideLanguageModelChatInformation({ silent: true }, cancellation.token);
    assert.deepEqual(model.configurationSchema.properties.reasoningEffort.enum, ['minimal', 'low', 'medium', 'high']);
    const options = { toolMode: vscode.LanguageModelChatToolMode.Auto, modelConfiguration: { reasoningEffort: 'high' }, tools: [{ name: 'read_file', description: 'Read a file', inputSchema: { type: 'object', properties: { path: { type: 'string' } } } }] };
    const history = [
      { role: vscode.LanguageModelChatMessageRole.System, content: [new vscode.LanguageModelTextPart('You are an agent.')], name: undefined },
      { role: vscode.LanguageModelChatMessageRole.User, content: [new vscode.LanguageModelTextPart('Read the file.'), vscode.LanguageModelDataPart.image(Buffer.from('test'), 'image/png')], name: undefined },
      { role: vscode.LanguageModelChatMessageRole.Assistant, content: [new vscode.LanguageModelTextPart('Earlier answer from another provider.')], name: undefined },
      { role: vscode.LanguageModelChatMessageRole.User, content: [new vscode.LanguageModelTextPart('Switched providers, continue.'), ...['cache_control', 'stateful_marker', 'thinking', 'context_management', 'phase_data', 'usage'].map(mime => new vscode.LanguageModelDataPart(Buffer.from('x'), mime)), new vscode.LanguageModelDataPart(Buffer.from('pdf'), 'application/pdf')], name: undefined },
    ];
    const first = [];
    await provider.provideLanguageModelChatResponse(model, history, options, { report: part => first.push(part) }, cancellation.token);
    assert(first[0] instanceof vscode.LanguageModelThinkingPart);
    assert(first[1] instanceof vscode.LanguageModelToolCallPart);
    history.push({ role: vscode.LanguageModelChatMessageRole.Assistant, content: first, name: undefined });
    history.push({ role: vscode.LanguageModelChatMessageRole.User, content: [new vscode.LanguageModelToolResultPart('native-call', [new vscode.LanguageModelTextPart('Hello')])], name: undefined });
    const second = [];
    await provider.provideLanguageModelChatResponse(model, history, options, { report: part => second.push(part) }, cancellation.token);
    assert.equal(second[0].value, '已读取');
    assert.equal(captured[1].messages[4].reasoning_content, '检查输入');
    assert.equal(captured[0].messages[1].content[1].image_url.url, 'data:image/png;base64,dGVzdA==');
    assert.equal(captured[0].messages.length, 4);
    assert.equal(captured[0].messages[2].content, 'Earlier answer from another provider.');
    assert.equal(captured[0].messages[3].content, 'Switched providers, continue.[Unsupported attachment: application/pdf, 3 bytes]');
    assert(!JSON.stringify(captured[0]).includes('stateful_marker'));
    assert(!JSON.stringify(captured[0]).includes('cache_control'));
    console.log('PASS: production activation, native VS Code message classes, images, reasoning effort, host metadata DataParts from another provider, unknown attachment, two-round Agent protocol.');
  } finally {
    provider.dispose(); cancellation.dispose(); server.closeAllConnections(); server.close();
  }
};
