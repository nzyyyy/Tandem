import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { once } from 'node:events';
import { generate } from '../src/model.ts';
import type { BoundModel } from '../src/model.ts';

async function fixture(handler: (req: IncomingMessage, res: ServerResponse) => void | Promise<void>) {
  const server = createServer((req, res) => { void handler(req, res); });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const address = server.address() as { port: number };
  return { url: `http://127.0.0.1:${address.port}/custom/v1`, close: () => { server.closeAllConnections(); server.close(); } };
}
async function read(req: IncomingMessage) {
  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  return JSON.parse(Buffer.concat(chunks).toString());
}
const bound = (url: string, apiType: BoundModel['apiType']) => ({ id: 'test', protocol: apiType === 'messages' ? 'anthropic' as const : 'openai' as const,
  apiType, url, modelName: 'exact-model-name', key: 'private-model-key' });
const normal = (api: BoundModel['apiType'], text: string, tool = false): any => {
  if (api === 'chat_completions') return { choices: [{ finish_reason: tool ? 'tool_calls' : 'stop', message: { content: text,
    ...(tool ? { tool_calls: [{ id: 'call-1', type: 'function', function: { name: 'read', arguments: '{"path":"a"}' } }] } : {}) } }] };
  if (api === 'responses') return { status: 'completed', output: [
    { type: 'message', content: [{ type: 'output_text', text }] },
    ...(tool ? [{ type: 'function_call', id: 'item-different', call_id: 'call-1', name: 'read', arguments: '{"path":"a"}' }] : [])
  ] };
  return { stop_reason: tool ? 'tool_use' : 'end_turn', content: [{ type: 'text', text },
    ...(tool ? [{ type: 'tool_use', id: 'call-1', name: 'read', input: { path: 'a' } }] : [])] };
};

for (const api of ['chat_completions', 'responses', 'messages'] as const) {
  test(`${api}: custom endpoint, authentication, ordinary text and tool-call identity`, async () => {
    let requests = 0;
    const mock = await fixture(async (req, res) => {
      requests++;
      assert.equal(req.url, `/custom/v1/${api === 'chat_completions' ? 'chat/completions' : api}`);
      assert.equal(req.headers[api === 'messages' ? 'x-api-key' : 'authorization'], api === 'messages' ? 'private-model-key' : 'Bearer private-model-key');
      const input = await read(req);
      assert.equal(input.model, 'exact-model-name');
      assert.equal(JSON.stringify(input).includes('private-model-key'), false);
      assert.equal((api === 'responses' ? input.input : input.messages)[0].content, '你好');
      assert.equal(input.previous_response_id, undefined);
      res.setHeader('content-type', 'application/json');
      res.end(JSON.stringify(normal(api, '回答', requests === 2)));
    });
    try {
      for (const tool of [false, true]) {
        let output = '';
        const result = await generate(bound(mock.url, api), [{ role: 'user', content: '你好' }], new AbortController().signal, value => { output = value; }, false);
        assert.equal(output, '回答');
        assert.equal(result.toolCalls.length, Number(tool));
        if (tool) assert.deepEqual(result.toolCalls[0], { callId: 'call-1', name: 'read', arguments: '{"path":"a"}' });
      }
    } finally { mock.close(); }
  });

  test(`${api}: fragmented SSE text and tool arguments`, async () => {
    const mock = await fixture(async (req, res) => {
      await read(req);
      res.setHeader('content-type', 'text/event-stream');
      const events: any[] = api === 'chat_completions' ? [
        { choices: [{ delta: { content: '你好' } }] }, { choices: [{ delta: { content: '👋' } }] },
        { choices: [{ delta: { tool_calls: [{ index: 0, id: 'call-1', function: { name: 'read', arguments: '{"path":' } }] } }] },
        { choices: [{ delta: { tool_calls: [{ index: 0, function: { arguments: '"a"}' } }] }, finish_reason: 'tool_calls' }] }, '[DONE]'
      ] : api === 'responses' ? [
        { type: 'response.output_text.delta', delta: '你好' }, { type: 'response.output_text.delta', delta: '👋' },
        { type: 'response.completed', response: normal(api, '你好👋', true) }
      ] : [
        { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } },
        { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: '你好' } },
        { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: '👋' } },
        { type: 'content_block_start', index: 1, content_block: { type: 'tool_use', id: 'call-1', name: 'read', input: {} } },
        { type: 'content_block_delta', index: 1, delta: { type: 'input_json_delta', partial_json: '{"path":' } },
        { type: 'content_block_delta', index: 1, delta: { type: 'input_json_delta', partial_json: '"a"}' } },
        { type: 'message_delta', delta: { stop_reason: 'tool_use' } }, { type: 'message_stop' }
      ];
      const bytes = Buffer.from(events.map(event => `event: ignored\r\ndata: ${event === '[DONE]' ? event : JSON.stringify(event)}\r\n\r\n`).join(''));
      for (let i = 0; i < bytes.length; i += 7) {
        res.write(bytes.subarray(i, i + 7));
        await new Promise(resolve => setTimeout(resolve, 1));
      }
      res.end();
    });
    try {
      const outputs: string[] = [];
      const result = await generate(bound(mock.url, api), [{ role: 'user', content: '你好' }], new AbortController().signal, value => outputs.push(value));
      assert.equal(result.text, '你好👋');
      assert.ok(outputs.includes('你好'));
      assert.deepEqual(result.toolCalls, [{ callId: 'call-1', name: 'read', arguments: '{"path":"a"}' }]);
    } finally { mock.close(); }
  });

  test(`${api}: authentication error is sanitized and never retried`, async () => {
    let requests = 0;
    const mock = await fixture((_req, res) => { requests++; res.writeHead(401); res.end('private-model-key'); });
    try {
      await assert.rejects(generate(bound(mock.url, api), [{ role: 'user', content: 'x' }], new AbortController().signal, () => {}), /MODEL_AUTH/);
      assert.equal(requests, 1);
    } finally { mock.close(); }
  });
}

test('stream interruption preserves partial text; redirects never forward credentials', async () => {
  let output = '';
  let forwarded = false;
  const target = await fixture((_req, res) => { forwarded = true; res.end('{}'); });
  const redirect = await fixture((_req, res) => { res.writeHead(307, { location: target.url }); res.end(); });
  const broken = await fixture((_req, res) => {
    res.setHeader('content-type', 'text/event-stream');
    res.end('data: {"choices":[{"delta":{"content":"partial"}}]}\n\n');
  });
  try {
    await assert.rejects(generate(bound(broken.url, 'chat_completions'), [{ role: 'user', content: 'x' }], new AbortController().signal, value => { output = value; }), /MODEL_STREAM_INTERRUPTED/);
    assert.equal(output, 'partial');
    await assert.rejects(generate(bound(redirect.url, 'responses'), [{ role: 'user', content: 'x' }], new AbortController().signal, () => {}), /MODEL_CONNECTION_OR_RESPONSE/);
    assert.equal(forwarded, false);
  } finally { target.close(); redirect.close(); broken.close(); }
});

test('request timeout and explicit cancellation have distinct errors', async () => {
  const mock = await fixture(() => {});
  try {
    await assert.rejects(generate(bound(mock.url, 'responses'), [{ role: 'user', content: 'x' }], new AbortController().signal, () => {}, true, 30), /MODEL_TIMEOUT/);
    const abort = new AbortController();
    abort.abort();
    await assert.rejects(generate(bound(mock.url, 'responses'), [{ role: 'user', content: 'x' }], abort.signal, () => {}), /CANCELLED/);
  } finally { mock.close(); }
});
