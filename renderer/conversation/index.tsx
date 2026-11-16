import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { ChevronDown, SquarePen } from "lucide-react";
import { useAssistant } from "../store.tsx";
import { activeQuestion } from "../../shared/conversation.ts";
import { Button, Header, Menu, MenuItem, Picker } from "../components/ui.tsx";
import { Approvals } from "../components/approvals.tsx";
import { Composer } from "./composer.tsx";
import { Message } from "./message.tsx";
import { Details } from "./details.tsx";
import { Pending } from "./pending.tsx";

export function Conversation({
  active,
  navigate,
}: {
  active: boolean;
  navigate: (page: string) => void;
}) {
  const { store, snapshot, messages, hasMore, sending, error, status } = useAssistant();
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
    () => messages.filter((message) => filter === "*" || (message.projectId ?? "") === filter),
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
    const saved = store.bootstrap.preferences.positions[store.bootstrap.surfaceId];
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
              ? element.querySelector<HTMLElement>(`[data-sequence="${validSaved.sequence}"]`)
              : null;
          if (anchor)
            element.scrollTop +=
              anchor.getBoundingClientRect().top - element.getBoundingClientRect().top;
          else element.scrollTop = element.scrollHeight;
          nearBottom.current = element.scrollHeight - element.clientHeight - element.scrollTop < 80;
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
    nearBottom.current = element.scrollHeight - element.clientHeight - element.scrollTop < 80;
    setAtBottom(element.scrollHeight - element.clientHeight - element.scrollTop <= 1);
    const top = element.getBoundingClientRect().top;
    const anchor = [...element.querySelectorAll<HTMLElement>("[data-sequence]")].find(
      (row) => row.getBoundingClientRect().bottom > top + 1,
    );
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
      target = element?.querySelector<HTMLElement>(`[data-sequence="${sequence}"]`);
    if (element && target) {
      nearBottom.current = false;
      element.scrollTop += target.getBoundingClientRect().top - element.getBoundingClientRect().top;
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
            snapshot?.sessions.find((session) => session.id === snapshot.focus.activeSessionId)
              ?.title ?? "准备开始新话题"
          }
        >
          {snapshot?.focus.interruptedSessionId && (
            <Button onClick={() => void store.focus(snapshot.focus.interruptedSessionId!)}>
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
            <MenuItem onSelect={() => store.set({ newTopic: true, temporary: false })}>
              新话题
            </MenuItem>
            <MenuItem onSelect={() => store.set({ temporary: true, newTopic: false })}>
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
                if (scroll.current) scroll.current.scrollTop = scroll.current.scrollHeight;
              });
            }}
            options={[
              { value: "*", label: "全部项目" },
              { value: "", label: "未关联项目" },
              ...(snapshot?.projects ?? []).map((project) => ({
                value: project.id,
                label: project.title + (project.status === "archived" ? "（归档）" : ""),
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
                  <h2>{error ? "暂时无法载入对话" : "正在启动本地运行环境…"}</h2>
                  <p className="caption">{error ?? status.status}</p>
                  {error && <Button onClick={() => void store.refresh()}>重试加载</Button>}
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
                const { message, previous } = messageBySequence.get(sequence) ?? {};
                const interaction = pending.find((item) => item.sequence === sequence);
                const boundary =
                  message &&
                  (previous?.sessionId !== message.sessionId ||
                    previous?.projectId !== message.projectId)
                    ? [
                        previous?.sessionId !== message.sessionId
                          ? (snapshot?.sessions.find((session) => session.id === message.sessionId)
                              ?.title ?? "历史话题")
                          : "",
                        previous?.projectId !== message.projectId
                          ? store.projectTitle(message.projectId)
                          : "",
                      ]
                        .filter(Boolean)
                        .join(" · ")
                    : "";
                return (
                  <div className="timeline-row stack" data-sequence={sequence} key={sequence}>
                    {boundary && (
                      <div className="boundary">
                        <span>{boundary}</span>
                      </div>
                    )}
                    {message ? (
                      <Message message={message} onDetails={() => setDetails(message.id)} />
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
                      执行预算已用尽：{run.steps}/{run.step_limit} 步 · {run.tokens}/
                      {run.token_limit} Token · {Math.floor(run.active_ms / 1000)}/
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
                    aria-current={activeSequence === message.sequence ? "true" : undefined}
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
                  if (scroll.current) scroll.current.scrollTop = scroll.current.scrollHeight;
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
        <Details message={selectedMessage} onClose={() => setDetails(undefined)} />
      )}
    </section>
  );
}
