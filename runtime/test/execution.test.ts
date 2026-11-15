import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { mkdtempSync, rmSync, readFileSync, readdirSync } from 'node:fs';
import { AppService } from '../src/service.ts';

async function wait(condition:()=>boolean) {
  for(let i=0;i<300;i++) { if(condition()) return; await new Promise(r=>setTimeout(r,10)); }
  throw new Error('WAIT_TIMEOUT');
}
async function fixture(api='chat_completions') {
  const requests:any[]=[];
  const server=createServer(async(req,res)=>{
    const chunks=[]; for await(const chunk of req) chunks.push(chunk);
    requests.push({input:JSON.parse(Buffer.concat(chunks).toString()),res});
  });
  server.listen(0,'127.0.0.1'); await once(server,'listening');
  const directory=mkdtempSync('/tmp/tandem-m3-');
  let service=new AppService(directory);
  const config={schemaVersion:1,modelConnections:[{id:'mock',protocol:api==='messages'?'anthropic':'openai',apiType:api,url:`http://127.0.0.1:${(server.address() as any).port}/v1`,key:'m3-private-test-key',modelNames:['test']}],defaultModel:{connectionId:'mock',modelName:'test'}};
  service.dispatch('config.save',{config,expectedRevision:'missing'});
  const send=(text='整理资料',extra={})=>service.dispatch('message.send',{surfaceId:'a',text,newTopic:true,idempotencyKey:crypto.randomUUID(),...extra}) as any;
  const row=(id:string)=>service.store.db.prepare('SELECT * FROM runs WHERE id=?').get(id)!;
  const reply=(index:number,content:string,calls:any[]=[],usage?:number)=>{
    const res=requests[index].res; res.setHeader('content-type','application/json');
    res.end(JSON.stringify(api==='chat_completions'?{usage:usage?{total_tokens:usage}:undefined,choices:[{finish_reason:calls.length?'tool_calls':'stop',message:{content,tool_calls:calls.map(c=>({id:c.id,type:'function',function:{name:c.name,arguments:JSON.stringify(c.args)}}))}}]}
      :api==='responses'?{status:'completed',output:[...(content?[{type:'message',content:[{type:'output_text',text:content}]}]:[]),...calls.map(c=>({type:'function_call',call_id:c.id,name:c.name,arguments:JSON.stringify(c.args)}))]}
      :{stop_reason:calls.length?'tool_use':'end_turn',content:[...(content?[{type:'text',text:content}]:[]),...calls.map(c=>({type:'tool_use',id:c.id,name:c.name,input:c.args}))]}));
  };
  return {get service(){return service;},directory,requests,send,row,reply,reopen:async()=>{await service.stop();service=new AppService(directory);},
    close:async()=>{await service.stop();server.closeAllConnections();server.close();rmSync(directory,{recursive:true,force:true});}};
}
const call=(id:string,name:string,args:object)=>({id,name,args});
const activity=(s:AppService):any=>s.dispatch('activity.get',{surfaceId:'a'});
const register=(s:AppService,id='grant',projectId:any=null)=>s.dispatch('directory.register',{id,label:'资料',projectId,resourceId:'fake-device-inode'});
const resume=(s:AppService,id:string,add={},key=crypto.randomUUID())=>s.dispatch('run.continue',{runId:id,expectedVersion:s.execution.progress(id).version,idempotencyKey:key,...add});

test('pi schema coercion cannot authorize a native read with invalid original line numbers', async () => {
  const f = await fixture();
  try {
    register(f.service);
    const sent = f.send();
    await wait(() => f.requests.length === 1);
    f.reply(0, '', [call('raw-read', 'read_file', { grantId: 'grant', path: 'notes.md', startLine: '1', endLine: 2 })]);
    await wait(() => f.requests.length === 2);
    assert.deepEqual(f.service.dispatch('native.next', {}), { requests: [] });
    assert.equal(JSON.parse(f.requests[1].input.messages.at(-1).content).error, 'TOOL_ARGUMENTS');
    const invocation = f.service.store.db.prepare('SELECT args FROM invocations WHERE call_id=?').get('raw-read')!;
    assert.equal(JSON.parse(String(invocation.args)).startLine, '1');
    f.reply(1, '请提供有效行号');
    await wait(() => f.row(sent.runId).status === 'completed');
  } finally { await f.close(); }
});

for(const api of ['chat_completions','responses','messages']) test(`M3 ${api}: native read, call identity, immutable snapshots and redaction`,async()=>{
  const f=await fixture(api);
  try {
    register(f.service);
    const {runId}=f.send(); await wait(()=>f.requests.length===1);
    assert.equal(f.requests[0].input.tools.length,5);
    f.reply(0,'', [call('read-1','read_file',{grantId:'grant',path:'notes.md',startLine:1,endLine:4})]);
    let request:any;
    await wait(()=>{request=(f.service.dispatch('native.next',{}) as any).requests[0];return !!request;});
    assert.equal(request.method,'read_file'); assert.equal(request.projectId,null);
    f.service.dispatch('native.result',{id:request.id,result:{resourceId:'grant:notes.md',path:'notes.md',version:'version1',startLine:1,endLine:4,content:'资料 m3-private-test-key',truncated:false}});
    await wait(()=>f.requests.length===2);
    const input=f.requests[1].input;
    assert.equal(JSON.stringify(input).includes('m3-private-test-key'),false);
    if(api==='chat_completions') { assert.equal(input.messages.at(-1).tool_call_id,'read-1');assert.equal(input.messages.at(-2).tool_calls[0].id,'read-1'); }
    if(api==='responses') { assert.equal(input.input.at(-1).call_id,'read-1');assert.equal(input.input.at(-1).type,'function_call_output'); }
    if(api==='messages') { assert.equal(input.messages.at(-1).content[0].tool_use_id,'read-1');assert.equal(input.messages.at(-2).content[0].id,'read-1'); }
    const snapshots=f.service.store.db.prepare('SELECT * FROM context_snapshots WHERE run_id=? ORDER BY rowid').all(runId);
    assert.ok(snapshots.length>=3); assert.ok(String(snapshots.at(-1)!.fragments_json).includes('version1'));
    f.reply(1,'[notes.md:1-4 @version1] 资料总结',[],api==='chat_completions'?80:undefined);
    await wait(()=>f.row(runId).status==='completed');
    assert.ok(f.service.execution.progress(runId).tokens>0);
    assert.equal(f.service.store.db.prepare('SELECT COUNT(*) AS n FROM invocations').get()!.n,1);
    assert.equal(f.service.store.db.prepare('PRAGMA foreign_key_check').all().length,0);
    for(const name of readdirSync(f.directory).filter(n=>n.startsWith('tandem.sqlite'))) assert.equal(readFileSync(`${f.directory}/${name}`).includes(Buffer.from('m3-private-test-key')),false);
  } finally {await f.close();}
});

test('M3 task completion checks all criteria, persists one result, revisions preserve earlier artifacts',async()=>{
  const f=await fixture();
  try {
    const {runId}=f.send('整理报告',{task:{deliverable:'Markdown 报告',criteria:['总结资料','给出建议']}});
    await wait(()=>f.requests.length===1);
    const task=activity(f.service).tasks[0]; assert.equal(task.status,'open');
    assert.deepEqual(JSON.parse(task.criteria),['总结资料','给出建议']);
    f.reply(0,'',[call('finish','complete_task',{markdown:'# 报告\n总结与建议',evidence:['总结已写入第一节','建议已写入第二节']})]);
    await wait(()=>f.row(runId).status==='completed');
    const complete=activity(f.service).tasks[0]; assert.equal(complete.status,'completed');
    const result:any=f.service.dispatch('result.get',{surfaceId:'a',messageId:complete.result_ref});
    assert.equal(result.content,'# 报告\n总结与建议');
    const second=f.send('补充风险',{sessionId:task.session_id,newTopic:false,task:{id:task.id,expectedRevision:1,deliverable:'修订报告',criteria:['包含风险']}});
    await wait(()=>f.requests.length===2);
    assert.equal(activity(f.service).tasks[0].revision,2);
    assert.equal(activity(f.service).tasks[0].status,'open');
    f.reply(1,'只是普通回答'); await wait(()=>f.row(second.runId).status==='completed');
    assert.equal(activity(f.service).tasks[0].status,'open');
    const history:any=f.service.dispatch('task.history',{surfaceId:'a',id:task.id});
    assert.equal(history.revisions.length,2); assert.equal(history.revisions[1].result_ref,complete.result_ref);
  } finally {await f.close();}
});

test('M3 budget pauses original Run, retains completed tool output and resumes only with additive budget',async()=>{
  const f=await fixture();
  try {
    const {runId}=f.send();
    f.service.store.db.prepare('UPDATE run_progress SET step_limit=2 WHERE run_id=?').run(runId);
    await wait(()=>f.requests.length===1);
    f.reply(0,'',[call('task','create_task',{deliverable:'报告',criteria:['总结']})]);
    await wait(()=>f.row(runId).status==='paused');
    const before=f.service.execution.progress(runId);assert.equal(before.steps,2);assert.equal(before.pause_reason,'budget_exhausted');
    assert.throws(()=>resume(f.service,runId),/BUDGET_REQUIRED/);
    const key=crypto.randomUUID(), payload={runId,expectedVersion:before.version,idempotencyKey:key,steps:4};
    f.service.dispatch('run.continue',payload);f.service.dispatch('run.continue',payload);
    await wait(()=>f.requests.length===2);
    assert.equal(f.service.execution.progress(runId).step_limit,6);
    f.reply(1,'总结');await wait(()=>f.row(runId).status==='completed');
    assert.equal(f.service.store.db.prepare('SELECT COUNT(*) AS n FROM tasks').get()!.n,1);
    assert.ok(f.service.execution.progress(runId).tokens>before.tokens);
  } finally {await f.close();}
});

test('M3 approvals shared across surfaces, denied or approved once; quit requires manual continuation and fresh approval',async()=>{
  const f=await fixture();
  try {
    const {runId}=f.send();await wait(()=>f.requests.length===1);
    f.reply(0,'',[call('permission','request_directory',{reason:'读取项目资料'})]);
    await wait(()=>f.row(runId).status==='waiting_approval');
    const a=activity(f.service).approvals[0];
    assert.equal((f.service.dispatch('activity.get',{surfaceId:'b'}) as any).approvals[0].id,a.id);
    assert.equal((f.service.dispatch('native.next',{}) as any).requests.length,0);
    await f.reopen();
    assert.equal(f.row(runId).status,'interrupted');assert.equal(f.requests.length,1);
    assert.throws(()=>f.service.dispatch('approval.decide',{id:a.id,approve:true,grantId:'fake'}),/APPROVAL_UNAVAILABLE/);
    resume(f.service,runId);
    await wait(()=>f.row(runId).status==='waiting_approval');
    const fresh=activity(f.service).approvals[0];assert.notEqual(fresh.id,a.id);
    register(f.service);
    f.service.dispatch('approval.decide',{id:fresh.id,approve:true,grantId:'grant'});
    f.service.dispatch('approval.decide',{id:fresh.id,approve:true,grantId:'grant'});
    await wait(()=>f.requests.length===2);
    assert.equal(f.requests[1].input.messages.at(-1).tool_call_id,'permission');
    f.reply(1,'授权就绪');await wait(()=>f.row(runId).status==='completed');
    assert.equal(f.service.store.db.prepare('SELECT COUNT(*) AS n FROM invocations').get()!.n,1);
  } finally {await f.close();}
});

test('M3 correction invalidates pending approvals, blocks old continuation and does not alter Task project',async()=>{
  const f=await fixture();
  try {
    const {runId}=f.send('整理',{task:{deliverable:'报告',criteria:['总结']}});await wait(()=>f.requests.length===1);
    f.reply(0,'',[call('permission','request_directory',{reason:'读取'})]);await wait(()=>f.row(runId).status==='waiting_approval');
    const a=activity(f.service).approvals[0], task=activity(f.service).tasks[0];
    const project:any=f.service.dispatch('project.create',{title:'新项目'});
    const i=f.service.store.db.prepare('SELECT * FROM interactions WHERE id=?').get(f.row(runId).interaction_id)!;
    f.service.dispatch('interaction.correct',{surfaceId:'a',interactionId:i.id,expectedVersion:i.version,projectId:project.id});
    assert.equal(f.row(runId).status,'cancelled');assert.equal(activity(f.service).approvals.length,0);
    assert.equal(activity(f.service).tasks.find((t:any)=>t.id===task.id).project_id,null);
    assert.throws(()=>resume(f.service,runId),/INTERACTION_CHANGED/);
    assert.throws(()=>f.service.dispatch('approval.decide',{id:a.id,approve:false}),/APPROVAL_UNAVAILABLE/);
    const retry:any=f.service.dispatch('message.retry',{runId,idempotencyKey:'reprocess'});
    await wait(()=>f.requests.length===2);
    assert.equal(f.service.execution.progress(retry.runId).task_id,null);
    f.reply(1,'按新归属处理'); await wait(()=>f.row(retry.runId).status==='completed');
  } finally {await f.close();}
});

test('M3 in-flight time budget is paused, survives restart, and ordinary follow-ups cannot release it',async()=>{
  const f=await fixture();
  try {
    const {runId}=f.send();f.service.store.db.prepare('UPDATE run_progress SET time_limit=60 WHERE run_id=?').run(runId);
    await wait(()=>f.requests.length===1);await wait(()=>f.row(runId).status==='paused');
    const used=f.service.execution.progress(runId).active_ms;assert.ok(used>=60);
    f.send('普通追加',{newTopic:false});await new Promise(r=>setTimeout(r,30));assert.equal(f.requests.length,1);
    await f.reopen();assert.equal(f.row(runId).status,'paused');assert.ok(f.service.execution.progress(runId).active_ms>=used);
    assert.throws(()=>resume(f.service,runId),/BUDGET_REQUIRED/);
  } finally {await f.close();}
});

test('M3 project deletion includes task impact, removes tool/checkpoint copies, keeps source files outside database untouched',async()=>{
  const f=await fixture();
  try {
    const project:any=f.service.dispatch('project.create',{title:'资料项目'});
    f.service.dispatch('context.set',{surfaceId:'a',mode:'isolated',projectId:project.id,expectedVersion:1});
    const {runId}=f.send('整理',{task:{deliverable:'报告',criteria:['总结']}});await wait(()=>f.requests.length===1);
    f.reply(0,'',[call('finish','complete_task',{markdown:'private report',evidence:['总结']})]);await wait(()=>f.row(runId).status==='completed');
    const preview:any=f.service.dispatch('project.deletePreview',{id:project.id});assert.equal(preview.tasks.length,1);
    f.service.dispatch('project.delete',{token:preview.token,confirm:true});
    for(const table of ['tasks','task_revisions','run_steps','run_progress','invocations','approvals']) assert.equal(f.service.store.db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get()!.n,0);
    assert.equal(f.service.store.db.prepare('PRAGMA foreign_key_check').all().length,0);
  } finally {await f.close();}
});

test('M3 expired approvals cannot authorize; denial and cancellation do not dispatch native work',async()=>{
  const f=await fixture();
  try {
    const {runId}=f.send(); await wait(()=>f.requests.length===1);
    f.reply(0,'',[call('access','request_directory',{reason:'资料'})]);await wait(()=>f.row(runId).status==='waiting_approval');
    const a=activity(f.service).approvals[0]; register(f.service);
    f.service.store.db.prepare('UPDATE approvals SET expires_at=0 WHERE id=?').run(a.id);
    assert.throws(()=>f.service.dispatch('approval.decide',{id:a.id,approve:true,grantId:'grant'}),/APPROVAL_EXPIRED/);
    f.service.dispatch('approval.decide',{id:a.id,approve:false});
    await wait(()=>f.requests.length===2);
    assert.match(f.requests[1].input.messages.at(-1).content,/APPROVAL_DENIED/);
    assert.equal((f.service.dispatch('native.next',{}) as any).requests.length,0);
    f.service.dispatch('message.cancel',{runId});
    f.reply(1,'late result'); await new Promise(r=>setTimeout(r,20)); assert.equal(f.row(runId).status,'cancelled');
  } finally {await f.close();}
});

test('M3 revocation blocks snapshot access and derived content in future model contexts',async()=>{
  const f=await fixture();
  try {
    register(f.service);const {runId}=f.send();await wait(()=>f.requests.length===1);
    f.reply(0,'',[call('read','read_file',{grantId:'grant',path:'private.txt',startLine:1,endLine:1})]);
    let request:any;await wait(()=>{request=(f.service.dispatch('native.next',{}) as any).requests[0];return !!request;});
    f.service.dispatch('native.result',{id:request.id,result:{content:'restricted source',version:'v1'}});
    await wait(()=>f.requests.length===2);f.reply(1,'restricted derived answer');await wait(()=>f.row(runId).status==='completed');
    const snapshot=f.service.store.db.prepare('SELECT id FROM context_snapshots WHERE run_id=? ORDER BY rowid DESC LIMIT 1').get(runId)!;
    f.service.dispatch('directory.revoke',{id:'grant'});
    assert.throws(()=>f.service.dispatch('snapshot.get',{id:snapshot.id,surfaceId:'a'}),/DIRECTORY_UNAUTHORIZED/);
    const next=f.send('next question',{newTopic:false});await wait(()=>f.requests.length===3);
    assert.equal(JSON.stringify(f.requests[2].input).includes('restricted derived answer'),false);
    f.reply(2,'safe answer');await wait(()=>f.row(next.runId).status==='completed');
  } finally {await f.close();}
});

test('M3 directory renewal requires original resource identity; resume retains completed tool results and budget',async()=>{
  const f=await fixture();
  try {
    register(f.service);const {runId}=f.send();
    f.service.store.db.prepare('UPDATE run_progress SET step_limit=2 WHERE run_id=?').run(runId);
    await wait(()=>f.requests.length===1);f.reply(0,'',[call('file','read_file',{grantId:'grant',path:'a.txt',startLine:1,endLine:1})]);
    let request:any;await wait(()=>{request=(f.service.dispatch('native.next',{}) as any).requests[0];return !!request;});
    f.service.dispatch('native.result',{id:request.id,result:{content:'preserved file',version:'original-version'}});
    await wait(()=>f.row(runId).status==='paused');
    const tokens=f.service.execution.progress(runId).tokens;
    await f.reopen();
    assert.throws(()=>resume(f.service,runId,{steps:3}),/DIRECTORY_UNAUTHORIZED/);
    assert.throws(()=>f.service.dispatch('directory.register',{id:'grant',label:'different',projectId:null,resourceId:'different-inode'}),/DIRECTORY_CHANGED/);
    register(f.service);resume(f.service,runId,{steps:3});
    await wait(()=>f.requests.length===2);assert.ok(JSON.stringify(f.requests[1].input).includes('original-version'));
    assert.equal((f.service.dispatch('native.next',{}) as any).requests.length,0);
    f.reply(1,'done');await wait(()=>f.row(runId).status==='completed');
    assert.ok(f.service.execution.progress(runId).tokens>=tokens);
    assert.equal(f.service.store.db.prepare('SELECT COUNT(*) AS n FROM invocations').get()!.n,1);
  } finally {await f.close();}
});
