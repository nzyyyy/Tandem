import { createHash, randomUUID } from 'node:crypto';
import { ConfigStore, bindModel, redact } from './config.ts';
import type { AppConfig, ModelSelection } from './config.ts';
import { ContextService } from './context.ts';
import { Store } from './store.ts';
import { AppError, record, requireValue, text } from './errors.ts';
import { generate } from './model.ts';
import type { BoundModel } from './model.ts';

const fingerprint = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex');

export class AppService {
  readonly config: ConfigStore;
  readonly store: Store;
  readonly context: ContextService;
  private stopped = false;
  private active = new Map<string, { sessionId: string; abort: AbortController }>();
  private jobs = new Set<Promise<void>>();
  private configuration: ReturnType<ConfigStore['read']> | null = null;
  private configError: string | null = null;

  constructor(directory: string) {
    this.config = new ConfigStore(directory); this.store = new Store(directory);
    try { this.reloadConfiguration(); } catch { /* Show the repair state without replacing the file. */ }
    this.context = new ContextService(this.store, () => this.currentConfig(), (...args) => this.createRun(...args), id => {
      this.store.db.prepare("UPDATE runs SET status='cancelled',error_code='CANCELLED' WHERE id=? AND status IN('queued','running')").run(id);
      const run = this.store.db.prepare('SELECT assistant_message_id FROM runs WHERE id=?').get(id);
      if (run) this.store.changed(String(run.assistant_message_id));
      this.active.get(id)?.abort.abort();
    });
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
      return { projects: this.context.projects(), pendingInteractions: this.context.pending(surfaceId), focus: this.store.focus(surfaceId), configError: this.configError,
        models: config.modelConnections.flatMap(item => item.modelNames.map(modelName => ({ connectionId: item.id, connectionName: item.name ?? new URL(item.url).hostname, modelName, apiType: item.apiType }))),
        defaultModel: config.defaultModel, messages, changedMessages: changes.messages, cursor: changes.cursor, hasMore: messages.length === 10,
        sessions: this.context.sessions(surfaceId) };
    }
    if (method === 'timeline.list') {
      requireValue(Number.isSafeInteger(payload.beforeSequence) && payload.beforeSequence > 0);
      return { messages: this.store.timeline(payload.beforeSequence) };
    }
    if (method === 'session.focus') {
      const surfaceId = text(payload.surfaceId);
      const sessionId = text(payload.sessionId);
      return this.context.focus(surfaceId, sessionId, payload.expectedVersion);
    }
    const contextResult = this.context.dispatch(method, payload);
    if (contextResult !== undefined) { this.kick(); return contextResult; }
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
    const result = this.context.receive(payload);
    this.kick();
    return result;
  }

  private createRun(messageId: string, sessionId: string, binding: BoundModel, key: string, hash: string, retryOf: string | null, attempt: number): string {
    const id = randomUUID();
    const assistantId = randomUUID();
    this.store.db.prepare("INSERT INTO runs(id,user_message_id,session_id,binding_json,status,attempt,retry_of,request_key,request_hash,created_at) VALUES(?,?,?,?,'queued',?,?,?,?,?)")
      .run(id, messageId, sessionId, JSON.stringify(binding), attempt, retryOf, key, hash, Date.now());
    this.store.db.prepare("INSERT INTO messages(id,session_id,sequence,role,content,run_id,created_at) VALUES(?,?,?,'assistant','',?,?)")
      .run(assistantId, sessionId, this.store.sequence(), id, Date.now());
    this.store.db.prepare('UPDATE runs SET assistant_message_id=? WHERE id=?').run(assistantId, id);
    const interaction = this.store.db.prepare('SELECT * FROM interactions WHERE message_id=?').get(messageId);
    if (interaction) this.store.db.prepare('UPDATE runs SET interaction_id=?,interaction_version=?,project_id=? WHERE id=?').run(interaction.id,interaction.version,interaction.project_id,id);
    this.store.changed(assistantId);
    return id;
  }

  private retry(payload: Record<string, any>): { runId: unknown } {
    let originalId = text(payload.runId);
    const key = text(payload.idempotencyKey);
    const selected = this.selection(payload.selection);
    const hash = fingerprint({ originalId, selected });
    const previous = this.store.db.prepare('SELECT id,request_hash FROM runs WHERE request_key=?').get(key);
    if (previous) { requireValue(previous.request_hash === hash, 'IDEMPOTENCY_CONFLICT'); return { runId: previous.id }; }
    while (true) {
      const duplicate = this.store.db.prepare('SELECT r.id,r.interaction_version,i.version FROM runs r JOIN interactions i ON i.id=r.interaction_id WHERE r.retry_of=?').get(originalId);
      if (!duplicate) break;
      if (duplicate.interaction_version === duplicate.version) return { runId: duplicate.id };
      originalId = String(duplicate.id);
    }
    const old = this.store.db.prepare('SELECT * FROM runs WHERE id=?').get(originalId);
    const interaction = old && this.store.db.prepare('SELECT version FROM interactions WHERE id=?').get(old.interaction_id);
    requireValue(old && (['failed', 'interrupted', 'cancelled'].includes(String(old.status)) || interaction?.version !== old.interaction_version), 'RETRY_UNAVAILABLE');
    const oldBinding = JSON.parse(String(old.binding_json)) as BoundModel;
    const config = this.currentConfig();
    const model = bindModel(config, selected ?? { connectionId: oldBinding.id, modelName: oldBinding.modelName });
    requireValue(selected || (model.url === oldBinding.url && model.apiType === oldBinding.apiType && model.protocol === oldBinding.protocol), 'MODEL_BINDING_CHANGED');
    const binding: BoundModel = { id: model.id, protocol: model.protocol, apiType: model.apiType, url: model.url, modelName: model.modelName };
    const runId = this.store.transaction(() => {
      const id = this.createRun(String(old.user_message_id), String(old.session_id), binding, key, hash, originalId, Number(old.attempt) + 1);
      this.context.prepareRetry(old,id);
      return id;
    });
    this.kick();
    return { runId };
  }

  private kick() {
    queueMicrotask(() => {
      if (this.stopped) return;
      const sessions = new Set([...this.active.values()].map(item => item.sessionId));
      for (const run of this.store.db.prepare("SELECT r.* FROM runs r JOIN messages m ON m.id=r.user_message_id WHERE r.status='queued' ORDER BY m.sequence,r.attempt,r.rowid").all()) {
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
      const messages = this.context.snapshot(run, config);
      const result = await generate(model, messages, abort.signal, output => {
        if (!this.stopped && !abort.signal.aborted && this.context.valid(run)) this.store.transaction(() => {
          this.store.db.prepare('UPDATE messages SET content=? WHERE id=?').run(redact(output, config), run.assistant_message_id);
          this.store.changed(String(run.assistant_message_id));
        });
      });
      requireValue(!this.stopped && !abort.signal.aborted && this.context.valid(run), 'CANCELLED');
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
