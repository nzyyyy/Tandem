import { createHash, randomUUID } from "node:crypto";
import { redact } from "./config.ts";
import type { AppConfig } from "./config.ts";
import { requireValue, text } from "./errors.ts";
import type { Store } from "./store.ts";

type Row = Record<string, any>;
const digest = (s: string) => createHash("sha256").update(s).digest("hex");
const normalize = (s: string) =>
  s
    .normalize("NFKC")
    .toLowerCase()
    .replace(/[\s\p{P}]/gu, "");
const sameContent = (a: string, b: string) =>
  a.normalize("NFKC").toLowerCase().replace(/\s+/g, " ").trim() ===
  b.normalize("NFKC").toLowerCase().replace(/\s+/g, " ").trim();
const predicate = (s: string) =>
  /^(数据库|存储方案|存储|database)$/i.test(s.trim()) ? "数据库" : normalize(s);
const key = (subject: string, relation: string) =>
  digest(normalize(subject) + "\0" + predicate(relation));
const words = (s: string) =>
  [
    ...new Set(
      [...new Intl.Segmenter("zh", { granularity: "word" }).segment(s.toLowerCase())]
        .filter((x) => x.isWordLike)
        .map((x) => x.segment),
    ),
  ].slice(0, 64);
const sensitive = (s: string) =>
  /\[REDACTED\]|密码|密钥|凭据|身份证|银行卡|病历|诊断|住址|手机号|电话|邮箱|健康|宗教|性取向|password|api.?key|secret|token|@|\b\d{7,}\b/i.test(
    s,
  );

export function memoryFragmentValid(
  store: Store,
  f: Row,
  scope?: Row,
  visited = new Set<string>(),
): boolean {
  if (scope && !memoryScopeAllowed(f, scope.projectId, scope.mode)) return false;
  if (f.sourceType === "memory") {
    const m = store.db
      .prepare(
        "SELECT * FROM memories WHERE id=? AND status='active' AND version=? AND project_id IS ?",
      )
      .get(f.sourceId, Number(f.sourceVersion), f.projectId);
    return (
      !!m &&
      !!store.db
        .prepare(
          "SELECT 1 FROM memory_evidence e JOIN interactions i ON i.id=e.interaction_id JOIN messages msg ON msg.id=e.message_id WHERE e.memory_id=? AND e.valid=1 AND (?!='decision' OR e.confirmed=1) AND e.interaction_version=i.version AND e.project_id IS i.project_id AND i.project_id IS ? AND msg.role='user'",
        )
        .get(m.id, m.kind, m.project_id)
    );
  }
  // Follow derived answers and model-created Task text, not just direct memory fragments.
  const origins =
    f.sourceType === "message"
      ? store.db
          .prepare("SELECT run_id FROM messages WHERE id=? AND run_id IS NOT NULL")
          .all(f.sourceId)
      : f.taskId
        ? store.db
            .prepare(
              "SELECT run_id FROM invocations WHERE name='create_task' AND status='completed' AND json_extract(result,'$.taskId')=? AND json_extract(result,'$.revision')=?",
            )
            .all(f.taskId, f.taskRevision)
        : [];
  for (const origin of origins) {
    const id = String(origin.run_id);
    if (visited.has(id)) continue;
    visited.add(id);
    const snapshots = store.db
      .prepare("SELECT fragments_json FROM context_snapshots WHERE run_id=?")
      .all(id);
    if (
      snapshots.some((s) =>
        JSON.parse(String(s.fragments_json)).some(
          (item: Row) => item.deleted || !memoryFragmentValid(store, item, scope, visited),
        ),
      )
    )
      return false;
  }
  return true;
}

export function memoryScopeAllowed(f: Row, projectId: unknown, mode: unknown): boolean {
  return (
    f.projectId === projectId ||
    (f.sourceType === "memory" && f.projectId === null && mode !== "isolated")
  );
}

export class MemoryEngine {
  readonly store: Store;
  readonly config: () => AppConfig;
  readonly cancel: (id: string) => void;
  constructor(store: Store, config: () => AppConfig, cancel: (id: string) => void) {
    this.store = store;
    this.config = config;
    this.cancel = cancel;
  }
  private get db() {
    return this.store.db;
  }
  private scope(surfaceId: unknown, projectId: unknown) {
    const f = this.store.focus(text(surfaceId));
    requireValue(
      f.contextMode === "automatic" || (!!f.activeProjectId && projectId === f.activeProjectId),
      "CONTEXT_SCOPE",
    );
  }
  private evidence(messageId: unknown, version: unknown) {
    const e = this.db
      .prepare(
        "SELECT m.id,m.content,i.id AS interaction_id,i.version,i.project_id FROM messages m JOIN interactions i ON i.id=m.interaction_id WHERE m.id=? AND m.role='user' AND i.status='committed'",
      )
      .get(text(messageId));
    requireValue(e && e.version === version, "MEMORY_EVIDENCE_CHANGED");
    return e;
  }
  private blocked(keyHash: string, sourceId: string) {
    return this.db
      .prepare(
        "SELECT evidence_ids FROM memory_forget_markers WHERE key_hash=? AND released_at IS NULL",
      )
      .all(keyHash)
      .some((m) => JSON.parse(String(m.evidence_ids)).includes(sourceId));
  }
  private index(id: string) {
    this.db.prepare("DELETE FROM memory_search WHERE memory_id=?").run(id);
    const m = this.db.prepare("SELECT * FROM memories WHERE id=? AND status='active'").get(id);
    if (m)
      this.db
        .prepare("INSERT INTO memory_search VALUES(?,?)")
        .run(id, words(`${m.subject} ${m.predicate} ${m.content}`).join(" "));
    this.changed(id);
  }
  rebuildSearch() {
    this.db.exec("DELETE FROM memory_search");
    for (const m of this.db.prepare("SELECT * FROM memories WHERE status='active'").all())
      this.db
        .prepare("INSERT INTO memory_search VALUES(?,?)")
        .run(m.id, words(`${m.subject} ${m.predicate} ${m.content}`).join(" "));
  }
  mergeForgetMarkers(markers: Row[]) {
    this.store.transaction(() => {
      for (const marker of markers) {
        const old = this.db
          .prepare("SELECT * FROM memory_forget_markers WHERE id=?")
          .get(marker.id);
        requireValue(
          !old || (old.scope === marker.scope && old.key_hash === marker.key_hash),
          "BACKUP_DATABASE",
        );
        const evidence = [
          ...new Set<string>([
            ...JSON.parse(String(marker.evidence_ids)),
            ...(old ? JSON.parse(String(old.evidence_ids)) : []),
          ]),
        ];
        this.db
          .prepare(
            "INSERT INTO memory_forget_markers VALUES(?,?,?,?,?,NULL) ON CONFLICT(id) DO UPDATE SET evidence_ids=excluded.evidence_ids,released_at=NULL",
          )
          .run(
            marker.id,
            marker.scope,
            marker.key_hash,
            JSON.stringify(evidence),
            marker.created_at,
          );
      }
      for (const marker of this.db
        .prepare("SELECT * FROM memory_forget_markers WHERE released_at IS NULL")
        .all()) {
        const sources: string[] = JSON.parse(String(marker.evidence_ids));
        const ids = this.db
          .prepare("SELECT id FROM memories WHERE COALESCE(project_id,'')=? AND key_hash=?")
          .all(marker.scope, marker.key_hash)
          .filter((m) =>
            this.db
              .prepare("SELECT message_id FROM memory_evidence WHERE memory_id=?")
              .all(m.id)
              .some((e) => sources.includes(String(e.message_id))),
          )
          .map((m) => String(m.id));
        this.invalidateCopies([...ids, ...sources], true);
        for (const id of ids) {
          this.db.prepare("DELETE FROM memory_search WHERE memory_id=?").run(id);
          this.db.prepare("DELETE FROM memories WHERE id=?").run(id);
        }
      }
    });
  }
  private changed(id: string) {
    this.db
      .prepare(
        "INSERT INTO events(id,schema_version,type,aggregate_id,correlation_id,occurred_at,payload_ref) VALUES(?,1,'memory.changed',?,?,?,?)",
      )
      .run(randomUUID(), id, id, Date.now(), id);
  }
  // shortcut: only anchored, unambiguous statements are extracted locally; extend the grammar with evaluated examples as needed.
  extract(interactionId: string, allowDecision = true) {
    const i = this.db.prepare("SELECT * FROM interactions WHERE id=?").get(interactionId);
    if (!i?.message_id) return;
    const s = String(i.input).trim();
    if (
      sensitive(s) ||
      /假如|假设|例如|比如|据说|他说|她说|引用|可能|也许|候选|考虑|建议|如果|[“”「」"`\n?？]/u.test(
        s,
      )
    )
      return;
    let value: Row | null = null;
    const fact =
      /^我(?:平时|一直|长期)?主要(?:用|使用)\s*([\p{L}\p{N}+#. /-]{1,60}?)\s*(?:开发|编程)[。！!]?$/u.exec(
        s,
      );
    if (fact)
      value = {
        kind: "fact",
        subject: "用户",
        predicate: "主要开发语言",
        content: fact[1].trim(),
        confirmed: false,
      };
    const decision =
      /^(?:我)?(?:确认|决定|确定)(?:项目)?(?:的)?(数据库|存储方案|技术栈|开发语言|部署方式)(?:采用|使用|选择|为|是)\s*([\p{L}\p{N}+#. /-]{1,100})[。！!]?$/u.exec(
        s,
      );
    const change =
      /^(?:我)?(?:确认)?(?:将|把)(?:项目)?(数据库|存储方案|技术栈|开发语言|部署方式)从[\p{L}\p{N}+#. /-]{1,100}(?:改为|改成|替换为)\s*([\p{L}\p{N}+#. /-]{1,100})[。！!]?$/u.exec(
        s,
      );
    const d = decision ?? change;
    if (d && i.project_id)
      value = {
        kind: "decision",
        subject: "项目",
        predicate: d[1],
        content: d[2].trim(),
        confirmed: allowDecision,
      };
    if (!value) return;
    if (this.blocked(key(value.subject, predicate(value.predicate)), String(i.message_id))) return;
    this.save({ ...value, messageId: i.message_id, expectedInteractionVersion: i.version }, false);
  }
  private save(p: Row, manual: boolean) {
    const e = this.evidence(p.messageId, p.expectedInteractionVersion);
    if (manual) this.scope(p.surfaceId, e.project_id);
    requireValue(["fact", "decision"].includes(p.kind));
    const subject = text(p.subject, 120).trim(),
      relation = predicate(text(p.predicate, 120)),
      content = text(p.content, 2000).trim();
    const combined = `${subject} ${relation} ${content}`;
    requireValue(
      !sensitive(combined) && redact(combined, this.config()) === combined,
      "MEMORY_SENSITIVE",
    );
    const keyHash = key(subject, relation);
    requireValue(!this.blocked(keyHash, String(e.id)), "MEMORY_FORGOTTEN");
    const confirmed = p.confirmed === true;
    const old = this.db
      .prepare("SELECT * FROM memories WHERE key_hash=? AND project_id IS ? AND status='active'")
      .get(keyHash, e.project_id);
    const duplicate = this.db
      .prepare(
        "SELECT m.* FROM memories m JOIN memory_evidence e ON e.memory_id=m.id WHERE m.key_hash=? AND m.project_id IS ? AND e.message_id=? AND e.interaction_version=? AND m.content=? AND m.status!='superseded' ORDER BY m.created_at DESC LIMIT 1",
      )
      .get(keyHash, e.project_id, e.id, e.version, content);
    if (duplicate && !(confirmed && !duplicate.confirmed_at)) return { id: duplicate.id };
    let status = p.kind === "decision" && !confirmed ? "candidate" : "active";
    if (old?.kind === "decision" && p.kind === "fact") status = "candidate";
    if (old && !sameContent(String(old.content), content) && !confirmed) status = "candidate";
    if (
      old &&
      sameContent(String(old.content), content) &&
      old.kind === p.kind &&
      (p.kind !== "decision" || confirmed) &&
      (!confirmed || old.confirmed_at)
    ) {
      this.db
        .prepare("INSERT OR REPLACE INTO memory_evidence VALUES(?,?,?,?,?,1,?)")
        .run(old.id, e.id, e.interaction_id, e.version, e.project_id, Number(confirmed));
      return { id: old.id };
    }
    if (status === "active" && old) {
      this.db
        .prepare(
          "UPDATE memories SET status='superseded',version=version+1,updated_at=? WHERE id=?",
        )
        .run(Date.now(), old.id);
      this.index(String(old.id));
      this.invalidateCopies([String(old.id)], false);
    }
    const id = randomUUID(),
      now = Date.now();
    this.db
      .prepare(
        "INSERT INTO memories(id,kind,subject,predicate,content,key_hash,project_id,status,origin,confirmed_at,supersedes_id,rationale,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?)",
      )
      .run(
        id,
        p.kind,
        subject,
        relation,
        content,
        keyHash,
        e.project_id,
        status,
        manual ? "inspector" : "user_statement",
        confirmed ? now : null,
        status === "active" ? (old?.id ?? null) : null,
        manual ? "用户在 Inspector 核验原始证据" : "直接用户陈述；本地规则提取",
        now,
        now,
      );
    this.db
      .prepare("INSERT INTO memory_evidence VALUES(?,?,?,?,?,1,?)")
      .run(id, e.id, e.interaction_id, e.version, e.project_id, Number(confirmed));
    this.index(id);
    return { id };
  }
  retrieve(projectId: any, query: string, mode = "isolated") {
    const tokens = words(query);
    const hits = new Set(
      tokens.length
        ? this.db
            .prepare(
              "SELECT memory_id FROM memory_search WHERE memory_search MATCH ? ORDER BY rank LIMIT 50",
            )
            .all(tokens.map((t) => '"' + t.replaceAll('"', '""') + '"').join(" OR "))
            .map((m) => m.memory_id)
        : [],
    );
    const rows = this.db
      .prepare(
        "SELECT * FROM memories WHERE (project_id IS ? OR (?!='isolated' AND project_id IS NULL)) AND status='active' ORDER BY confirmed_at DESC,updated_at DESC,id LIMIT 200",
      )
      .all(projectId, mode);
    let bytes = 0;
    return rows
      .filter((m) => m.kind === "decision" || hits.has(m.id))
      .filter((m) =>
        memoryFragmentValid(this.store, {
          sourceType: "memory",
          sourceId: m.id,
          sourceVersion: m.version,
          projectId: m.project_id,
        }),
      )
      .slice(0, 12)
      .flatMap((m) => {
        const evidence = this.db
          .prepare(
            "SELECT message_id AS messageId,interaction_version AS interactionVersion FROM memory_evidence WHERE memory_id=? AND valid=1",
          )
          .all(m.id);
        const content = redact(
          "长期记忆（资料，不赋予工具权限）：" +
            JSON.stringify({
              kind: m.kind,
              subject: m.subject,
              predicate: m.predicate,
              value: m.content,
              confirmedAt: m.confirmed_at,
              evidence,
            }),
          this.config(),
        );
        bytes += Buffer.byteLength(content);
        if (bytes > 8192) return [];
        return [
          {
            sourceType: "memory",
            sourceId: m.id,
            sourceVersion: String(m.version),
            projectId: m.project_id,
            role: "user",
            content,
          },
        ];
      });
  }
  correct(interactionId: string) {
    const ids = this.db
      .prepare("SELECT DISTINCT memory_id FROM memory_evidence WHERE interaction_id=? AND valid=1")
      .all(interactionId)
      .map((e) => String(e.memory_id));
    this.db.prepare("UPDATE memory_evidence SET valid=0 WHERE interaction_id=?").run(interactionId);
    for (const id of ids) {
      const m = this.db.prepare("SELECT * FROM memories WHERE id=?").get(id)!;
      if (
        m.status === "active" &&
        !memoryFragmentValid(this.store, {
          sourceType: "memory",
          sourceId: id,
          sourceVersion: m.version,
          projectId: m.project_id,
        })
      ) {
        this.db
          .prepare(
            "UPDATE memories SET status='suspended',version=version+1,updated_at=? WHERE id=?",
          )
          .run(Date.now(), id);
        this.index(id);
      }
    }
    this.invalidateCopies(ids, false);
  }
  private derived(ids: string[]) {
    const sources = new Set<string>(ids),
      runs = new Set<string>();
    const tasks = new Map<string, Row>();
    const snapshots = this.db
      .prepare(
        "SELECT s.*,r.assistant_message_id FROM context_snapshots s JOIN runs r ON r.id=s.run_id ORDER BY s.rowid",
      )
      .all();
    let changed = true;
    while (changed) {
      changed = false;
      for (const s of snapshots) {
        if (runs.has(String(s.run_id))) continue;
        if (
          JSON.parse(String(s.fragments_json)).some(
            (f: Row) => sources.has(f.sourceId) || tasks.has(`${f.taskId}:${f.taskRevision}`),
          )
        ) {
          runs.add(String(s.run_id));
          sources.add(String(s.assistant_message_id));
          changed = true;
          for (const i of this.db
            .prepare(
              "SELECT result FROM invocations WHERE run_id=? AND name='create_task' AND status='completed' AND result IS NOT NULL",
            )
            .all(s.run_id)) {
            const result = JSON.parse(String(i.result));
            if (result.taskId && result.revision)
              tasks.set(`${result.taskId}:${result.revision}`, result);
          }
        }
      }
    }
    return { sources, runs, snapshots, tasks };
  }
  private invalidateCopies(ids: string[], erase: boolean) {
    if (!ids.length) return;
    const job = randomUUID();
    this.db
      .prepare("INSERT INTO memory_outbox VALUES(?,?,?,'pending',?)")
      .run(job, ids.join(","), erase ? "forget" : "invalidate", Date.now());
    const { sources, runs, snapshots, tasks } = this.derived(ids);
    if (erase)
      for (const task of tasks.values()) {
        this.db
          .prepare(
            "UPDATE task_revisions SET deliverable='内容已删除，无法还原',criteria='[\"原依据已遗忘，请修改任务并重新确认标准\"]',result_ref=NULL,evidence=NULL,status='open' WHERE task_id=? AND revision=?",
          )
          .run(task.taskId, task.revision);
        this.db
          .prepare("UPDATE tasks SET status='open' WHERE id=? AND revision=?")
          .run(task.taskId, task.revision);
      }
    for (const id of runs) {
      const run = this.db.prepare("SELECT * FROM runs WHERE id=?").get(id)!;
      if (
        ["queued", "running", "waiting_approval", "paused", "interrupted"].includes(
          String(run.status),
        )
      )
        this.cancel(id);
      if (erase) {
        this.db.prepare("UPDATE run_progress SET checkpoint=NULL WHERE run_id=?").run(id);
        this.db.prepare("DELETE FROM run_steps WHERE run_id=?").run(id);
        this.db.prepare("DELETE FROM invocations WHERE run_id=?").run(id);
        this.db
          .prepare("UPDATE messages SET content='内容已删除，无法还原' WHERE id=?")
          .run(run.assistant_message_id);
        this.db
          .prepare(
            "UPDATE tasks SET status='open' WHERE id IN(SELECT task_id FROM task_revisions WHERE result_ref=? AND revision=tasks.revision)",
          )
          .run(run.assistant_message_id);
        this.db
          .prepare(
            "UPDATE task_revisions SET result_ref=NULL,evidence=NULL,status='open' WHERE result_ref=?",
          )
          .run(run.assistant_message_id);
      }
      this.store.changed(String(run.assistant_message_id));
    }
    if (erase)
      for (const s of snapshots) {
        if (!runs.has(String(s.run_id))) continue;
        const fragments = JSON.parse(String(s.fragments_json)).map((f: Row) =>
          sources.has(f.sourceId) ||
          tasks.has(`${f.taskId}:${f.taskRevision}`) ||
          f.sourceType === "model_output" ||
          f.sourceType === "tool"
            ? {
                sourceType: f.sourceType,
                sourceId: f.sourceId,
                sourceVersion: f.sourceVersion,
                projectId: f.projectId,
                role: f.role,
                content: "内容已删除，无法还原",
                deleted: true,
              }
            : f,
        );
        this.db
          .prepare("UPDATE context_snapshots SET fragments_json=? WHERE id=?")
          .run(JSON.stringify(fragments), s.id);
        this.db.prepare("UPDATE runs SET context_json=NULL WHERE id=?").run(s.run_id);
      }
    this.db.prepare("UPDATE memory_outbox SET status='done' WHERE id=?").run(job);
  }
  projectMemories(projectId: string, messageIds: string[]) {
    const sources = new Set(messageIds);
    return this.db
      .prepare("SELECT id,version,project_id FROM memories ORDER BY id")
      .all()
      .filter(
        (m) =>
          m.project_id === projectId ||
          this.db
            .prepare("SELECT message_id FROM memory_evidence WHERE memory_id=?")
            .all(m.id)
            .some((e) => sources.has(String(e.message_id))),
      );
  }
  deleteProject(projectId: string, messageIds: string[]) {
    const ids = this.projectMemories(projectId, messageIds).map((m) => String(m.id));
    this.invalidateCopies(ids, true);
    for (const id of ids) {
      this.db.prepare("DELETE FROM memory_search WHERE memory_id=?").run(id);
      this.db.prepare("DELETE FROM memories WHERE id=?").run(id);
    }
  }
  dispatch(method: string, p: Row): unknown {
    if (!method.startsWith("memory.")) return undefined;
    if (method === "memory.list") {
      const focus = this.store.focus(text(p.surfaceId));
      const allowed = (project: any) =>
        focus.contextMode === "automatic" ||
        (!!focus.activeProjectId && focus.activeProjectId === project);
      const all = this.db
        .prepare("SELECT * FROM memories ORDER BY updated_at DESC,id")
        .all()
        .filter((m) => allowed(m.project_id));
      const query = p.query == null || p.query === "" ? "" : text(p.query, 200);
      const tokens = words(query);
      const matches = new Set(
        tokens.length
          ? this.db
              .prepare("SELECT memory_id FROM memory_search WHERE memory_search MATCH ?")
              .all(tokens.map((t) => '"' + t.replaceAll('"', '""') + '"').join(" OR "))
              .map((m) => m.memory_id)
          : [],
      );
      return {
        memories: all
          .filter(
            (m) =>
              !query ||
              matches.has(m.id) ||
              normalize(`${m.subject}${m.predicate}${m.content}`).includes(normalize(query)),
          )
          .slice(0, 200),
        markers: this.db
          .prepare(
            "SELECT * FROM memory_forget_markers WHERE released_at IS NULL ORDER BY created_at DESC",
          )
          .all()
          .filter((m) => allowed(m.scope || null)),
      };
    }
    if (method === "memory.save") return this.store.transaction(() => this.save(p, true));
    if (method === "memory.allow")
      return this.store.transaction(() => {
        const marker = this.db
          .prepare("SELECT * FROM memory_forget_markers WHERE id=?")
          .get(text(p.id));
        requireValue(marker, "MEMORY_NOT_FOUND");
        this.scope(p.surfaceId, marker.scope || null);
        requireValue(p.confirm === true, "MEMORY_CONFIRM_REQUIRED");
        this.db
          .prepare(
            "UPDATE memory_forget_markers SET released_at=COALESCE(released_at,?) WHERE id=?",
          )
          .run(Date.now(), marker.id);
        this.changed(String(marker.id));
        return {};
      });
    const m = this.db.prepare("SELECT * FROM memories WHERE id=?").get(text(p.id));
    requireValue(m, "MEMORY_NOT_FOUND");
    this.scope(p.surfaceId, m.project_id);
    if (method === "memory.get")
      return {
        ...m,
        evidence: this.db
          .prepare(
            "SELECT e.*,m.content,m.session_id,i.project_id AS current_project_id,i.version AS current_version FROM memory_evidence e JOIN messages m ON m.id=e.message_id JOIN interactions i ON i.id=e.interaction_id WHERE e.memory_id=?",
          )
          .all(m.id),
      };
    requireValue(m.version === p.expectedVersion, "MEMORY_CONFLICT");
    if (method === "memory.forget")
      return this.store.transaction(() => {
        const evidence = this.db
          .prepare("SELECT message_id FROM memory_evidence WHERE memory_id=?")
          .all(m.id)
          .map((e) => String(e.message_id));
        const lineage = [...new Set([...evidence, ...this.derived([String(m.id)]).sources])].filter(
          (id) => id !== m.id,
        );
        this.db
          .prepare("INSERT INTO memory_forget_markers VALUES(?,?,?,?,?,NULL)")
          .run(randomUUID(), m.project_id ?? "", m.key_hash, JSON.stringify(lineage), Date.now());
        this.invalidateCopies([String(m.id)], true);
        this.db.prepare("DELETE FROM memory_search WHERE memory_id=?").run(m.id);
        this.db.prepare("DELETE FROM memories WHERE id=?").run(m.id);
        this.changed(String(m.id));
        return {};
      });
    if (method === "memory.confirm" || method === "memory.update")
      return this.store.transaction(() => {
        requireValue(p.confirm === true, "MEMORY_CONFIRM_REQUIRED");
        const e = this.db
          .prepare(
            "SELECT * FROM memory_evidence WHERE memory_id=? AND valid=1 ORDER BY rowid DESC LIMIT 1",
          )
          .get(m.id);
        requireValue(e, "MEMORY_EVIDENCE_CHANGED");
        const result = this.save(
          {
            ...m,
            ...p,
            subject: m.subject,
            predicate: m.predicate,
            kind: m.kind,
            content: method === "memory.update" ? p.content : m.content,
            messageId: e.message_id,
            expectedInteractionVersion: e.interaction_version,
            confirmed: true,
          },
          true,
        );
        if (result.id !== m.id && m.status !== "active") {
          this.db
            .prepare("UPDATE memories SET status='superseded',version=version+1 WHERE id=?")
            .run(m.id);
          this.index(String(m.id));
        }
        return result;
      });
    return undefined;
  }
}
