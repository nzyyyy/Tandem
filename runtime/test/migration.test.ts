import { test } from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { copyFileSync, mkdtempSync, readdirSync, rmSync, statSync } from "node:fs";
import { AppService } from "../src/service.ts";

test("M1 to M2 migration preserves identities, causal inputs and focus, and interrupts pending work", async () => {
  const directory = mkdtempSync("/tmp/tandem-migrate-");
  const legacy = new DatabaseSync(`${directory}/tandem.sqlite`);
  legacy.exec(`
    PRAGMA foreign_keys=ON;
    CREATE TABLE timelines(id TEXT PRIMARY KEY,next_sequence INTEGER NOT NULL);
    INSERT INTO timelines VALUES('main',5);
    CREATE TABLE sessions(id TEXT PRIMARY KEY,title TEXT NOT NULL,temporary INTEGER NOT NULL,created_at INTEGER NOT NULL,updated_at INTEGER NOT NULL);
    INSERT INTO sessions VALUES('s','legacy session',0,1,1);
    CREATE TABLE focus_states(surface_id TEXT PRIMARY KEY,active_session_id TEXT REFERENCES sessions(id),interrupted_session_id TEXT REFERENCES sessions(id),version INTEGER NOT NULL DEFAULT 1);
    INSERT INTO focus_states VALUES('a','s',NULL,7);
    CREATE TABLE messages(id TEXT PRIMARY KEY,timeline_id TEXT NOT NULL DEFAULT 'main' REFERENCES timelines(id),session_id TEXT NOT NULL REFERENCES sessions(id),sequence INTEGER NOT NULL UNIQUE,role TEXT NOT NULL,content TEXT NOT NULL,run_id TEXT REFERENCES runs(id),created_at INTEGER NOT NULL);
    CREATE TABLE runs(id TEXT PRIMARY KEY,user_message_id TEXT NOT NULL REFERENCES messages(id),assistant_message_id TEXT REFERENCES messages(id),session_id TEXT NOT NULL REFERENCES sessions(id),binding_json TEXT NOT NULL,context_json TEXT,status TEXT NOT NULL,error_code TEXT,attempt INTEGER NOT NULL,retry_of TEXT UNIQUE REFERENCES runs(id),request_key TEXT NOT NULL UNIQUE,request_hash TEXT NOT NULL,created_at INTEGER NOT NULL);
    CREATE TABLE events(sequence INTEGER PRIMARY KEY AUTOINCREMENT,id TEXT NOT NULL UNIQUE,schema_version INTEGER NOT NULL,type TEXT NOT NULL,aggregate_id TEXT NOT NULL,correlation_id TEXT NOT NULL,causation_id TEXT,occurred_at INTEGER NOT NULL,payload_ref TEXT NOT NULL);
    CREATE INDEX events_aggregate_sequence ON events(aggregate_id,sequence);
    INSERT INTO messages VALUES('u1','main','s',1,'user','legacy question',NULL,1);
    INSERT INTO runs VALUES('r1','u1',NULL,'s','{}','[{"role":"user","content":"legacy question"}]','completed',NULL,1,NULL,'key1','hash1',1);
    INSERT INTO messages VALUES('a1','main','s',2,'assistant','legacy answer','r1',1);
    UPDATE runs SET assistant_message_id='a1' WHERE id='r1';
    INSERT INTO messages VALUES('u2','main','s',3,'user','pending',NULL,2);
    INSERT INTO runs VALUES('r2','u2',NULL,'s','{}','[{"role":"user","content":"legacy question"},{"role":"assistant","content":"legacy answer"},{"role":"user","content":"pending"}]','running',NULL,1,NULL,'key2','hash2',2);
    INSERT INTO messages VALUES('a2','main','s',4,'assistant','','r2',2);
    UPDATE runs SET assistant_message_id='a2' WHERE id='r2';
    PRAGMA user_version=1;
  `);
  legacy.close();
  let app = new AppService(directory);
  try {
    const state: any = app.dispatch("state.get", { surfaceId: "a" });
    assert.deepEqual(
      state.messages.map((m: any) => [m.id, m.sequence]),
      [
        ["u1", 1],
        ["a1", 2],
        ["u2", 3],
        ["a2", 4],
      ],
    );
    assert.equal(state.focus.version, 7);
    assert.equal(state.focus.activeSessionId, "s");
    assert.equal(state.focus.contextMode, "automatic");
    assert.equal(state.messages[3].status, "interrupted");
    const snapshot: any = app.dispatch("snapshot.get", {
      surfaceId: "a",
      id: state.messages[1].snapshotId,
    });
    assert.equal(snapshot.fragments[0].content, "legacy question");
    assert.equal(snapshot.fragments[0].sourceType, "legacy_input");
    assert.equal(app.store.db.prepare("SELECT COUNT(*) AS n FROM interactions").get()!.n, 2);
    assert.equal(app.store.db.prepare("PRAGMA foreign_key_check").all().length, 0);
    assert.equal(app.store.db.prepare("PRAGMA user_version").get()!.user_version, 4);
    const backups = readdirSync(`${directory}/migrations`);
    assert.equal(backups.length, 3);
    const backupPath = `${directory}/migrations/${backups.find((name) => name.startsWith("schema-1-"))}`;
    assert.equal(statSync(backupPath).mode & 0o777, 0o600);
    const original = new DatabaseSync(backupPath, { readOnly: true });
    try {
      assert.equal(original.prepare("PRAGMA user_version").get()!.user_version, 1);
      assert.equal(original.prepare("SELECT COUNT(*) AS n FROM messages").get()!.n, 4);
      assert.equal(original.prepare("PRAGMA quick_check").get()!.quick_check, "ok");
    } finally {
      original.close();
    }
    // Exercise recovery on a disposable copy; never replace a live application database.
    const recovery = mkdtempSync("/tmp/tandem-recovery-");
    try {
      copyFileSync(backupPath, `${recovery}/tandem.sqlite`);
      const restored = new AppService(recovery);
      assert.equal(restored.store.db.prepare("SELECT COUNT(*) AS n FROM messages").get()!.n, 4);
      await restored.stop();
    } finally {
      rmSync(recovery, { recursive: true, force: true });
    }
    const failure = mkdtempSync("/tmp/tandem-migration-fail-");
    try {
      copyFileSync(backupPath, `${failure}/tandem.sqlite`);
      const conflict = new DatabaseSync(`${failure}/tandem.sqlite`);
      conflict.exec("CREATE TABLE projects(id TEXT)");
      conflict.close();
      assert.throws(() => new AppService(failure));
      const unchanged = new DatabaseSync(`${failure}/tandem.sqlite`, { readOnly: true });
      try {
        assert.equal(unchanged.prepare("PRAGMA user_version").get()!.user_version, 1);
        assert.equal(unchanged.prepare("SELECT COUNT(*) AS n FROM messages").get()!.n, 4);
        assert.equal(
          unchanged
            .prepare(
              "SELECT COUNT(*) AS n FROM pragma_table_info('messages') WHERE name='interaction_id'",
            )
            .get()!.n,
          0,
        );
      } finally {
        unchanged.close();
      }
      assert.equal(readdirSync(`${failure}/migrations`).length, 1);
    } finally {
      rmSync(failure, { recursive: true, force: true });
    }
    await app.stop();
    app = new AppService(directory);
    assert.equal(app.store.db.prepare("SELECT COUNT(*) AS n FROM interactions").get()!.n, 2);
    assert.equal(app.store.db.prepare("SELECT COUNT(*) AS n FROM context_snapshots").get()!.n, 2);
    const project: any = app.dispatch("project.create", {
      title: "legacy corrected",
      description: "",
    });
    const input = app.store.db.prepare("SELECT interaction_id FROM messages WHERE id='u1'").get()!;
    app.dispatch("interaction.correct", {
      surfaceId: "a",
      interactionId: input.interaction_id,
      projectId: project.id,
      expectedVersion: 1,
    });
    const preview: any = app.dispatch("project.deletePreview", { id: project.id });
    app.dispatch("project.delete", { token: preview.token, confirm: true });
    const remaining = app.store.db.prepare("SELECT fragments_json FROM context_snapshots").all();
    assert.equal(remaining.length, 1);
    assert.equal(String(remaining[0].fragments_json).includes("legacy question"), false);
    assert.equal(
      app.store.db.prepare("SELECT content FROM messages WHERE id='a2'").get()!.content,
      "内容已删除，无法还原",
    );
    assert.equal(app.store.db.prepare("PRAGMA foreign_key_check").all().length, 0);
  } finally {
    await app.stop();
    rmSync(directory, { recursive: true, force: true });
  }
});

test("M2 to M3 protects WAL history and rolls back a conflicting schema without altering old tables", async () => {
  const directory = mkdtempSync("/tmp/tandem-m3-migration-");
  const recovery = mkdtempSync("/tmp/tandem-m3-rollback-");
  try {
    const initial = new AppService(directory);
    await initial.stop();
    const name = readdirSync(`${directory}/migrations`).find((n) => n.startsWith("schema-2-"))!;
    const path = `${directory}/migrations/${name}`;
    assert.equal(statSync(path).mode & 0o777, 0o600);
    copyFileSync(path, `${recovery}/tandem.sqlite`);
    const old = new DatabaseSync(`${recovery}/tandem.sqlite`);
    old.exec(
      "INSERT INTO sessions(id,title,temporary,created_at,updated_at) VALUES('preserve','WAL data',0,1,1); CREATE TABLE tasks(conflict TEXT);",
    );
    old.close();
    assert.throws(() => new AppService(recovery));
    const unchanged = new DatabaseSync(`${recovery}/tandem.sqlite`);
    assert.equal(unchanged.prepare("PRAGMA user_version").get()!.user_version, 2);
    assert.equal(
      unchanged.prepare("SELECT title FROM sessions WHERE id='preserve'").get()!.title,
      "WAL data",
    );
    assert.equal(
      unchanged.prepare("SELECT 1 FROM sqlite_master WHERE name='run_progress'").get(),
      undefined,
    );
    unchanged.exec("DROP TABLE tasks");
    unchanged.close();
    const upgraded = new AppService(recovery);
    assert.equal(upgraded.store.db.prepare("PRAGMA user_version").get()!.user_version, 4);
    assert.equal(
      upgraded.store.db.prepare("SELECT title FROM sessions WHERE id='preserve'").get()!.title,
      "WAL data",
    );
    assert.equal(upgraded.store.db.prepare("PRAGMA foreign_key_check").all().length, 0);
    await upgraded.stop();
  } finally {
    rmSync(directory, { recursive: true, force: true });
    rmSync(recovery, { recursive: true, force: true });
  }
});
