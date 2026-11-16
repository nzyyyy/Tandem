import { chmodSync, closeSync, existsSync, fsyncSync, openSync, renameSync, unlinkSync } from 'node:fs';
import { join } from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { privateDirectory } from './config.ts';
import { requireValue } from './errors.ts';
import type { Store } from './store.ts';

export function migrate(store: Store, directory: string) {
  const db = store.db;
  const version = db.prepare('PRAGMA user_version').get()!.user_version;
  requireValue(version === 0 || version === 1 || version === 2 || version === 3 || version === 4, 'DATABASE_VERSION');
  if (version === 0) store.transaction(() => {
    db.exec(`
      CREATE TABLE timelines(id TEXT PRIMARY KEY CHECK(id='main'), next_sequence INTEGER NOT NULL);
      INSERT INTO timelines VALUES('main', 1);
      CREATE TABLE sessions(id TEXT PRIMARY KEY, title TEXT NOT NULL, temporary INTEGER NOT NULL CHECK(temporary IN(0,1)), created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL);
      CREATE TABLE focus_states(surface_id TEXT PRIMARY KEY, active_session_id TEXT REFERENCES sessions(id), interrupted_session_id TEXT REFERENCES sessions(id), version INTEGER NOT NULL DEFAULT 1);
      CREATE TABLE messages(id TEXT PRIMARY KEY, timeline_id TEXT NOT NULL DEFAULT 'main' REFERENCES timelines(id), session_id TEXT NOT NULL REFERENCES sessions(id), sequence INTEGER NOT NULL UNIQUE, role TEXT NOT NULL CHECK(role IN('user','assistant')), content TEXT NOT NULL, run_id TEXT REFERENCES runs(id), created_at INTEGER NOT NULL);
      CREATE TABLE runs(id TEXT PRIMARY KEY, user_message_id TEXT NOT NULL REFERENCES messages(id), assistant_message_id TEXT REFERENCES messages(id), session_id TEXT NOT NULL REFERENCES sessions(id), binding_json TEXT NOT NULL, context_json TEXT, status TEXT NOT NULL CHECK(status IN('queued','running','completed','failed','interrupted','cancelled')), error_code TEXT, attempt INTEGER NOT NULL, retry_of TEXT UNIQUE REFERENCES runs(id), request_key TEXT NOT NULL UNIQUE, request_hash TEXT NOT NULL, created_at INTEGER NOT NULL);
      CREATE INDEX messages_session_sequence ON messages(session_id, sequence);
      CREATE INDEX runs_queue ON runs(status, created_at);
      CREATE TABLE events(sequence INTEGER PRIMARY KEY AUTOINCREMENT,id TEXT NOT NULL UNIQUE,schema_version INTEGER NOT NULL,type TEXT NOT NULL,aggregate_id TEXT NOT NULL,correlation_id TEXT NOT NULL,causation_id TEXT,occurred_at INTEGER NOT NULL,payload_ref TEXT NOT NULL);
      CREATE INDEX events_aggregate_sequence ON events(aggregate_id,sequence);
      PRAGMA user_version=1;
    `);
  });
  if (version === 1) {
    const backups = join(directory,'migrations'); privateDirectory(backups);
    const backupPath = join(backups,`schema-1-${randomUUID()}.sqlite`);
    const temporary = backupPath + '.tmp';
    closeSync(openSync(temporary,'wx',0o600));
    try {
      // VACUUM INTO includes committed WAL contents in a consistent standalone database.
      db.prepare('VACUUM INTO ?').run(temporary);
      const check = new DatabaseSync(temporary,{readOnly:true});
      try {
        requireValue(check.prepare('PRAGMA quick_check').get()!.quick_check === 'ok'
          && check.prepare('PRAGMA foreign_key_check').all().length === 0
          && check.prepare('PRAGMA user_version').get()!.user_version === 1,'MIGRATION_BACKUP_INVALID');
      } finally { check.close(); }
      const fd = openSync(temporary,'r');
      try { fsyncSync(fd); } finally { closeSync(fd); }
      renameSync(temporary,backupPath);
    } finally { if(existsSync(temporary)) unlinkSync(temporary); }
  }
  if (Number(version) < 2) store.transaction(() => {
    db.exec(`
      CREATE TABLE projects(id TEXT PRIMARY KEY,title TEXT NOT NULL,description TEXT NOT NULL,status TEXT NOT NULL CHECK(status IN('open','archived')),version INTEGER NOT NULL,created_at INTEGER NOT NULL,updated_at INTEGER NOT NULL);
      ALTER TABLE sessions ADD COLUMN project_id TEXT REFERENCES projects(id);
      ALTER TABLE sessions ADD COLUMN status TEXT NOT NULL DEFAULT 'open';
      ALTER TABLE focus_states ADD COLUMN active_project_id TEXT REFERENCES projects(id);
      ALTER TABLE focus_states ADD COLUMN context_mode TEXT NOT NULL DEFAULT 'automatic';
      ALTER TABLE focus_states ADD COLUMN recent_session_ids TEXT NOT NULL DEFAULT '[]';
      CREATE TABLE interactions(id TEXT PRIMARY KEY,timeline_id TEXT NOT NULL DEFAULT 'main',sequence INTEGER NOT NULL UNIQUE,surface_id TEXT NOT NULL,input TEXT NOT NULL,input_json TEXT NOT NULL,request_key TEXT NOT NULL UNIQUE,request_hash TEXT NOT NULL,status TEXT NOT NULL CHECK(status IN('received','waiting_route','committed')),version INTEGER NOT NULL DEFAULT 1,project_id TEXT REFERENCES projects(id),session_id TEXT REFERENCES sessions(id),message_id TEXT UNIQUE REFERENCES messages(id),route_json TEXT,focus_version INTEGER NOT NULL,created_at INTEGER NOT NULL);
      ALTER TABLE messages ADD COLUMN interaction_id TEXT REFERENCES interactions(id);
      CREATE UNIQUE INDEX messages_interaction ON messages(interaction_id) WHERE interaction_id IS NOT NULL;
      ALTER TABLE runs ADD COLUMN interaction_id TEXT REFERENCES interactions(id);
      ALTER TABLE runs ADD COLUMN interaction_version INTEGER;
      ALTER TABLE runs ADD COLUMN project_id TEXT REFERENCES projects(id);
      ALTER TABLE runs ADD COLUMN context_mode TEXT NOT NULL DEFAULT 'automatic';
      ALTER TABLE runs ADD COLUMN snapshot_id TEXT REFERENCES context_snapshots(id);
      CREATE TABLE context_snapshots(id TEXT PRIMARY KEY,run_id TEXT NOT NULL REFERENCES runs(id),mode TEXT NOT NULL,project_id TEXT REFERENCES projects(id),fragments_json TEXT NOT NULL,created_at INTEGER NOT NULL);
      CREATE TABLE corrections(id TEXT PRIMARY KEY,interaction_id TEXT NOT NULL REFERENCES interactions(id),from_project TEXT,to_project TEXT,version INTEGER NOT NULL,created_at INTEGER NOT NULL);
      CREATE TABLE outbox(interaction_id TEXT PRIMARY KEY REFERENCES interactions(id),kind TEXT NOT NULL CHECK(kind IN('route','run')),status TEXT NOT NULL CHECK(status IN('pending','done','interrupted')));
      CREATE TABLE delete_previews(token TEXT PRIMARY KEY,project_id TEXT NOT NULL,revision TEXT NOT NULL,created_at INTEGER NOT NULL);
      CREATE VIRTUAL TABLE session_search USING fts5(session_id UNINDEXED,content);
      PRAGMA user_version=2;
    `);
    // Preserve existing message IDs, order and historical execution inputs during the M1 migration.
    for (const m of db.prepare("SELECT * FROM messages WHERE role='user'").all()) {
      const id = randomUUID();
      db.prepare("INSERT INTO interactions(id,sequence,surface_id,input,input_json,request_key,request_hash,status,message_id,session_id,focus_version,created_at) VALUES(?,?,'legacy',?,'{}',?,?,'committed',?,?,1,?)")
        .run(id,m.sequence,m.content,'legacy:'+id,'legacy',m.id,m.session_id,m.created_at);
      db.prepare('UPDATE messages SET interaction_id=? WHERE id=?').run(id,m.id);
      db.prepare('UPDATE runs SET interaction_id=?,interaction_version=1 WHERE user_message_id=?').run(id,m.id);
    }
    for (const r of db.prepare('SELECT * FROM runs WHERE context_json IS NOT NULL').all()) {
      const id=randomUUID();
      const fragments=JSON.parse(String(r.context_json)).map((m: any) => ({sourceType:'legacy_input',sourceId:String(r.id),sourceVersion:createHash('sha256').update(JSON.stringify(m)).digest('hex'),projectId:null,role:m.role,content:m.content}));
      db.prepare("INSERT INTO context_snapshots VALUES(?,?,'automatic',NULL,?,?)").run(id,r.id,JSON.stringify(fragments),r.created_at);
      db.prepare('UPDATE runs SET snapshot_id=? WHERE id=?').run(id,r.id);
    }
  });
  migrateM3(store, directory);
  migrateM4(store, directory);
}

function migrateM3(store: Store, directory: string) {
  const db = store.db;
  if (Number(db.prepare('PRAGMA user_version').get()!.user_version) >= 3) return;
  const backups = join(directory, 'migrations'); privateDirectory(backups);
  const path = join(backups, `schema-2-${randomUUID()}.sqlite`);
  // The private parent protects the VACUUM output until its permissions are restricted.
  db.prepare('VACUUM INTO ?').run(path); chmodSync(path, 0o600);
  const backup = new DatabaseSync(path, { readOnly: true });
  try { requireValue(backup.prepare('PRAGMA quick_check').get()!.quick_check === 'ok' && backup.prepare('PRAGMA user_version').get()!.user_version === 2 && backup.prepare('PRAGMA foreign_key_check').all().length === 0, 'MIGRATION_BACKUP_INVALID'); }
  finally { backup.close(); }
  const descriptor = openSync(path,'r');
  try { fsyncSync(descriptor); } finally { closeSync(descriptor); }
  db.exec('PRAGMA foreign_keys=OFF');
  try {
    store.transaction(() => {
      const sql = String(db.prepare("SELECT sql FROM sqlite_master WHERE name='runs'").get()!.sql)
        .replace('CREATE TABLE runs', 'CREATE TABLE runs_m3').replace("'cancelled'", "'cancelled','waiting_approval','paused'");
      db.exec(sql);
      db.exec(`INSERT INTO runs_m3 SELECT * FROM runs; DROP TABLE runs; ALTER TABLE runs_m3 RENAME TO runs;
        CREATE INDEX runs_queue ON runs(status,created_at);
        CREATE TABLE run_progress(run_id TEXT PRIMARY KEY REFERENCES runs(id) ON DELETE CASCADE,version INTEGER NOT NULL DEFAULT 1,checkpoint TEXT,steps INTEGER NOT NULL DEFAULT 0,tokens INTEGER NOT NULL DEFAULT 0,active_ms INTEGER NOT NULL DEFAULT 0,step_limit INTEGER NOT NULL DEFAULT 24,token_limit INTEGER NOT NULL DEFAULT 64000,time_limit INTEGER NOT NULL DEFAULT 300000,pause_reason TEXT,estimated INTEGER NOT NULL DEFAULT 0,task_id TEXT REFERENCES tasks(id) ON DELETE SET NULL,revision INTEGER);
        CREATE TABLE tasks(id TEXT PRIMARY KEY,project_id TEXT REFERENCES projects(id),session_id TEXT NOT NULL REFERENCES sessions(id),revision INTEGER NOT NULL,status TEXT NOT NULL,created_at INTEGER NOT NULL);
        CREATE TABLE task_revisions(task_id TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,revision INTEGER NOT NULL,deliverable TEXT NOT NULL,criteria TEXT NOT NULL,result_ref TEXT REFERENCES messages(id) ON DELETE SET NULL,evidence TEXT,status TEXT NOT NULL,PRIMARY KEY(task_id,revision));
        CREATE TABLE run_steps(id TEXT PRIMARY KEY,run_id TEXT NOT NULL REFERENCES runs(id) ON DELETE CASCADE,kind TEXT NOT NULL,status TEXT NOT NULL,snapshot_id TEXT REFERENCES context_snapshots(id) ON DELETE SET NULL,detail TEXT NOT NULL,created_at INTEGER NOT NULL);
        CREATE TABLE invocations(id TEXT PRIMARY KEY,run_id TEXT NOT NULL REFERENCES runs(id) ON DELETE CASCADE,call_id TEXT NOT NULL,name TEXT NOT NULL,tool_version INTEGER NOT NULL,args TEXT NOT NULL,args_hash TEXT NOT NULL,status TEXT NOT NULL,result TEXT,UNIQUE(run_id,call_id));
        CREATE TABLE approvals(id TEXT PRIMARY KEY,invocation_id TEXT NOT NULL UNIQUE REFERENCES invocations(id) ON DELETE CASCADE,subject TEXT NOT NULL,scope TEXT NOT NULL,args_hash TEXT NOT NULL,tool_version INTEGER NOT NULL,expires_at INTEGER NOT NULL,status TEXT NOT NULL);
        CREATE TABLE directory_grants(id TEXT PRIMARY KEY,project_id TEXT REFERENCES projects(id),label TEXT NOT NULL,status TEXT NOT NULL,resource_id TEXT NOT NULL);
        CREATE TABLE budget_changes(key TEXT PRIMARY KEY,run_id TEXT NOT NULL REFERENCES runs(id) ON DELETE CASCADE,hash TEXT NOT NULL);
        INSERT INTO run_progress(run_id) SELECT id FROM runs;
        PRAGMA user_version=3;`);
      requireValue(db.prepare('PRAGMA foreign_key_check').all().length === 0, 'MIGRATION_INVALID');
    });
  } finally { db.exec('PRAGMA foreign_keys=ON'); }
}

function migrateM4(store: Store, directory: string) {
  const db=store.db;
  if (Number(db.prepare('PRAGMA user_version').get()!.user_version)>=4) return;
  const backups=join(directory,'migrations'); privateDirectory(backups);
  const path=join(backups,`schema-3-${randomUUID()}.sqlite`);
  db.prepare('VACUUM INTO ?').run(path); chmodSync(path,0o600);
  const backup=new DatabaseSync(path,{readOnly:true});
  try { requireValue(backup.prepare('PRAGMA quick_check').get()!.quick_check==='ok' && backup.prepare('PRAGMA user_version').get()!.user_version===3 && backup.prepare('PRAGMA foreign_key_check').all().length===0,'MIGRATION_BACKUP_INVALID'); }
  finally { backup.close(); }
  const fd=openSync(path,'r'); try { fsyncSync(fd); } finally { closeSync(fd); }
  store.transaction(()=>db.exec(`
    CREATE TABLE memories(id TEXT PRIMARY KEY,kind TEXT NOT NULL CHECK(kind IN('fact','decision')),subject TEXT NOT NULL,predicate TEXT NOT NULL,content TEXT NOT NULL,key_hash TEXT NOT NULL,project_id TEXT REFERENCES projects(id),status TEXT NOT NULL CHECK(status IN('candidate','active','superseded','suspended')),origin TEXT NOT NULL,confirmed_at INTEGER,supersedes_id TEXT REFERENCES memories(id) ON DELETE SET NULL,rationale TEXT NOT NULL,version INTEGER NOT NULL DEFAULT 1,created_at INTEGER NOT NULL,updated_at INTEGER NOT NULL);
    CREATE UNIQUE INDEX memory_current ON memories(COALESCE(project_id,''),key_hash) WHERE status='active';
    CREATE TABLE memory_evidence(memory_id TEXT NOT NULL REFERENCES memories(id) ON DELETE CASCADE,message_id TEXT NOT NULL REFERENCES messages(id),interaction_id TEXT NOT NULL REFERENCES interactions(id),interaction_version INTEGER NOT NULL,project_id TEXT,valid INTEGER NOT NULL CHECK(valid IN(0,1)),confirmed INTEGER NOT NULL CHECK(confirmed IN(0,1)),PRIMARY KEY(memory_id,message_id));
    CREATE TABLE memory_forget_markers(id TEXT PRIMARY KEY,scope TEXT NOT NULL,key_hash TEXT NOT NULL,evidence_ids TEXT NOT NULL,created_at INTEGER NOT NULL,released_at INTEGER);
    CREATE TABLE memory_outbox(id TEXT PRIMARY KEY,memory_id TEXT NOT NULL,kind TEXT NOT NULL,status TEXT NOT NULL CHECK(status IN('pending','done')),created_at INTEGER NOT NULL);
    CREATE VIRTUAL TABLE memory_search USING fts5(memory_id UNINDEXED,content);
    PRAGMA user_version=4;
  `));
}
