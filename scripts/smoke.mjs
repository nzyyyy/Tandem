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
  const messages = body.messages ?? body.input;
  if (JSON.stringify(messages).includes('M4 current decision')) {
    assert.ok(messages.some(m=>m.content.includes('长期记忆') && m.content.includes('SQLite') && m.content.includes('messageId')));
  }
  if (JSON.stringify(messages).includes('M3 native read')) {
    response.setHeader('content-type','application/json');
    const result = messages.find(m=>m.role==='tool');
    const policy = messages.find(m=>typeof m.content==='string' && m.content.includes('"grants":'));
    const grant = policy && JSON.parse(policy.content.slice(policy.content.indexOf('{'))).grants[0].id;
    if (!result) {
      assert.ok(grant);
      response.end(JSON.stringify({choices:[{finish_reason:'tool_calls',message:{content:'',tool_calls:[{id:'native-read',type:'function',function:{name:'read_file',arguments:JSON.stringify({grantId:grant,path:'notes.md',startLine:1,endLine:2})}}]}}]}));
    } else {
      const file = JSON.parse(result.content);
      assert.equal(file.content,'原生读取资料\n第二行');
      assert.equal(file.version.length,64);
      response.end(JSON.stringify({choices:[{finish_reason:'tool_calls',message:{content:'',tool_calls:[{id:'finish-report',type:'function',function:{name:'complete_task',arguments:JSON.stringify({markdown:`# M3 报告\n${file.content}\nnotes.md:1-2 @${file.version}`,evidence:['原生读取完成，报告引用行号及内容哈希']})}}]}}]}));
    }
    return;
  }
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
  assert.deepEqual(paths, ['/v1/responses', '/v1/chat/completions', '/v1/messages', '/v1/messages', '/v1/messages', '/v1/messages', '/v1/chat/completions', '/v1/chat/completions', '/v1/chat/completions']);
} finally { clearTimeout(timer); server.closeAllConnections(); server.close(); }
