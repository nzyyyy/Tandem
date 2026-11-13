import { spawn } from 'node:child_process';
import { resolve } from 'node:path';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { DatabaseSync } from 'node:sqlite';

const directory = mkdtempSync('/tmp/tandem-lifecycle-');
const server = createServer(async (request,response) => {
  const chunks=[]; for await(const chunk of request) chunks.push(chunk);
  const body=JSON.parse(Buffer.concat(chunks).toString());
  if (JSON.stringify(body.messages).includes('lifecycle-hold')) return;
  setTimeout(()=>{
    response.setHeader('content-type','application/json');
    response.end(JSON.stringify({choices:[{finish_reason:'tool_calls',message:{content:'',tool_calls:[{id:'background-report',type:'function',function:{name:'complete_task',arguments:JSON.stringify({markdown:'# 后台报告\n关窗后仍已完成',evidence:['报告生成并保存']})}}]}}]}));
  },500);
});
server.listen(0,'127.0.0.1'); await once(server,'listening');
let timer;
try {
  writeFileSync(`${directory}/config.json`,JSON.stringify({schemaVersion:1,modelConnections:[{id:'lifecycle',protocol:'openai',apiType:'chat_completions',url:`http://127.0.0.1:${server.address().port}/v1`,key:'fake-lifecycle-key',modelNames:['lifecycle']}],defaultModel:{connectionId:'lifecycle',modelName:'lifecycle'}}),{mode:0o600});
  const child=spawn(resolve('dist/Tandem.app/Contents/MacOS/Tandem'),['--lifecycle-test'],{env:{...process.env,TANDEM_TEST_DATA_DIR:directory}});
  let stdout='',stderr='';
  child.stdout.on('data',chunk=>{stdout+=chunk;process.stdout.write(chunk);});
  child.stderr.on('data',chunk=>{stderr+=chunk;process.stderr.write(chunk);});
  timer=setTimeout(()=>child.kill('SIGKILL'),20000);
  const [code]=await once(child,'exit');assert.equal(code,0);assert.match(stdout,/PASS App lifecycle/);
  const pids=[...stderr.matchAll(/runtime_started pid=(\d+)/g)].map(match=>Number(match[1]));
  assert.ok(pids.length>0);for(const pid of pids) assert.throws(()=>process.kill(pid,0),{code:'ESRCH'});
  const db=new DatabaseSync(`${directory}/tandem.sqlite`,{readOnly:true});
  try {
    assert.equal(db.prepare("SELECT status FROM tasks").get().status,'completed');
    assert.equal(db.prepare("SELECT status FROM runs WHERE request_key='lifecycle-hold'").get().status,'interrupted');
  } finally {db.close();}
  console.log('PASS bundled Node exited with App; background result persisted and in-flight work interrupted');
} finally {clearTimeout(timer);server.closeAllConnections();server.close();rmSync(directory,{recursive:true,force:true});}
