import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import type { ServerResponse } from 'node:http';
import { once } from 'node:events';
import { mkdtempSync, rmSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { AppService } from '../src/service.ts';

async function waitFor(condition: () => boolean) {
  for (let i = 0; i < 200; i++) {
    if (condition()) return;
    await new Promise(resolve => setTimeout(resolve, 10));
  }
  throw new Error('WAIT_TIMEOUT');
}
async function environment(mode: 'normal' | 'queue' | 'fail' | 'hold' = 'normal') {
  const requests: { path: string; input: any; response: ServerResponse }[] = [];
  const server = createServer(async (req, res) => {
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    const input = JSON.parse(Buffer.concat(chunks).toString());
    requests.push({ path: req.url!, input, response: res });
    if (mode === 'fail') { res.writeHead(401); res.end('secret-service-key'); return; }
    const last = (input.messages ?? input.input).at(-1).content;
    if (mode === 'hold' || (mode === 'queue' && ['first', 'second'].includes(last))) return;
    reply(res, req.url!, `answer:${last}`);
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const url = `http://127.0.0.1:${(server.address() as { port: number }).port}/v1`;
  const directory = mkdtempSync('/tmp/tandem-service-');
  const service = new AppService(directory);
  const config = { schemaVersion: 1, modelConnections: [
    { id: 'one', protocol: 'openai', apiType: 'chat_completions', url, key: 'secret-service-key', modelNames: ['same-name', 'other'] },
    { id: 'two', protocol: 'openai', apiType: 'responses', url, key: 'secret-service-key-2', modelNames: ['same-name'] }
  ], defaultModel: { connectionId: 'one', modelName: 'same-name' } };
  service.dispatch('config.save', { config, expectedRevision: 'missing' });
  return { requests, directory, service, config, close: async () => { await service.stop(); server.closeAllConnections(); server.close(); rmSync(directory, { recursive: true, force: true }); } };
}
function reply(res: ServerResponse, path: string, text: string) {
  res.setHeader('content-type', 'application/json');
  res.end(JSON.stringify(path.endsWith('/responses') ? { status: 'completed', output: [{ type: 'message', content: [{ type: 'output_text', text }] }] }
    : { choices: [{ finish_reason: 'stop', message: { content: text } }] }));
}
const send = (service: AppService, key: string, content: string, extras = {}): any => service.dispatch('message.send', { surfaceId: 'a', idempotencyKey: key, text: content, ...extras });
const state = (service: AppService, surfaceId = 'a', extras = {}): any => service.dispatch('state.get', { surfaceId, ...extras });
const status = (service: AppService, id: string) => service.store.db.prepare('SELECT status FROM runs WHERE id=?').get(id)?.status;

test('same-session messages queue, bind models on creation, and exclude later inputs', async () => {
  const env = await environment('queue');
  try {
    const first = send(env.service, 'first', 'first');
    await waitFor(() => env.requests.length === 1);
    const second = send(env.service, 'second', 'second');
    const document = env.service.config.read();
    env.service.dispatch('config.save', { config: { ...env.config, defaultModel: { connectionId: 'two', modelName: 'same-name' } }, expectedRevision: document.revision });
    const third = send(env.service, 'third', 'third');
    assert.equal(env.requests.length, 1);
    reply(env.requests[0].response, env.requests[0].path, 'first-answer');
    await waitFor(() => env.requests.length === 2);
    assert.equal(env.requests[1].path, '/v1/chat/completions');
    assert.deepEqual(env.requests[1].input.messages.map((m: any) => m.content), ['first', 'first-answer', 'second']);
    reply(env.requests[1].response, env.requests[1].path, 'second-answer');
    await waitFor(() => status(env.service, third.runId) === 'completed');
    assert.equal(status(env.service, first.runId), 'completed');
    assert.equal(status(env.service, second.runId), 'completed');
    assert.equal(env.requests[2].path, '/v1/responses');
    const before = env.service.store.db.prepare('SELECT COUNT(*) AS n FROM messages').get()!.n;
    assert.deepEqual(send(env.service, 'third', 'third'), third);
    assert.equal(env.service.store.db.prepare('SELECT COUNT(*) AS n FROM messages').get()!.n, before);
    assert.throws(() => send(env.service, 'third', 'different'), /IDEMPOTENCY_CONFLICT/);
  } finally { await env.close(); }
});

test('shared timeline identities, independent focus, temporary interruption and explicit resume persist', async () => {
  const env = await environment();
  try {
    const original = send(env.service, '1', 'architecture');
    await waitFor(() => status(env.service, original.runId) === 'completed');
    const originalSession = state(env.service).focus.activeSessionId;
    state(env.service, 'b');
    const other = send(env.service, '2', 'another topic', { surfaceId: 'b', newTopic: true });
    await waitFor(() => status(env.service, other.runId) === 'completed');
    assert.equal(state(env.service).focus.activeSessionId, originalSession);
    assert.notEqual(state(env.service, 'b').focus.activeSessionId, originalSession);
    assert.deepEqual(state(env.service).messages, state(env.service, 'b').messages);
    const temporary = send(env.service, '3', '临时问：what is WAL?');
    await waitFor(() => status(env.service, temporary.runId) === 'completed');
    assert.equal(state(env.service).focus.interruptedSessionId, originalSession);
    const resumed = send(env.service, '4', '继续上次的讨论');
    await waitFor(() => status(env.service, resumed.runId) === 'completed');
    assert.equal(state(env.service).focus.activeSessionId, originalSession);
    assert.equal(state(env.service).focus.interruptedSessionId, null);
    const lastRequest = env.requests.at(-1)!.input.messages;
    assert.equal(JSON.stringify(lastRequest).includes('what is WAL'), false);
    const before = state(env.service);
    await env.service.stop();
    const reopened = new AppService(env.directory);
    try {
      assert.deepEqual(state(reopened).messages, before.messages);
      assert.deepEqual(state(reopened).focus, before.focus);
      assert.equal(reopened.config.read().config.defaultModel?.connectionId, 'one');
    } finally { await reopened.stop(); }
  } finally { await env.close(); }
});

test('failures never auto retry; manual retry retains original model and is idempotent', async () => {
  const env = await environment('fail');
  try {
    const first = send(env.service, 'first', 'question');
    await waitFor(() => status(env.service, first.runId) === 'failed');
    const doc = env.service.config.read();
    env.service.dispatch('config.save', { config: { ...env.config, defaultModel: { connectionId: 'two', modelName: 'same-name' } }, expectedRevision: doc.revision });
    assert.equal(env.requests.length, 1);
    const retry: any = env.service.dispatch('message.retry', { runId: first.runId, idempotencyKey: 'retry' });
    const duplicate = env.service.dispatch('message.retry', { runId: first.runId, idempotencyKey: 'double-click' });
    assert.equal(retry.runId, (duplicate as { runId: string }).runId);
    await waitFor(() => status(env.service, retry.runId) === 'failed');
    assert.equal(env.requests[1].path, '/v1/chat/completions');
    assert.equal(env.service.store.db.prepare("SELECT COUNT(*) AS n FROM messages WHERE role='user'").get()!.n, 1);
    const changed: any = env.service.dispatch('message.retry', { runId: retry.runId, idempotencyKey: 'switch', selection: { connectionId: 'two', modelName: 'same-name' } });
    await waitFor(() => status(env.service, changed.runId) === 'failed');
    assert.equal(env.requests[2].path, '/v1/responses');
    for (const file of readdirSync(env.directory).filter(name => name.startsWith('tandem.sqlite'))) {
      assert.equal(readFileSync(`${env.directory}/${file}`).includes(Buffer.from('secret-service-key')), false);
    }
  } finally { await env.close(); }
});

test('full quit interrupts queued/running requests; reopen is idle until manual retry', async () => {
  const env = await environment('hold');
  try {
    const first = send(env.service, 'first', 'first');
    await waitFor(() => env.requests.length === 1);
    const queued = send(env.service, 'second', 'second');
    await env.service.stop();
    const reopened = new AppService(env.directory);
    try {
      assert.equal(status(reopened, first.runId), 'interrupted');
      assert.equal(status(reopened, queued.runId), 'interrupted');
      await new Promise(resolve => setTimeout(resolve, 40));
      assert.equal(env.requests.length, 1);
      const old = reopened.config.read();
      reopened.dispatch('config.save', { config: { ...old.config, modelConnections: old.config.modelConnections.map(c => ({ ...c, url: c.url + '/changed' })) }, expectedRevision: old.revision });
      assert.throws(() => reopened.dispatch('message.retry', { runId: first.runId, idempotencyKey: 'retry' }), /MODEL_BINDING_CHANGED/);
    } finally { await reopened.stop(); }
  } finally { await env.close(); }
});

test('credential redaction, event replay, pagination and invalid config preservation', async () => {
  const env = await environment();
  try {
    const initial = state(env.service);
    const first = send(env.service, 'first', 'a secret-service-key here');
    await waitFor(() => status(env.service, first.runId) === 'completed');
    const replay = state(env.service, 'b', { afterSequence: initial.cursor });
    assert.ok(replay.changedMessages.length > 0);
    assert.equal(JSON.stringify(replay).includes('secret-service-key'), false);
    assert.equal(JSON.stringify(env.requests[0].input).includes('secret-service-key'), false);
    assert.throws(() => state(env.service, 'b', { afterSequence: 999999 }), /GAP_REQUIRED/);
    for (let i = 0; i < 5; i++) {
      const run = send(env.service, `more-${i}`, `message ${i}`);
      await waitFor(() => status(env.service, run.runId) === 'completed');
    }
    const latest = state(env.service);
    const earlier: any = env.service.dispatch('timeline.list', { beforeSequence: latest.messages[0].sequence });
    assert.equal(latest.messages.length, 10);
    assert.equal(earlier.messages.length, 2);
    assert.equal(new Set([...earlier.messages, ...latest.messages].map((m: any) => m.sequence)).size, 12);
    writeFileSync(env.service.config.path, '{bad-private-value');
    assert.throws(() => env.service.dispatch('config.get', {}), /CONFIG_INVALID_JSON/);
    assert.equal(state(env.service).configError, 'CONFIG_INVALID_JSON');
    assert.throws(() => send(env.service, 'bad', 'should not store'));
    assert.match(readFileSync(env.service.config.path, 'utf8'), /bad-private-value/);
  } finally { await env.close(); }
});
