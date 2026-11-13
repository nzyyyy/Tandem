import { createHash, randomUUID } from 'node:crypto';
import type { Store } from './store.ts';
import { record, requireValue, text } from './errors.ts';
import { bindModel, redact } from './config.ts';
import type { AppConfig } from './config.ts';
import type { BoundModel, ChatMessage } from './model.ts';

const hash = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const segmenter = new Intl.Segmenter('zh', { granularity: 'word' });
const terms = (value: string, limit = 64) => [...new Set([...segmenter.segment(value.toLowerCase())].filter(x => x.isWordLike && x.segment.length > 1).map(x => x.segment))].slice(0, limit);
type Row = Record<string, any>;
type Candidate = { sessionId: string; projectId: string | null; title: string; updatedAt: number; score: number; reason: string };
type Route = { action: string; reason: string; candidates: Candidate[]; sessionId?: string; temporary?: boolean };

export class ContextService {
  readonly store: Store;
  readonly config: () => AppConfig;
  readonly createRun: (messageId: string, sessionId: string, binding: BoundModel, key: string, fingerprint: string, retryOf: string | null, attempt: number) => string;
  readonly cancel: (runId: string) => void;
  constructor(store: Store, config: () => AppConfig, createRun: ContextService['createRun'], cancel: ContextService['cancel']) {
    this.store = store; this.config = config; this.createRun = createRun; this.cancel = cancel;
    this.rebuildSearch();
  }
  private get db() { return this.store.db; }
  private project(id: unknown, open = true): Row | null {
    if (id == null || id === '') return null;
    const row = this.db.prepare('SELECT * FROM projects WHERE id=?').get(text(id));
    requireValue(row && (!open || row.status === 'open'), 'PROJECT_UNAVAILABLE');
    return row;
  }
  private allowed(projectId: unknown, focus: Row, includeArchived = false) {
    const project = this.project(projectId, !includeArchived);
    return focus.contextMode === 'automatic' || (!!focus.activeProjectId && project?.id === focus.activeProjectId);
  }
  private session(id: string, focus: Row) {
    const row = this.db.prepare("SELECT * FROM sessions WHERE id=? AND status='open'").get(id);
    requireValue(row && this.allowed(row.project_id, focus), 'CONTEXT_SCOPE');
    return row;
  }
  private rebuildSearch(sessionId?: string) {
    this.store.transaction(() => {
      this.db.prepare('DELETE FROM session_search WHERE (? IS NULL OR session_id=?)').run(sessionId ?? null,sessionId ?? null);
      for (const s of this.db.prepare('SELECT id,title FROM sessions WHERE (? IS NULL OR id=?)').all(sessionId ?? null,sessionId ?? null)) {
        const project = this.db.prepare('SELECT p.title,p.description FROM projects p JOIN sessions s ON s.project_id=p.id WHERE s.id=?').get(s.id);
        const inputs = this.db.prepare("SELECT i.input FROM interactions i JOIN sessions s ON s.id=i.session_id WHERE i.session_id=? AND i.project_id IS s.project_id AND i.status='committed' ORDER BY i.sequence DESC LIMIT 20").all(s.id);
        this.db.prepare('INSERT INTO session_search VALUES(?,?)').run(s.id, terms(String(s.title) + ' ' + String(project?.title ?? '') + ' ' + String(project?.description ?? '') + ' ' + inputs.map(x => x.input).join(' '),2048).join(' '));
      }
    });
  }
  sessions(surfaceId: string) {
    const focus=this.store.focus(surfaceId);
    return this.db.prepare("SELECT s.id,s.title,s.temporary,s.project_id AS projectId,s.updated_at AS updatedAt FROM sessions s LEFT JOIN projects p ON p.id=s.project_id WHERE s.status='open' AND (p.id IS NULL OR p.status='open') AND (?='automatic' OR (s.project_id=? AND ? IS NOT NULL)) ORDER BY s.updated_at DESC,s.rowid DESC LIMIT 100").all(focus.contextMode,focus.activeProjectId,focus.activeProjectId);
  }
  private projectCapacity() { requireValue(Number(this.db.prepare('SELECT COUNT(*) AS n FROM projects').get()!.n) < 200, 'PROJECT_LIMIT'); }
  projects() { return this.db.prepare('SELECT * FROM projects ORDER BY updated_at DESC,id').all(); }
  pending(surfaceId: string) {
    const viewer = this.store.focus(surfaceId);
    return this.db.prepare("SELECT * FROM interactions WHERE status!='committed' AND (surface_id=? OR ?='automatic') ORDER BY sequence LIMIT 20").all(surfaceId,viewer.contextMode).map(i => {
      const focus = this.store.focus(String(i.surface_id));
      const route = JSON.parse(String(i.route_json ?? '{"action":"CLARIFY","reason":"应用中断，请选择话题","candidates":[]}'));
      route.candidates = route.candidates.filter((c: Candidate) => {
        try { this.session(c.sessionId, focus); this.session(c.sessionId, viewer); return true; } catch { return false; }
      });
      return { id: i.id, sequence: i.sequence, input: i.input, version: i.version, surfaceId: i.surface_id, route };
    });
  }
  dispatch(method: string, p: Row): unknown {
    if (method === 'project.create') {
      this.projectCapacity();
      const title = redact(text(p.title, 120), this.config());
      const description = p.description == null || p.description === '' ? '' : redact(text(p.description, 4000), this.config());
      const id = randomUUID();
      this.db.prepare("INSERT INTO projects VALUES(?,?,?,'open',1,?,?)").run(id, title, description, Date.now(), Date.now());
      return { id };
    }
    if (method === 'project.update') {
      const project = this.project(p.id, false)!;
      requireValue(project.version === p.expectedVersion, 'PROJECT_CONFLICT');
      requireValue(['open', 'archived'].includes(p.status));
      const title = redact(text(p.title, 120), this.config());
      const description = p.description === '' ? '' : redact(text(p.description, 4000), this.config());
      const result = this.store.transaction(() => {
        this.db.prepare('UPDATE projects SET title=?,description=?,status=?,version=version+1,updated_at=? WHERE id=?').run(title, description, p.status, Date.now(), project.id);
        if (p.status === 'archived') this.db.prepare('UPDATE focus_states SET active_session_id=NULL,active_project_id=NULL,interrupted_session_id=NULL,version=version+1 WHERE active_project_id=?').run(project.id);
        return {};
      });
      this.rebuildSearch(); return result;
    }
    if (method === 'context.set') {
      const surface = text(p.surfaceId); const focus = this.store.focus(surface);
      requireValue(focus.version === p.expectedVersion, 'FOCUS_CONFLICT');
      requireValue(['automatic', 'pinned', 'isolated'].includes(p.mode));
      const project = this.project(p.projectId);
      // A missing isolated project remains an explicit unresolved scope, never a global fallback.
      this.db.prepare('UPDATE focus_states SET context_mode=?,active_project_id=?,active_session_id=NULL,interrupted_session_id=NULL,version=version+1 WHERE surface_id=?').run(p.mode, project?.id ?? null, surface);
      return this.store.focus(surface);
    }
    if (method === 'interaction.confirm') return this.confirm(p);
    if (method === 'interaction.correct') { const result = this.correct(p); this.rebuildSearch(); return result; }
    if (method === 'interaction.history') {
      const i = this.interaction(text(p.interactionId));
      return { corrections: this.db.prepare('SELECT * FROM corrections WHERE interaction_id=? ORDER BY version').all(i.id) };
    }
    if (method === 'snapshot.get') {
      const s = this.db.prepare('SELECT * FROM context_snapshots WHERE id=?').get(text(p.id));
      requireValue(s, 'SNAPSHOT_NOT_FOUND');
      const focus = this.store.focus(text(p.surfaceId));
      requireValue(this.allowed(s.project_id, focus, true), 'CONTEXT_SCOPE');
      const fragments = JSON.parse(String(s.fragments_json));
      for (const f of fragments) {
        requireValue(f.deleted || this.allowed(f.projectId, focus, true), 'CONTEXT_SCOPE');
        if (f.grantId && !f.deleted) requireValue(this.db.prepare("SELECT 1 FROM directory_grants WHERE id=? AND status='active' AND project_id IS ?").get(f.grantId,f.projectId),'DIRECTORY_UNAUTHORIZED');
      }
      return { id: s.id, mode: s.mode, projectId: s.project_id, fragments };
    }
    if (method === 'project.deletePreview') {
      const project = this.project(p.id, false)!;
      const details = this.deletionDetails(String(project.id)); const token = randomUUID();
      this.db.prepare('INSERT INTO delete_previews VALUES(?,?,?,?)').run(token, project.id, hash(details), Date.now());
      return { token, ...details };
    }
    if (method === 'project.delete') { const result = this.deleteProject(p); this.rebuildSearch(); return result; }
    return undefined;
  }
  focus(surface: string, sessionId: string, version: number) {
    return this.store.transaction(() => {
      const focus = this.store.focus(surface);
      requireValue(focus.version === version, 'FOCUS_CONFLICT');
      const session = this.session(sessionId, focus);
      this.setFocus(surface, sessionId, session.project_id, false);
      return this.store.focus(surface);
    });
  }
  private setFocus(surface: string, sessionId: string, projectId: any, temporary: boolean) {
    const focus = this.store.focus(surface);
    const recent = [sessionId, ...JSON.parse(String(focus.recentSessionIds)).filter((id: string) => id !== sessionId)].slice(0, 20);
    const interrupted = temporary ? focus.interruptedSessionId ?? focus.activeSessionId : null;
    this.db.prepare('UPDATE focus_states SET active_session_id=?,active_project_id=?,interrupted_session_id=?,recent_session_ids=?,version=version+1 WHERE surface_id=?')
      .run(sessionId, projectId ?? null, interrupted, JSON.stringify(recent), surface);
  }
  private interaction(id: string) {
    const row = this.db.prepare('SELECT * FROM interactions WHERE id=?').get(id);
    requireValue(row, 'INTERACTION_NOT_FOUND'); return row;
  }
  private candidates(input: string, focus: Row): Candidate[] {
    const tokens = terms(input);
    if (!tokens.length) return [];
    const rows = this.db.prepare(`SELECT s.*,bm25(session_search) AS rank FROM session_search JOIN sessions s ON s.id=session_search.session_id
      LEFT JOIN projects p ON p.id=s.project_id WHERE session_search MATCH ? AND s.status='open' AND (p.id IS NULL OR p.status='open')
      AND (?='automatic' OR (s.project_id=? AND ? IS NOT NULL)) ORDER BY rank,s.updated_at DESC LIMIT 8`)
      .all(tokens.map(t => '"' + t.replaceAll('"', '""') + '"').join(' OR '), focus.contextMode, focus.activeProjectId, focus.activeProjectId);
    return rows.map(s => {
      const indexed = String(this.db.prepare('SELECT content FROM session_search WHERE session_id=?').get(s.id)?.content ?? '');
      const matches = tokens.filter(t => indexed.split(' ').includes(t));
      return { sessionId: String(s.id), projectId: s.project_id as string | null, title: String(s.title), updatedAt: Number(s.updated_at), score: matches.length / tokens.length,
        reason: '匹配：' + matches.join('、') };
    }).sort((a,b) => b.score - a.score || b.updatedAt - a.updatedAt).slice(0, 5);
  }
  private route(input: Row, focus: Row): Route {
    const empty = (action: string, reason: string): Route => ({ action, reason, candidates: [] });
    if (focus.contextMode !== 'automatic' && !focus.activeProjectId) return empty('CLARIFY', '请先明确选择项目');
    if (/^创建(?:一个)?[“「"]?(.{1,60}?)[”」"]?项目[。！!]?$/u.test(input.text)) return empty('CREATE', '明确创建项目');
    if (input.sessionId) { this.session(input.sessionId, focus); return { ...empty('RESUME', '明确选择话题'), sessionId: input.sessionId }; }
    if (input.newTopic) return empty('CREATE', '明确创建新话题');
    const resume = /继续|恢复|回到|上次|昨天/.test(input.text);
    if (resume && focus.interruptedSessionId && /^(继续上次|回到刚才|继续原来的话题)/.test(input.text)) {
      this.session(String(focus.interruptedSessionId), focus);
      return { ...empty('RESUME', '恢复被临时插话中断的话题'), sessionId: String(focus.interruptedSessionId) };
    }
    if (input.temporary || /^(顺便问|顺便，|插一句|临时问|换个话题)/.test(input.text)) return { ...empty('CREATE', '临时插话，保留原话题'), temporary: true };
    // shortcut: FTS word overlap cannot identify arbitrary paraphrases; add semantic reranking after collecting routing examples.
    const candidates = this.candidates(input.text, focus);
    const best = candidates[0]; const second = candidates[1];
    const active = focus.activeSessionId ? (() => { try { return this.session(String(focus.activeSessionId), focus); } catch { return null; } })() : null;
    if (best && second && best.score - second.score < 0.2 && (resume || !active || !candidates.some(c => c.sessionId === active.id))) return { action: 'CLARIFY', reason: '多个历史话题匹配接近，请确认', candidates };
    if (best && best.score >= 0.4 && (resume || !active || (best.sessionId !== active.id && best.score >= 0.6 && !candidates.some(c => c.sessionId === active.id)))) return { action: 'RESUME', reason: best.reason, candidates, sessionId: best.sessionId };
    if (resume) return { action: 'CLARIFY', reason: '未能可靠识别要恢复的话题，请选择或另建话题', candidates };
    if (active) return { ...empty('CONTINUE', '继续当前话题'), sessionId: String(active.id) };
    return empty('CREATE', '开始新话题');
  }
  receive(p: Row) {
    const key = text(p.idempotencyKey);
    const input = { surfaceId: text(p.surfaceId), text: text(p.text,8000), newTopic: p.newTopic === true, temporary: p.temporary === true,
      selection: p.selection == null ? null : {connectionId:text(record(p.selection).connectionId),modelName:text(record(p.selection).modelName,256)}, sessionId: p.sessionId == null ? null : text(p.sessionId) };
    if (p.task != null) {
      const task = record(p.task);
      requireValue(Array.isArray(task.criteria) && task.criteria.length>0 && task.criteria.length<=12);
      Object.assign(input,{ task: {deliverable:redact(text(task.deliverable,2000),this.config()),criteria:task.criteria.map((c:unknown)=>redact(text(c,1000),this.config())),
        ...(task.id ? {id:text(task.id),expectedRevision:task.expectedRevision} : {})} });
    }
    const fingerprint = hash(input);
    const old = this.db.prepare('SELECT * FROM interactions WHERE request_key=?').get(key);
    if (old) { requireValue(old.request_hash === fingerprint, 'IDEMPOTENCY_CONFLICT'); return this.result(old); }
    if (p.task?.id) {
      const task = this.db.prepare('SELECT * FROM tasks WHERE id=?').get(p.task.id);
      requireValue(task && task.revision===p.task.expectedRevision,'TASK_CONFLICT');
      const focus = this.store.focus(input.surfaceId);
      requireValue(this.allowed(task.project_id,focus),'CONTEXT_SCOPE');
      requireValue(input.sessionId===task.session_id,'TASK_CONFLICT');
    }
    const config = this.config();
    const model = bindModel(config,input.selection);
    const binding: BoundModel = { id:model.id,protocol:model.protocol,apiType:model.apiType,url:model.url,modelName:model.modelName };
    const id=randomUUID();
    this.store.transaction(() => {
      const focus=this.store.focus(input.surfaceId);
      const saved={...input,text:redact(input.text,config),binding};
      this.db.prepare("INSERT INTO interactions(id,sequence,surface_id,input,input_json,request_key,request_hash,status,focus_version,created_at) VALUES(?,?,?,?,?,?,?,'received',?,?)")
        .run(id,this.store.sequence(),input.surfaceId,saved.text,JSON.stringify(saved),key,fingerprint,focus.version,Date.now());
      this.db.prepare("INSERT INTO outbox VALUES(?,'route','pending')").run(id);
    });
    const route=this.route(JSON.parse(String(this.interaction(id).input_json)),this.store.focus(input.surfaceId));
    this.db.prepare("UPDATE interactions SET status='waiting_route',route_json=? WHERE id=?").run(JSON.stringify(route),id);
    if(route.action !== 'CLARIFY') return this.commit(id,route,this.interaction(id).version,this.store.focus(input.surfaceId).version);
    this.db.prepare("UPDATE outbox SET status='done' WHERE interaction_id=?").run(id);
    return this.result(this.interaction(id));
  }
  private result(i: Row) {
    const run=this.db.prepare('SELECT id FROM runs WHERE interaction_id=? ORDER BY attempt LIMIT 1').get(i.id);
    return run ? { runId: run.id } : { interactionId:i.id,status:i.status };
  }
  private confirm(p: Row) {
    const i=this.interaction(text(p.interactionId));
    const surface = text(p.surfaceId);
    if(i.status==='committed') return this.result(i);
    const focus=this.store.focus(surface);
    requireValue(focus.contextMode==='automatic' || focus.activeProjectId,'PROJECT_REQUIRED');
    const route: Route={ action:p.sessionId ? 'RESUME':'CREATE',reason:'用户确认',candidates:[],temporary: p.temporary===true };
    if(p.sessionId) { this.session(text(p.sessionId),focus); route.sessionId=p.sessionId; }
    return this.commit(String(i.id),route,p.expectedVersion,p.expectedFocusVersion,surface);
  }
  private commit(id: string,route: Route,version: any,focusVersion: any,surface?: string) {
    const result=this.store.transaction(() => {
      const i=this.interaction(id); if(i.status==='committed') return this.result(i);
      requireValue(i.version===version,'INTERACTION_CONFLICT');
      const surfaceId=surface ?? String(i.surface_id);
      const focus=this.store.focus(surfaceId);
      requireValue(focus.version===focusVersion,'FOCUS_CONFLICT');
      requireValue(focus.contextMode==='automatic' || focus.activeProjectId,'PROJECT_REQUIRED');
      const input=JSON.parse(String(i.input_json));
      let sessionId=route.sessionId; let projectId=focus.activeProjectId;
      const create = /^创建(?:一个)?[“「"]?(.{1,60}?)[”」"]?项目[。！!]?$/u.exec(input.text);
      if(create && route.reason==='明确创建项目') {
        requireValue(focus.contextMode==='automatic','CONTEXT_SCOPE');
        this.projectCapacity();
        projectId=randomUUID();
        this.db.prepare("INSERT INTO projects VALUES(?,?,?,'open',1,?,?)").run(projectId,create[1],'',Date.now(),Date.now());
      }
      if(sessionId) projectId=this.session(sessionId,focus).project_id;
      else { sessionId=this.store.newSession(String(i.input),!!route.temporary); this.project(projectId); this.db.prepare('UPDATE sessions SET project_id=? WHERE id=?').run(projectId,sessionId); }
      this.db.prepare('UPDATE interactions SET surface_id=? WHERE id=?').run(surfaceId,id);
      const messageId=randomUUID();
      this.db.prepare("INSERT INTO messages(id,session_id,sequence,role,content,created_at,interaction_id) VALUES(?,?,?,'user',?,?,?)").run(messageId,sessionId,i.sequence,i.input,Date.now(),id);
      this.db.prepare("UPDATE interactions SET status='committed',version=version+1,project_id=?,session_id=?,message_id=?,route_json=? WHERE id=?").run(projectId,sessionId,messageId,JSON.stringify(route),id);
      this.setFocus(surfaceId,sessionId,projectId,!!route.temporary);
      this.db.prepare('UPDATE sessions SET updated_at=? WHERE id=?').run(Date.now(),sessionId);
      this.store.changed(messageId);
      const runId=this.createRun(messageId,sessionId,input.binding,String(i.request_key),String(i.request_hash),null,1);
      this.db.prepare('UPDATE runs SET interaction_id=?,interaction_version=?,project_id=?,context_mode=? WHERE id=?').run(id,Number(i.version)+1,projectId,focus.contextMode,runId);
      this.db.prepare("UPDATE outbox SET kind='run',status='pending' WHERE interaction_id=?").run(id);
      return {runId};
    });
    this.rebuildSearch(String(this.interaction(id).session_id)); return result;
  }
  private correct(p: Row) {
    const id=text(p.interactionId); const target=this.project(p.projectId);
    return this.store.transaction(() => {
      const i=this.interaction(id);
      requireValue(i.status==='committed' && i.version===p.expectedVersion,'INTERACTION_CONFLICT');
      const focus=this.store.focus(text(p.surfaceId));
      requireValue(this.allowed(target?.id ?? null,focus),'CONTEXT_SCOPE');
      if (i.project_id === (target?.id ?? null)) return {version:i.version};
      const version=Number(i.version)+1;
      this.db.prepare('UPDATE interactions SET project_id=?,version=? WHERE id=?').run(target?.id ?? null,version,id);
      const eventId=randomUUID();
      this.db.prepare('INSERT INTO corrections VALUES(?,?,?,?,?,?)').run(eventId,id,i.project_id,target?.id ?? null,version,Date.now());
      this.db.prepare("INSERT INTO events(id,schema_version,type,aggregate_id,correlation_id,causation_id,occurred_at,payload_ref) VALUES(?,1,'interaction.corrected',?,?,?, ?,?)").run(eventId,id,id,null,Date.now(),eventId);
      for(const run of this.db.prepare("SELECT id FROM runs WHERE interaction_id=? AND status IN('queued','running','paused','waiting_approval','interrupted')").all(id)) this.cancel(String(run.id));
      this.db.prepare("UPDATE outbox SET status='interrupted' WHERE interaction_id=?").run(id);
      for(const m of this.db.prepare('SELECT id FROM messages WHERE interaction_id=? OR run_id IN(SELECT id FROM runs WHERE interaction_id=?)').all(id,id)) this.store.changed(String(m.id));
      return {version};
    });
  }
  prepareRetry(old: Row,runId: string) {
    const i=this.interaction(String(old.interaction_id));
    this.project(i.project_id);
    this.db.prepare('UPDATE runs SET interaction_id=?,interaction_version=?,project_id=?,context_mode=? WHERE id=?').run(i.id,i.version,i.project_id,old.context_mode,runId);
    this.db.prepare("INSERT INTO outbox VALUES(?,'run','pending') ON CONFLICT(interaction_id) DO UPDATE SET kind='run',status='pending'").run(i.id);
  }
  valid(run: Row) {
    const i=this.db.prepare('SELECT version FROM interactions WHERE id=?').get(run.interaction_id);
    const current=this.db.prepare('SELECT status FROM runs WHERE id=?').get(run.id);
    return !!i && i.version===run.interaction_version && current?.status==='running';
  }
  snapshot(run: Row,config: AppConfig): ChatMessage[] {
    const i=this.interaction(String(run.interaction_id));
    requireValue(i.version===run.interaction_version,'INTERACTION_CHANGED');
    this.project(run.project_id, false);
    requireValue(run.context_mode==='automatic' || run.project_id,'PROJECT_REQUIRED');
    const cutoff=this.db.prepare('SELECT sequence FROM messages WHERE id=?').get(run.user_message_id)!.sequence;
    const rows=this.db.prepare(`SELECT m.id,m.role,m.content,m.interaction_id,r.project_id AS execution_project,r.id AS source_run_id,r.snapshot_id,i.project_id,i.version FROM messages m
      LEFT JOIN runs r ON r.id=m.run_id LEFT JOIN messages origin ON origin.id=r.user_message_id
      JOIN interactions i ON i.id=COALESCE(m.interaction_id,r.interaction_id)
      WHERE m.session_id=? AND i.project_id IS ? AND ((m.role='user' AND m.sequence<=?) OR
      (m.role='assistant' AND r.status='completed' AND r.project_id IS ? AND r.interaction_version=i.version AND origin.sequence<?
      AND r.attempt=(SELECT MAX(r2.attempt) FROM runs r2 WHERE r2.user_message_id=r.user_message_id AND r2.status='completed')))
      ORDER BY COALESCE(origin.sequence,m.sequence),CASE m.role WHEN 'user' THEN 0 ELSE 1 END`).all(run.session_id,run.project_id,cutoff,run.project_id,cutoff);
    const safe=rows.filter(row => {
      if(row.role!=='assistant' || !row.snapshot_id) return row.role==='user';
      const snapshots=this.db.prepare('SELECT fragments_json FROM context_snapshots WHERE run_id=?').all(row.source_run_id);
      return snapshots.length>0 && snapshots.every(s=>JSON.parse(String(s.fragments_json)).every((f:Row)=>!f.deleted && f.projectId===run.project_id && (!f.grantId || this.db.prepare("SELECT 1 FROM directory_grants WHERE id=? AND status='active' AND project_id IS ?").get(f.grantId,run.project_id))));
    });
    let selected=safe.slice(-40); while(selected[0]?.role==='assistant') selected.shift();
    let size=0;
    const fragments: Row[]=[];
    for(const row of selected.reverse()) {
      const content=redact(String(row.content),config); const bytes=Buffer.byteLength(content);
      if(size+bytes>32*1024) break;
      size+=bytes;
      fragments.unshift({sourceType:'message',sourceId:row.id,sourceVersion:hash({content:row.content,version:row.version}),projectId:row.project_id,role:row.role,content});
    }
    while(fragments[0]?.role==='assistant') fragments.shift();
    requireValue(fragments.some(f=>f.sourceId===run.user_message_id),'CONTEXT_TOO_LARGE');
    const messages=fragments.map(f=>({role:f.role,content:f.content})) as ChatMessage[];
    this.store.transaction(()=>{
      requireValue(this.interaction(String(run.interaction_id)).version===run.interaction_version,'INTERACTION_CHANGED');
      const id=randomUUID();
      this.db.prepare('INSERT INTO context_snapshots VALUES(?,?,?,?,?,?)').run(id,run.id,run.context_mode,run.project_id,JSON.stringify(fragments),Date.now());
      this.db.prepare('UPDATE runs SET snapshot_id=?,context_json=?,status=\'running\' WHERE id=?').run(id,JSON.stringify(messages),run.id);
      this.store.changed(String(run.assistant_message_id));
      this.db.prepare("UPDATE outbox SET status='done' WHERE interaction_id=?").run(run.interaction_id);
    });
    return messages;
  }
  private deletionDetails(id: string) {
    const project=this.project(id,false)!;
    const interactions=this.db.prepare(`SELECT DISTINCT i.id,i.version FROM interactions i LEFT JOIN runs r ON r.interaction_id=i.id
      WHERE i.project_id=? OR r.project_id=? ORDER BY i.id`).all(id,id);
    const affected=new Set(interactions.map(i=>i.id));
    const runs=this.db.prepare('SELECT id,interaction_id,status,snapshot_id FROM runs ORDER BY id').all().filter(r=>affected.has(r.interaction_id));
    const messages=this.db.prepare('SELECT id,interaction_id,run_id,session_id FROM messages ORDER BY id').all().filter(m=>affected.has(m.interaction_id)||runs.some(r=>r.id===m.run_id));
    const sources=new Set(messages.map(m=>m.id));
    const affectedSessions=new Set(messages.map(m=>m.session_id));
    const shared=new Set<string>(); const derived=new Set<string>();
    const snapshots=this.db.prepare('SELECT s.id,s.fragments_json,r.assistant_message_id,r.session_id FROM context_snapshots s JOIN runs r ON r.id=s.run_id ORDER BY s.created_at,s.rowid').all();
    let expanded=true;
    while(expanded) {
      expanded=false;
      for(const snapshot of snapshots) {
        if(shared.has(String(snapshot.id))) continue;
        if(JSON.parse(String(snapshot.fragments_json)).some((f:Row)=>f.projectId===id || sources.has(f.sourceId) || (f.sourceType==='legacy_input' && affectedSessions.has(snapshot.session_id)))) {
          shared.add(String(snapshot.id)); expanded=true;
          if(!sources.has(snapshot.assistant_message_id)) { sources.add(snapshot.assistant_message_id); derived.add(String(snapshot.assistant_message_id)); }
        }
      }
    }
    const tasks=this.db.prepare('SELECT t.id,t.revision,t.project_id,v.result_ref FROM tasks t JOIN task_revisions v ON v.task_id=t.id ORDER BY t.id,v.revision').all().filter(t=>t.project_id===id || sources.has(t.result_ref)).map(t=>({id:t.id,revision:t.revision,action:t.project_id===id?'delete':'clear_result'}));
    return {tasks,projectId:id,title:project.title,version:project.version,interactions,runs,messages,sharedSnapshots:[...shared].sort(),derivedMessages:[...derived].sort(),externalFilesDeleted:false};
  }

  private deleteProject(p: Row) {
    requireValue(p.confirm===true,'DELETE_CONFIRM_REQUIRED');
    return this.store.transaction(()=>{
      const preview=this.db.prepare('SELECT * FROM delete_previews WHERE token=?').get(text(p.token));
      requireValue(preview && Date.now()-Number(preview.created_at)<10*60*1000,'DELETE_PREVIEW_EXPIRED');
      const details=this.deletionDetails(String(preview.project_id));
      requireValue(hash(details)===preview.revision,'DELETE_PREVIEW_CHANGED');
      this.db.exec('PRAGMA defer_foreign_keys=ON');
      for(const r of details.runs) this.cancel(String(r.id));
      for(const messageId of details.derivedMessages) {
        const run=this.db.prepare("SELECT r.id FROM runs r JOIN messages m ON m.run_id=r.id WHERE m.id=? AND r.status IN('queued','running','paused','waiting_approval','interrupted')").get(messageId);
        if(run) this.cancel(String(run.id));
      }
      const messageIds=new Set([...details.messages.map(m=>m.id),...details.derivedMessages]);
      const affectedSessions=this.db.prepare('SELECT DISTINCT session_id FROM interactions WHERE id IN (SELECT interaction_id FROM runs WHERE project_id=?) OR project_id=?').all(details.projectId,details.projectId);
      for(const s of this.db.prepare('SELECT s.*,r.session_id FROM context_snapshots s JOIN runs r ON r.id=s.run_id').all()) {
        if(details.runs.some(r=>r.id===s.run_id)) { this.db.prepare('DELETE FROM context_snapshots WHERE id=?').run(s.id); continue; }
        const fragments=JSON.parse(String(s.fragments_json)).map((f:Row)=>f.projectId===details.projectId || messageIds.has(f.sourceId) || (f.sourceType==='legacy_input' && affectedSessions.some(session=>session.session_id===s.session_id)) ? {...f,content:'内容已删除，无法还原',deleted:true,projectId:null}:f);
        this.db.prepare('UPDATE context_snapshots SET project_id=CASE WHEN project_id=? THEN NULL ELSE project_id END,fragments_json=? WHERE id=?').run(details.projectId,JSON.stringify(fragments),s.id);
        this.db.prepare('UPDATE runs SET context_json=? WHERE id=?').run(JSON.stringify(fragments.map((f:Row)=>({role:f.role,content:f.content}))),s.run_id);
      }
      for(const snapshotId of details.sharedSnapshots) {
        this.db.prepare('UPDATE run_progress SET checkpoint=NULL WHERE run_id=(SELECT run_id FROM context_snapshots WHERE id=?)').run(snapshotId);
        this.db.prepare('DELETE FROM run_steps WHERE run_id=(SELECT run_id FROM context_snapshots WHERE id=?)').run(snapshotId);
        this.db.prepare('DELETE FROM invocations WHERE run_id=(SELECT run_id FROM context_snapshots WHERE id=?)').run(snapshotId);
      }
      for(const id of details.derivedMessages) this.db.prepare("UPDATE messages SET content='内容已删除，无法还原' WHERE id=?").run(id);
      for(const session of affectedSessions) this.db.prepare("UPDATE sessions SET title='历史话题（部分内容已删除）' WHERE id=?").run(session.session_id);
      const affectedSessionIds=new Set(affectedSessions.map(s=>s.session_id));
      for(const interaction of this.db.prepare('SELECT id,route_json FROM interactions WHERE route_json IS NOT NULL').all()) {
        const route=JSON.parse(String(interaction.route_json));
        route.candidates=route.candidates.filter((candidate:Candidate)=>candidate.projectId!==details.projectId && !affectedSessionIds.has(candidate.sessionId));
        if(affectedSessionIds.has(route.sessionId)) route.reason='历史来源已清理';
        this.db.prepare('UPDATE interactions SET route_json=? WHERE id=?').run(JSON.stringify(route),interaction.id);
      }
      for(const t of details.tasks.filter(t=>t.action==='delete')) this.db.prepare('DELETE FROM tasks WHERE id=?').run(t.id);
      this.db.prepare('DELETE FROM directory_grants WHERE project_id=?').run(details.projectId);
      for(const id of messageIds) {
        this.db.prepare("UPDATE tasks SET status='open' WHERE id IN(SELECT task_id FROM task_revisions WHERE result_ref=? AND revision=tasks.revision)").run(id);
        this.db.prepare("UPDATE task_revisions SET result_ref=NULL,evidence=NULL,status='open' WHERE result_ref=?").run(id);
      }
      for(const m of details.messages) this.db.prepare('DELETE FROM messages WHERE id=?').run(m.id);
      for(const r of details.runs) this.db.prepare('DELETE FROM runs WHERE id=?').run(r.id);
      for(const i of details.interactions) {
        this.db.prepare('DELETE FROM corrections WHERE interaction_id=?').run(i.id);
        this.db.prepare('DELETE FROM outbox WHERE interaction_id=?').run(i.id);
        this.db.prepare('DELETE FROM interactions WHERE id=?').run(i.id);
      }
      this.db.prepare('UPDATE focus_states SET active_session_id=NULL,interrupted_session_id=NULL,active_project_id=NULL,recent_session_ids=\'[]\',version=version+1 WHERE active_project_id=?').run(details.projectId);
      this.db.prepare('UPDATE sessions SET project_id=NULL WHERE project_id=?').run(details.projectId);
      this.db.prepare('DELETE FROM sessions WHERE NOT EXISTS(SELECT 1 FROM messages WHERE session_id=sessions.id) AND NOT EXISTS(SELECT 1 FROM interactions WHERE session_id=sessions.id) AND NOT EXISTS(SELECT 1 FROM tasks WHERE session_id=sessions.id) AND id NOT IN(SELECT active_session_id FROM focus_states WHERE active_session_id IS NOT NULL) AND id NOT IN(SELECT interrupted_session_id FROM focus_states WHERE interrupted_session_id IS NOT NULL)').run();
      this.db.prepare('DELETE FROM delete_previews WHERE project_id=?').run(details.projectId);
      this.db.prepare('UPDATE runs SET project_id=NULL WHERE project_id=?').run(details.projectId);
      this.db.prepare('DELETE FROM projects WHERE id=?').run(details.projectId);
      // Invalidate view cursors so every window drops removed message copies on its next poll.
      this.db.exec('DELETE FROM events');
      this.db.prepare("INSERT INTO events(id,schema_version,type,aggregate_id,correlation_id,occurred_at,payload_ref) VALUES(?,1,'history.deleted','main','main',?,'deleted')").run(randomUUID(),Date.now());
      return {};
    });
  }
}
