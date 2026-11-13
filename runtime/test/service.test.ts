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

const project = (service: AppService, title: string): string => (service.dispatch('project.create', { title, description: '' }) as any).id;
function scope(service: AppService, projectId: string | null, mode = 'automatic', surfaceId = 'a') {
  return service.dispatch('context.set', { surfaceId, projectId, mode, expectedVersion: state(service, surfaceId).focus.version });
}
function confirm(service: AppService, interactionId: string, sessionId: string | null = null): any {
  const pending = state(service).pendingInteractions.find((i: any) => i.id === interactionId);
  return service.dispatch('interaction.confirm', { surfaceId: 'a', interactionId, sessionId, expectedVersion: pending.version, expectedFocusVersion: state(service).focus.version });
}

test('M2 ambiguity reserves order, persists across restart, and commits only once after explicit choice', async () => {
  const env = await environment();
  try {
    const p = project(env.service, 'Alpha'); scope(env.service,p);
    const first = send(env.service, 'm2-a', 'alpha architecture', {newTopic:true});
    await waitFor(() => status(env.service,first.runId)==='completed');
    const session = state(env.service).focus.activeSessionId;
    const second = send(env.service, 'm2-b', 'alpha storage', {newTopic:true});
    await waitFor(() => status(env.service,second.runId)==='completed');
    const before = state(env.service);
    const pending = send(env.service,'m2-c','继续 alpha');
    assert.ok(pending.interactionId);
    assert.deepEqual(state(env.service).focus,before.focus);
    assert.equal(state(env.service).messages.length,before.messages.length);
    assert.equal(env.requests.length,2);
    assert.deepEqual(send(env.service,'m2-c','继续 alpha'),pending);
    const saved = state(env.service).pendingInteractions[0];
    assert.equal(saved.route.candidates.length,2);
    assert.equal(saved.sequence,5);
    await env.service.stop();
    const reopened = new AppService(env.directory);
    try {
      assert.equal(state(reopened).pendingInteractions[0].id,pending.interactionId);
      assert.equal(env.requests.length,2);
      assert.throws(()=>reopened.dispatch('interaction.confirm',{surfaceId:'a',interactionId:pending.interactionId,sessionId:session,expectedVersion:99,expectedFocusVersion:state(reopened).focus.version}),/INTERACTION_CONFLICT/);
      const result = confirm(reopened,pending.interactionId,session);
      assert.deepEqual(reopened.dispatch('interaction.confirm',{surfaceId:'a',interactionId:pending.interactionId,sessionId:session,expectedVersion:1,expectedFocusVersion:1}),result);
      await waitFor(()=>status(reopened,result.runId)==='completed');
      const message = state(reopened).messages.find((m:any)=>m.interactionId===pending.interactionId&&m.role==='user');
      assert.equal(message.sequence,saved.sequence);
      assert.equal(message.sessionId,session);
      assert.equal(state(reopened).pendingInteractions.length,0);
      assert.equal(reopened.store.db.prepare('SELECT COUNT(*) AS n FROM runs WHERE interaction_id=?').get(pending.interactionId)!.n,1);
    } finally { await reopened.stop(); }
  } finally { await env.close(); }
});

test('M2 isolated scope filters candidates, snapshots and causal inputs, including explicit cross-project resume',async()=>{
  const env=await environment();
  try {
    const a=project(env.service,'Alpha private'); const b=project(env.service,'Beta private');
    scope(env.service,a);
    const original=send(env.service,'iso-a','alpha private credentials');
    await waitFor(()=>status(env.service,original.runId)==='completed');
    const old=state(env.service).messages.find((m:any)=>m.runId===original.runId);
    const session=state(env.service).focus.activeSessionId;
    scope(env.service,b,'isolated');
    const pending=send(env.service,'iso-b','继续 alpha private credentials');
    assert.ok(pending.interactionId);
    assert.equal(state(env.service).pendingInteractions[0].route.candidates.length,0);
    assert.equal(state(env.service).sessions.length,0);
    assert.throws(()=>confirm(env.service,pending.interactionId,session),/CONTEXT_SCOPE/);
    assert.throws(()=>env.service.dispatch('snapshot.get',{id:old.snapshotId,surfaceId:'a'}),/CONTEXT_SCOPE/);
    const result=confirm(env.service,pending.interactionId);
    await waitFor(()=>status(env.service,result.runId)==='completed');
    assert.deepEqual(env.requests.at(-1)!.input.messages.map((m:any)=>m.content),['继续 alpha private credentials']);
    scope(env.service,null,'isolated');
    const unresolved=send(env.service,'iso-missing','hello');
    assert.ok(unresolved.interactionId);
    assert.throws(()=>confirm(env.service,unresolved.interactionId),/PROJECT_REQUIRED/);
    assert.equal(env.requests.length,2);
    assert.throws(()=>env.service.dispatch('session.focus',{surfaceId:'a',sessionId:session,expectedVersion:state(env.service).focus.version}),/CONTEXT_SCOPE/);
  } finally { await env.close(); }
});

test('M2 correction affects one interaction, stops queued work and reprocesses with a fresh immutable snapshot',async()=>{
  const env=await environment('queue');
  try {
    const a=project(env.service,'source');const b=project(env.service,'target');scope(env.service,a);
    const first=send(env.service,'correct-a','first');
    await waitFor(()=>env.requests.length===1);
    const queued=send(env.service,'correct-b','second');
    const user=state(env.service).messages.find((m:any)=>m.role==='user'&&m.content==='second');
    const before=state(env.service).messages.map((m:any)=>[m.id,m.sequence]);
    env.service.dispatch('interaction.correct',{surfaceId:'a',interactionId:user.interactionId,projectId:b,expectedVersion:user.interactionVersion});
    assert.equal(status(env.service,queued.runId),'cancelled');
    const untouched=env.service.store.db.prepare('SELECT project_id FROM interactions WHERE message_id=(SELECT user_message_id FROM runs WHERE id=?)').get(first.runId);
    assert.equal(untouched!.project_id,a);
    assert.deepEqual(state(env.service).messages.map((m:any)=>[m.id,m.sequence]),before);
    reply(env.requests[0].response,env.requests[0].path,'source-answer');
    await waitFor(()=>status(env.service,first.runId)==='completed');
    const snapshotBefore=env.service.store.db.prepare('SELECT fragments_json FROM context_snapshots WHERE run_id=?').get(first.runId)!.fragments_json;
    const retried:any=env.service.dispatch('message.retry',{runId:queued.runId,idempotencyKey:'correct-retry'});
    await waitFor(()=>env.requests.length===2);
    assert.deepEqual(env.requests[1].input.messages.map((m:any)=>m.content),['second']);
    reply(env.requests[1].response,env.requests[1].path,'target-answer');
    await waitFor(()=>status(env.service,retried.runId)==='completed');
    assert.equal(env.service.store.db.prepare('SELECT project_id FROM runs WHERE id=?').get(retried.runId)!.project_id,b);
    assert.equal(env.service.store.db.prepare('SELECT fragments_json FROM context_snapshots WHERE run_id=?').get(first.runId)!.fragments_json,snapshotBefore);
    assert.equal((env.service.dispatch('interaction.history',{interactionId:user.interactionId}) as any).corrections.length,1);
    assert.throws(()=>env.service.dispatch('interaction.correct',{surfaceId:'a',interactionId:user.interactionId,projectId:a,expectedVersion:user.interactionVersion}),/INTERACTION_CONFLICT/);
  } finally { await env.close(); }
});

test('M2 project archive keeps history; deletion requires a fresh preview and preserves unrelated interactions',async()=>{
  const env=await environment();
  try {
    const a=project(env.service,'remove');const b=project(env.service,'keep');scope(env.service,a);
    const first=send(env.service,'delete-a','remove only');
    await waitFor(()=>status(env.service,first.runId)==='completed');
    const p:any=state(env.service).projects.find((p:any)=>p.id===a);
    env.service.dispatch('project.update',{id:a,title:p.title,description:'',status:'archived',expectedVersion:p.version});
    assert.equal(env.service.store.db.prepare('SELECT COUNT(*) AS n FROM messages').get()!.n,2);
    assert.equal(state(env.service).sessions.length,0);
    env.service.dispatch('project.update',{id:a,title:p.title,description:'',status:'open',expectedVersion:p.version+1});
    scope(env.service,b);
    const keep=send(env.service,'delete-b','keep this');
    await waitFor(()=>status(env.service,keep.runId)==='completed');
    const preview:any=env.service.dispatch('project.deletePreview',{id:a});
    assert.equal(preview.interactions.length,1);assert.equal(preview.messages.length,2);
    assert.throws(()=>env.service.dispatch('project.delete',{token:preview.token}),/DELETE_CONFIRM_REQUIRED/);
    env.service.dispatch('project.update',{id:a,title:'edited',description:'',status:'open',expectedVersion:p.version+2});
    assert.throws(()=>env.service.dispatch('project.delete',{token:preview.token,confirm:true}),/DELETE_PREVIEW_CHANGED/);
    const fresh:any=env.service.dispatch('project.deletePreview',{id:a});
    const cursor=state(env.service).cursor;
    env.service.dispatch('project.delete',{token:fresh.token,confirm:true});
    assert.equal(env.service.store.db.prepare('PRAGMA foreign_key_check').all().length,0);
    assert.equal(env.service.store.db.prepare('SELECT COUNT(*) AS n FROM messages').get()!.n,2);
    assert.equal(status(env.service,keep.runId),'completed');
    assert.throws(()=>state(env.service,'a',{afterSequence:cursor}),/GAP_REQUIRED/);
    assert.equal(state(env.service).projects.some((p:any)=>p.id===a),false);
  } finally { await env.close(); }
});

test('M2 snapshot fragments remain unchanged after source edits, and neither keys nor other-project answers enter a new context',async()=>{
  const env=await environment();
  try {
    const a=project(env.service,'A');scope(env.service,a);
    const first=send(env.service,'snap-a','secret-service-key original');
    await waitFor(()=>status(env.service,first.runId)==='completed');
    const run=state(env.service).messages.find((m:any)=>m.runId===first.runId);
    const snap:any=env.service.dispatch('snapshot.get',{id:run.snapshotId,surfaceId:'a'});
    assert.equal(snap.fragments[0].sourceType,'message');
    assert.equal(snap.fragments[0].sourceVersion.length,64);
    assert.equal(JSON.stringify(snap).includes('secret-service-key'),false);
    env.service.store.db.prepare("UPDATE messages SET content='edited' WHERE role='user'").run();
    assert.deepEqual(env.service.dispatch('snapshot.get',{id:run.snapshotId,surfaceId:'a'}),snap);
    const message=state(env.service).messages.find((m:any)=>m.role==='user');
    const b=project(env.service,'B');
    env.service.dispatch('interaction.correct',{surfaceId:'a',interactionId:message.interactionId,projectId:b,expectedVersion:message.interactionVersion});
    const retry:any=env.service.dispatch('message.retry',{runId:first.runId,idempotencyKey:'snap-reprocess'});
    await waitFor(()=>status(env.service,retry.runId)==='completed');
    assert.deepEqual(env.requests.at(-1)!.input.messages.map((m:any)=>m.content),['edited']);
    assert.deepEqual(env.service.dispatch('snapshot.get',{id:run.snapshotId,surfaceId:'a'}),snap);
  } finally { await env.close(); }
});

test('M2 only explicit creation creates projects; exact named creation is atomic with its interaction',async()=>{
  const env=await environment();
  try {
    const first=send(env.service,'project-topic','聊聊数据库项目');
    await waitFor(()=>status(env.service,first.runId)==='completed');
    assert.equal(state(env.service).projects.length,0);
    const created=send(env.service,'project-explicit','创建一个旅行项目');
    await waitFor(()=>status(env.service,created.runId)==='completed');
    assert.equal(state(env.service).projects.length,1);
    assert.equal(state(env.service).projects[0].title,'旅行');
    assert.deepEqual(send(env.service,'project-explicit','创建一个旅行项目'),created);
    assert.equal(state(env.service).projects.length,1);
  } finally { await env.close(); }
});

test('M2 in-flight correction rejects late output, repeated reprocessing stays idempotent and shared-session deletion keeps other work',async()=>{
  const env=await environment('hold');
  try {
    const a=project(env.service,'original');const b=project(env.service,'corrected');scope(env.service,a);
    const first=send(env.service,'late','late question');
    await waitFor(()=>env.requests.length===1);
    const user=state(env.service).messages.find((m:any)=>m.role==='user');
    env.service.dispatch('interaction.correct',{surfaceId:'a',interactionId:user.interactionId,projectId:b,expectedVersion:user.interactionVersion});
    reply(env.requests[0].response,env.requests[0].path,'late result must not overwrite');
    await waitFor(()=>status(env.service,first.runId)==='cancelled');
    assert.equal(env.service.store.db.prepare('SELECT content FROM messages WHERE run_id=?').get(first.runId)!.content,'');
    const retry:any=env.service.dispatch('message.retry',{runId:first.runId,idempotencyKey:'late-retry'});
    await waitFor(()=>env.requests.length===2);
    reply(env.requests[1].response,env.requests[1].path,'corrected answer');
    await waitFor(()=>status(env.service,retry.runId)==='completed');
    const corrected=state(env.service).messages.find((m:any)=>m.id===user.id);
    env.service.dispatch('interaction.correct',{surfaceId:'a',interactionId:user.interactionId,projectId:a,expectedVersion:corrected.interactionVersion});
    const reprocessed:any=env.service.dispatch('message.retry',{runId:first.runId,idempotencyKey:'late-reprocess'});
    assert.deepEqual(env.service.dispatch('message.retry',{runId:first.runId,idempotencyKey:'late-reprocess'}),reprocessed);
    await waitFor(()=>env.requests.length===3);
    reply(env.requests[2].response,env.requests[2].path,'third answer');
    await waitFor(()=>status(env.service,reprocessed.runId)==='completed');
    const another=send(env.service,'shared-keep','another question');
    await waitFor(()=>env.requests.length===4);
    const preview:any=env.service.dispatch('project.deletePreview',{id:b});
    env.service.dispatch('project.delete',{token:preview.token,confirm:true});
    reply(env.requests[3].response,env.requests[3].path,'late derived answer');
    await new Promise(resolve=>setTimeout(resolve,30));
    assert.equal(status(env.service,another.runId),'cancelled');
    assert.equal(env.service.store.db.prepare('SELECT content FROM messages WHERE run_id=?').get(another.runId)!.content,'内容已删除，无法还原');
    assert.equal(env.service.store.db.prepare('SELECT title FROM sessions LIMIT 1').get()!.title,'历史话题（部分内容已删除）');
    const fragments=JSON.parse(String(env.service.store.db.prepare('SELECT fragments_json FROM context_snapshots WHERE run_id=?').get(another.runId)!.fragments_json));
    assert.ok(fragments.some((f:any)=>f.deleted===true));
    assert.equal(JSON.stringify(fragments).includes('third answer'),false);
    assert.equal(env.service.store.db.prepare('PRAGMA foreign_key_check').all().length,0);
  } finally {await env.close();}
});
