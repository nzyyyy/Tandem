import { AppError, requireValue } from './errors.ts';
import type { Connection } from './config.ts';

export type ChatMessage = { role: 'user' | 'assistant'; content: string };
export type ToolCall = { callId: string; name: string; arguments: string };
export type ModelResult = { text: string; toolCalls: ToolCall[] };
export type BoundModel = Omit<Connection, 'key' | 'modelNames'> & { modelName: string };

export function endpoint(model: Pick<Connection, 'url' | 'apiType'>): string {
  const suffix = { chat_completions: 'chat/completions', responses: 'responses', messages: 'messages' }[model.apiType];
  return model.url.replace(/\/+$/, '') + '/' + suffix;
}

function normalResponse(api: Connection['apiType'], body: any): ModelResult {
  const toolCalls: ToolCall[] = [];
  let output = '';
  if (api === 'chat_completions') {
    const choice = body.choices?.[0];
    requireValue(choice && ['stop', 'tool_calls'].includes(choice.finish_reason), 'MODEL_INCOMPLETE');
    output = typeof choice.message?.content === 'string' ? choice.message.content : '';
    for (const call of choice.message?.tool_calls ?? []) {
      requireValue(call.type === 'function', 'MODEL_UNSUPPORTED_OUTPUT');
      toolCalls.push({ callId: call.id, name: call.function?.name, arguments: call.function?.arguments });
    }
  } else if (api === 'responses') {
    requireValue(body.status === 'completed', 'MODEL_INCOMPLETE');
    for (const item of body.output ?? []) {
      if (item.type === 'message') {
        for (const part of item.content ?? []) {
          if (part.type === 'output_text') output += part.text;
          if (part.type === 'refusal') throw new AppError('MODEL_REFUSED');
        }
      } else if (item.type === 'function_call') {
        toolCalls.push({ callId: item.call_id, name: item.name, arguments: item.arguments });
      } else if (item.type !== 'reasoning') throw new AppError('MODEL_UNSUPPORTED_OUTPUT');
    }
  } else {
    requireValue(['end_turn', 'tool_use', 'stop_sequence'].includes(body.stop_reason), 'MODEL_INCOMPLETE');
    for (const part of body.content ?? []) {
      if (part.type === 'text') output += part.text;
      else if (part.type === 'tool_use') toolCalls.push({ callId: part.id, name: part.name, arguments: JSON.stringify(part.input) });
      else if (!['thinking', 'redacted_thinking'].includes(part.type)) throw new AppError('MODEL_UNSUPPORTED_OUTPUT');
    }
  }
  for (const call of toolCalls) {
    requireValue(typeof call.callId === 'string' && typeof call.name === 'string' && typeof call.arguments === 'string', 'MODEL_INVALID_RESPONSE');
    try { JSON.parse(call.arguments); } catch { throw new AppError('MODEL_INVALID_TOOL_ARGUMENTS'); }
  }
  requireValue(output.length > 0 || toolCalls.length > 0, 'MODEL_EMPTY_RESPONSE');
  return { text: output, toolCalls };
}

async function* sse(body: ReadableStream<Uint8Array>): AsyncGenerator<any> {
  const decoder = new TextDecoder('utf-8', { fatal: true });
  let pending = '';
  let data: string[] = [];
  let received = 0;
  const line = (value: string): string | undefined => {
    if (value === '') {
      const event = data.length ? data.join('\n') : undefined;
      data = [];
      return event;
    }
    if (value.startsWith('data:')) data.push(value.slice(5).replace(/^ /, ''));
    return undefined;
  };
  const reader = body.getReader();
  try {
    while (true) {
      const next = await reader.read();
      if (next.done) break;
      received += next.value.length;
      requireValue(received <= 2 * 1024 * 1024, 'MODEL_RESPONSE_TOO_LARGE');
      pending += decoder.decode(next.value, { stream: true });
      while (true) {
        const match = /\r\n|\r|\n/.exec(pending);
        if (!match) break;
        // A CR at a chunk boundary may be the first half of CRLF.
        if (match[0] === '\r' && match.index === pending.length - 1) break;
        const value = pending.slice(0, match.index);
        pending = pending.slice(match.index + match[0].length);
        const event = line(value);
        if (event !== undefined) yield event === '[DONE]' ? '[DONE]' : JSON.parse(event);
      }
    }
    pending += decoder.decode();
    if (pending) line(pending.replace(/\r$/, ''));
    const event = line('');
    if (event !== undefined) yield event === '[DONE]' ? '[DONE]' : JSON.parse(event);
  } finally { await reader.cancel().catch(() => {}); reader.releaseLock(); }
}

export async function generate(
  model: BoundModel & { key: string }, messages: ChatMessage[], signal: AbortSignal,
  onText: (text: string) => void, stream = true, timeoutMs = 90_000
): Promise<ModelResult> {
  const headers: Record<string, string> = { 'content-type': 'application/json' };
  if (model.protocol === 'openai') headers.authorization = `Bearer ${model.key}`;
  else { headers['x-api-key'] = model.key; headers['anthropic-version'] = '2023-06-01'; }
  const payload = model.apiType === 'responses'
    ? { model: model.modelName, input: messages, stream, store: false }
    : { model: model.modelName, messages, stream, ...(model.apiType === 'messages' ? { max_tokens: 4096 } : {}) };
  let output = '';
  const emit = (delta: string) => {
    output += delta;
    requireValue(Buffer.byteLength(output) <= 32 * 1024, 'MODEL_OUTPUT_LIMIT');
    onText(output);
  };
  try {
    const response = await fetch(endpoint(model), {
      method: 'POST', headers, body: JSON.stringify(payload), redirect: 'error',
      signal: AbortSignal.any([signal, AbortSignal.timeout(timeoutMs)])
    });
    if (!response.ok) {
      await response.body?.cancel();
      throw new AppError(({ 401: 'MODEL_AUTH', 403: 'MODEL_AUTH', 429: 'MODEL_RATE_LIMIT' } as Record<number, string>)[response.status] ?? `MODEL_HTTP_${response.status}`);
    }
    requireValue(response.body, 'MODEL_EMPTY_RESPONSE');
    if (!response.headers.get('content-type')?.includes('text/event-stream')) {
      const reader = response.body.getReader();
      const chunks: Uint8Array[] = [];
      let size = 0;
      try {
        while (true) {
          const next = await reader.read();
          if (next.done) break;
          size += next.value.length;
          requireValue(size <= 2 * 1024 * 1024, 'MODEL_RESPONSE_TOO_LARGE');
          chunks.push(next.value);
        }
      } finally { await reader.cancel().catch(() => {}); reader.releaseLock(); }
      const result = normalResponse(model.apiType, JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(chunks))));
      emit(result.text);
      return result;
    }
    let completed = false;
    let finish: string | null = null;
    let finalResponse: any;
    const calls = new Map<number, any>();
    for await (const event of sse(response.body)) {
      if (event === '[DONE]') { completed = model.apiType === 'chat_completions' && finish !== null; break; }
      if (event.error || event.type === 'error' || ['response.failed', 'response.incomplete'].includes(event.type)) throw new AppError('MODEL_STREAM_FAILED');
      if (model.apiType === 'chat_completions') {
        const choice = event.choices?.[0];
        if (!choice) continue;
        if (typeof choice.delta?.content === 'string') emit(choice.delta.content);
        for (const delta of choice.delta?.tool_calls ?? []) {
          const call = calls.get(delta.index) ?? { id: '', type: 'function', function: { name: '', arguments: '' } };
          if (delta.id) call.id = delta.id;
          if (delta.function?.name) call.function.name += delta.function.name;
          if (delta.function?.arguments) call.function.arguments += delta.function.arguments;
          calls.set(delta.index, call);
        }
        if (choice.finish_reason) finish = choice.finish_reason;
      } else if (model.apiType === 'responses') {
        if (event.type === 'response.output_text.delta') emit(event.delta);
        if (event.type === 'response.completed') { finalResponse = event.response; completed = true; break; }
      } else {
        if (event.type === 'content_block_start') calls.set(event.index, event.content_block);
        if (event.type === 'content_block_delta') {
          const block = calls.get(event.index);
          requireValue(block, 'MODEL_INVALID_RESPONSE');
          if (event.delta.type === 'text_delta') { emit(event.delta.text); block.text = (block.text ?? '') + event.delta.text; }
          if (event.delta.type === 'input_json_delta') block.partial = (block.partial ?? '') + event.delta.partial_json;
        }
        if (event.type === 'message_delta') finish = event.delta?.stop_reason ?? finish;
        if (event.type === 'message_stop') { completed = true; break; }
      }
    }
    requireValue(completed, 'MODEL_STREAM_INTERRUPTED');
    let result: ModelResult;
    if (model.apiType === 'responses') result = normalResponse(model.apiType, finalResponse);
    else if (model.apiType === 'chat_completions') result = normalResponse(model.apiType, { choices: [{ finish_reason: finish, message: { content: output, tool_calls: [...calls.values()] } }] });
    else result = normalResponse(model.apiType, { stop_reason: finish, content: [...calls.values()].map(block => {
      if (block.type === 'tool_use' && block.partial) return { ...block, input: JSON.parse(block.partial) };
      return block;
    }) });
    // Final response content is authoritative, but incomplete stream text is retained on failure.
    if (result.text !== output) { output = ''; emit(result.text); }
    return result;
  } catch (error) {
    if (error instanceof AppError) throw error;
    if (signal.aborted) throw new AppError('CANCELLED');
    if (error instanceof Error && error.name === 'TimeoutError') throw new AppError('MODEL_TIMEOUT');
    throw new AppError('MODEL_CONNECTION_OR_RESPONSE');
  }
}
