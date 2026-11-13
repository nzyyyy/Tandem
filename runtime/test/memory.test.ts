import { test } from 'node:test';
import assert from 'node:assert/strict';
import { copyFileSync, mkdtempSync, readdirSync, rmSync, statSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { AppService } from '../src/service.ts';
import { memoryFragmentValid } from '../src/memory.ts';

function fixture() {
  const directory=mkdtempSync('/tmp/tandem-m4-');
  let app=new AppService(directory);
  const config={schemaVersion:1,modelConnections:[{id:'mock',protocol:'openai',apiType:'chat_completions',url:'http://127.0.0.1:1/v1',key:'m4-private-key-123456',modelNames:['test']}],defaultModel:{connectionId:'mock',modelName:'test'}};
  app.dispatch('config.save',{config,expectedRevision:'missing'});
  const project=(title='项目')=>(app.dispatch('project.create',{title,description:''}) as any).id;
  const scope=(projectId: string|null,mode='automatic',surfaceId='a')=>{
    const focus=app.store.focus(surfaceId);
    app.dispatch('context.set',{surfaceId,projectId,mode,expectedVersion:focus.version});
  };
  const receive=(input: string,extra={})=>{
    // Use the production router/commit without kicking off a network job.
    const result=app.context.receive({surfaceId:'a',text:input,newTopic:true,idempotencyKey:crypto.randomUUID(),...extra}) as any;
    assert.ok(result.runId);
    return app.store.db.prepare('SELECT * FROM runs WHERE id=?').get(result.runId)!;
  };
  const memories=()=>app.store.db.prepare('SELECT * FROM memories ORDER BY rowid').all();
  const save=(run: any,content='SQLite',extra={})=>app.dispatch('memory.save',{surfaceId:'a',messageId:run.user_message_id,expectedInteractionVersion:run.interaction_version,kind:'decision',subject:'项目',predicate:'数据库',content,confirmed:true,...extra}) as any;
  return {get app(){return app;},directory,config,project,scope,receive,memories,save,
    reopen:async()=>{await app.stop();app=new AppService(directory);},
    close:async()=>{await app.stop();rmSync(directory,{recursive:true,force:true});}};
}
const mutation=(m:any,extra={})=>({surfaceId:'a',id:m.id,expectedVersion:m.version,...extra});

test('M4 direct facts auto-save with user evidence, no fake confirmation, and reject uncertain or sensitive input',async()=>{
  const f=fixture();
  try {
    const run=f.receive('我平时主要用 Swift 开发');
    const [fact]=f.memories();
    assert.equal(fact.kind,'fact'); assert.equal(fact.status,'active'); assert.equal(fact.content,'Swift'); assert.equal(fact.confirmed_at,null);
    assert.equal(fact.origin,'user_statement');
    const detail:any=f.app.dispatch('memory.get',{surfaceId:'a',id:fact.id});
    assert.equal(detail.evidence[0].message_id,run.user_message_id);
    assert.equal(detail.evidence[0].content,'我平时主要用 Swift 开发');
    assert.equal(detail.evidence[0].session_id,run.session_id);
    for(const s of ['假如我主要用 Rust 开发','例如我主要用 Java 开发','他说我主要用 Python 开发','“我主要用 Go 开发”','我可能主要用 C 开发','我主要用 Swift 开发？','我主要用密码开发','我主要用 m4-private-key-123456 开发','今天吃饭了']) f.receive(s);
    assert.equal(f.memories().length,1);
    f.app.context.memory.extract(String(run.interaction_id));
    assert.equal(f.memories().length,1);
    assert.equal(f.app.store.db.prepare('SELECT COUNT(*) AS n FROM memory_evidence').get()!.n,1);
    assert.throws(()=>f.save(run,'secret password'),/MEMORY_SENSITIVE/);
    const other=f.receive('普通用户消息');
    assert.throws(()=>f.save({...other,user_message_id:other.assistant_message_id}),/MEMORY_EVIDENCE_CHANGED/);
    await f.reopen();
    assert.equal(f.memories()[0].id,fact.id);
    const matches:any=f.app.dispatch('memory.list',{surfaceId:'a',query:'Swift'});
    assert.equal(matches.memories.length,1);
  } finally {await f.close();}
});

test('M4 explicit decisions supersede by normalized key and scope; candidates cannot overwrite; cross-session snapshots cite current evidence',async()=>{
  const f=fixture();
  try {
    const project=f.project(); f.scope(project);
    f.receive('确认项目数据库使用 PostgreSQL');
    const first=f.memories()[0]; assert.equal(first.status,'active'); assert.ok(first.confirmed_at);
    f.receive('将项目存储方案从 PostgreSQL 改为 SQLite');
    const [,second]=f.memories();
    assert.equal(f.memories()[0].status,'superseded'); assert.equal(second.supersedes_id,first.id); assert.equal(second.predicate,'数据库');
    const candidate=f.receive('考虑使用 MySQL');
    f.save(candidate,'MySQL',{confirmed:false});
    assert.equal(f.memories().at(-1)!.status,'candidate');
    f.save(candidate,'SQLite',{kind:'fact',confirmed:false});
    assert.equal(f.memories().at(-1)!.status,'candidate');
    assert.equal(f.memories().find(m=>m.id===second.id)!.status,'active');
    const run=f.receive('继续架构设计');
    const messages=f.app.context.snapshot(run,f.config as any);
    assert.ok(messages[0].content.includes('SQLite')); assert.equal(messages.some(m=>m.content.includes('PostgreSQL')),false);
    assert.ok(messages[0].content.includes('messageId')); assert.ok(messages[0].content.includes('confirmedAt'));
    const fragments=JSON.parse(String(f.app.store.db.prepare('SELECT fragments_json FROM context_snapshots WHERE id=(SELECT snapshot_id FROM runs WHERE id=?)').get(run.id)!.fragments_json));
    assert.equal(fragments[0].sourceType,'memory'); assert.equal(fragments[0].sourceId,second.id);
    assert.equal(fragments[0].sourceVersion,'1');
    const old:any=f.app.dispatch('memory.get',{surfaceId:'a',id:first.id}); assert.equal(old.evidence.length,1);
    const other=f.project('另一个项目'); f.scope(other,'isolated');
    assert.equal((f.app.dispatch('memory.list',{surfaceId:'a'}) as any).memories.length,0);
    assert.throws(()=>f.app.dispatch('memory.get',{surfaceId:'a',id:second.id}),/CONTEXT_SCOPE/);
    f.receive('确认项目数据库使用 MySQL');
    assert.equal(f.memories().filter(m=>m.status==='active').length,2);
    assert.equal(f.app.context.memory.retrieve(other,'数据库')[0].content.includes('MySQL'),true);
    f.receive('确认项目技术栈使用 Node 1.2');
    f.receive('确认项目技术栈使用 Node 12');
    assert.deepEqual(f.memories().filter(m=>m.predicate==='技术栈').map(m=>[m.content,m.status]),[['Node 1.2','superseded'],['Node 12','active']]);
    assert.equal(f.app.store.db.prepare('PRAGMA foreign_key_check').all().length,0);
  } finally {await f.close();}
});

test('M4 correction pauses sole evidence, cancels dependent execution and preserves audit; reprocessing cannot transfer confirmation',async()=>{
  const f=fixture();
  try {
    const a=f.project('原项目'),b=f.project('目标项目'); f.scope(a);
    const source=f.receive('确认项目数据库使用 SQLite');
    const m=f.memories()[0];
    const dependent=f.receive('继续数据库设计'); f.app.context.snapshot(dependent,f.config as any);
    const fragments=f.app.store.db.prepare('SELECT fragments_json FROM context_snapshots WHERE run_id=?').get(dependent.id)!.fragments_json;
    f.app.dispatch('interaction.correct',{surfaceId:'a',interactionId:source.interaction_id,projectId:b,expectedVersion:source.interaction_version});
    const suspended=f.memories()[0]; assert.equal(suspended.status,'suspended');
    assert.equal(f.app.store.db.prepare('SELECT valid FROM memory_evidence WHERE memory_id=?').get(m.id)!.valid,0);
    assert.equal(f.app.store.db.prepare('SELECT status FROM runs WHERE id=?').get(dependent.id)!.status,'cancelled');
    assert.equal(f.app.store.db.prepare('SELECT fragments_json FROM context_snapshots WHERE run_id=?').get(dependent.id)!.fragments_json,fragments);
    assert.equal(f.app.context.memory.retrieve(a,'SQLite').length,0);
    assert.equal(memoryFragmentValid(f.app.store,{sourceType:'memory',sourceId:m.id,sourceVersion:1,projectId:a}),false);
    assert.throws(()=>f.save(source,'PostgreSQL'),/MEMORY_EVIDENCE_CHANGED/);
    assert.equal(f.app.store.db.prepare("SELECT COUNT(*) AS n FROM memory_outbox WHERE status='done'").get()!.n,1);
    f.app.store.transaction(()=>f.app.context.prepareRetry(source,String(source.id)));
    const candidate=f.memories().find(x=>x.project_id===b)!;
    assert.equal(candidate.status,'candidate'); assert.equal(candidate.confirmed_at,null);
    assert.equal(f.memories().find(x=>x.id===m.id)!.project_id,a);
    assert.equal(f.app.context.memory.retrieve(b,'数据库').length,0);
  } finally {await f.close();}
});

test('M4 independent valid evidence survives correction; inactive old decisions never fill a missing current decision',async()=>{
  const f=fixture();
  try {
    const a=f.project('A'),b=f.project('B'); f.scope(a);
    const first=f.receive('确认项目数据库使用 SQLite');
    f.receive('确认项目存储方案使用 SQLite');
    assert.equal(f.memories().length,1);
    f.app.dispatch('interaction.correct',{surfaceId:'a',interactionId:first.interaction_id,projectId:b,expectedVersion:first.interaction_version});
    assert.equal(f.memories()[0].status,'active'); assert.equal(f.app.context.memory.retrieve(a,'数据库').length,1);
    const latest=f.receive('确认项目数据库使用 PostgreSQL');
    f.app.dispatch('interaction.correct',{surfaceId:'a',interactionId:latest.interaction_id,projectId:b,expectedVersion:latest.interaction_version});
    assert.equal(f.app.context.memory.retrieve(a,'数据库').length,0);
    assert.deepEqual(f.memories().map(m=>m.status),['superseded','suspended']);
  } finally {await f.close();}
});

test('M4 forgetting clears FTS, snapshots, checkpoints and transitive outputs; markers survive restart and block stale extraction',async()=>{
  const f=fixture();
  try {
    const project=f.project(); f.scope(project);
    const origin=f.receive('确认项目数据库使用 SQLite'); const m=f.memories()[0];
    const run=f.receive('继续设计'); f.app.context.snapshot(run,f.config as any);
    const snap=f.app.store.db.prepare('SELECT * FROM context_snapshots WHERE run_id=?').get(run.id)!;
    f.app.store.db.prepare('UPDATE messages SET content=? WHERE id=?').run('SQLite 派生回答',run.assistant_message_id);
    f.app.store.runStatus(String(run.id),'completed');
    f.app.store.db.prepare('UPDATE run_progress SET checkpoint=? WHERE run_id=?').run(JSON.stringify({messages:[{role:'user',content:'SQLite'}],fragments:JSON.parse(String(snap.fragments_json))}),run.id);
    const next=f.receive('详细解释',{newTopic:false,sessionId:run.session_id});
    f.app.context.snapshot(next,f.config as any);
    const unchanged=f.receive('独立未引用记录');
    const originalMessages=f.app.store.db.prepare('SELECT COUNT(*) AS n FROM messages').get()!.n;
    f.app.dispatch('memory.forget',mutation(m));
    assert.equal(f.memories().length,0);
    assert.equal(f.app.store.db.prepare('SELECT COUNT(*) AS n FROM memory_search').get()!.n,0);
    assert.equal(f.app.store.db.prepare('SELECT COUNT(*) AS n FROM messages').get()!.n,originalMessages);
    assert.equal(f.app.store.db.prepare('SELECT content FROM messages WHERE id=?').get(origin.user_message_id)!.content,'确认项目数据库使用 SQLite');
    assert.equal(f.app.store.db.prepare('SELECT content FROM messages WHERE id=?').get(run.assistant_message_id)!.content,'内容已删除，无法还原');
    assert.equal(f.app.store.db.prepare('SELECT checkpoint FROM run_progress WHERE run_id=?').get(run.id)!.checkpoint,null);
    const sanitized=f.app.store.db.prepare('SELECT fragments_json FROM context_snapshots WHERE id=?').get(snap.id)!;
    assert.equal(String(sanitized.fragments_json).includes('SQLite'),false);
    assert.equal(f.app.store.db.prepare('SELECT status FROM runs WHERE id=?').get(next.id)!.status,'cancelled');
    assert.equal(f.app.store.db.prepare('SELECT status FROM runs WHERE id=?').get(unchanged.id)!.status,'queued');
    const marker=f.app.store.db.prepare('SELECT * FROM memory_forget_markers').get()!;
    assert.equal(JSON.stringify(marker).includes('SQLite'),false);
    assert.equal(JSON.parse(String(marker.evidence_ids)).includes(run.assistant_message_id),true);
    f.app.store.transaction(()=>f.app.context.memory.extract(String(origin.interaction_id)));
    assert.equal(f.memories().length,0);
    assert.throws(()=>f.save(origin),/MEMORY_FORGOTTEN/);
    await f.reopen();
    assert.throws(()=>f.save(origin),/MEMORY_FORGOTTEN/);
    f.app.dispatch('memory.allow',{surfaceId:'a',id:marker.id,confirm:true});
    assert.equal(f.memories().length,0);
    f.app.store.transaction(()=>f.app.context.memory.extract(String(origin.interaction_id)));
    assert.equal(f.memories()[0].status,'active');
    assert.equal(f.app.store.db.prepare('PRAGMA foreign_key_check').all().length,0);
  } finally {await f.close();}
});

test('M4 inspector confirms candidates, preserves edited versions, and rolls back forgetting atomically',async()=>{
  const f=fixture();
  try {
    const p=f.project(); f.scope(p); const run=f.receive('数据库选型待核验');
    const {id}=f.save(run,'SQLite',{confirmed:false});
    const candidate=f.memories()[0]; assert.equal(candidate.status,'candidate');
    f.app.dispatch('memory.confirm',mutation(candidate,{confirm:true}));
    let active=f.memories().find(x=>x.status==='active')!;
    f.app.dispatch('memory.update',mutation(active,{content:'PostgreSQL',confirm:true}));
    const latest=f.memories().find(x=>x.status==='active')!;
    assert.equal(latest.content,'PostgreSQL'); assert.equal(latest.supersedes_id,active.id);
    assert.equal(f.memories().find(x=>x.id===id)!.status,'superseded');
    assert.throws(()=>f.app.dispatch('memory.update',mutation(active,{content:'MySQL',confirm:true})),/MEMORY_CONFLICT/);
    f.app.store.db.exec("CREATE TRIGGER fail_memory_delete BEFORE DELETE ON memories BEGIN SELECT RAISE(ABORT,'injected'); END;");
    assert.throws(()=>f.app.dispatch('memory.forget',mutation(latest)),/injected/);
    assert.equal(f.memories().find(x=>x.id===latest.id)!.status,'active');
    assert.equal(f.app.store.db.prepare('SELECT COUNT(*) AS n FROM memory_forget_markers').get()!.n,0);
    assert.equal(f.app.store.db.prepare('SELECT COUNT(*) AS n FROM memory_search').get()!.n,1);
    assert.ok(f.app.context.memory.retrieve(p,'数据库')[0].content.includes('PostgreSQL'));
  } finally {await f.close();}
});

test('M4 global memory is eligible in automatic/pinned, excluded in isolated, and unconfirmed evidence cannot keep a decision active',async()=>{
  const f=fixture();
  try {
    f.receive('我主要用 Swift 开发');
    const p=f.project(); f.scope(p);
    const run=f.receive('Swift 开发');
    f.app.context.snapshot(run,f.config as any);
    const s=f.app.store.db.prepare('SELECT * FROM context_snapshots WHERE run_id=?').get(run.id)!;
    const fragments=JSON.parse(String(s.fragments_json));
    assert.equal(fragments[0].sourceType,'memory'); assert.equal(fragments[0].projectId,null);
    f.app.store.db.prepare('UPDATE run_progress SET checkpoint=? WHERE run_id=?').run(JSON.stringify({messages:[],fragments}),run.id);
    assert.doesNotThrow(()=>f.app.execution.valid(run));
    f.scope(p,'pinned');
    assert.doesNotThrow(()=>f.app.dispatch('snapshot.get',{surfaceId:'a',id:s.id}));
    f.scope(p,'isolated');
    assert.throws(()=>f.app.dispatch('snapshot.get',{surfaceId:'a',id:s.id}),/CONTEXT_SCOPE/);
    const isolated=f.receive('Swift 开发');
    assert.equal(f.app.context.snapshot(isolated,f.config as any).some(m=>m.content.includes('长期记忆')),false);
    const source=f.receive('确认项目数据库使用 SQLite');
    const unconfirmed=f.receive('SQLite 尚待确认'); f.save(unconfirmed,'SQLite',{confirmed:false});
    assert.equal(f.memories().filter(m=>m.status==='candidate').length,1);
    const b=f.project('B');
    f.scope(p);
    f.app.dispatch('interaction.correct',{surfaceId:'a',interactionId:source.interaction_id,projectId:b,expectedVersion:source.interaction_version});
    assert.equal(f.app.context.memory.retrieve(p,'数据库').length,0);
  } finally {await f.close();}
});

test('M4 project deletion previews and removes memories and evidence, preserving unrelated scopes and forget markers',async()=>{
  const f=fixture();
  try {
    const a=f.project('A'),b=f.project('B'); f.scope(a);
    f.receive('确认项目数据库使用 SQLite');
    f.scope(b); f.receive('我主要用 Swift 开发'); const fact=f.memories().at(-1)!;
    f.app.dispatch('memory.forget',mutation(fact));
    f.receive('确认项目数据库使用 PostgreSQL');
    const preview:any=f.app.dispatch('project.deletePreview',{id:a});
    assert.equal(preview.memories.length,1);
    f.app.dispatch('project.delete',{token:preview.token,confirm:true});
    assert.equal(f.memories().length,1); assert.equal(f.memories()[0].project_id,b);
    assert.equal(f.app.store.db.prepare('SELECT COUNT(*) AS n FROM memory_forget_markers').get()!.n,1);
    assert.equal(f.app.store.db.prepare('PRAGMA foreign_key_check').all().length,0);
  } finally {await f.close();}
});

test('M4 transitive answers and model-created Task text cannot bypass isolated scope or forgetting',async()=>{
  const f=fixture();
  try {
    f.receive('我主要用 Swift 开发'); const memory=f.memories()[0];
    const p=f.project(); f.scope(p);
    const first=f.receive('Swift 开发');
    f.app.context.snapshot(first,f.config as any);
    const task=await f.app.execution.tool(first,{name:'create_task',callId:'task',arguments:JSON.stringify({deliverable:'Swift 资料总结',criteria:['Swift 实践']})},new AbortController().signal);
    assert.ok(task?.taskId);
    f.app.store.db.prepare('UPDATE messages SET content=? WHERE id=?').run('GLOBAL_DERIVED',first.assistant_message_id);
    f.app.store.runStatus(String(first.id),'completed');
    const second=f.receive('展开细节',{newTopic:false,sessionId:first.session_id});
    f.app.context.snapshot(second,f.config as any);
    f.app.store.db.prepare('UPDATE messages SET content=? WHERE id=?').run('SECOND_DERIVED',second.assistant_message_id);
    f.app.store.runStatus(String(second.id),'completed');
    f.scope(p,'isolated');
    const isolated=f.receive('继续说明',{newTopic:false,sessionId:first.session_id});
    const input=f.app.context.snapshot(isolated,f.config as any);
    assert.equal(JSON.stringify(input).includes('GLOBAL_DERIVED'),false);
    assert.equal(JSON.stringify(input).includes('SECOND_DERIVED'),false);
    const policy={sourceType:'runtime_policy',sourceId:isolated.id,sourceVersion:'1',projectId:p,taskId:task!.taskId,taskRevision:1,role:'user',content:'Swift 资料总结'};
    f.app.execution.save(isolated,[{role:'user',content:policy.content}],[policy]);
    assert.throws(()=>f.app.execution.valid(isolated),/MEMORY_UNAVAILABLE/);
    f.scope(p);
    const carrier=f.receive('任务继续');
    f.app.context.snapshot(carrier,f.config as any);
    f.app.execution.save(carrier,[{role:'user',content:policy.content}],[{...policy,sourceId:carrier.id}]);
    assert.doesNotThrow(()=>f.app.execution.valid(carrier));
    f.app.dispatch('memory.forget',mutation(memory));
    const revision=f.app.store.db.prepare('SELECT * FROM task_revisions WHERE task_id=?').get(task!.taskId)!;
    assert.equal(String(revision.deliverable).includes('Swift'),false);
    assert.equal(String(revision.criteria).includes('Swift'),false);
    assert.equal(f.app.store.db.prepare('SELECT status FROM runs WHERE id=?').get(carrier.id)!.status,'cancelled');
    assert.equal(f.app.store.db.prepare('SELECT COUNT(*) AS n FROM invocations WHERE run_id=?').get(first.id)!.n,0);
    const copied=f.app.store.db.prepare('SELECT fragments_json FROM context_snapshots WHERE run_id=?').all(carrier.id);
    assert.equal(copied.some(s=>String(s.fragments_json).includes('Swift')),false);
    assert.equal(f.app.store.db.prepare('PRAGMA foreign_key_check').all().length,0);
  } finally {await f.close();}
});

test('M4 migration protects committed WAL, validates rollback, and rejects future versions',async()=>{
  const f=fixture(); const directory=mkdtempSync('/tmp/tandem-m4-rollback-');
  try {
    const path=`${f.directory}/migrations/${readdirSync(`${f.directory}/migrations`).find(n=>n.startsWith('schema-3-'))}`;
    assert.equal(statSync(path).mode&0o777,0o600);
    copyFileSync(path,`${directory}/tandem.sqlite`);
    const old=new DatabaseSync(`${directory}/tandem.sqlite`);
    old.exec("PRAGMA journal_mode=WAL; INSERT INTO sessions(id,title,temporary,created_at,updated_at) VALUES('keep','committed WAL',0,1,1); CREATE TABLE memories(conflict TEXT);");
    assert.throws(()=>new AppService(directory));
    assert.equal(old.prepare('PRAGMA user_version').get()!.user_version,3);
    assert.equal(old.prepare("SELECT 1 FROM sqlite_master WHERE name='memory_evidence'").get(),undefined);
    const protection=`${directory}/migrations/${readdirSync(`${directory}/migrations`)[0]}`;
    const copy=new DatabaseSync(protection,{readOnly:true});
    assert.equal(copy.prepare("SELECT title FROM sessions WHERE id='keep'").get()!.title,'committed WAL'); copy.close();
    old.exec('DROP TABLE memories'); old.close();
    const updated=new AppService(directory);
    assert.equal(updated.store.db.prepare('PRAGMA user_version').get()!.user_version,4);
    assert.equal(updated.store.db.prepare('PRAGMA foreign_key_check').all().length,0); await updated.stop();
    const future=new DatabaseSync(`${directory}/tandem.sqlite`); future.exec('PRAGMA user_version=5'); future.close();
    assert.throws(()=>new AppService(directory),/DATABASE_VERSION/);
  } finally {await f.close();rmSync(directory,{recursive:true,force:true});}
});

test('M4 end to end: current decision reaches actual model input across sessions and app restart',async()=>{
  const requests:any[]=[];
  const server=createServer(async(req,res)=>{
    const chunks=[]; for await(const chunk of req) chunks.push(chunk);
    requests.push(JSON.parse(Buffer.concat(chunks).toString()));
    res.setHeader('content-type','application/json'); res.end(JSON.stringify({choices:[{message:{content:'采用现行 SQLite 决策，来源可查'},finish_reason:'stop'}]}));
  });
  server.listen(0,'127.0.0.1'); await once(server,'listening');
  const f=fixture();
  try {
    const config={...f.config,modelConnections:[{...f.config.modelConnections[0],url:`http://127.0.0.1:${(server.address() as any).port}/v1`}]};
    const doc:any=f.app.dispatch('config.get',{}); f.app.dispatch('config.save',{config,expectedRevision:doc.revision});
    const p=f.project(); f.scope(p);
    const original:any=f.app.dispatch('message.send',{surfaceId:'a',text:'确认项目数据库使用 PostgreSQL',newTopic:true,idempotencyKey:crypto.randomUUID()});
    const wait=async(id:string)=>{for(let i=0;i<300;i++){const status=f.app.store.db.prepare('SELECT status FROM runs WHERE id=?').get(id)!.status;if(status==='completed')return;await new Promise(r=>setTimeout(r,10));}throw new Error('TIMEOUT');};
    await wait(original.runId);
    const changed:any=f.app.dispatch('message.send',{surfaceId:'a',text:'将项目存储方案从 PostgreSQL 改为 SQLite',newTopic:true,idempotencyKey:crypto.randomUUID()}); await wait(changed.runId);
    await f.reopen(); f.scope(p,'isolated');
    const resumed:any=f.app.dispatch('message.send',{surfaceId:'a',text:'继续数据库设计',newTopic:true,idempotencyKey:crypto.randomUUID()}); await wait(resumed.runId);
    const input=JSON.stringify(requests.at(-1).messages);
    assert.ok(input.includes('SQLite')); assert.ok(input.includes('messageId')); assert.equal(input.includes('PostgreSQL'),false);
    assert.equal(input.includes('m4-private-key-123456'),false);
    assert.equal(f.memories().filter(m=>m.status==='active').length,1);
  } finally {await f.close();server.closeAllConnections();server.close();}
});
