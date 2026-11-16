import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, renameSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { AppService } from '../src/service.ts';
import { recoverRestore } from '../src/backup.ts';

function fixture() {
  const root = realpathSync(mkdtempSync('/tmp/tandem-backup-'));
  const directory = join(root, 'live');
  let app = new AppService(directory);
  const config = { schemaVersion: 1, modelConnections: [{ id: 'mock', protocol: 'openai', apiType: 'chat_completions', url: 'http://127.0.0.1:1/v1', key: 'backup-private-key-123456', modelNames: ['test'] }], defaultModel: { connectionId: 'mock', modelName: 'test' } };
  app.dispatch('config.save', { config, expectedRevision: 'missing' });
  const call = (method: string, payload = {}): any => app.dispatch(method, payload);
  const receive = (input: string) => {
    const result: any = app.context.receive({ surfaceId: 'a', text: input, newTopic: true, idempotencyKey: randomUUID() });
    assert.ok(result.runId);
    return app.store.db.prepare('SELECT * FROM runs WHERE id=?').get(result.runId)!;
  };
  const path = join(root, 'backup.json');
  return { root, directory, path, config, call, receive, get app() { return app; },
    export: () => call('backup.export', { path }),
    preview: () => call('backup.preview', { path }),
    reopen: async () => { await app.stop(); app = new AppService(directory); },
    close: async () => { await app.stop(); rmSync(root, { recursive: true, force: true }); } };
}

function replaceEntry(manifest: any, path: string, data: Buffer) {
  const entry = manifest.files.find((f: any) => f.path === path);
  entry.data = data.toString('base64'); entry.size = data.length;
  entry.sha256 = createHash('sha256').update(data).digest('hex');
}

test('a fresh installation can create a nested data directory before any restore journal exists', async () => {
  const root = mkdtempSync('/tmp/tandem-fresh-');
  const app = new AppService(join(root, 'new-parent', 'live'));
  try { assert.ok(app.dispatch('runtime.info', {})); }
  finally { await app.stop(); rmSync(root, { recursive: true, force: true }); }
});

test('backup exports committed WAL, bounded attachments and key-free configuration without changing live files', async () => {
  const f = fixture();
  try {
    const run = f.receive('我主要使用 Swift 开发');
    mkdirSync(join(f.directory, 'attachments', '资料'), { recursive: true });
    writeFileSync(join(f.directory, 'attachments', '资料', 'a.txt'), '受管资料');
    const originalConfig = readFileSync(join(f.directory, 'config.json'));
    f.export();
    const raw = readFileSync(f.path, 'utf8'); const manifest = JSON.parse(raw);
    assert.equal(raw.includes(f.config.modelConnections[0].key), false);
    assert.deepEqual(readFileSync(join(f.directory, 'config.json')), originalConfig);
    assert.equal(statSync(f.path).mode & 0o777, 0o600);
    assert.equal(manifest.files.length, 3);
    assert.equal(manifest.files.some((e: any) => /migrations|generation|grant/.test(e.path)), false);
    const preview = f.preview();
    assert.equal(preview.messages, 2); assert.equal(preview.memories, 1); assert.equal(preview.attachments, 1);
    const staged = f.app.backups.staged(preview.token);
    const db = new DatabaseSync(join(staged, 'tandem.sqlite'), { readOnly: true });
    try { assert.equal(db.prepare('SELECT content FROM messages WHERE id=?').get(run.user_message_id)!.content, '我主要使用 Swift 开发'); }
    finally { db.close(); }
    assert.equal(readFileSync(join(staged, 'attachments', '资料', 'a.txt'), 'utf8'), '受管资料');
    assert.deepEqual(readdirSync(f.directory).filter(x => x.startsWith('.backup-')), []);
  } finally { await f.close(); }
});

test('restore replaces data, preserves current forget markers and derived erasure, protects the full local configuration and resets all window generations', async () => {
  const f = fixture();
  try {
    const run = f.receive('我主要使用 Swift 开发');
    const memory = f.app.store.db.prepare('SELECT * FROM memories').get()!;
    f.app.store.db.prepare("UPDATE runs SET status='running' WHERE id=?").run(run.id);
    f.app.execution.save(run, [{ role: 'user', content: 'source' }], [{ sourceType: 'memory', sourceId: memory.id, sourceVersion: memory.version, projectId: null, content: 'Swift', role: 'user' }]);
    f.app.store.db.prepare("UPDATE messages SET content='derived-private-memory' WHERE id=?").run(run.assistant_message_id);
    f.app.store.db.prepare("UPDATE runs SET status='completed' WHERE id=?").run(run.id);
    f.export();
    f.call('memory.forget', { surfaceId: 'a', id: memory.id, expectedVersion: memory.version });
    f.call('project.create', { title: '备份后创建', description: '' });
    const before = f.call('state.get', { surfaceId: 'a' });
    const preview = f.preview();
    const restored = await f.call('backup.restore', { token: preview.token, confirm: true });
    assert.notEqual(restored.generation, before.generation);
    assert.equal(f.app.store.db.prepare('SELECT COUNT(*) AS n FROM projects').get()!.n, 0);
    assert.equal(f.app.store.db.prepare('SELECT COUNT(*) AS n FROM memories').get()!.n, 0);
    assert.equal(f.app.store.db.prepare('SELECT COUNT(*) AS n FROM memory_forget_markers WHERE released_at IS NULL').get()!.n, 1);
    assert.equal(f.app.store.db.prepare('SELECT content FROM messages WHERE id=?').get(run.assistant_message_id)!.content, '内容已删除，无法还原');
    assert.equal(f.app.store.db.prepare('SELECT checkpoint FROM run_progress WHERE run_id=?').get(run.id)!.checkpoint, null);
    const after = f.call('state.get', { surfaceId: 'a', generation: before.generation, afterSequence: 999999 });
    assert.equal(after.messages.length, 2); assert.equal(after.generation, restored.generation);
    assert.equal(f.call('config.get').config.modelConnections[0].key, '');
    assert.equal(JSON.parse(readFileSync(join(restored.protectionPath, 'config.json'), 'utf8')).modelConnections[0].key, f.config.modelConnections[0].key);
    assert.equal(statSync(restored.protectionPath).mode & 0o777, 0o700);
    assert.equal(statSync(join(restored.protectionPath, 'config.json')).mode & 0o777, 0o600);
    const old = new DatabaseSync(join(restored.protectionPath, 'tandem.sqlite'), { readOnly: true });
    try { assert.equal(old.prepare('SELECT title FROM projects').get()!.title, '备份后创建'); } finally { old.close(); }
    f.app.context.memory.extract(String(run.interaction_id));
    assert.equal(f.app.store.db.prepare('SELECT COUNT(*) AS n FROM memories').get()!.n, 0);
    await f.reopen();
    assert.equal(f.call('runtime.info').generation, restored.generation);
  } finally { await f.close(); }
});

test('restore invalidates historical approvals and native grants, keeps exhausted budgets and never dispatches restored work', async () => {
  const f = fixture();
  try {
    const run = f.receive('等待审批');
    f.app.store.db.prepare("UPDATE runs SET status='running' WHERE id=?").run(run.id);
    const result = await f.app.execution.tool(run, { callId: 'approval', name: 'request_directory', arguments: JSON.stringify({ reason: '读取资料' }) }, new AbortController().signal);
    assert.equal(result, null);
    f.app.store.db.prepare("INSERT INTO directory_grants VALUES('grant',NULL,'资料','active','device:inode')").run();
    f.app.store.db.prepare("UPDATE run_progress SET steps=24,tokens=64000,active_ms=300000,pause_reason='budget_exhausted' WHERE run_id=?").run(run.id);
    f.export(); const preview = f.preview();
    assert.throws(() => f.call('backup.restore', { token: preview.token }), /RESTORE_CONFIRM_REQUIRED/);
    await f.call('backup.restore', { token: preview.token, confirm: true });
    await new Promise(r => setTimeout(r, 30));
    assert.equal(f.app.store.db.prepare('SELECT status FROM runs WHERE id=?').get(run.id)!.status, 'interrupted');
    assert.equal(f.app.store.db.prepare('SELECT status FROM approvals').get()!.status, 'invalid');
    assert.equal(f.app.store.db.prepare('SELECT status FROM directory_grants').get()!.status, 'unavailable');
    const progress = f.app.execution.progress(String(run.id));
    assert.equal(progress.steps, 24); assert.equal(progress.tokens, 64000); assert.equal(progress.active_ms, 300000);
    assert.equal(progress.pause_reason, 'budget_exhausted');
    assert.throws(() => f.call('run.continue', { runId: run.id, expectedVersion: progress.version, idempotencyKey: 'no-budget' }), /BUDGET_REQUIRED/);
    assert.equal(f.app.store.db.prepare('SELECT COUNT(*) AS n FROM approvals').get()!.n, 1);
  } finally { await f.close(); }
});

test('restore refuses to replay an unfinished transactional tool result', async () => {
  const f = fixture();
  try {
    const run = f.receive('结果未知');
    f.app.store.db.prepare("INSERT INTO invocations VALUES('unknown',?, 'call','create_task',1,'{}','hash','pending',NULL)").run(run.id);
    f.export(); const preview = f.preview();
    await f.call('backup.restore', { token: preview.token, confirm: true });
    assert.equal(f.app.store.db.prepare('SELECT status FROM invocations').get()!.status, 'unknown');
    assert.throws(() => f.call('run.continue', { runId: run.id, expectedVersion: 1, idempotencyKey: 'unknown' }), /TOOL_RESULT_UNKNOWN/);
  } finally { await f.close(); }
});

test('restore blocks mutations, aborts active model work and rejects late output before swapping stores', async () => {
  const f = fixture();
  const server = createServer();
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  try {
    const config = structuredClone(f.config);
    config.modelConnections[0].url = `http://127.0.0.1:${(server.address() as any).port}/v1`;
    f.call('config.save', { config, expectedRevision: f.call('config.get').revision });
    f.export(); const preview = f.preview();
    const incoming = once(server, 'request');
    const run = f.call('message.send', { surfaceId: 'a', text: 'in flight', newTopic: true, idempotencyKey: randomUUID() });
    const [, response] = await incoming;
    const restoring = f.call('backup.restore', { token: preview.token, confirm: true });
    assert.throws(() => f.call('project.create', { title: '不能写入', description: '' }), /BACKUP_BUSY/);
    assert.throws(() => f.call('config.save', { config, expectedRevision: f.call('runtime.info').generation }), /BACKUP_BUSY/);
    assert.deepEqual(f.call('native.next').requests, []);
    const result = await restoring;
    response.end(JSON.stringify({ choices: [{ message: { content: 'late output' }, finish_reason: 'stop' }] }));
    await new Promise(r => setTimeout(r, 20));
    assert.equal(f.app.store.db.prepare('SELECT COUNT(*) AS n FROM messages').get()!.n, 0);
    const protection = new DatabaseSync(join(result.protectionPath, 'tandem.sqlite'), { readOnly: true });
    try { assert.equal(protection.prepare('SELECT status FROM runs WHERE id=?').get(run.runId)!.status, 'interrupted'); }
    finally { protection.close(); }
  } finally { await f.close(); server.closeAllConnections(); server.close(); }
});

test('restore rejects damaged, oversized, unsafe and incompatible packages before touching current data', async () => {
  const f = fixture();
  try {
    f.receive('我主要使用 Swift 开发'); f.export();
    const original = readFileSync(f.path, 'utf8');
    const cases: [string, (manifest: any) => void][] = [
      ['BACKUP_VERSION', m => { m.formatVersion = 2; }],
      ['BACKUP_VERSION', m => { m.databaseSchema = 99; }],
      ['BACKUP_PATH', m => { m.files[0].path = '../escape.sqlite'; }],
      ['BACKUP_PATH', m => { m.files[0].path = 'attachments/../escape'; }],
      ['BACKUP_PATH', m => { m.files[0].type = 'symlink'; }],
      ['BACKUP_PATH', m => { m.files.push(m.files[0]); }],
      ['BACKUP_CHECKSUM', m => { m.files[0].sha256 = '0'.repeat(64); }],
      ['BACKUP_SIZE', m => { m.files[0].size = 128 * 1024 * 1024 + 1; }],
      ['BACKUP_SIZE', m => { delete m.files[0].data; }],
      ['BACKUP_FORMAT', m => { m.files = m.files.filter((e: any) => e.path !== 'config.json'); }],
      ['BACKUP_CREDENTIALS', m => { const c = JSON.parse(Buffer.from(m.files.find((e: any) => e.path === 'config.json').data, 'base64').toString()); c.modelConnections[0].key = 'not-cleared'; replaceEntry(m, 'config.json', Buffer.from(JSON.stringify(c))); }],
    ];
    for (const [code, mutate] of cases) {
      const manifest = JSON.parse(original); mutate(manifest); writeFileSync(f.path, JSON.stringify(manifest));
      assert.throws(() => f.preview(), new RegExp(code));
      assert.equal(f.app.store.db.prepare('SELECT COUNT(*) AS n FROM memories').get()!.n, 1);
      assert.equal(f.call('config.get').config.modelConnections[0].key, f.config.modelConnections[0].key);
    }
    writeFileSync(f.path, '{'); assert.throws(() => f.preview(), /BACKUP_FORMAT/);
    assert.equal(existsSync(join(f.root, 'escape.sqlite')), false);
    assert.deepEqual(readdirSync(f.root).filter(x => x.startsWith('live.stage-')), []);
  } finally { await f.close(); }
});

test('restore refuses executable schema, corrupted databases and mismatched database versions even with recomputed checksums', async () => {
  const f = fixture();
  try {
    f.export(); const original = readFileSync(f.path, 'utf8');
    for (const change of ['CREATE TRIGGER attack AFTER INSERT ON messages BEGIN DELETE FROM projects; END', 'CREATE TRIGGER sqlitexattack AFTER INSERT ON messages BEGIN DELETE FROM projects; END', 'PRAGMA user_version=99', 'DROP TABLE budget_changes']) {
      const manifest = JSON.parse(original);
      const path = join(f.root, randomUUID() + '.sqlite');
      writeFileSync(path, Buffer.from(manifest.files[0].data, 'base64'));
      const db = new DatabaseSync(path); try { db.exec(change); } finally { db.close(); }
      replaceEntry(manifest, 'tandem.sqlite', readFileSync(path)); writeFileSync(f.path, JSON.stringify(manifest));
      assert.throws(() => f.preview(), /BACKUP_DATABASE|BACKUP_VERSION/);
    }
    const manifest = JSON.parse(original); replaceEntry(manifest, 'tandem.sqlite', Buffer.from('not a database')); writeFileSync(f.path, JSON.stringify(manifest));
    assert.throws(() => f.preview(), /BACKUP_FORMAT|BACKUP_DATABASE/);
  } finally { await f.close(); }
});

test('backup rejects existing destinations, paths inside the live directory, source symlinks and linked attachments', async () => {
  const f = fixture();
  try {
    f.export(); const original = readFileSync(f.path);
    assert.throws(() => f.export(), /BACKUP_DESTINATION/);
    assert.deepEqual(readFileSync(f.path), original);
    assert.throws(() => f.call('backup.export', { path: join(f.directory, 'inside.json') }), /BACKUP_DESTINATION/);
    const alias = join(f.root, 'alias'); symlinkSync(f.directory, alias);
    assert.throws(() => f.call('backup.export', { path: join(alias, 'inside.json') }), /BACKUP_DESTINATION/);
    const source = join(f.root, 'source.json'); symlinkSync(f.path, source);
    assert.throws(() => f.call('backup.preview', { path: source }));
    mkdirSync(join(f.directory, 'attachments')); symlinkSync('/etc/hosts', join(f.directory, 'attachments', 'link'));
    assert.throws(() => f.call('backup.export', { path: join(f.root, 'linked.json') }), /BACKUP_PATH/);
    assert.equal(existsSync(join(f.root, 'linked.json')), false);
  } finally { await f.close(); }
});

test('an older supported schema migrates only in the restore staging copy', async () => {
  const f = fixture();
  try {
    f.receive('旧版本消息'); f.export();
    const manifest = JSON.parse(readFileSync(f.path, 'utf8'));
    const path = join(f.root, 'schema-3.sqlite'); writeFileSync(path, Buffer.from(manifest.files[0].data, 'base64'));
    const db = new DatabaseSync(path);
    try { db.exec('DROP TABLE memory_search; DROP TABLE memory_evidence; DROP TABLE memories; DROP TABLE memory_outbox; DROP TABLE memory_forget_markers; PRAGMA user_version=3;'); }
    finally { db.close(); }
    replaceEntry(manifest, 'tandem.sqlite', readFileSync(path)); manifest.databaseSchema = 3; writeFileSync(f.path, JSON.stringify(manifest));
    const raw = readFileSync(f.path); const preview = f.preview();
    assert.equal(preview.databaseSchema, 3); assert.equal(preview.messages, 2);
    assert.deepEqual(readFileSync(f.path), raw);
    await f.call('backup.restore', { token: preview.token, confirm: true });
    assert.equal(f.app.store.db.prepare('PRAGMA user_version').get()!.user_version, 4);
    assert.equal(f.app.store.db.prepare('SELECT COUNT(*) AS n FROM messages').get()!.n, 2);
  } finally { await f.close(); }
});

test('a forged marker identity or staging write failure leaves live data, local keys and forget markers usable', async () => {
  const f = fixture();
  try {
    f.receive('我主要使用 Swift 开发'); f.export();
    const memory = f.app.store.db.prepare('SELECT * FROM memories').get()!;
    f.call('memory.forget', { surfaceId: 'a', id: memory.id, expectedVersion: memory.version });
    let preview = f.preview();
    const marker = f.app.store.db.prepare('SELECT * FROM memory_forget_markers').get()!;
    const forged = new DatabaseSync(join(f.app.backups.staged(preview.token), 'tandem.sqlite'));
    try { forged.prepare('INSERT INTO memory_forget_markers VALUES(?,?,?,?,?,NULL)').run(marker.id,marker.scope,'forged-key',marker.evidence_ids,marker.created_at); }
    finally { forged.close(); }
    await assert.rejects(f.call('backup.restore', { token: preview.token, confirm: true }), /BACKUP_DATABASE/);
    preview = f.preview();
    const db = new DatabaseSync(join(f.app.backups.staged(preview.token), 'tandem.sqlite'));
    try { db.exec("CREATE TRIGGER fail_write BEFORE INSERT ON memory_forget_markers BEGIN SELECT RAISE(ABORT,'injected storage write failure'); END;"); }
    finally { db.close(); }
    await assert.rejects(f.call('backup.restore', { token: preview.token, confirm: true }), /injected storage write failure/);
    assert.equal(f.call('config.get').config.modelConnections[0].key, f.config.modelConnections[0].key);
    assert.equal(f.app.store.db.prepare('SELECT COUNT(*) AS n FROM memories').get()!.n, 0);
    assert.equal(f.app.store.db.prepare('SELECT COUNT(*) AS n FROM memory_forget_markers').get()!.n, 1);
    assert.equal(existsSync(f.directory + '.restore-journal.json'), false);
    assert.ok(f.call('project.create', { title: '失败后仍可使用', description: '' }).id);
  } finally { await f.close(); }
});

test('restore preview tokens cannot be confirmed after cancellation or replacement, and stale window cancellation is harmless', async () => {
  const f = fixture();
  try {
    f.export(); const first = f.preview(); const second = f.preview();
    f.call('backup.cancel', { token: first.token });
    assert.throws(() => f.call('backup.restore', { token: first.token, confirm: true }), /RESTORE_PREVIEW_EXPIRED/);
    assert.ok(f.app.backups.staged(second.token));
    f.call('backup.cancel', { token: second.token });
    assert.throws(() => f.call('backup.restore', { token: second.token, confirm: true }), /RESTORE_PREVIEW_EXPIRED/);
  } finally { await f.close(); }
});

test('failed directory switch rolls back the original data and complete local keys', async () => {
  const f = fixture();
  try {
    f.export(); const preview = f.preview();
    f.call('project.create', { title: '必须保留', description: '' });
    assert.throws(() => f.app.backups.switch(preview.token, () => {}, () => { throw new Error('injected reopen failure'); }), /injected reopen failure/);
    assert.equal(existsSync(f.directory + '.restore-journal.json'), false);
    assert.equal(JSON.parse(readFileSync(join(f.directory, 'config.json'), 'utf8')).modelConnections[0].key, f.config.modelConnections[0].key);
    assert.equal(f.app.store.db.prepare('SELECT title FROM projects').get()!.title, '必须保留');
  } finally { await f.close(); }
});

test('startup recovers interruptions before, between and after the directory renames', async () => {
  for (const phase of [0, 1, 2]) {
    const f = fixture();
    try {
      f.export(); const preview = f.preview(); const stage = f.app.backups.staged(preview.token);
      const protection = f.directory + '.protection-' + randomUUID();
      f.call('project.create', { title: '中断前数据', description: '' });
      f.app.store.db.exec('PRAGMA wal_checkpoint(TRUNCATE)');
      writeFileSync(f.directory + '.restore-journal.json', JSON.stringify({ stage, protection }), { mode: 0o600 });
      if (phase >= 1) renameSync(f.directory, protection);
      if (phase >= 2) renameSync(stage, f.directory);
      recoverRestore(f.directory);
      assert.equal(existsSync(f.directory + '.restore-journal.json'), false);
      assert.equal(JSON.parse(readFileSync(join(f.directory, 'config.json'), 'utf8')).modelConnections[0].key, f.config.modelConnections[0].key);
      const check = new DatabaseSync(join(f.directory, 'tandem.sqlite'), { readOnly: true });
      try { assert.equal(check.prepare('SELECT title FROM projects').get()!.title, '中断前数据'); } finally { check.close(); }
    } finally { await f.close(); }
  }
});
