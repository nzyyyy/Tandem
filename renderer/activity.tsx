import { useEffect, useState } from "react";
import { useAssistant, rpc, unwrap } from "./store.tsx";
import type { PersistentTask, RunContext } from "../shared/model.ts";
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
    return [item.name, item.path, item.error, item.modelName]
      .filter(Boolean)
      .join(" · ");
  } catch {
    return value;
  }
}
function Revision({
  task,
  onClose,
}: {
  task: PersistentTask;
  onClose: () => void;
}) {
  const { store, selectedModel, error } = useAssistant();
  const { busy, run } = useAction();
  const [request, setRequest] = useState(""),
    [deliverable, setDeliverable] = useState(task.deliverable),
    [criteria, setCriteria] = useState(strings(task.criteria).join("\n")),
    [key] = useState(() => crypto.randomUUID());
  return (
    <Modal
      title={`修改任务 · 新建修订 ${task.revision + 1}`}
      busy={busy}
      onClose={onClose}
    >
      <p className="caption">
        旧执行停止派发；既有交付与完成依据保留，新修订重新核验。使用输入区当前选定模型或全局默认模型。
      </p>
      <Field title="修改要求">
        <textarea
          value={request}
          onChange={(event) => setRequest(event.target.value)}
          rows={2}
        />
      </Field>
      <Field title="预期交付物">
        <textarea
          value={deliverable}
          onChange={(event) => setDeliverable(event.target.value)}
          rows={2}
        />
      </Field>
      <Field title="完成标准（每行一条）">
        <textarea
          value={criteria}
          onChange={(event) => setCriteria(event.target.value)}
          rows={5}
        />
      </Field>
      <Notice error>{error}</Notice>
      <div className="row end">
        <Button
          kind="primary"
          disabled={
            busy || !request.trim() || !deliverable.trim() || !criteria.trim()
          }
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
                    criteria: criteria
                      .split("\n")
                      .filter((value) => value.trim()),
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
export function Activity({ onBusy }: { onBusy: (value: boolean) => void }) {
  const { store, snapshot } = useAssistant();
  const { busy, run } = useAction();
  const [result, setResult] = useState<string>(),
    [context, setContext] = useState<RunContext>(),
    [editing, setEditing] = useState<PersistentTask>();
  useEffect(() => {
    onBusy(busy);
  }, [busy, onBusy]);
  const openResult = (messageId: string) =>
    run(async () =>
      setResult(
        (await rpc<{ content: string }>("result.get", { messageId })).content,
      ),
    );
  return (
    <section className="page">
      <Header title="Activity">
        <Button
          disabled={busy}
          onClick={() =>
            void run(() =>
              store.authorize(snapshot?.focus.activeProjectId ?? null),
            )
          }
        >
          授权只读目录
        </Button>
      </Header>
      <div className="page-scroll">
        <div className="page-content stack spacious">
          <Approvals />
          <h2>授权目录</h2>
          <p className="caption">
            授权保留到应用退出，可随时撤销；重新启动后请主动重新选择目录。
          </p>
          {snapshot?.activity.grants.map((grant) => (
            <div className="row wrap" key={grant.id}>
              <strong>{grant.label}</strong>
              <span className="caption">
                {store.projectTitle(grant.project_id)}
              </span>
              <span className="spacer" />
              {grant.status === "active" ? (
                <Button
                  disabled={busy}
                  onClick={() =>
                    void run(async () => {
                      unwrap(await window.tandem.revokeDirectory(grant.id));
                      await store.refresh();
                    })
                  }
                >
                  撤销
                </Button>
              ) : (
                <Button
                  disabled={busy}
                  onClick={() =>
                    void run(() => store.authorize(grant.project_id, grant.id))
                  }
                >
                  重新选择同一目录
                </Button>
              )}
            </div>
          ))}
          <h2>持续任务</h2>
          {snapshot?.activity.tasks.map((task) => (
            <article className="record stack" key={task.id}>
              <div className="row">
                <h3>{task.deliverable}</h3>
                <span className="spacer" />
                <span className="caption">
                  修订 {task.revision} · {executionStatus(task.status)}
                </span>
              </div>
              <p className="caption">{store.projectTitle(task.project_id)}</p>
              {strings(task.criteria).map((criterion, index) => (
                <p key={index}>
                  {index + 1}. {criterion}
                </p>
              ))}
              {strings(task.evidence).map((evidence, index) => (
                <p key={index}>
                  完成依据 {index + 1}：{evidence}
                </p>
              ))}
              <div className="row wrap">
                {task.result_ref && (
                  <Button
                    disabled={busy}
                    onClick={() => void openResult(task.result_ref!)}
                  >
                    打开 Markdown 结果
                  </Button>
                )}
                <Button disabled={busy} onClick={() => setEditing(task)}>
                  修改任务
                </Button>
                <Button
                  disabled={busy}
                  onClick={() =>
                    void run(async () => {
                      const history = await rpc<{
                        revisions: {
                          revision: number;
                          deliverable: string;
                          status: string;
                          result_ref: string | null;
                        }[];
                      }>("task.history", { id: task.id });
                      const texts = [];
                      for (const revision of history.revisions) {
                        const content = revision.result_ref
                          ? (
                              await rpc<{ content: string }>("result.get", {
                                messageId: revision.result_ref,
                              })
                            ).content
                          : "尚无已完成交付物";
                        texts.push(
                          `## 修订 ${revision.revision} · ${executionStatus(revision.status)}\n${revision.deliverable}\n\n${content}`,
                        );
                      }
                      setResult(texts.join("\n\n"));
                    })
                  }
                >
                  查看历次交付
                </Button>
              </div>
            </article>
          ))}
          <h2>执行记录</h2>
          {snapshot?.activity.runs.map((item) => (
            <article className="record stack" key={item.id}>
              <div className="row wrap">
                <h3>{executionStatus(item.status)}</h3>
                <span className="caption">{item.modelName}</span>
                <span className="spacer" />
                <Button
                  disabled={busy}
                  onClick={() => void openResult(item.assistant_message_id)}
                >
                  查看当前输出
                </Button>
              </div>
              <p className="caption">{store.projectTitle(item.project_id)}</p>
              <p className="caption">
                步骤 {item.steps}/{item.step_limit} · Token {item.tokens}/
                {item.token_limit}
                {item.estimated === 1 ? "（含保守估算）" : ""} · 活跃时间{" "}
                {Math.floor(item.active_ms / 1000)}/
                {Math.floor(item.time_limit / 1000)} 秒
              </p>
              {item.error_code && (
                <p className="error">{errorText(item.error_code)}</p>
              )}
              <div className="row wrap">
                {["paused", "interrupted"].includes(item.status) && (
                  <Button
                    disabled={busy}
                    onClick={() => void run(() => store.continueRun(item))}
                  >
                    {item.pause_reason === "budget_exhausted"
                      ? "追加预算并继续"
                      : "继续"}
                  </Button>
                )}
                {item.pause_reason === "budget_exhausted" && (
                  <span className="caption">+24 步 / 64000 Token / 300 秒</span>
                )}
                {[
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
                {item.status === "failed" && (
                  <Button
                    disabled={busy}
                    onClick={() => void store.retry(item.id)}
                  >
                    重试
                  </Button>
                )}
              </div>
              <details>
                <summary>步骤与实际上下文</summary>
                <div className="stack">
                  {item.stepsDetail.map((step) => (
                    <div className="row" key={step.id}>
                      <p className="caption">
                        {executionStatus(step.status)} ·{" "}
                        {summary(step.detail) || step.kind}
                      </p>
                      <span className="spacer" />
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
            </article>
          ))}
        </div>
      </div>
      {result !== undefined && (
        <Modal
          title="执行结果与来源"
          onClose={() => setResult(undefined)}
          className="result-modal"
        >
          <div className="row end">
            <Button onClick={() => void window.tandem.copy(result)}>
              复制 Markdown
            </Button>
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
      {editing && (
        <Revision task={editing} onClose={() => setEditing(undefined)} />
      )}
    </section>
  );
}
