import { createContext, useContext, useSyncExternalStore } from "react";
import type {
  AssistantSnapshot,
  RendererMethod,
  TimelineMessage,
  ApprovalCard,
  ActivityRun,
} from "../shared/model.ts";
import type {
  Bootstrap,
  Payload,
  Reply,
  RuntimeStatus,
} from "../shared/bridge.ts";
import {
  applySnapshot,
  mergeMessages,
  modelSelection,
} from "../shared/conversation.ts";
import { errorText } from "../shared/errors.ts";

export function unwrap<T>(reply: Reply): T {
  if (!reply.ok) throw new Error(reply.error);
  return reply.data as T;
}
export async function rpc<T>(
  method: RendererMethod,
  payload: Payload = {},
): Promise<T> {
  return unwrap<T>(await window.tandem.request(method, payload));
}
type Composer = {
  draft: string;
  selectedModel: string;
  newTopic: boolean;
  temporary: boolean;
  createTask: boolean;
  taskDeliverable: string;
  taskCriteria: string;
};
type State = Composer & {
  snapshot?: AssistantSnapshot;
  messages: TimelineMessage[];
  hasMore: boolean;
  sending: boolean;
  error?: string;
  status: RuntimeStatus;
};
export class AssistantStore {
  state: State = {
    draft: "",
    selectedModel: "",
    newTopic: false,
    temporary: false,
    createTask: false,
    taskDeliverable: "",
    taskCriteria: "",
    messages: [],
    hasMore: false,
    sending: false,
    status: {
      status: "启动中",
      connected: false,
      nodePID: 0,
      pongCount: 0,
      connectionCount: 0,
      restartCount: 0,
      logs: [],
    },
  };
  private listeners = new Set<() => void>();
  private pollVersion = 0;
  private refreshing = false;
  private cursor?: number;
  private snapshotJSON = "";
  private pending?: { signature: string; key: string };
  private retryKeys = new Map<string, string>();
  constructor(readonly bootstrap: Bootstrap) {}
  subscribe = (listener: () => void) => {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  };
  getSnapshot = () => this.state;
  set(value: Partial<State>) {
    this.state = { ...this.state, ...value };
    for (const listener of this.listeners) listener();
  }
  async start() {
    const version = ++this.pollVersion;
    while (version === this.pollVersion) {
      try {
        const status = await window.tandem.status();
        if (version !== this.pollVersion) return;
        this.set({ status });
        if (status.connected) await this.refresh();
      } catch {
        this.set({ error: "本地连接暂时不可用，请稍后重试。" });
      }
      await new Promise((resolve) =>
        setTimeout(resolve, this.state.snapshot ? 400 : 100),
      );
    }
  }
  stop() {
    this.pollVersion++;
  }
  async refresh() {
    if (this.refreshing) return;
    this.refreshing = true;
    try {
      const snapshot = await rpc<AssistantSnapshot>("state.get", {
        generation: this.state.snapshot?.generation,
        afterSequence: this.cursor,
      });
      const changedGeneration =
        this.state.snapshot?.generation !== snapshot.generation;
      const json = JSON.stringify(snapshot);
      const messages = applySnapshot(
        this.state.messages,
        this.state.snapshot?.generation ?? undefined,
        snapshot,
      );
      if (json !== this.snapshotJSON)
        this.set({
          snapshot,
          messages,
          hasMore:
            changedGeneration || this.cursor === undefined
              ? snapshot.hasMore
              : this.state.hasMore,
          ...(changedGeneration || !this.state.snapshot
            ? { error: undefined }
            : {}),
        });
      this.snapshotJSON = json;
      this.cursor = snapshot.cursor;
    } catch (error) {
      if (error instanceof Error && error.message === "GAP_REQUIRED") {
        this.cursor = undefined;
        this.snapshotJSON = "";
        this.set({ messages: [] });
      } else if (!this.state.snapshot) this.showError(error);
    } finally {
      this.refreshing = false;
    }
  }
  async loadEarlier() {
    const first = this.state.messages[0];
    if (!first) return false;
    const generation = this.state.snapshot?.generation;
    try {
      const page = await rpc<{ messages: TimelineMessage[] }>("timeline.list", {
        beforeSequence: first.sequence,
      });
      if (generation !== this.state.snapshot?.generation) return false;
      this.set({
        messages: mergeMessages(this.state.messages, page.messages),
        hasMore: page.messages.length === 10,
      });
      return page.messages.length > 0;
    } catch (error) {
      this.showError(error);
      return false;
    }
  }
  showError(error: unknown) {
    this.set({
      error: errorText(
        error instanceof Error ? error.message : "LOCAL_STORAGE_ERROR",
      ),
    });
  }
  async perform(method: RendererMethod, payload: Payload = {}) {
    try {
      await rpc(method, payload);
      this.set({ error: undefined });
      await this.refresh();
      return true;
    } catch (error) {
      this.showError(error);
      return false;
    }
  }
  async send() {
    const state = this.state;
    if (state.sending || !state.draft.trim() || !state.snapshot) return;
    this.set({ sending: true });
    const signature = JSON.stringify([
      state.draft,
      state.selectedModel,
      state.newTopic,
      state.temporary,
      state.createTask,
      state.taskDeliverable,
      state.taskCriteria,
    ]);
    if (this.pending?.signature !== signature)
      this.pending = { signature, key: crypto.randomUUID() };
    try {
      await rpc("message.send", {
        text: state.draft,
        selection: modelSelection(state.selectedModel),
        newTopic: state.newTopic,
        temporary: state.temporary,
        idempotencyKey: this.pending!.key,
        ...(state.createTask
          ? {
              task: {
                deliverable: state.taskDeliverable,
                criteria: state.taskCriteria
                  .split("\n")
                  .filter((line) => line.trim()),
              },
            }
          : {}),
      });
      this.pending = undefined;
      this.set({
        ...(this.state.draft === state.draft ? { draft: "" } : {}),
        newTopic: false,
        temporary: false,
        createTask: false,
        taskDeliverable: "",
        taskCriteria: "",
        error: undefined,
      });
      await this.refresh();
    } catch (error) {
      this.showError(error);
    } finally {
      this.set({ sending: false });
    }
  }
  async retry(runId: string) {
    if (this.state.sending) return;
    this.set({ sending: true });
    const signature = runId + "\0" + this.state.selectedModel;
    const key = this.retryKeys.get(signature) ?? crypto.randomUUID();
    this.retryKeys.set(signature, key);
    await this.perform("message.retry", {
      runId,
      selection: modelSelection(this.state.selectedModel),
      idempotencyKey: key,
    });
    this.set({ sending: false });
  }
  async focus(sessionId: string) {
    if (
      await this.perform("session.focus", {
        sessionId,
        expectedVersion: this.state.snapshot?.focus.version,
      })
    )
      this.set({ newTopic: false, temporary: false });
  }
  async approve(approval: ApprovalCard, allow: boolean) {
    try {
      const projectId =
        this.state.snapshot?.activity.runs.find(
          (run) => run.id === approval.run_id,
        )?.project_id ?? null;
      const grantId = allow
        ? unwrap<string | null>(await window.tandem.chooseDirectory(projectId))
        : null;
      if (allow && !grantId) return;
      await this.perform("approval.decide", {
        id: approval.id,
        approve: allow,
        ...(grantId ? { grantId } : {}),
      });
    } catch (error) {
      this.showError(error);
    }
  }
  async authorize(projectId: string | null, renewing?: string) {
    try {
      unwrap(await window.tandem.chooseDirectory(projectId, renewing));
      await this.refresh();
    } catch (error) {
      this.showError(error);
    }
  }
  async continueRun(run: ActivityRun) {
    const budget = run.pause_reason === "budget_exhausted";
    await this.perform("run.continue", {
      runId: run.id,
      expectedVersion: run.version,
      idempotencyKey: `continue-${run.id}-${run.version}`,
      steps: budget ? 24 : 0,
      tokens: budget ? 64000 : 0,
      activeMs: budget ? 300000 : 0,
    });
  }
  projectTitle(id: string | null | undefined) {
    return id
      ? (this.state.snapshot?.projects.find((project) => project.id === id)
          ?.title ?? "历史项目")
      : "未关联项目";
  }
  connectionTitle(id: string | null) {
    return (
      this.state.snapshot?.models.find((option) => option.connectionId === id)
        ?.connectionName ?? "历史供应商"
    );
  }
}
export const StoreContext = createContext<AssistantStore | null>(null);
export function useAssistant() {
  const store = useContext(StoreContext);
  if (!store) throw new Error("MISSING_STORE");
  const state = useSyncExternalStore(store.subscribe, store.getSnapshot);
  return { store, ...state };
}
