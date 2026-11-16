import { DatabaseSync } from "node:sqlite";
import { chmodSync, existsSync, lstatSync } from "node:fs";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { privateDirectory } from "./config.ts";
import { migrate } from "./migrations.ts";
import { requireValue } from "./errors.ts";

export class Store {
  readonly db: DatabaseSync;
  constructor(directory: string) {
    privateDirectory(directory);
    const path = join(directory, "tandem.sqlite");
    if (existsSync(path))
      requireValue(lstatSync(path).isFile() && !lstatSync(path).isSymbolicLink(), "DATABASE_FILE");
    this.db = new DatabaseSync(path);
    chmodSync(path, 0o600);
    this.db.exec("PRAGMA foreign_keys=ON; PRAGMA journal_mode=WAL; PRAGMA busy_timeout=3000;");
    try {
      migrate(this, directory);
    } catch (error) {
      this.db.close();
      throw error;
    }
    this.db.exec("UPDATE outbox SET status='interrupted' WHERE status='pending';");
    // Reopening the app never restarts interrupted model work automatically.
    this.transaction(() => {
      const pending = this.db
        .prepare("SELECT assistant_message_id FROM runs WHERE status IN('queued','running')")
        .all();
      this.db
        .prepare(
          "UPDATE runs SET status='interrupted', error_code='INTERRUPTED' WHERE status IN('queued','running')",
        )
        .run();
      for (const run of pending) this.changed(String(run.assistant_message_id));
    });
  }

  transaction<T>(body: () => T): T {
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const result = body();
      this.db.exec("COMMIT");
      return result;
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
  }

  sequence(): number {
    return Number(
      this.db
        .prepare(
          "UPDATE timelines SET next_sequence=next_sequence+1 WHERE id='main' RETURNING next_sequence-1 AS value",
        )
        .get()!.value,
    );
  }

  focus(surfaceId: string) {
    this.db
      .prepare(
        `INSERT OR IGNORE INTO focus_states(surface_id,active_session_id) VALUES(?,
      (SELECT id FROM sessions WHERE temporary=0 ORDER BY updated_at DESC, rowid DESC LIMIT 1))`,
      )
      .run(surfaceId);
    return this.db
      .prepare(
        "SELECT active_session_id AS activeSessionId, interrupted_session_id AS interruptedSessionId,active_project_id AS activeProjectId,context_mode AS contextMode,recent_session_ids AS recentSessionIds, version FROM focus_states WHERE surface_id=?",
      )
      .get(surfaceId)!;
  }

  newSession(title: string, temporary: boolean): string {
    const id = randomUUID();
    this.db
      .prepare("INSERT INTO sessions(id,title,temporary,created_at,updated_at) VALUES(?,?,?,?,?)")
      .run(id, title.slice(0, 60), Number(temporary), Date.now(), Date.now());
    return id;
  }

  timeline(before?: number) {
    return this.messageRows(
      "m.sequence<? ORDER BY m.sequence DESC LIMIT 10",
      before ?? Number.MAX_SAFE_INTEGER,
    ).reverse();
  }

  private messageRows(where: string, ...args: (string | number)[]) {
    const rows = this.db
      .prepare(
        `SELECT m.id,m.session_id AS sessionId,m.sequence,m.role,m.content,m.created_at AS createdAt,
      i.route_json AS routeJson,COALESCE(m.interaction_id,r.interaction_id) AS interactionId,i.project_id AS projectId,i.version AS interactionVersion,r.project_id AS executionProjectId,r.interaction_version AS executionInteractionVersion,r.snapshot_id AS snapshotId,r.id AS runId,r.status,r.error_code AS errorCode,r.binding_json AS bindingJson,r.attempt
      FROM messages m LEFT JOIN runs r ON r.id=m.run_id LEFT JOIN interactions i ON i.id=COALESCE(m.interaction_id,r.interaction_id)
      WHERE ${where}`,
      )
      .all(...args);
    return rows.map((row) => {
      const binding = row.bindingJson ? JSON.parse(String(row.bindingJson)) : null;
      const { bindingJson, routeJson, ...message } = row;
      const route = routeJson ? JSON.parse(String(routeJson)) : null;
      return {
        ...message,
        routeReason: route?.reason ?? null,
        modelName: binding?.modelName ?? null,
        connectionId: binding?.id ?? null,
      };
    });
  }

  changed(messageId: string) {
    const row = this.db.prepare("SELECT run_id FROM messages WHERE id=?").get(messageId);
    this.db
      .prepare(
        "INSERT INTO events(id,schema_version,type,aggregate_id,correlation_id,causation_id,occurred_at,payload_ref) VALUES(?,1,'message.changed',?,?,?,?,?)",
      )
      .run(randomUUID(), messageId, row?.run_id ?? messageId, null, Date.now(), messageId);
  }

  changes(after?: number) {
    const latest = Number(
      this.db.prepare("SELECT COALESCE(MAX(sequence),0) AS n FROM events").get()!.n,
    );
    if (after === undefined) return { cursor: latest, messages: [] };
    requireValue(Number.isSafeInteger(after) && after >= 0 && after <= latest, "GAP_REQUIRED");
    if (after !== undefined)
      requireValue(
        !this.db
          .prepare("SELECT 1 FROM events WHERE type='history.deleted' AND sequence>? LIMIT 1")
          .get(after),
        "GAP_REQUIRED",
      );
    if (after === latest) return { cursor: latest, messages: [] };
    // Coalesce text deltas per message so a token stream cannot delay other views' updates.
    const boundary = this.db
      .prepare(
        "SELECT MAX(sequence) AS sequence FROM events GROUP BY aggregate_id HAVING MAX(sequence)>? ORDER BY sequence LIMIT 5",
      )
      .all(after);
    const cursor = boundary.length ? Number(boundary.at(-1)!.sequence) : latest;
    return {
      cursor,
      messages: this.messageRows(
        "m.id IN (SELECT aggregate_id FROM events GROUP BY aggregate_id HAVING MAX(sequence)>? AND MAX(sequence)<=?) ORDER BY m.sequence",
        after,
        cursor,
      ),
    };
  }

  runStatus(id: string, status: string, code: string | null = null) {
    this.transaction(() => {
      this.db.prepare("UPDATE runs SET status=?,error_code=? WHERE id=?").run(status, code, id);
      const run = this.db.prepare("SELECT assistant_message_id FROM runs WHERE id=?").get(id);
      if (run) this.changed(String(run.assistant_message_id));
      if (["completed", "failed", "cancelled", "interrupted"].includes(status))
        this.db
          .prepare(
            "UPDATE outbox SET status=? WHERE interaction_id=(SELECT interaction_id FROM runs WHERE id=?)",
          )
          .run(status === "interrupted" ? "interrupted" : "done", id);
    });
  }
}
