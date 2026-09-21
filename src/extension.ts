import * as vscode from 'vscode';
import { apiUrl, listModels, object, redact, request, type Json } from './client';
import { discover, onlineMetadata, type Model } from './models';
import { convertMessages, estimateTokens } from './messages';
import { streamResponse, type ResponsePart } from './stream';

export class CompatibleChatProvider implements vscode.LanguageModelChatProvider<Model>, vscode.Disposable {
  private readonly changed = new vscode.EventEmitter<void>();
  readonly onDidChangeLanguageModelChatInformation = this.changed.event;

  constructor(private readonly secrets: vscode.SecretStorage) {}

  refresh(): void { this.changed.fire(); }
  dispose(): void { this.changed.dispose(); }

  async manage(): Promise<void> {
    const selected = await vscode.window.showQuickPick([
      { label: '$(refresh) 刷新模型列表', description: '重新拉取 API 模型与在线能力', action: 'refresh' },
      { label: '$(settings-gear) 配置 API', description: '设置 baseUrl 和 apiKey', action: 'configure' },
    ], { title: 'Open Chat Bridge', placeHolder: '管理模型与连接' });
    if (selected?.action === 'refresh') await this.refreshModels();
    if (selected?.action === 'configure') await this.configure();
  }

  async refreshModels(): Promise<void> {
    try {
      const models = await vscode.window.withProgress({
        location: vscode.ProgressLocation.Notification, title: 'Open Chat Bridge：正在刷新模型列表…', cancellable: true,
      }, async (_progress, token) => {
        if (!await this.credentials()) throw new Error('请先运行 Open Chat Bridge: Configure 配置 API。');
        return this.provideLanguageModelChatInformation({ silent: true }, token);
      });
      this.refresh();
      const tools = models.filter(model => model.capabilities.toolCalling).length;
      const incomplete = models.some(model => model.tooltip?.includes('在线能力获取失败'));
      const message = `已拉取 ${models.length} 个聊天模型，其中 ${tools} 个支持工具调用。${incomplete ? '在线能力获取失败，仅采用 API 元数据。' : ''}`;
      if (incomplete) await vscode.window.showWarningMessage(message);
      else await vscode.window.showInformationMessage(message);
    } catch (error) {
      if (!(error instanceof vscode.CancellationError)) await vscode.window.showErrorMessage(error instanceof Error ? error.message : String(error));
    }
  }

  async configure(): Promise<void> {
    const baseUrl = await vscode.window.showInputBox({
      title: 'Open Chat Bridge — baseUrl', prompt: 'OpenAI-compatible API base URL (include any API path prefix)',
      value: vscode.workspace.getConfiguration('openChatBridge').get<string>('baseUrl', ''),
      ignoreFocusOut: true,
      validateInput: value => { try { apiUrl(value, 'models'); return undefined; } catch { return 'Enter a valid HTTP(S) server URL.'; } },
    });
    if (baseUrl === undefined) return;
    const apiKey = await vscode.window.showInputBox({ title: 'Open Chat Bridge — apiKey', password: true, ignoreFocusOut: true, prompt: 'Stored in VS Code SecretStorage', validateInput: value => value.trim() ? undefined : 'apiKey is required.' });
    if (apiKey === undefined) return;
    await this.secrets.store('openChatBridge.credentials', JSON.stringify({ baseUrl: apiUrl(baseUrl, ''), apiKey: apiKey.trim() }));
    await vscode.workspace.getConfiguration('openChatBridge').update('baseUrl', baseUrl.trim(), vscode.ConfigurationTarget.Global);
    this.refresh();
  }

  private async credentials(): Promise<{ baseUrl: string; apiKey: string } | undefined> {
    const baseUrl = vscode.workspace.getConfiguration('openChatBridge').get<string>('baseUrl', '');
    const stored = await this.secrets.get('openChatBridge.credentials');
    if (!baseUrl || !stored) return undefined;
    const credentials = object(JSON.parse(stored));
    if (credentials.baseUrl !== apiUrl(baseUrl, '') || typeof credentials.apiKey !== 'string' || !credentials.apiKey) return undefined;
    return { baseUrl, apiKey: credentials.apiKey };
  }

  private async configured<T>(token: vscode.CancellationToken, timeout: number, run: (baseUrl: string, apiKey: string, signal: AbortSignal) => Promise<T>): Promise<T> {
    const credentials = await this.credentials();
    if (!credentials) throw new Error('Run “Open Chat Bridge: Configure” to set baseUrl and apiKey.');
    const { baseUrl, apiKey } = credentials;
    const controller = new AbortController();
    const subscription = token.onCancellationRequested(() => controller.abort());
    if (token.isCancellationRequested) controller.abort();
    const signal = AbortSignal.any([controller.signal, AbortSignal.timeout(timeout)]);
    try {
      signal.throwIfAborted();
      return await run(baseUrl, apiKey, signal);
    } catch (error) {
      if (token.isCancellationRequested) throw new vscode.CancellationError();
      if (signal.aborted) throw new Error('Open Chat Bridge request timed out.');
      throw new Error(redact(error instanceof Error ? error.message : String(error), apiKey));
    } finally { subscription.dispose(); }
  }

  async provideLanguageModelChatInformation(options: vscode.PrepareLanguageModelChatModelOptions, token: vscode.CancellationToken): Promise<Model[]> {
    if (!await this.credentials()) {
      if (options.silent) return [];
      await this.configure();
      if (!await this.credentials()) return [];
    }
    return this.configured(token, 30_000, async (baseUrl, apiKey, signal) => {
      const [upstream, online] = await Promise.allSettled([
        listModels(baseUrl, apiKey, signal),
        onlineMetadata(AbortSignal.any([signal, AbortSignal.timeout(10_000)])),
      ]);
      signal.throwIfAborted();
      if (upstream.status === 'rejected') throw upstream.reason;
      return online.status === 'fulfilled'
        ? discover(upstream.value, online.value)
        : discover(upstream.value, {}, '在线能力获取失败；仅使用上游字段，刷新模型可重试');
    });
  }

  async provideLanguageModelChatResponse(model: Model, messages: readonly vscode.LanguageModelChatRequestMessage[], options: vscode.ProvideLanguageModelChatResponseOptions, progress: vscode.Progress<ResponsePart>, token: vscode.CancellationToken): Promise<void> {
    const effort = options.modelConfiguration?.reasoningEffort ?? options.modelOptions?.reasoningEffort;
    if (effort !== undefined && (typeof effort !== 'string' || !model.efforts.includes(effort))) throw new Error('Unsupported thinking effort for this model.');
    const tools = options.tools ?? [];
    if (tools.length && !model.capabilities.toolCalling) throw new Error('This model has no known tool calling support.');
    if (!tools.length && options.toolMode === vscode.LanguageModelChatToolMode.Required) throw new Error('A required tool request needs at least one tool.');
    const body: Json = {
      model: model.id, stream: true, messages: convertMessages(messages, !!model.capabilities.imageInput),
      ...(effort !== undefined ? { reasoning_effort: effort } : {}),
      ...(tools.length ? {
        tools: tools.map(tool => ({ type: 'function', function: { name: tool.name, description: tool.description, parameters: tool.inputSchema ?? { type: 'object', properties: {} } } })),
        tool_choice: options.toolMode === vscode.LanguageModelChatToolMode.Required ? 'required' : 'auto',
      } : {}),
    };
    await this.configured(token, 600_000, async (baseUrl, apiKey, signal) => {
      const response = await request(baseUrl, apiKey, 'chat/completions', signal, body);
      await streamResponse(response, { report: part => {
        signal.throwIfAborted();
        progress.report(part);
      } });
    });
  }

  async provideTokenCount(_model: Model, text: string | vscode.LanguageModelChatRequestMessage, token: vscode.CancellationToken): Promise<number> {
    if (token.isCancellationRequested) throw new vscode.CancellationError();
    return estimateTokens(text);
  }
}

export async function activate(context: vscode.ExtensionContext): Promise<void> {
  if (typeof vscode.LanguageModelThinkingPart !== 'function') {
    throw new Error('Open Chat Bridge requires experimental APIs. Fully quit VS Code and start with: code --enable-proposed-api ahang.newapi-copilot');
  }
  const config = vscode.workspace.getConfiguration('openChatBridge');
  const previousUrl = vscode.workspace.getConfiguration('newapi').inspect<string>('baseUrl')?.globalValue;
  const previousCredentials = await context.secrets.get('newapi.credentials');
  const previousApiUrl = previousCredentials ? object(JSON.parse(previousCredentials)).baseUrl : undefined;
  if (!config.get('baseUrl') && previousUrl) await config.update('baseUrl', typeof previousApiUrl === 'string' ? previousApiUrl : previousUrl, vscode.ConfigurationTarget.Global);
  if (!await context.secrets.get('openChatBridge.credentials') && previousCredentials) await context.secrets.store('openChatBridge.credentials', previousCredentials);
  const provider = new CompatibleChatProvider(context.secrets);
  const refreshTimer = setInterval(() => provider.refresh(), 5 * 60_000);
  context.subscriptions.push(
    provider,
    { dispose: () => clearInterval(refreshTimer) },
    vscode.window.onDidChangeWindowState(state => { if (state.focused) provider.refresh(); }),
    vscode.commands.registerCommand('openChatBridge.configure', () => provider.configure()),
    vscode.commands.registerCommand('openChatBridge.manage', () => provider.manage()),
    vscode.commands.registerCommand('openChatBridge.refresh', () => provider.refreshModels()),
    vscode.workspace.onDidChangeConfiguration(event => { if (event.affectsConfiguration('openChatBridge.baseUrl')) provider.refresh(); }),
    context.secrets.onDidChange(event => { if (event.key === 'openChatBridge.credentials') provider.refresh(); }),
    vscode.lm.registerLanguageModelChatProvider('newapi', provider),
  );
}
