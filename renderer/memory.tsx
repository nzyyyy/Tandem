import { useEffect, useState } from "react";
import { useAssistant, rpc } from "./store.tsx";
import {
  Button,
  Field,
  Header,
  Modal,
  Notice,
  Picker,
  Toggle,
} from "./components/ui.tsx";
import { useAction } from "./components/actions.ts";
import type { Payload } from "../shared/bridge.ts";

type MemoryRecord = {
  id: string;
  kind: string;
  subject: string;
  predicate: string;
  content: string;
  project_id: string | null;
  status: string;
  origin: string;
  confirmed_at: number | null;
  supersedes_id: string | null;
  rationale: string;
  version: number;
};
type Evidence = {
  message_id: string;
  session_id: string;
  interaction_version: number;
  current_version: number;
  valid: number;
  content: string;
};
type Marker = { id: string; scope: string; key_hash: string };
type MemoryList = { memories: MemoryRecord[]; markers: Marker[] };
const statusTitle = (value: string) =>
  ({
    active: "现行",
    candidate: "待确认 / 可能冲突",
    superseded: "历史版本",
    suspended: "证据停用，待核验",
  })[value] ?? value;
export function Memory({
  openSource,
  onBusy,
}: {
  openSource: (id: string) => void;
  onBusy: (value: boolean) => void;
}) {
  const { store, snapshot, messages } = useAssistant();
  const { busy, run } = useAction();
  const [list, setList] = useState<MemoryList>({ memories: [], markers: [] }),
    [query, setQuery] = useState(""),
    [selected, setSelected] = useState<MemoryRecord>(),
    [evidence, setEvidence] = useState<Evidence[]>([]),
    [edited, setEdited] = useState(""),
    [forget, setForget] = useState<MemoryRecord>(),
    [showSave, setShowSave] = useState(false);
  const [sourceId, setSource] = useState(""),
    [kind, setKind] = useState("fact"),
    [subject, setSubject] = useState("用户"),
    [predicate, setPredicate] = useState(""),
    [content, setContent] = useState(""),
    [confirmed, setConfirmed] = useState(false);
  const sources = messages.filter(
    (message) =>
      message.role === "user" &&
      message.interactionVersion != null &&
      (snapshot?.focus.contextMode === "automatic" ||
        (!!message.projectId &&
          message.projectId === snapshot?.focus.activeProjectId)),
  );
  const source = sources.find((message) => message.id === sourceId);
  const reload = async () =>
    setList(await rpc<MemoryList>("memory.list", { query }));
  useEffect(() => {
    let alive = true;
    void rpc<MemoryList>("memory.list", { query }).then(
      (value) => {
        if (alive) setList(value);
      },
      (error) => {
        if (alive) {
          setList({ memories: [], markers: [] });
          store.showError(error);
        }
      },
    );
    return () => {
      alive = false;
    };
  }, [snapshot?.cursor, snapshot?.focus.version, snapshot?.generation]);
  useEffect(() => {
    onBusy(busy);
  }, [busy, onBusy]);
  const action = async (method: string, payload: Payload) => {
    if (!(await store.perform(method, payload))) return false;
    await reload();
    return true;
  };
  const groups = [
    ...new Set(list.memories.map((record) => record.project_id ?? "")),
  ].sort();
  return (
    <section className="page">
      <Header title="长期记忆">
        <Button disabled={busy} onClick={() => setShowSave(true)}>
          从用户消息保存
        </Button>
        <Button disabled={busy} onClick={() => void run(reload)}>
          刷新
        </Button>
      </Header>
      <div className="page-scroll">
        <div className="page-content memory-content stack">
          <input
            aria-label="搜索事实、决策及历史"
            placeholder="搜索记忆"
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === "Enter" && !event.nativeEvent.isComposing)
                void run(reload);
            }}
          />
          {groups.map((scope) => (
            <section className="stack tight" key={scope}>
              <h3 className="caption">
                {scope ? store.projectTitle(scope) : "全局"}
              </h3>
              {list.memories
                .filter((record) => (record.project_id ?? "") === scope)
                .map((record) => (
                  <article className="record stack" key={record.id}>
                    <div className="row wrap">
                      <strong>
                        {record.kind === "decision" ? "决策" : "事实"}
                      </strong>
                      <span className="caption">
                        {statusTitle(record.status)}
                      </span>
                      <span className="spacer" />
                      <Button
                        disabled={busy}
                        onClick={() =>
                          void run(async () => {
                            const detail = await rpc<{ evidence: Evidence[] }>(
                              "memory.get",
                              { id: record.id },
                            );
                            setEvidence(detail.evidence);
                            setEdited(record.content);
                            setSelected(record);
                          })
                        }
                      >
                        证据与修正
                      </Button>
                      <Button
                        kind="danger"
                        disabled={busy}
                        onClick={() => setForget(record)}
                      >
                        遗忘
                      </Button>
                    </div>
                    <p>
                      {record.subject} · {record.predicate}：{record.content}
                    </p>
                    <p className="caption">
                      {record.confirmed_at
                        ? "已确认"
                        : record.origin === "user_statement"
                          ? "用户陈述 · 未确认"
                          : "用户消息 · 候选"}
                    </p>
                    {record.supersedes_id && (
                      <p className="caption">
                        替代版本：{record.supersedes_id}
                      </p>
                    )}
                  </article>
                ))}
            </section>
          ))}
          {!list.memories.length && <p className="caption">暂无匹配记忆</p>}
          {!!list.markers.length && (
            <>
              <hr />
              <h2>遗忘标记</h2>
              <p className="caption">
                标记只保留键摘要和原证据标识。允许重新记住后仍需重新提取及校验，不会恢复旧正文。
              </p>
              {list.markers.map((marker) => (
                <div className="row" key={marker.id}>
                  <span className="caption">
                    {store.projectTitle(marker.scope || null)} ·{" "}
                    {marker.key_hash.slice(0, 12)}
                  </span>
                  <span className="spacer" />
                  <Button
                    disabled={busy}
                    onClick={() =>
                      void run(() =>
                        action("memory.allow", {
                          id: marker.id,
                          confirm: true,
                        }),
                      )
                    }
                  >
                    允许重新记住
                  </Button>
                </div>
              ))}
            </>
          )}
        </div>
      </div>
      {selected && (
        <Modal
          title={`${selected.subject} · ${selected.predicate}`}
          busy={busy}
          onClose={() => setSelected(undefined)}
        >
          <p className="caption">
            {statusTitle(selected.status)} · {selected.rationale}
          </p>
          <div className="evidence-list stack">
            {evidence.map((item) => (
              <section className="stack" key={item.message_id}>
                <p className="prewrap">{item.content}</p>
                <p className="caption">
                  消息 {item.message_id} · 原版本 {item.interaction_version} /
                  当前 {item.current_version} ·{" "}
                  {item.valid === 1 ? "有效" : "归属已纠正，证据停用"}
                </p>
                <Button
                  onClick={() => {
                    setSelected(undefined);
                    openSource(item.session_id);
                  }}
                >
                  打开来源话题
                </Button>
                <hr />
              </section>
            ))}
          </div>
          <Field title="修正内容">
            <textarea
              value={edited}
              onChange={(event) => setEdited(event.target.value)}
              rows={3}
            />
          </Field>
          <p className="caption">
            确认或修正会创建带原始证据的新版本，不迁移已失效的证据，也不更改任务。
          </p>
          <Notice error>{store.state.error}</Notice>
          <div className="row end">
            <Button
              kind="primary"
              disabled={
                busy ||
                ["superseded", "suspended"].includes(selected.status) ||
                !edited.trim()
              }
              onClick={() =>
                void run(async () => {
                  if (
                    await action(
                      edited === selected.content
                        ? "memory.confirm"
                        : "memory.update",
                      {
                        id: selected.id,
                        expectedVersion: selected.version,
                        content: edited,
                        confirm: true,
                      },
                    )
                  )
                    setSelected(undefined);
                })
              }
            >
              {edited === selected.content ? "确认此版本" : "确认修正"}
            </Button>
          </div>
        </Modal>
      )}
      {forget && (
        <Modal
          title="遗忘这条记忆及其派生副本？"
          busy={busy}
          onClose={() => setForget(undefined)}
        >
          <p>
            原聊天仍保留；同一原证据不会自动重新生成此记忆。已有备份及云端副本不随本地删除改变。
          </p>
          <div className="row end">
            <Button disabled={busy} onClick={() => setForget(undefined)}>
              取消
            </Button>
            <Button
              kind="danger"
              disabled={busy}
              onClick={() =>
                void run(async () => {
                  if (
                    await action("memory.forget", {
                      id: forget.id,
                      expectedVersion: forget.version,
                    })
                  )
                    setForget(undefined);
                })
              }
            >
              遗忘
            </Button>
          </div>
        </Modal>
      )}
      {showSave && (
        <Modal
          title="从用户证据保存"
          busy={busy}
          onClose={() => setShowSave(false)}
        >
          <p className="caption">
            仅列出当前已加载的用户消息。请核对主体、属性、内容和原始证据。
          </p>
          <Picker
            label="用户消息"
            value={sourceId}
            onChange={setSource}
            options={[
              { value: "", label: "请选择用户消息" },
              ...sources.map((message) => ({
                value: message.id,
                label: message.content.slice(0, 80),
              })),
            ]}
          />
          {source && <p className="source-excerpt prewrap">{source.content}</p>}
          <Picker
            label="类型"
            value={kind}
            onChange={setKind}
            options={[
              { value: "fact", label: "事实" },
              { value: "decision", label: "决策" },
            ]}
          />
          <Field title="主体">
            <input
              value={subject}
              onChange={(event) => setSubject(event.target.value)}
              placeholder="用户、项目"
            />
          </Field>
          <Field title="属性">
            <input
              value={predicate}
              onChange={(event) => setPredicate(event.target.value)}
              placeholder="数据库、主要开发语言"
            />
          </Field>
          <Field title="内容">
            <textarea
              value={content}
              onChange={(event) => setContent(event.target.value)}
              rows={3}
            />
          </Field>
          <Toggle checked={confirmed} onChange={setConfirmed}>
            我已核验证据并明确确认此内容（可替代同键现行版本）
          </Toggle>
          <Notice error>{store.state.error}</Notice>
          <div className="row end">
            <Button
              kind="primary"
              disabled={
                busy ||
                !source ||
                !subject.trim() ||
                !predicate.trim() ||
                !content.trim()
              }
              onClick={() =>
                void run(async () => {
                  if (
                    source &&
                    (await action("memory.save", {
                      messageId: source.id,
                      expectedInteractionVersion: source.interactionVersion,
                      kind,
                      subject,
                      predicate,
                      content,
                      confirmed,
                    }))
                  ) {
                    setContent("");
                    setPredicate("");
                    setConfirmed(false);
                    setShowSave(false);
                  }
                })
              }
            >
              保存
            </Button>
          </div>
        </Modal>
      )}
    </section>
  );
}
