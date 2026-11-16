import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import {
  ArrowUp,
  Ellipsis,
  Plus,
  SlidersHorizontal,
  SquarePen,
  X,
  ChevronDown,
} from "lucide-react";
import { useAssistant, rpc } from "./store.tsx";
import type {
  PendingInteraction,
  TimelineMessage,
  RunContext,
  CorrectionHistory,
} from "../shared/model.ts";
import { activeQuestion, modelId } from "../shared/conversation.ts";
import { errorText } from "../shared/errors.ts";
import {
  Button,
  Header,
  IconButton,
  Menu,
  MenuItem,
  MenuSub,
  Notice,
  Picker,
  Popup,
} from "./components/ui.tsx";
import { Markdown } from "./components/markdown.tsx";
import { useAction } from "./components/actions.ts";

export function Approvals() {
  const { store, snapshot } = useAssistant();
  const { busy, run } = useAction();
  return (
    <>
      {snapshot?.activity.approvals.map((approval) => {
        let reason = "读取本地资料";
        try {
          reason = JSON.parse(approval.args).reason ?? reason;
        } catch {
          /* Use the safe default. */
        }
        return (
          <section className="card stack" key={approval.id}>
            <h3>待审批 · 选择只读目录</h3>
            <p>{reason}</p>
            <p className="caption">
              工具：{approval.name} ·{" "}
              {store.projectTitle(
                snapshot.activity.runs.find(
                  (item) => item.id === approval.run_id,
                )?.project_id,
              )}
            </p>
            <p className="caption">
              批准后由你选择目录；只允许读取 UTF-8
              文本，不修改源文件。文件片段可能发送给所选模型。审批十分钟有效。
            </p>
            <div className="row">
              <Button
                disabled={busy || Date.now() >= approval.expires_at}
                onClick={() => void run(() => store.approve(approval, true))}
              >
                批准一次并选择目录
              </Button>
              <Button
                disabled={busy}
                onClick={() => void run(() => store.approve(approval, false))}
              >
                拒绝
              </Button>
            </div>
          </section>
        );
      })}
    </>
  );
}
function Pending({ interaction }: { interaction: PendingInteraction }) {
  const { store, snapshot } = useAssistant();
  const [session, setSession] = useState("");
  const { busy, run } = useAction();
  const confirm = (sessionId: string | null) =>
    run(() =>
      store.perform("interaction.confirm", {
        interactionId: interaction.id,
        expectedVersion: interaction.version,
        expectedFocusVersion: snapshot?.focus.version,
        sessionId,
      }),
    );
  return (
    <section className="card selection stack">
      <h3>待确认话题</h3>
      <p>{interaction.input}</p>
      <p className="caption">{interaction.route.reason}</p>
      {interaction.route.candidates.map((candidate) => (
        <div className="stack tight" key={candidate.sessionId}>
          <Button
            disabled={busy}
            onClick={() => void confirm(candidate.sessionId)}
          >
            {candidate.title}
          </Button>
          <p className="caption">
            {store.projectTitle(candidate.projectId)} · {candidate.reason} ·{" "}
            {new Date(candidate.updatedAt).toLocaleString()}
          </p>
        </div>
      ))}
      <div className="row wrap">
        <Picker
          label="其他话题"
          value={session}
          onChange={setSession}
          options={[
            { value: "", label: "新建话题" },
            ...(snapshot?.sessions ?? []).map((item) => ({
              value: item.id,
              label: item.title,
            })),
          ]}
        />
        <Button disabled={busy} onClick={() => void confirm(session || null)}>
          确认归属并发送
        </Button>
      </div>
    </section>
  );
}
function ContextControls() {
  const { store, snapshot } = useAssistant();
  const focus = snapshot?.focus;
  const [mode, setMode] = useState(focus?.contextMode ?? "automatic"),
    [projectId, setProject] = useState(focus?.activeProjectId ?? "");
  const { busy, run } = useAction();
  const titles: Record<string, string> = {
    automatic: "自动",
    pinned: "固定项目",
    isolated: "隔离项目",
  };
  useEffect(() => {
    setMode(focus?.contextMode ?? "automatic");
    setProject(focus?.activeProjectId ?? "");
  }, [focus?.version, focus?.contextMode, focus?.activeProjectId]);
  const summary = `${titles[focus?.contextMode ?? "automatic"]} · ${focus?.activeProjectId ? store.projectTitle(focus.activeProjectId) : "未指定项目"}`;
  return (
    <Popup
      label={`上下文范围：${summary}`}
      trigger={
        <span className="row caption">
          <SlidersHorizontal size={13} />
          {summary}
        </span>
      }
    >
      <h3>上下文范围</h3>
      <Picker
        label="上下文"
        value={mode}
        onChange={setMode}
        options={Object.entries(titles).map(([value, label]) => ({
          value,
          label,
        }))}
      />
      <Picker
        label="项目"
        value={projectId}
        onChange={setProject}
        options={[
          { value: "", label: "未指定项目" },
          ...(
            snapshot?.projects.filter((item) => item.status === "open") ?? []
          ).map((item) => ({ value: item.id, label: item.title })),
        ]}
      />
      <p className="caption">当前：{summary}</p>
      {mode === "isolated" && (
        <p className="caption">仅限所选项目 · 不加载全局记忆</p>
      )}
      <Button
        kind="primary"
        disabled={
          busy ||
          !focus ||
          (mode === focus.contextMode &&
            projectId === (focus.activeProjectId ?? ""))
        }
        onClick={() =>
          void run(() =>
            store.perform("context.set", {
              mode,
              projectId: projectId || null,
              expectedVersion: focus?.version,
            }),
          )
        }
      >
        应用范围
      </Button>
    </Popup>
  );
}
function Composer({ active }: { active: boolean }) {
  const {
    store,
    snapshot,
    draft,
    selectedModel,
    newTopic,
    temporary,
    createTask,
    taskDeliverable,
    taskCriteria,
    sending,
    error,
    status,
  } = useAssistant();
  const textarea = useRef<HTMLTextAreaElement>(null);
  useLayoutEffect(() => {
    const element = textarea.current;
    if (element) {
      element.style.height = "auto";
      element.style.height = `${Math.min(168, Math.max(48, element.scrollHeight))}px`;
    }
  }, [draft]);
  useEffect(() => {
    if (active) textarea.current?.focus();
  }, [active]);
  const defaultTitle = snapshot?.defaultModel
    ? `默认 · ${snapshot.defaultModel.modelName}`
    : "请选择模型";
  const options = [
    { value: "", label: defaultTitle },
    ...(snapshot?.models ?? []).map((option) => ({
      value: modelId(option),
      label: `${option.modelName} · ${store.connectionTitle(option.connectionId)}`,
    })),
  ];
  if (
    selectedModel &&
    !options.some((option) => option.value === selectedModel)
  )
    options.push({ value: selectedModel, label: "所选模型已失效" });
  return (
    <div className="composer-wrap">
      <div className="composer-notice">
        <Notice error>{error}</Notice>
        {!status.connected && <p className="caption">{status.status}</p>}
        {snapshot?.configError && (
          <Notice error>{errorText(snapshot.configError)}</Notice>
        )}
      </div>
      <div className="composer stack">
        {(createTask || newTopic || temporary) && (
          <div className="row wrap">
            {createTask && (
              <Button
                kind="plain"
                className="chip"
                onClick={() => store.set({ createTask: false })}
              >
                持续任务 <X size={12} />
              </Button>
            )}
            {(newTopic || temporary) && (
              <Button
                kind="plain"
                className="chip"
                onClick={() => store.set({ newTopic: false, temporary: false })}
              >
                {temporary ? "临时插话" : "新话题"} <X size={12} />
              </Button>
            )}
          </div>
        )}
        {createTask && (
          <>
            <input
              aria-label="预期交付物"
              placeholder="预期交付物"
              value={taskDeliverable}
              onChange={(event) =>
                store.set({ taskDeliverable: event.target.value })
              }
            />
            <textarea
              aria-label="完成标准"
              placeholder="完成标准，每行一条"
              rows={2}
              value={taskCriteria}
              onChange={(event) =>
                store.set({ taskCriteria: event.target.value })
              }
            />
          </>
        )}
        <textarea
          className="message-input"
          ref={textarea}
          aria-label="消息内容"
          placeholder="输入消息…"
          rows={2}
          value={draft}
          onChange={(event) => store.set({ draft: event.target.value })}
          onKeyDown={(event) => {
            if (
              event.key === "Enter" &&
              !event.nativeEvent.isComposing &&
              (!event.shiftKey || event.metaKey)
            ) {
              event.preventDefault();
              void store.send();
            }
          }}
        />
        <div className="row composer-toolbar">
          <Menu label="添加消息选项" trigger={<Plus size={18} />}>
            <MenuItem onSelect={() => store.set({ createTask: !createTask })}>
              {createTask ? "✓ " : ""}持续任务
            </MenuItem>
            <MenuItem
              onSelect={() => store.set({ newTopic: true, temporary: false })}
            >
              新话题
            </MenuItem>
            <MenuItem
              onSelect={() => store.set({ newTopic: false, temporary: true })}
            >
              临时插话
            </MenuItem>
          </Menu>
          <ContextControls />
          <span className="spacer" />
          <Picker
            label="模型"
            value={selectedModel}
            onChange={(value) => store.set({ selectedModel: value })}
            options={options}
            className="model-picker"
          />
          <Button
            kind="send"
            disabled={
              sending || !snapshot || !status.connected || !draft.trim()
            }
            aria-label="发送消息"
            title="发送消息（⌘Return）"
            onClick={() => void store.send()}
          >
            <ArrowUp size={16} />
          </Button>
        </div>
      </div>
    </div>
  );
}
function CorrectMenu({ message }: { message: TimelineMessage }) {
  return (
    <Menu
      label="纠正项目归属"
      trigger={
        <>
          纠正项目归属 <ChevronDown size={12} />
        </>
      }
    >
      <CorrectionItems message={message} />
    </Menu>
  );
}
function CorrectionItems({ message }: { message: TimelineMessage }) {
  const { store, snapshot } = useAssistant();
  return (
    <>
      <MenuItem
        onSelect={() =>
          void store.perform("interaction.correct", {
            interactionId: message.interactionId,
            expectedVersion: message.interactionVersion,
            projectId: null,
          })
        }
      >
        未关联项目
      </MenuItem>
      {snapshot?.projects
        .filter((project) => project.status === "open")
        .map((project) => (
          <MenuItem
            key={project.id}
            onSelect={() =>
              void store.perform("interaction.correct", {
                interactionId: message.interactionId,
                expectedVersion: message.interactionVersion,
                projectId: project.id,
              })
            }
          >
            {project.title}
          </MenuItem>
        ))}
    </>
  );
}
function Message({
  message,
  onDetails,
}: {
  message: TimelineMessage;
  onDetails: () => void;
}) {
  const { store, selectedModel, sending } = useAssistant();
  const user = message.role === "user";
  return (
    <div className={`message ${user ? "user" : "assistant"}`}>
      <div className="message-body stack">
        {!user && (
          <div className="row message-author">
            <span className="tandem-symbol">◐</span>
            <strong>Tandem</strong>
            <span
              className="caption"
              title={`${message.modelName} · ${store.connectionTitle(message.connectionId)}`}
            >
              {message.modelName}
            </span>
          </div>
        )}
        {message.content &&
          (user ? (
            <p className="user-text">{message.content}</p>
          ) : (
            <Markdown source={message.content} />
          ))}
        {!user &&
          message.executionInteractionVersion !==
            message.interactionVersion && (
            <section className="card stack tight">
              <p className="caption">
                原回答使用：{store.projectTitle(message.executionProjectId)}
                。更改归属不会改写历史上下文。
              </p>
              {message.runId && (
                <Button
                  disabled={sending}
                  onClick={() => void store.retry(message.runId!)}
                >
                  按当前归属重新处理
                </Button>
              )}
            </section>
          )}
        {message.status && message.status !== "completed" && (
          <div className="stack tight">
            {["queued", "running"].includes(message.status) ? (
              <div className="row caption">
                <span className="spinner" />
                {message.status === "queued" ? "排队中" : "正在生成…"}
                <Button
                  kind="plain"
                  onClick={() =>
                    void store.perform("message.cancel", {
                      runId: message.runId,
                    })
                  }
                >
                  停止
                </Button>
              </div>
            ) : message.status === "waiting_approval" ? (
              <p className="caption">等待目录授权，请在审批卡片中处理。</p>
            ) : message.status === "paused" ? (
              <p className="caption">
                执行已暂停，请在 Activity 查看进度与预算。
              </p>
            ) : (
              <>
                <p
                  className={
                    message.status === "cancelled" ? "caption" : "error"
                  }
                >
                  {errorText(message.errorCode ?? "INTERRUPTED")}
                </p>
                {message.runId && (
                  <Button
                    disabled={sending}
                    onClick={() => void store.retry(message.runId!)}
                  >
                    {selectedModel ? "使用所选模型重试" : "使用原模型重试"}
                  </Button>
                )}
              </>
            )}
          </div>
        )}
      </div>
      <div className="row message-meta">
        <span>{store.projectTitle(message.projectId)}</span>
        <Button kind="plain" onClick={onDetails}>
          详情与来源
        </Button>
        <Menu label="消息操作" trigger={<Ellipsis size={17} />}>
          <MenuItem onSelect={() => void window.tandem.copy(message.content)}>
            {user ? "复制消息" : "复制 Markdown"}
          </MenuItem>
          <MenuItem onSelect={onDetails}>消息详情与来源</MenuItem>
          {message.interactionId && (
            <MenuSub title="纠正项目归属">
              <CorrectionItems message={message} />
            </MenuSub>
          )}
        </Menu>
      </div>
    </div>
  );
}
export function ContextFragments({ context }: { context: RunContext }) {
  const { store } = useAssistant();
  return (
    <div className="stack">
      {context.fragments.map((fragment, index) => (
        <section className="stack tight" key={`${fragment.sourceId}:${index}`}>
          <h3>
            {fragment.sourceType === "memory"
              ? "长期记忆"
              : fragment.role === "user"
                ? "用户输入"
                : fragment.role === "tool"
                  ? "工具结果"
                  : "回答"}
          </h3>
          <p className="caption">{store.projectTitle(fragment.projectId)}</p>
          <p className="prewrap">{fragment.content}</p>
          <p className="caption monospace prewrap">
            来源 {fragment.sourceId}
            {"\n"}版本 {fragment.sourceVersion}
          </p>
        </section>
      ))}
    </div>
  );
}
function Details({
  message,
  onClose,
}: {
  message: TimelineMessage;
  onClose: () => void;
}) {
  const { snapshot, store } = useAssistant();
  const [context, setContext] = useState<RunContext>(),
    [history, setHistory] = useState<CorrectionHistory>(),
    [error, setError] = useState("");
  useEffect(() => {
    let alive = true;
    setContext(undefined);
    setHistory(undefined);
    setError("");
    void Promise.allSettled([
      message.snapshotId
        ? rpc<RunContext>("snapshot.get", { id: message.snapshotId })
        : Promise.resolve(undefined),
      message.interactionId
        ? rpc<CorrectionHistory>("interaction.history", {
            interactionId: message.interactionId,
          })
        : Promise.resolve(undefined),
    ]).then(([a, b]) => {
      if (!alive) return;
      if (a.status === "fulfilled") setContext(a.value);
      else setError("当前范围无法查看此快照，请先明确切换项目或模式。");
      if (b.status === "fulfilled") setHistory(b.value);
      else setError("无法读取纠正记录，请重试。");
    });
    return () => {
      alive = false;
    };
  }, [
    message.id,
    message.snapshotId,
    message.interactionId,
    message.interactionVersion,
    snapshot?.focus.version,
  ]);
  return (
    <aside className="inspector">
      <div className="row inspector-header">
        <h3>消息详情</h3>
        <span className="spacer" />
        <IconButton label="关闭消息详情" onClick={onClose}>
          <X size={16} />
        </IconButton>
      </div>
      <div className="inspector-content stack">
        <h3>{message.role === "user" ? "你的消息" : "Tandem 的回答"}</h3>
        <p>
          {snapshot?.sessions.find(
            (session) => session.id === message.sessionId,
          )?.title ?? "历史话题"}
        </p>
        <p className="caption">
          {message.modelName} · {store.connectionTitle(message.connectionId)}
        </p>
        <p className="prewrap detail-excerpt">{message.content}</p>
        <h3>项目归属</h3>
        <p>{store.projectTitle(message.projectId)}</p>
        {message.interactionId && <CorrectMenu message={message} />}
        <p className="caption">{message.routeReason}</p>
        <Notice error>{error}</Notice>
        {context && (
          <>
            <h3>执行上下文</h3>
            <p className="caption">
              {store.projectTitle(context.projectId)} · {context.mode}
            </p>
            <ContextFragments context={context} />
          </>
        )}
        {history && (
          <>
            <h3>纠正记录</h3>
            {history.corrections.map((item) => (
              <p className="caption" key={item.id}>
                {store.projectTitle(item.from_project)} →{" "}
                {store.projectTitle(item.to_project)} · 修订 {item.version} ·{" "}
                {new Date(item.created_at).toLocaleString()}
              </p>
            ))}
          </>
        )}
      </div>
    </aside>
  );
}
export function Conversation({
  active,
  navigate,
}: {
  active: boolean;
  navigate: (page: string) => void;
}) {
  const { store, snapshot, messages, hasMore, sending, error, status } =
    useAssistant();
  const [filter, setFilter] = useState("*"),
    [detailsId, setDetails] = useState<string>(),
    [ready, setReady] = useState(false),
    [atBottom, setAtBottom] = useState(true),
    [visibleSequence, setVisibleSequence] = useState<number>();
  const scroll = useRef<HTMLDivElement>(null),
    timeline = useRef<HTMLDivElement>(null),
    nearBottom = useRef(true),
    restored = useRef<string | null>(null),
    saveTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  // shortcut: loaded history stays mounted for stable anchors; virtualize if deep-history profiling shows slow layout.
  const visible = useMemo(
    () =>
      messages.filter(
        (message) => filter === "*" || (message.projectId ?? "") === filter,
      ),
    [messages, filter],
  );
  const messageBySequence = useMemo(
    () =>
      new Map(
        visible.map((message, index) => [
          message.sequence,
          { message, previous: visible[index - 1] },
        ]),
      ),
    [visible],
  );
  const pending = filter === "*" ? (snapshot?.pendingInteractions ?? []) : [];
  const sequences = [
    ...new Set([
      ...visible.map((message) => message.sequence),
      ...pending.map((item) => item.sequence),
    ]),
  ].sort((a, b) => a - b);
  const selectedMessage = messages.find((message) => message.id === detailsId);
  const activeSequence = activeQuestion(visible, visibleSequence, atBottom);
  useEffect(() => {
    const send = (event: KeyboardEvent) => {
      if (
        active &&
        !event.defaultPrevented &&
        event.metaKey &&
        event.key === "Enter" &&
        !event.isComposing
      ) {
        event.preventDefault();
        void store.send();
      }
    };
    window.addEventListener("keydown", send);
    return () => window.removeEventListener("keydown", send);
  }, [active, store]);
  useEffect(() => {
    const generation = snapshot?.generation;
    if (!generation || restored.current === generation) return;
    restored.current = generation;
    setReady(false);
    let cancelled = false;
    const saved =
      store.bootstrap.preferences.positions[store.bootstrap.surfaceId];
    const validSaved = saved?.generation === generation ? saved : undefined;
    const projectFilter = validSaved?.projectFilter;
    if (
      projectFilter !== undefined &&
      (projectFilter === "*" ||
        projectFilter === "" ||
        snapshot.projects.some((project) => project.id === projectFilter))
    )
      setFilter(projectFilter);
    void (async () => {
      if (validSaved && !validSaved.atBottom)
        while (
          !cancelled &&
          store.state.hasMore &&
          (store.state.messages[0]?.sequence ?? 0) > validSaved.sequence
        ) {
          if (!(await store.loadEarlier())) break;
        }
      if (cancelled) return;
      requestAnimationFrame(() => {
        if (cancelled) return;
        const element = scroll.current;
        if (element) {
          const anchor =
            validSaved && !validSaved.atBottom
              ? element.querySelector<HTMLElement>(
                  `[data-sequence="${validSaved.sequence}"]`,
                )
              : null;
          if (anchor)
            element.scrollTop +=
              anchor.getBoundingClientRect().top -
              element.getBoundingClientRect().top;
          else element.scrollTop = element.scrollHeight;
          nearBottom.current =
            element.scrollHeight - element.clientHeight - element.scrollTop <
            80;
        }
        setReady(true);
      });
    })();
    return () => {
      cancelled = true;
    };
  }, [snapshot?.generation, store]);
  useLayoutEffect(() => {
    if (!timeline.current) return;
    const observer = new ResizeObserver(() => {
      if (active && ready && nearBottom.current && scroll.current)
        scroll.current.scrollTop = scroll.current.scrollHeight;
    });
    observer.observe(timeline.current);
    return () => observer.disconnect();
  }, [active, ready]);
  useLayoutEffect(() => {
    if (active && ready && sending && scroll.current) {
      nearBottom.current = true;
      scroll.current.scrollTop = scroll.current.scrollHeight;
    }
  }, [active, ready, sending]);
  useEffect(
    () => () => {
      if (saveTimer.current) clearTimeout(saveTimer.current);
    },
    [],
  );
  const onScroll = () => {
    const element = scroll.current;
    if (!element || !active || !ready || !snapshot?.generation) return;
    nearBottom.current =
      element.scrollHeight - element.clientHeight - element.scrollTop < 80;
    setAtBottom(
      element.scrollHeight - element.clientHeight - element.scrollTop <= 1,
    );
    const top = element.getBoundingClientRect().top;
    const anchor = [
      ...element.querySelectorAll<HTMLElement>("[data-sequence]"),
    ].find((row) => row.getBoundingClientRect().bottom > top + 1);
    const sequence = Number(anchor?.dataset.sequence);
    if (!sequence) return;
    setVisibleSequence(sequence);
    if (saveTimer.current) clearTimeout(saveTimer.current);
    const position = {
      generation: snapshot.generation,
      sequence,
      atBottom: nearBottom.current,
      projectFilter: filter,
    };
    saveTimer.current = setTimeout(() => {
      void window.tandem.position(position);
    }, 150);
  };
  const jump = (sequence: number) => {
    const element = scroll.current,
      target = element?.querySelector<HTMLElement>(
        `[data-sequence="${sequence}"]`,
      );
    if (element && target) {
      nearBottom.current = false;
      element.scrollTop +=
        target.getBoundingClientRect().top -
        element.getBoundingClientRect().top;
      onScroll();
    }
  };
  const loadEarlier = async () => {
    const element = scroll.current;
    const height = element?.scrollHeight ?? 0,
      top = element?.scrollTop ?? 0;
    await store.loadEarlier();
    requestAnimationFrame(() => {
      if (element) element.scrollTop = top + element.scrollHeight - height;
    });
  };
  return (
    <section className="conversation-page" hidden={!active}>
      <div className="conversation-main">
        <Header
          title="对话"
          subtitle={
            snapshot?.sessions.find(
              (session) => session.id === snapshot.focus.activeSessionId,
            )?.title ?? "准备开始新话题"
          }
        >
          {snapshot?.focus.interruptedSessionId && (
            <Button
              onClick={() =>
                void store.focus(snapshot.focus.interruptedSessionId!)
              }
            >
              恢复原话题
            </Button>
          )}
          <Menu
            label="新话题"
            trigger={
              <span className="button row">
                <SquarePen size={14} />
                新话题
                <ChevronDown size={12} />
              </span>
            }
          >
            <MenuItem
              onSelect={() => store.set({ newTopic: true, temporary: false })}
            >
              新话题
            </MenuItem>
            <MenuItem
              onSelect={() => store.set({ temporary: true, newTopic: false })}
            >
              临时插话
            </MenuItem>
          </Menu>
        </Header>
        <div className="history-toolbar row">
          <span className="caption">全部话题</span>
          <span className="spacer" />
          <Picker
            label="历史筛选"
            value={filter}
            onChange={(value) => {
              setFilter(value);
              nearBottom.current = true;
              requestAnimationFrame(() => {
                if (scroll.current)
                  scroll.current.scrollTop = scroll.current.scrollHeight;
              });
            }}
            options={[
              { value: "*", label: "全部项目" },
              { value: "", label: "未关联项目" },
              ...(snapshot?.projects ?? []).map((project) => ({
                value: project.id,
                label:
                  project.title +
                  (project.status === "archived" ? "（归档）" : ""),
              })),
            ]}
          />
        </div>
        <div className="timeline-area">
          <div className="timeline-scroll" ref={scroll} onScroll={onScroll}>
            <div
              className={`timeline stack ${snapshot && !ready ? "restoring" : ""}`}
              ref={timeline}
            >
              {hasMore && (
                <Button className="earlier" onClick={() => void loadEarlier()}>
                  加载更早的消息
                </Button>
              )}
              {!snapshot ? (
                <div className="empty-state stack">
                  <h2>
                    {error ? "暂时无法载入对话" : "正在启动本地运行环境…"}
                  </h2>
                  <p className="caption">{error ?? status.status}</p>
                  {error && (
                    <Button onClick={() => void store.refresh()}>
                      重试加载
                    </Button>
                  )}
                </div>
              ) : !messages.length && !pending.length ? (
                <div className="empty-state stack">
                  <span className="empty-symbol">◐</span>
                  <h2>从一个想法开始</h2>
                  {!snapshot.models.length && (
                    <Button kind="primary" onClick={() => navigate("settings")}>
                      配置第一个模型
                    </Button>
                  )}
                </div>
              ) : !sequences.length ? (
                <p className="empty-state caption">此项目暂无消息</p>
              ) : null}
              {sequences.map((sequence) => {
                const { message, previous } =
                  messageBySequence.get(sequence) ?? {};
                const interaction = pending.find(
                  (item) => item.sequence === sequence,
                );
                const boundary =
                  message &&
                  (previous?.sessionId !== message.sessionId ||
                    previous?.projectId !== message.projectId)
                    ? [
                        previous?.sessionId !== message.sessionId
                          ? (snapshot?.sessions.find(
                              (session) => session.id === message.sessionId,
                            )?.title ?? "历史话题")
                          : "",
                        previous?.projectId !== message.projectId
                          ? store.projectTitle(message.projectId)
                          : "",
                      ]
                        .filter(Boolean)
                        .join(" · ")
                    : "";
                return (
                  <div
                    className="timeline-row stack"
                    data-sequence={sequence}
                    key={sequence}
                  >
                    {boundary && (
                      <div className="boundary">
                        <span>{boundary}</span>
                      </div>
                    )}
                    {message ? (
                      <Message
                        message={message}
                        onDetails={() => setDetails(message.id)}
                      />
                    ) : interaction ? (
                      <Pending interaction={interaction} />
                    ) : null}
                  </div>
                );
              })}
              <Approvals />
              {snapshot?.activity.runs
                .filter((run) => run.status === "paused")
                .map((run) => (
                  <section key={run.id} className="card stack">
                    <p className="caption">
                      执行预算已用尽：{run.steps}/{run.step_limit} 步 ·{" "}
                      {run.tokens}/{run.token_limit} Token ·{" "}
                      {Math.floor(run.active_ms / 1000)}/
                      {Math.floor(run.time_limit / 1000)} 秒
                    </p>
                    <Button onClick={() => navigate("activity")}>
                      在 Activity 查看进度与追加预算
                    </Button>
                  </section>
                ))}
            </div>
          </div>
          {sequences.length > 0 && (
            <nav className="conversation-nav" aria-label="对话消息导航">
              {visible
                .filter((message) => message.role === "user")
                .map((message) => (
                  <button
                    key={message.id}
                    title={message.content}
                    aria-label={`跳转到：${message.content.slice(0, 60)}`}
                    aria-current={
                      activeSequence === message.sequence ? "true" : undefined
                    }
                    onClick={() => jump(message.sequence)}
                  >
                    <span />
                  </button>
                ))}
              <button
                title="最新消息"
                aria-label="跳转到最新消息"
                onClick={() => {
                  nearBottom.current = true;
                  if (scroll.current)
                    scroll.current.scrollTop = scroll.current.scrollHeight;
                }}
              >
                ↓
              </button>
            </nav>
          )}
        </div>
        <Composer active={active} />
      </div>
      {selectedMessage && (
        <Details
          message={selectedMessage}
          onClose={() => setDetails(undefined)}
        />
      )}
    </section>
  );
}
