import { useCallback, useEffect, useRef, useState } from "react";
import { Tooltip } from "radix-ui";
import {
  Brain,
  ChevronRight,
  Folder,
  ListTodo,
  MessageCircle,
  MessagesSquare,
  Monitor,
  Moon,
  SlidersHorizontal,
  Sun,
} from "lucide-react";
import type { Preferences } from "../shared/bridge.ts";
import { useAssistant } from "./store.tsx";
import { Conversation } from "./conversation/index.tsx";
import { Settings } from "./settings.tsx";
import { Projects } from "./projects.tsx";
import { Memory } from "./memory.tsx";
import { Activity } from "./activity.tsx";
import {
  Button,
  IconButton,
  Modal,
  Notice,
  SelectionRow,
} from "./components/ui.tsx";

const pages = [
  { id: "assistant", title: "对话", Icon: MessagesSquare },
  { id: "activity", title: "Activity", Icon: ListTodo },
  { id: "projects", title: "项目", Icon: Folder },
  { id: "memory", title: "长期记忆", Icon: Brain },
  { id: "settings", title: "模型设置", Icon: SlidersHorizontal },
];
export function App() {
  useEffect(() => {
    void window.tandem.ready();
  }, []);
  const { store, snapshot, status, error } = useAssistant();
  const [page, setPage] = useState("assistant"),
    [dirty, setDirty] = useState(false),
    [busy, setBusy] = useState(false),
    [pending, setPending] = useState<{ page: string; session?: string }>(),
    [diagnostics, setDiagnostics] = useState(false),
    [preferences, setPreferences] = useState(store.bootstrap.preferences);
  const drag = useRef<{ x: number; width: number } | null>(null);
  const onDirty = useCallback((value: boolean) => setDirty(value), []),
    onBusy = useCallback((value: boolean) => setBusy(value), []);
  useEffect(() => {
    void store.start();
    return () => store.stop();
  }, [store]);
  useEffect(() => {
    document.documentElement.dataset.appearance = preferences.appearance;
  }, [preferences.appearance]);
  useEffect(
    () =>
      window.tandem.onPreferences((value) =>
        setPreferences((previous) => ({ ...previous, ...value })),
      ),
    [],
  );
  const move = (target: { page: string; session?: string }) => {
    setPage(target.page);
    setDirty(false);
    setPending(undefined);
    if (target.session) void store.focus(target.session);
  };
  const navigate = (target: string, session?: string) => {
    if (busy) return;
    if (target === page && !session) return;
    if (dirty) setPending({ page: target, session });
    else move({ page: target, session });
  };
  const changePreferences = (
    value: Partial<Pick<Preferences, "appearance" | "sidebarWidth">>,
  ) => {
    setPreferences((previous) => ({ ...previous, ...value }));
    void window.tandem.preferences(value);
  };
  return (
    <Tooltip.Provider delayDuration={450}>
      <div className="app-shell">
        <aside className="sidebar" style={{ width: preferences.sidebarWidth }}>
          <div className="sidebar-brand drag-region">
            <span className="brand-symbol">◐</span>
            <strong>Tandem</strong>
          </div>
          <nav className="primary-nav stack tight" aria-label="主导航">
            {pages.map(({ id, title, Icon }) => (
              <SelectionRow
                key={id}
                selected={page === id}
                onClick={() => navigate(id)}
              >
                <Icon size={17} />
                <span>{title}</span>
              </SelectionRow>
            ))}
          </nav>
          <h2 className="topics-title caption">最近话题</h2>
          <nav className="recent-topics stack tight" aria-label="最近话题">
            {snapshot?.sessions.map((session) => (
              <SelectionRow
                key={session.id}
                selected={
                  page === "assistant" &&
                  snapshot.focus.activeSessionId === session.id
                }
                onClick={() => navigate("assistant", session.id)}
              >
                <MessageCircle size={16} />
                <span>{session.title}</span>
              </SelectionRow>
            ))}
          </nav>
          <footer className="sidebar-footer stack">
            <div className="appearance-switch" aria-label="外观">
              {(
                [
                  { value: "auto", label: "跟随系统", Icon: Monitor },
                  { value: "light", label: "浅色", Icon: Sun },
                  { value: "dark", label: "深色", Icon: Moon },
                ] as const
              ).map(({ value, label, Icon }) => (
                <IconButton
                  key={value}
                  label={label}
                  aria-pressed={preferences.appearance === value}
                  onClick={() => changePreferences({ appearance: value })}
                >
                  <Icon size={14} />
                </IconButton>
              ))}
            </div>
            <Button
              kind="plain"
              className="runtime-status"
              onClick={() => setDiagnostics(true)}
              title={status.status}
            >
              <span
                className={`status-dot ${status.connected ? "connected" : ""}`}
              />
              <span>本地运行</span>
              <span className="spacer" />
              <ChevronRight size={12} />
            </Button>
          </footer>
        </aside>
        <div
          className="sidebar-divider"
          role="separator"
          aria-label="调整侧栏宽度"
          aria-orientation="vertical"
          tabIndex={0}
          aria-valuemin={196}
          aria-valuemax={360}
          aria-valuenow={preferences.sidebarWidth}
          onKeyDown={(event) => {
            if (["ArrowLeft", "ArrowRight"].includes(event.key)) {
              event.preventDefault();
              changePreferences({
                sidebarWidth: Math.min(
                  360,
                  Math.max(
                    196,
                    preferences.sidebarWidth +
                      (event.key === "ArrowLeft" ? -8 : 8),
                  ),
                ),
              });
            }
          }}
          onPointerDown={(event) => {
            drag.current = {
              x: event.clientX,
              width: preferences.sidebarWidth,
            };
            event.currentTarget.setPointerCapture(event.pointerId);
          }}
          onPointerMove={(event) => {
            if (drag.current)
              setPreferences((previous) => ({
                ...previous,
                sidebarWidth: Math.min(
                  360,
                  Math.max(
                    196,
                    drag.current!.width + event.clientX - drag.current!.x,
                  ),
                ),
              }));
          }}
          onPointerUp={(event) => {
            if (drag.current) {
              drag.current = null;
              event.currentTarget.releasePointerCapture(event.pointerId);
              void window.tandem.preferences({
                sidebarWidth: preferences.sidebarWidth,
              });
            }
          }}
          onPointerCancel={() => {
            drag.current = null;
          }}
        />
        <main className="main-area">
          <Conversation active={page === "assistant"} navigate={navigate} />
          {page !== "assistant" && (
            <div className="secondary-page">
              {(error || !status.connected) && (
                <div className="page-notice">
                  <Notice error>{error ?? status.status}</Notice>
                </div>
              )}
              {page === "settings" && (
                <Settings onDirty={onDirty} onBusy={onBusy} />
              )}
              {page === "projects" && (
                <Projects onDirty={onDirty} onBusy={onBusy} />
              )}
              {page === "activity" && <Activity onBusy={onBusy} />}
              {page === "memory" && (
                <Memory
                  onBusy={onBusy}
                  openSource={(session) => navigate("assistant", session)}
                />
              )}
            </div>
          )}
        </main>
      </div>
      {pending && (
        <Modal title="放弃未保存的修改？" onClose={() => setPending(undefined)}>
          <p>当前页面的修改尚未保存。</p>
          <div className="row end">
            <Button onClick={() => setPending(undefined)}>继续编辑</Button>
            <Button kind="danger" onClick={() => move(pending)}>
              放弃修改并离开
            </Button>
          </div>
        </Modal>
      )}
      {diagnostics && (
        <Modal title="运行状态" onClose={() => setDiagnostics(false)}>
          <dl className="diagnostic-values">
            <dt>连接</dt>
            <dd>{status.status}</dd>
            <dt>Node PID</dt>
            <dd>{status.nodePID || "—"}</dd>
            <dt>Ping/Pong</dt>
            <dd>{status.pongCount}</dd>
            <dt>连接次数</dt>
            <dd>{status.connectionCount}</dd>
            <dt>重启次数</dt>
            <dd>{status.restartCount}</dd>
          </dl>
          <div className="row">
            <Button onClick={() => void window.tandem.diagnostics("reconnect")}>
              断开重连
            </Button>
            <Button onClick={() => void window.tandem.diagnostics("crash")}>
              模拟 Runtime 崩溃
            </Button>
          </div>
          <pre className="host-logs">{status.logs.join("\n")}</pre>
        </Modal>
      )}
    </Tooltip.Provider>
  );
}
