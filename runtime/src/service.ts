import { createHash, randomUUID } from 'node:crypto';
import { ConfigStore, bindModel, redact } from './config.ts';
import type { AppConfig, ModelSelection } from './config.ts';
import { Store } from './store.ts';
import { AppError, record, requireValue, text } from './errors.ts';
import { generate } from './model.ts';
import type { BoundModel, ChatMessage } from './model.ts';

const fingerprint = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex');

export class AppService {
  readonly config: ConfigStore;
  readonly store: Store;
  private stopped = false;
  private active = new Map<string, { sessionId: string; abort: AbortController }>();
  private jobs = new Set<Promise<void>>();
  private configuration: ReturnType<ConfigStore['read']> | null = null;
  private configError: string | null = null;

  constructor(directory: string) {
    this.config = new ConfigStore(directory); this.store = new Store(directory);
    try { this.reloadConfiguration(); } catch { /* Show the repair state without replacing the file. */ }
  }

  private reloadConfiguration() {
    try {
      this.configuration = this.config.read(); this.configError = null;
      return this.configuration;
    } catch (error) {
      this.configuration = null;
      this.configError = error instanceof AppError ? error.code : 'CONFIG_FILE';
      throw new AppError(this.configError);
    }
  }

  private currentConfig(): AppConfig {
    if (!this.configuration) throw new AppError(this.configError ?? 'CONFIG_FILE');
    return this.configuration.config;
  }

  dispatch(method: string, value: unknown): unknown {
    requireValue(!this.stopped, 'RUNTIME_STOPPING');
    const payload = record(value ?? {});
    if (method === 'config.get') return this.reloadConfiguration();
    if (method === 'config.save') {
      const result = this.config.save(payload.config, payload.expectedRevision);
      this.configuration = result; this.configError = null;
      return result;
    }
    if (method === 'state.get') {
      const surfaceId = text(payload.surfaceId);
      const config = this.configuration?.config ?? { modelConnections: [], defaultModel: null };
      const messages = this.store.timeline();
      const changes = this.store.changes(payload.afterSequence);
      return { focus: this.store.focus(surfaceId), configError: this.configError,
        models: config.modelConnections.flatMap(item => item.modelNames.map(modelName => ({ connectionId: item.id, modelName, apiType: item.apiType }))),
        defaultModel: config.defaultModel, messages, changedMessages: changes.messages, cursor: changes.cursor, hasMore: messages.length === 10,
        sessions: this.store.db.prepare('SELECT id,title,temporary,updated_at AS updatedAt FROM sessions ORDER BY updated_at DESC,rowid DESC LIMIT 100').all() };
    }
    if (method === 'timeline.list') {
      requireValue(Number.isSafeInteger(payload.beforeSequence) && payload.beforeSequence > 0);
      return { messages: this.store.timeline(payload.beforeSequence) };
    }
    if (method === 'session.focus') {
      const surfaceId = text(payload.surfaceId);
      const sessionId = text(payload.sessionId);
      return this.store.transaction(() => {
        requireValue(this.store.db.prepare('SELECT id FROM sessions WHERE id=?').get(sessionId), 'SESSION_NOT_FOUND');
        const focus = this.store.focus(surfaceId);
        requireValue(focus.version === payload.expectedVersion, 'FOCUS_CONFLICT');
        this.store.db.prepare('UPDATE focus_states SET active_session_id=?, interrupted_session_id=NULL,version=version+1 WHERE surface_id=?').run(sessionId, surfaceId);
        return this.store.focus(surfaceId);
      });
    }
    if (method === 'message.send') return this.send(payload);
    if (method === 'message.retry') return this.retry(payload);
    if (method === 'message.cancel') {
      const id = text(payload.runId);
      const run = this.store.db.prepare('SELECT status FROM runs WHERE id=?').get(id);
      if (run && ['queued', 'running'].includes(String(run.status))) this.store.runStatus(id, 'cancelled', 'CANCELLED');
      this.active.get(id)?.abort.abort();
      return {};
    }
    throw new AppError('METHOD_NOT_FOUND');
  }

  private selection(value: unknown): ModelSelection | null {
    if (value == null) return null;
    const selected = record(value);
    return { connectionId: text(selected.connectionId), modelName: text(selected.modelName, 256) };
  }

  private send(payload: Record<string, any>) {
    const key = text(payload.idempotencyKey);
    const input = { surfaceId: text(payload.surfaceId), text: text(payload.text, 8000),
      newTopic: payload.newTopic === true, temporary: payload.temporary === true, selection: this.selection(payload.selection) };
    const hash = fingerprint(input);
    const previous = this.store.db.prepare('SELECT id,request_hash FROM runs WHERE request_key=?').get(key);
    if (previous) { requireValue(previous.request_hash === hash, 'IDEMPOTENCY_CONFLICT'); return { runId: previous.id }; }
    const config = this.currentConfig();
    const model = bindModel(config, input.selection);
    const binding: BoundModel = { id: model.id, protocol: model.protocol, apiType: model.apiType, url: model.url, modelName: model.modelName };
    const runId = this.store.transaction(() => {
      const focus = this.store.focus(input.surfaceId);
      let sessionId = focus.activeSessionId as string | null;
      const temporary = input.temporary || /^(顺便问|顺便，|插一句|临时问|换个话题)/.test(input.text);
      // shortcut: M1 uses explicit controls and conservative phrases; semantic routing belongs to M2.
      if (/^(继续上次|回到刚才|继续原来的话题)/.test(input.text) && focus.interruptedSessionId && !input.newTopic && !temporary) {
        sessionId = String(focus.interruptedSessionId);
        this.store.db.prepare('UPDATE focus_states SET interrupted_session_id=NULL WHERE surface_id=?').run(input.surfaceId);
      } else if (!sessionId || input.newTopic || temporary) {
        const old = sessionId;
        sessionId = this.store.newSession(redact(input.text, config), temporary);
        if (temporary && old && !focus.interruptedSessionId) this.store.db.prepare('UPDATE focus_states SET interrupted_session_id=? WHERE surface_id=?').run(old, input.surfaceId);
        if (!temporary) this.store.db.prepare('UPDATE focus_states SET interrupted_session_id=NULL WHERE surface_id=?').run(input.surfaceId);
      }
      this.store.db.prepare('UPDATE focus_states SET active_session_id=?,version=version+1 WHERE surface_id=?').run(sessionId, input.surfaceId);
      const messageId = randomUUID();
      this.store.db.prepare("INSERT INTO messages(id,session_id,sequence,role,content,created_at) VALUES(?,?,?,'user',?,?)")
        .run(messageId, sessionId, this.store.sequence(), redact(input.text, config), Date.now());
      this.store.changed(messageId);
      this.store.db.prepare('UPDATE sessions SET updated_at=? WHERE id=?').run(Date.now(), sessionId);
      return this.createRun(messageId, String(sessionId), binding, key, hash, null, 1);
    });
    this.kick();
    return { runId };
  }

  private createRun(messageId: string, sessionId: string, binding: BoundModel, key: string, hash: string, retryOf: string | null, attempt: number): string {
    const id = randomUUID();
    const assistantId = randomUUID();
    this.store.db.prepare("INSERT INTO runs(id,user_message_id,session_id,binding_json,status,attempt,retry_of,request_key,request_hash,created_at) VALUES(?,?,?,?,'queued',?,?,?,?,?)")
      .run(id, messageId, sessionId, JSON.stringify(binding), attempt, retryOf, key, hash, Date.now());
    this.store.db.prepare("INSERT INTO messages(id,session_id,sequence,role,content,run_id,created_at) VALUES(?,?,?,'assistant','',?,?)")
      .run(assistantId, sessionId, this.store.sequence(), id, Date.now());
    this.store.db.prepare('UPDATE runs SET assistant_message_id=? WHERE id=?').run(assistantId, id);
    this.store.changed(assistantId);
    return id;
  }

  private retry(payload: Record<string, any>) {
    const originalId = text(payload.runId);
    const key = text(payload.idempotencyKey);
    const selected = this.selection(payload.selection);
    const hash = fingerprint({ originalId, selected });
    const previous = this.store.db.prepare('SELECT id,request_hash FROM runs WHERE request_key=?').get(key);
    if (previous) { requireValue(previous.request_hash === hash, 'IDEMPOTENCY_CONFLICT'); return { runId: previous.id }; }
    const duplicate = this.store.db.prepare('SELECT id FROM runs WHERE retry_of=?').get(originalId);
    if (duplicate) return { runId: duplicate.id };
    const old = this.store.db.prepare('SELECT * FROM runs WHERE id=?').get(originalId);
    requireValue(old && ['failed', 'interrupted', 'cancelled'].includes(String(old.status)), 'RETRY_UNAVAILABLE');
    const oldBinding = JSON.parse(String(old.binding_json)) as BoundModel;
    const config = this.currentConfig();
    const model = bindModel(config, selected ?? { connectionId: oldBinding.id, modelName: oldBinding.modelName });
    requireValue(selected || (model.url === oldBinding.url && model.apiType === oldBinding.apiType && model.protocol === oldBinding.protocol), 'MODEL_BINDING_CHANGED');
    const binding: BoundModel = { id: model.id, protocol: model.protocol, apiType: model.apiType, url: model.url, modelName: model.modelName };
    const runId = this.store.transaction(() => this.createRun(String(old.user_message_id), String(old.session_id), binding, key, hash, originalId, Number(old.attempt) + 1));
    this.kick();
    return { runId };
  }

  private kick() {
    queueMicrotask(() => {
      if (this.stopped) return;
      const sessions = new Set([...this.active.values()].map(item => item.sessionId));
      for (const run of this.store.db.prepare("SELECT * FROM runs WHERE status='queued' ORDER BY created_at,rowid").all()) {
        if (this.active.size >= 2) break;
        const sessionId = String(run.session_id);
        if (sessions.has(sessionId)) continue;
        sessions.add(sessionId);
        const abort = new AbortController();
        this.active.set(String(run.id), { sessionId, abort });
        const job = this.execute(run, abort).finally(() => { this.active.delete(String(run.id)); this.jobs.delete(job); this.kick(); });
        this.jobs.add(job);
      }
    });
  }

  private async execute(run: Record<string, any>, abort: AbortController) {
    try {
      const config = this.currentConfig();
      const binding = JSON.parse(String(run.binding_json)) as BoundModel;
      const model = bindModel(config, { connectionId: binding.id, modelName: binding.modelName });
      requireValue(model.url === binding.url && model.apiType === binding.apiType && model.protocol === binding.protocol, 'MODEL_BINDING_CHANGED');
      const cutoff = this.store.db.prepare('SELECT sequence FROM messages WHERE id=?').get(run.user_message_id)!.sequence;
      const rows = this.store.db.prepare(`SELECT m.role,m.content FROM messages m LEFT JOIN runs r ON r.id=m.run_id
        LEFT JOIN messages origin ON origin.id=r.user_message_id
        WHERE m.session_id=? AND ((m.role='user' AND m.sequence<=?) OR
          (m.role='assistant' AND r.status='completed' AND origin.sequence<? AND r.attempt=(SELECT MAX(r2.attempt) FROM runs r2 WHERE r2.user_message_id=r.user_message_id AND r2.status='completed')))
        ORDER BY COALESCE(origin.sequence,m.sequence),CASE m.role WHEN 'user' THEN 0 ELSE 1 END`).all(run.session_id, cutoff, cutoff);
      const messages = rows.slice(-40).map(row => ({ role: row.role, content: redact(String(row.content), config) })) as ChatMessage[];
      requireValue(messages.length > 0 && messages[0].role === 'user', 'CONTEXT_TOO_LARGE');
      requireValue(Buffer.byteLength(JSON.stringify(messages)) <= 128 * 1024, 'CONTEXT_TOO_LARGE');
      this.store.db.prepare('UPDATE runs SET context_json=? WHERE id=?').run(JSON.stringify(messages), run.id);
      this.store.runStatus(String(run.id), 'running');
      const result = await generate(model, messages, abort.signal, output => {
        if (!this.stopped && !abort.signal.aborted) this.store.transaction(() => {
          this.store.db.prepare('UPDATE messages SET content=? WHERE id=?').run(redact(output, config), run.assistant_message_id);
          this.store.changed(String(run.assistant_message_id));
        });
      });
      requireValue(!this.stopped && !abort.signal.aborted, 'CANCELLED');
      requireValue(result.toolCalls.length === 0, 'TOOLS_UNAVAILABLE');
      this.store.runStatus(String(run.id), 'completed');
    } catch (error) {
      const code = this.stopped ? 'INTERRUPTED' : error instanceof AppError ? error.code : 'MODEL_FAILED';
      const current = this.store.db.prepare('SELECT status FROM runs WHERE id=?').get(run.id);
      if (current && ['queued', 'running'].includes(String(current.status))) this.store.runStatus(String(run.id), this.stopped ? 'interrupted' : code === 'CANCELLED' ? 'cancelled' : 'failed', code);
    }
  }

  async stop() {
    if (this.stopped) return;
    this.stopped = true;
    for (const item of this.active.values()) item.abort.abort();
    await Promise.all(this.jobs);
    for (const run of this.store.db.prepare("SELECT id FROM runs WHERE status IN('queued','running')").all()) this.store.runStatus(String(run.id), 'interrupted', 'INTERRUPTED');
    this.store.db.close();
  }
}
