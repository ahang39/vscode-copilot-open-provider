export type Json = Record<string, unknown>;

export function object(value: unknown): Json {
  return value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Json : {};
}

export function apiUrl(baseUrl: string, path: string): string {
  const url = new URL(baseUrl.trim());
  if (!['https:', 'http:'].includes(url.protocol) || url.username || url.password || url.search || url.hash) {
    throw new Error('baseUrl must be an HTTP(S) URL without credentials, query or fragment.');
  }
  url.pathname = (url.pathname.replace(/\/+$/, '') || '/v1') + '/' + path;
  return url.toString();
}

export function redact(message: string, apiKey: string): string {
  return (apiKey ? message.split(apiKey).join('[redacted]') : message).slice(0, 1500);
}

export async function request(baseUrl: string, apiKey: string, path: string, signal: AbortSignal, body?: Json, after?: string): Promise<Response> {
  const url = new URL(apiUrl(baseUrl, path));
  if (after !== undefined) url.searchParams.set('after', after);
  const response = await fetch(url, {
    method: body ? 'POST' : 'GET',
    headers: { Authorization: `Bearer ${apiKey}`, Accept: body ? 'text/event-stream' : 'application/json', ...(body ? { 'Content-Type': 'application/json' } : {}) },
    body: body ? JSON.stringify(body) : undefined,
    signal,
    redirect: 'error',
  });
  if (!response.ok) {
    const reader = response.body?.getReader();
    let detail = '';
    try {
      const chunk = await reader?.read();
      if (chunk?.value) detail = new TextDecoder().decode(chunk.value.slice(0, 4096));
    } finally { await reader?.cancel(); }
    throw new Error(redact(`Open Provider HTTP ${response.status}: ${detail}`, apiKey));
  }
  return response;
}

export async function listModels(baseUrl: string, apiKey: string, signal: AbortSignal): Promise<Json> {
  const data: unknown[] = [];
  const cursors = new Set<string>();
  let after: string | undefined;
  do {
    const response = await request(baseUrl, apiKey, 'models', signal, undefined, after);
    const page = object(await response.json());
    if (page.error || page.success === false || !Array.isArray(page.data)) throw new Error('Invalid /models response.');
    data.push(...page.data);
    if (page.has_more !== true) return { data };
    const cursor = page.last_id ?? object(page.data.at(-1)).id;
    if (typeof cursor !== 'string' || !cursor || cursors.has(cursor)) throw new Error('Invalid or repeated /models pagination cursor.');
    cursors.add(cursor);
    after = cursor;
  } while (!signal.aborted);
  signal.throwIfAborted();
  throw new Error('Model discovery interrupted.');
}

export async function* events(response: Response): AsyncGenerator<unknown> {
  if (!response.body || !response.headers.get('content-type')?.includes('text/event-stream')) {
    throw new Error('Open Provider did not return a text/event-stream response.');
  }
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  let data: string[] = [];
  let size = 0;
  try {
    while (true) {
      const chunk = await reader.read();
      buffer += decoder.decode(chunk.value, { stream: !chunk.done });
      if (chunk.done) buffer += '\n\n';
      let match: RegExpExecArray | null;
      while ((match = /\r\n|\r|\n/.exec(buffer))) {
        if (!chunk.done && match[0] === '\r' && match.index === buffer.length - 1) break;
        const line = buffer.slice(0, match.index);
        buffer = buffer.slice(match.index + match[0].length);
        if (line === '') {
          if (data.length) {
            const payload = data.join('\n');
            if (payload === '[DONE]') { yield '[DONE]'; return; }
            try { yield JSON.parse(payload); }
            catch (error) {
              if (error instanceof SyntaxError) throw new Error('Invalid JSON in Open Provider SSE stream.');
              throw error;
            }
          }
          data = [];
          size = 0;
        } else if (line.startsWith('data:')) {
          const value = line.slice(5).replace(/^ /, '');
          data.push(value);
          size += value.length;
        }
        if (size > 8 * 1024 * 1024) throw new Error('Open Provider SSE event exceeds 8 MiB.');
      }
      if (buffer.length > 8 * 1024 * 1024) throw new Error('Open Provider SSE line exceeds 8 MiB.');
      if (chunk.done) return;
    }
  } finally { await reader.cancel(); reader.releaseLock(); }
}
