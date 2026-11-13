import { DatabaseSync } from 'node:sqlite';
import { chmodSync, closeSync, existsSync, fsyncSync, lstatSync, openSync, renameSync, unlinkSync } from 'node:fs';
import { join } from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { privateDirectory } from './config.ts';
import { migrateM3 } from './execution.ts';
import { requireValue } from './errors.ts';

export class Store {
  readonly db: DatabaseSync;
  constructor(directory: string) {
    privateDirectory(directory);
    const path = join(directory, 'tandem.sqlite');
    if (existsSync(path)) requireValue(lstatSync(path).isFile() && !lstatSync(path).isSymbolicLink(), 'DATABASE_FILE');
    this.db = new DatabaseSync(path);
    chmodSync(path, 0o600);
    this.db.exec('PRAGMA foreign_keys=ON; PRAGMA journal_mode=WAL; PRAGMA busy_timeout=3000;');
    const version = this.db.prepare('PRAGMA user_version').get()!.user_version;
    requireValue(version === 0 || version === 1 || version === 2 || version === 3, 'DATABASE_VERSION');
    if (version === 0) this.transaction(() => {
      this.db.exec(`
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
    try {
      if (version === 1) {
        const backups = join(directory,'migrations'); privateDirectory(backups);
        const backupPath = join(backups,`schema-1-${randomUUID()}.sqlite`);
        const temporary = backupPath + '.tmp';
        closeSync(openSync(temporary,'wx',0o600));
        try {
          // VACUUM INTO includes committed WAL contents in a consistent standalone database.
          this.db.prepare('VACUUM INTO ?').run(temporary);
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
      if (Number(version) < 2) this.transaction(() => {
        this.db.exec(`
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
        for (const m of this.db.prepare("SELECT * FROM messages WHERE role='user'").all()) {
          const id = randomUUID();
          this.db.prepare("INSERT INTO interactions(id,sequence,surface_id,input,input_json,request_key,request_hash,status,message_id,session_id,focus_version,created_at) VALUES(?,?,'legacy',?,'{}',?,?,'committed',?,?,1,?)")
            .run(id,m.sequence,m.content,'legacy:'+id,'legacy',m.id,m.session_id,m.created_at);
          this.db.prepare('UPDATE messages SET interaction_id=? WHERE id=?').run(id,m.id);
          this.db.prepare('UPDATE runs SET interaction_id=?,interaction_version=1 WHERE user_message_id=?').run(id,m.id);
        }
        for (const r of this.db.prepare('SELECT * FROM runs WHERE context_json IS NOT NULL').all()) {
          const id=randomUUID();
          const fragments=JSON.parse(String(r.context_json)).map((m: any) => ({sourceType:'legacy_input',sourceId:String(r.id),sourceVersion:createHash('sha256').update(JSON.stringify(m)).digest('hex'),projectId:null,role:m.role,content:m.content}));
          this.db.prepare("INSERT INTO context_snapshots VALUES(?,?,'automatic',NULL,?,?)").run(id,r.id,JSON.stringify(fragments),r.created_at);
          this.db.prepare('UPDATE runs SET snapshot_id=? WHERE id=?').run(id,r.id);
        }
      });
    } catch (error) { this.db.close(); throw error; }
    try { migrateM3(this, directory); } catch (error) { this.db.close(); throw error; }
    this.db.exec("UPDATE outbox SET status='interrupted' WHERE status='pending';");
    // Reopening the app never restarts interrupted model work automatically.
    this.transaction(() => {
      const pending = this.db.prepare("SELECT assistant_message_id FROM runs WHERE status IN('queued','running')").all();
      this.db.prepare("UPDATE runs SET status='interrupted', error_code='INTERRUPTED' WHERE status IN('queued','running')").run();
      for (const run of pending) this.changed(String(run.assistant_message_id));
    });
  }

  transaction<T>(body: () => T): T {
    this.db.exec('BEGIN IMMEDIATE');
    try { const result = body(); this.db.exec('COMMIT'); return result; }
    catch (error) { this.db.exec('ROLLBACK'); throw error; }
  }

  sequence(): number {
    return Number(this.db.prepare("UPDATE timelines SET next_sequence=next_sequence+1 WHERE id='main' RETURNING next_sequence-1 AS value").get()!.value);
  }

  focus(surfaceId: string) {
    this.db.prepare(`INSERT OR IGNORE INTO focus_states(surface_id,active_session_id) VALUES(?,
      (SELECT id FROM sessions WHERE temporary=0 ORDER BY updated_at DESC, rowid DESC LIMIT 1))`).run(surfaceId);
    return this.db.prepare('SELECT active_session_id AS activeSessionId, interrupted_session_id AS interruptedSessionId,active_project_id AS activeProjectId,context_mode AS contextMode,recent_session_ids AS recentSessionIds, version FROM focus_states WHERE surface_id=?').get(surfaceId)!;
  }

  newSession(title: string, temporary: boolean): string {
    const id = randomUUID();
    this.db.prepare('INSERT INTO sessions(id,title,temporary,created_at,updated_at) VALUES(?,?,?,?,?)').run(id, title.slice(0, 60), Number(temporary), Date.now(), Date.now());
    return id;
  }

  timeline(before?: number) {
    return this.messageRows('m.sequence<? ORDER BY m.sequence DESC LIMIT 10', before ?? Number.MAX_SAFE_INTEGER).reverse();
  }

  private messageRows(where: string, ...args: (string | number)[]) {
    const rows = this.db.prepare(`SELECT m.id,m.session_id AS sessionId,m.sequence,m.role,m.content,m.created_at AS createdAt,
      i.route_json AS routeJson,COALESCE(m.interaction_id,r.interaction_id) AS interactionId,i.project_id AS projectId,i.version AS interactionVersion,r.project_id AS executionProjectId,r.interaction_version AS executionInteractionVersion,r.snapshot_id AS snapshotId,r.id AS runId,r.status,r.error_code AS errorCode,r.binding_json AS bindingJson,r.attempt
      FROM messages m LEFT JOIN runs r ON r.id=m.run_id LEFT JOIN interactions i ON i.id=COALESCE(m.interaction_id,r.interaction_id)
      WHERE ${where}`).all(...args);
    return rows.map(row => {
      const binding = row.bindingJson ? JSON.parse(String(row.bindingJson)) : null;
      const { bindingJson, routeJson, ...message } = row;
      const route = routeJson ? JSON.parse(String(routeJson)) : null;
      return { ...message, routeReason: route?.reason ?? null, modelName: binding?.modelName ?? null, connectionId: binding?.id ?? null };
    });
  }

  changed(messageId: string) {
    const row = this.db.prepare('SELECT run_id FROM messages WHERE id=?').get(messageId);
    this.db.prepare("INSERT INTO events(id,schema_version,type,aggregate_id,correlation_id,causation_id,occurred_at,payload_ref) VALUES(?,1,'message.changed',?,?,?,?,?)")
      .run(randomUUID(), messageId, row?.run_id ?? messageId, null, Date.now(), messageId);
  }

  changes(after?: number) {
    const latest = Number(this.db.prepare('SELECT COALESCE(MAX(sequence),0) AS n FROM events').get()!.n);
    if (after === undefined) return { cursor: latest, messages: [] };
    requireValue(Number.isSafeInteger(after) && after >= 0 && after <= latest, 'GAP_REQUIRED');
    if (after !== undefined) requireValue(!this.db.prepare("SELECT 1 FROM events WHERE type='history.deleted' AND sequence>? LIMIT 1").get(after), 'GAP_REQUIRED');
    if (after === latest) return { cursor: latest, messages: [] };
    // Coalesce text deltas per message so a token stream cannot delay other views' updates.
    const boundary = this.db.prepare('SELECT MAX(sequence) AS sequence FROM events GROUP BY aggregate_id HAVING MAX(sequence)>? ORDER BY sequence LIMIT 5').all(after);
    const cursor = boundary.length ? Number(boundary.at(-1)!.sequence) : latest;
    return { cursor, messages: this.messageRows('m.id IN (SELECT aggregate_id FROM events GROUP BY aggregate_id HAVING MAX(sequence)>? AND MAX(sequence)<=?) ORDER BY m.sequence', after, cursor) };
  }

  runStatus(id: string, status: string, code: string | null = null) {
    this.transaction(() => {
      this.db.prepare('UPDATE runs SET status=?,error_code=? WHERE id=?').run(status, code, id);
      const run = this.db.prepare('SELECT assistant_message_id FROM runs WHERE id=?').get(id);
      if (run) this.changed(String(run.assistant_message_id));
      if (['completed','failed','cancelled','interrupted'].includes(status)) this.db.prepare("UPDATE outbox SET status=? WHERE interaction_id=(SELECT interaction_id FROM runs WHERE id=?)").run(status === 'interrupted' ? 'interrupted' : 'done',id);
    });
  }
}
