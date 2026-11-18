import { useEffect, useRef, useState } from "react";
import {
  ArrowLeft,
  ArrowRight,
  ChevronDown,
  ClipboardList,
  Folder,
  FolderPlus,
  ListTree,
  MessageSquare,
  ShieldAlert,
} from "lucide-react";
import { Tabs } from "radix-ui";
import { useAssistant, rpc, unwrap } from "./store.tsx";
import type { ActivityRun, PersistentTask, RunContext } from "../shared/model.ts";
import { modelSelection, executionStatus } from "../shared/conversation.ts";
import { errorText } from "../shared/errors.ts";
import { Button, Field, Header, Modal, Notice } from "./components/ui.tsx";
import { Markdown } from "./components/markdown.tsx";
import { useAction } from "./components/actions.ts";
import { Approvals } from "./components/approvals.tsx";
import { ContextFragments } from "./components/context-fragments.tsx";

function strings(value: string | null) {
  try {
    return JSON.parse(value ?? "[]") as string[];
  } catch {
    return [];
  }
}
function summary(value: string) {
  try {
    const item = JSON.parse(value);
    return [item.name, item.path, item.error, item.modelName].filter(Boolean).join(" · ");
  } catch {
    return value;
  }
}
function Revision({ task, onClose }: { task: PersistentTask; onClose: () => void }) {
  const { store, selectedModel, error } = useAssistant();
  const { busy, run } = useAction();
  const [request, setRequest] = useState(""),
    [deliverable, setDeliverable] = useState(task.deliverable),
    [criteria, setCriteria] = useState(strings(task.criteria).join("\n")),
    [key] = useState(() => crypto.randomUUID());
  return (
    <Modal title={`修改任务 · 新建修订 ${task.revision + 1}`} busy={busy} onClose={onClose}>
      <p className="caption">
        旧执行停止派发；既有交付与完成依据保留，新修订重新核验。使用输入区当前选定模型或全局默认模型。
      </p>
      <Field title="修改要求">
        <textarea value={request} onChange={(event) => setRequest(event.target.value)} rows={2} />
      </Field>
      <Field title="预期交付物">
        <textarea
          value={deliverable}
          onChange={(event) => setDeliverable(event.target.value)}
          rows={2}
        />
      </Field>
      <Field title="完成标准（每行一条）">
        <textarea value={criteria} onChange={(event) => setCriteria(event.target.value)} rows={5} />
      </Field>
      <Notice error>{error}</Notice>
      <div className="row end">
        <Button
          kind="primary"
          disabled={busy || !request.trim() || !deliverable.trim() || !criteria.trim()}
          onClick={() =>
            void run(async () => {
              if (
                await store.perform("message.send", {
                  text: request,
                  sessionId: task.session_id,
                  selection: modelSelection(selectedModel),
                  idempotencyKey: key,
                  task: {
                    id: task.id,
                    expectedRevision: task.revision,
                    deliverable,
                    criteria: criteria.split("\n").filter((value) => value.trim()),
                  },
                })
              )
                onClose();
            })
          }
        >
          保存修订并执行
        </Button>
      </div>
    </Modal>
  );
}
const tabs = [
  ["runs", "执行记录"],
  ["tasks", "持续任务"],
  ["grants", "目录权限"],
] as const;
const dateLabel = new Intl.DateTimeFormat("zh-CN", { dateStyle: "medium" });
const timeLabel = new Intl.DateTimeFormat("zh-CN", { hour: "2-digit", minute: "2-digit" });
const runTitle = (item: ActivityRun) =>
  item.title?.trim().replace(/\s+/g, " ") || (item.task_id ? "持续任务执行" : "对话执行");

function groupRuns(runs: ActivityRun[]) {
  const today = new Date().toDateString();
  const groups = new Map<string, ActivityRun[]>();
  for (const item of runs) {
    const day =
      new Date(item.created_at).toDateString() === today
        ? "今天"
        : dateLabel.format(item.created_at);
    const group = groups.get(day);
    if (group) group.push(item);
    else groups.set(day, [item]);
  }
  return [...groups];
}

function Status({ value }: { value: string }) {
  const label =
    value === "active" ? "已授权" : value === "reauthorize" ? "待重新授权" : executionStatus(value);
  return (
    <span className="activity-status" data-status={value}>
      {label}
    </span>
  );
}

function ActivityRow({
  icon: Icon,
  title,
  subtitle,
  status,
  timestamp,
  selected,
  onSelect,
}: {
  icon: typeof Folder;
  title: string;
  subtitle: string;
  status: string;
  timestamp?: number;
  selected: boolean;
  onSelect: () => void;
}) {
  return (
    <Button kind="plain" className="activity-row" aria-pressed={selected} onClick={onSelect}>
      <span className="activity-icon">
        <Icon size={15} aria-hidden="true" />
      </span>
      <span className="activity-row-text">
        <strong className="ellipsis" title={title}>
          {title}
        </strong>
        <span className="caption ellipsis">{subtitle}</span>
      </span>
      <span className="activity-row-end">
        <Status value={status} />
        {timestamp !== undefined && (
          <time className="caption" dateTime={new Date(timestamp).toISOString()}>
            {timeLabel.format(timestamp)}
          </time>
        )}
      </span>
    </Button>
  );
}

export function Activity({ onBusy }: { onBusy: (value: boolean) => void }) {
  const { store, snapshot } = useAssistant();
  const { busy, run } = useAction();
  const [tab, setTab] = useState("runs");
  const [selections, setSelections] = useState<Record<string, string>>({});
  const [approvalTarget, setApprovalTarget] = useState<string | null>();
  const [result, setResult] = useState<string>(),
    [context, setContext] = useState<RunContext>(),
    [editing, setEditing] = useState<PersistentTask>();
  const detailRef = useRef<HTMLElement>(null);
  const tabsRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    onBusy(busy);
  }, [busy, onBusy]);

  const { runs = [], tasks = [], grants = [], approvals = [] } = snapshot?.activity ?? {};
  const taskRun = (entry: PersistentTask) =>
    runs.find(
      (candidate) => candidate.task_id === entry.id && candidate.revision === entry.revision,
    );
  const task =
    tab === "tasks" ? (tasks.find((item) => item.id === selections.tasks) ?? tasks[0]) : undefined;
  const grant =
    tab === "grants"
      ? (grants.find((item) => item.id === selections.grants) ?? grants[0])
      : undefined;
  const item =
    tab === "runs"
      ? (runs.find((entry) => entry.id === selections.runs) ?? runs[0])
      : task && taskRun(task);
  const approvalRun = runs.find((entry) => entry.id === approvals[0]?.run_id);
  const approvalPanel =
    approvalTarget !== undefined &&
    approvals.some((approval) => approvalTarget === null || approval.run_id === approvalTarget);
  const taskStatus = (entry: PersistentTask) => {
    const latest = taskRun(entry);
    return entry.status === "open" && latest && latest.status !== "completed"
      ? latest.status
      : entry.status;
  };
  const focusDetail = () => requestAnimationFrame(() => detailRef.current?.focus());
  const select = (id: string) => {
    setSelections((previous) => ({ ...previous, [tab]: id }));
    setApprovalTarget(undefined);
    focusDetail();
  };
  const openApprovalPanel = (runId: string | null = null) => {
    setApprovalTarget(runId);
    focusDetail();
  };
  const openResult = (messageId: string) =>
    run(async () =>
      setResult((await rpc<{ content: string }>("result.get", { messageId })).content),
    );
  const openTaskHistory = (task: PersistentTask) =>
    run(async () => {
      const { revisions } = await rpc<{
        revisions: Pick<PersistentTask, "revision" | "deliverable" | "status" | "result_ref">[];
      }>("task.history", { id: task.id });
      const texts = [];
      for (const revision of revisions) {
        const content = revision.result_ref
          ? (await rpc<{ content: string }>("result.get", { messageId: revision.result_ref }))
              .content
          : "尚无已完成交付物";
        texts.push(
          `## 修订 ${revision.revision} · ${executionStatus(revision.status)}\n${revision.deliverable}\n\n${content}`,
        );
      }
      setResult(texts.join("\n\n"));
    });
  const resultId = task?.result_ref ?? item?.assistant_message_id;
  const output =
    resultId === item?.assistant_message_id
      ? item?.output_preview
      : runs.find((entry) => entry.assistant_message_id === resultId)?.output_preview;
  const waiting = item && approvals.some((approval) => approval.run_id === item.id);
  const directoryStatus = (status: string) => (status === "active" ? status : "reauthorize");

  return (
    <section className="page activity-page">
      <Header title="活动" />
      <div className="page-scroll">
        <div className="page-content activity-content">
          {approvals.length > 0 && (
            <section className="activity-attention" aria-label="待处理的审批">
              <span className="activity-icon">
                <ShieldAlert size={17} aria-hidden="true" />
              </span>
              <div className="activity-attention-copy">
                <h2 className="ellipsis" title={approvalRun && runTitle(approvalRun)}>
                  {approvals.length === 1 && approvalRun
                    ? `等待目录审批 · ${runTitle(approvalRun)}`
                    : `${approvals.length} 项目录审批待处理`}
                </h2>
                <p className="caption">选择允许读取的目录后，助手即可继续。</p>
              </div>
              <Button onClick={() => openApprovalPanel()}>
                处理审批
                <ArrowRight size={14} aria-hidden="true" />
              </Button>
            </section>
          )}
          <Tabs.Root
            value={tab}
            onValueChange={(value) => {
              setTab(value);
              setApprovalTarget(undefined);
            }}
          >
            <Tabs.List className="activity-tabs" aria-label="活动分类" ref={tabsRef}>
              {tabs.map(([value, label]) => (
                <Tabs.Trigger key={value} value={value}>
                  {label}
                </Tabs.Trigger>
              ))}
            </Tabs.List>

            <div className="activity-layout">
              <Tabs.Content value="runs" className="activity-list stack tight">
                {groupRuns(runs).map(([day, entries]) => (
                  <section className="stack tight" aria-label={day} key={day}>
                    <h2 className="activity-date caption">{day}</h2>
                    {entries.map((entry) => (
                      <ActivityRow
                        key={entry.id}
                        icon={entry.task_id ? ClipboardList : MessageSquare}
                        title={runTitle(entry)}
                        subtitle={`${store.projectTitle(entry.project_id)} · ${entry.task_id ? "持续任务" : "对话"}`}
                        status={entry.status}
                        timestamp={entry.created_at}
                        selected={!approvalPanel && item?.id === entry.id}
                        onSelect={() => select(entry.id)}
                      />
                    ))}
                  </section>
                ))}
                {runs.length === 0 && (
                  <p className="activity-empty caption">
                    {snapshot
                      ? "暂无执行记录。发送消息后可在这里查看执行进度和结果。"
                      : "正在加载活动…"}
                  </p>
                )}
              </Tabs.Content>
              <Tabs.Content value="tasks" className="activity-list stack tight">
                {tasks.map((entry) => (
                  <ActivityRow
                    key={entry.id}
                    icon={ClipboardList}
                    title={entry.deliverable}
                    subtitle={`${store.projectTitle(entry.project_id)} · 修订 ${entry.revision}`}
                    status={taskStatus(entry)}
                    timestamp={entry.created_at}
                    selected={!approvalPanel && task?.id === entry.id}
                    onSelect={() => select(entry.id)}
                  />
                ))}
                {tasks.length === 0 && (
                  <p className="activity-empty caption">
                    暂无持续任务。可在对话输入框的「＋」菜单中开启。
                  </p>
                )}
              </Tabs.Content>
              <Tabs.Content value="grants" className="activity-list stack tight">
                {grants.map((entry) => (
                  <ActivityRow
                    key={entry.id}
                    icon={Folder}
                    title={entry.label}
                    subtitle={`${store.projectTitle(entry.project_id)} · 只读`}
                    status={directoryStatus(entry.status)}
                    selected={!approvalPanel && grant?.id === entry.id}
                    onSelect={() => select(entry.id)}
                  />
                ))}
                {grants.length === 0 && <p className="activity-empty caption">暂无授权目录。</p>}
                <Button
                  className="activity-add-directory"
                  disabled={busy}
                  onClick={() =>
                    void run(() => store.authorize(snapshot?.focus.activeProjectId ?? null))
                  }
                >
                  <FolderPlus size={15} aria-hidden="true" />
                  授权只读目录
                </Button>
              </Tabs.Content>

              {(approvalPanel || item || task || grant) && (
                <aside
                  className="activity-detail stack"
                  aria-label="活动详情"
                  ref={detailRef}
                  tabIndex={-1}
                >
                  <Button
                    kind="plain"
                    className={approvalPanel ? "activity-link" : "activity-back"}
                    onClick={() => {
                      setApprovalTarget(undefined);
                      tabsRef.current
                        ?.querySelector<HTMLButtonElement>('[aria-selected="true"]')
                        ?.focus();
                    }}
                  >
                    <ArrowLeft size={14} aria-hidden="true" />
                    返回列表
                  </Button>
                  {approvalPanel ? (
                    <>
                      <h2>目录审批</h2>
                      <Approvals runId={approvalTarget ?? undefined} />
                    </>
                  ) : grant ? (
                    <>
                      <div className="stack tight">
                        <p className="row caption">
                          <Folder size={15} aria-hidden="true" />
                          只读目录
                        </p>
                        <h2>{grant.label}</h2>
                        <div className="row wrap caption">
                          <Status value={directoryStatus(grant.status)} />
                          {store.projectTitle(grant.project_id)}
                        </div>
                      </div>
                      <div className="activity-output stack tight">
                        <h3>{grant.status === "active" ? "当前权限" : "上次授权已结束"}</h3>
                        <p className="caption">
                          授权保留到应用退出，可随时撤销。重启后可重新选择同一目录恢复授权。
                        </p>
                      </div>
                      <Button
                        disabled={busy}
                        onClick={() =>
                          void run(async () => {
                            if (grant.status === "active") {
                              unwrap(await window.tandem.revokeDirectory(grant.id));
                              await store.refresh();
                            } else {
                              await store.authorize(grant.project_id, grant.id);
                            }
                          })
                        }
                      >
                        {grant.status === "active" ? "撤销" : "重新选择同一目录"}
                      </Button>
                    </>
                  ) : (
                    <div className="stack activity-run-detail" key={task?.id ?? item?.id}>
                      <div className="stack tight">
                        <p className="row caption">
                          {task || item?.task_id ? (
                            <ClipboardList size={15} aria-hidden="true" />
                          ) : (
                            <MessageSquare size={15} aria-hidden="true" />
                          )}
                          {task
                            ? `持续任务 · 修订 ${task.revision}`
                            : item?.task_id
                              ? "持续任务执行"
                              : "对话执行"}
                        </p>
                        <h2>{task ? task.deliverable : item && runTitle(item)}</h2>
                        <div className="row wrap caption">
                          <Status value={task ? taskStatus(task) : item!.status} />
                          {store.projectTitle(task ? task.project_id : item?.project_id)}
                          {item && (
                            <time dateTime={new Date(item.created_at).toISOString()}>
                              {dateLabel.format(item.created_at)}{" "}
                              {timeLabel.format(item.created_at)}
                            </time>
                          )}
                        </div>
                      </div>
                      {resultId && (
                        <div className="activity-output stack tight">
                          <h3>输出预览</h3>
                          <p className="caption prewrap activity-excerpt">
                            {output?.trim() || "暂无可预览的输出。"}
                          </p>
                          <Button
                            kind="plain"
                            className="activity-link"
                            disabled={busy}
                            onClick={() => void openResult(resultId)}
                          >
                            {task?.result_ref
                              ? "打开 Markdown 结果"
                              : item?.status === "completed"
                                ? "查看完整输出"
                                : "查看当前输出"}
                            <ArrowRight size={14} aria-hidden="true" />
                          </Button>
                        </div>
                      )}
                      {item?.error_code && <p className="error">{errorText(item.error_code)}</p>}
                      {(waiting ||
                        (item &&
                          [
                            "queued",
                            "running",
                            "paused",
                            "waiting_approval",
                            "interrupted",
                            "failed",
                          ].includes(item.status))) && (
                        <div className="row wrap">
                          {waiting && (
                            <Button disabled={busy} onClick={() => openApprovalPanel(item?.id)}>
                              处理审批
                            </Button>
                          )}
                          {item && ["paused", "interrupted"].includes(item.status) && (
                            <Button
                              disabled={busy}
                              onClick={() => void run(() => store.continueRun(item))}
                            >
                              {item.pause_reason === "budget_exhausted" ? "追加预算并继续" : "继续"}
                            </Button>
                          )}
                          {item?.pause_reason === "budget_exhausted" && (
                            <span className="caption">+24 步 / 64000 Token / 300 秒</span>
                          )}
                          {item &&
                            [
                              "queued",
                              "running",
                              "paused",
                              "waiting_approval",
                              "interrupted",
                            ].includes(item.status) && (
                              <Button
                                disabled={busy}
                                onClick={() =>
                                  void run(() =>
                                    store.perform("message.cancel", { runId: item.id }),
                                  )
                                }
                              >
                                取消执行
                              </Button>
                            )}
                          {item?.status === "failed" && (
                            <Button disabled={busy} onClick={() => void store.retry(item.id)}>
                              重试
                            </Button>
                          )}
                        </div>
                      )}
                      {task && (
                        <section className="stack tight">
                          <h3>完成标准</h3>
                          <ol className="activity-criteria">
                            {strings(task.criteria).map((criterion, index) => (
                              <li key={index}>{criterion}</li>
                            ))}
                          </ol>
                          {strings(task.evidence).map((evidence, index) => (
                            <p key={index} className="caption">
                              完成依据 {index + 1} · {evidence}
                            </p>
                          ))}
                          <div className="row wrap">
                            <Button disabled={busy} onClick={() => setEditing(task)}>
                              修改任务
                            </Button>
                            <Button disabled={busy} onClick={() => void openTaskHistory(task)}>
                              查看历次交付
                            </Button>
                          </div>
                        </section>
                      )}
                      {item && (
                        <>
                          <dl className="activity-facts caption">
                            <dt>模型</dt>
                            <dd>{item.modelName}</dd>
                            <dt>活跃时间</dt>
                            <dd>{Math.floor(item.active_ms / 1000)} 秒</dd>
                          </dl>
                          <details className="activity-trace">
                            <summary className="row">
                              <ListTree size={15} aria-hidden="true" />
                              步骤、来源与用量
                              <span className="spacer" />
                              <ChevronDown size={15} aria-hidden="true" />
                            </summary>
                            <div className="stack tight">
                              <p className="caption">
                                步骤 {item.steps}/{item.step_limit} · Token {item.tokens}/
                                {item.token_limit}
                                {item.estimated === 1 ? "（含保守估算）" : ""}
                              </p>
                              <p className="caption">
                                活跃时间 {Math.floor(item.active_ms / 1000)}/
                                {Math.floor(item.time_limit / 1000)} 秒
                              </p>
                              {item.stepsDetail.map((step) => (
                                <div className="row wrap" key={step.id}>
                                  <p className="caption">
                                    {executionStatus(step.status)} ·{" "}
                                    {summary(step.detail) || step.kind}
                                  </p>
                                  {step.snapshot_id && (
                                    <Button
                                      disabled={busy}
                                      onClick={() =>
                                        void run(async () =>
                                          setContext(
                                            await rpc<RunContext>("snapshot.get", {
                                              id: step.snapshot_id,
                                            }),
                                          ),
                                        )
                                      }
                                    >
                                      上下文
                                    </Button>
                                  )}
                                </div>
                              ))}
                            </div>
                          </details>
                        </>
                      )}
                    </div>
                  )}
                </aside>
              )}
            </div>
          </Tabs.Root>
        </div>
      </div>
      {result !== undefined && (
        <Modal title="执行结果与来源" onClose={() => setResult(undefined)} className="result-modal">
          <div className="row end">
            <Button onClick={() => void window.tandem.copy(result)}>复制 Markdown</Button>
          </div>
          <div className="result-scroll">
            <Markdown source={result} />
          </div>
        </Modal>
      )}
      {context && (
        <Modal title="实际执行上下文" onClose={() => setContext(undefined)}>
          <p className="caption">
            {store.projectTitle(context.projectId)} · {context.mode}
          </p>
          <div className="result-scroll">
            <ContextFragments context={context} />
          </div>
        </Modal>
      )}
      {editing && <Revision task={editing} onClose={() => setEditing(undefined)} />}
    </section>
  );
}
