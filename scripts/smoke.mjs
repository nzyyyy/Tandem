import { execFileSync, spawn } from 'node:child_process';
import { resolve } from 'node:path';
import { createServer } from 'node:http';
import { once } from 'node:events';
import assert from 'node:assert/strict';
const bin = execFileSync('swift', ['build', '--package-path', 'native', '--arch', 'arm64', '--show-bin-path'], { encoding: 'utf8' }).trim();
const paths = [];
const server = createServer(async (request, response) => {
  const chunks = [];
  for await (const chunk of request) chunks.push(chunk);
  const body = JSON.parse(Buffer.concat(chunks).toString());
  assert.equal(body.model, 'smoke-model');
  paths.push(request.url);
  response.setHeader('content-type', 'text/event-stream');
  if ((body.messages ?? body.input).at(-1).content === 'crash-request') {
    response.write('data: {"type":"content_block_start","index":0,"content_block":{"type":"text","text":""}}\n\n');
    response.write('data: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"partial"}}\n\n');
    return;
  }
  let events;
  if (request.url.endsWith('/responses')) events = [
    { type: 'response.output_text.delta', delta: '你好，' },
    { type: 'response.output_text.delta', delta: 'M1' },
    { type: 'response.completed', response: { status: 'completed', output: [{ type: 'message', content: [{ type: 'output_text', text: '你好，M1' }] }] } }
  ];
  else if (request.url.endsWith('/messages')) events = [
    { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } },
    { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: '你好，M1' } },
    { type: 'message_delta', delta: { stop_reason: 'end_turn' } }, { type: 'message_stop' }
  ];
  else events = [ { choices: [{ delta: { content: '你好，M1' } }] }, { choices: [{ delta: {}, finish_reason: 'stop' }] }, '[DONE]' ];
  response.end(events.map(event => `data: ${event === '[DONE]' ? event : JSON.stringify(event)}\n\n`).join(''));
});
server.listen(0, '127.0.0.1');
await once(server, 'listening');
let timer;
try {
  const url = `http://127.0.0.1:${server.address().port}/v1`;
  const child = spawn(`${bin}/Tandem`, ['--smoke-test', process.execPath, resolve('runtime/src/main.ts'), url], { stdio: 'inherit' });
  timer = setTimeout(() => child.kill('SIGKILL'), 45000);
  const [code] = await once(child, 'exit');
  assert.equal(code, 0);
  assert.deepEqual(paths, ['/v1/responses', '/v1/chat/completions', '/v1/messages', '/v1/messages', '/v1/messages', '/v1/messages']);
} finally { clearTimeout(timer); server.closeAllConnections(); server.close(); }
