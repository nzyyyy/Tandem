import { useEffect, useState } from "react";
import { Archive, Folder, Plus } from "lucide-react";
import { useAssistant, rpc } from "./store.tsx";
import type { ProjectDeletion, TandemProject } from "../shared/model.ts";
import {
  Button,
  Field,
  Header,
  Modal,
  Picker,
  SelectionRow,
  Toggle,
} from "./components/ui.tsx";
import { useAction } from "./components/actions.ts";

export function Projects({
  onDirty,
  onBusy,
}: {
  onDirty: (value: boolean) => void;
  onBusy: (value: boolean) => void;
}) {
  const { store, snapshot } = useAssistant();
  const { busy, run } = useAction();
  const [selection, setSelection] = useState(""),
    [title, setTitle] = useState(""),
    [description, setDescription] = useState(""),
    [saved, setSaved] = useState({ title: "", description: "", version: 0 }),
    [archived, setArchived] = useState(false),
    [pending, setPending] = useState<string>(),
    [preview, setPreview] = useState<ProjectDeletion>();
  const dirty = title !== saved.title || description !== saved.description;
  const project = snapshot?.projects.find((item) => item.id === selection),
    projects =
      snapshot?.projects.filter((item) => archived || item.status === "open") ??
      [];
  useEffect(() => {
    onDirty(dirty);
  }, [dirty, onDirty]);
  useEffect(() => {
    onBusy(busy);
  }, [busy, onBusy]);
  function select(id: string, discard = false) {
    if (dirty && !discard) {
      setPending(id);
      return;
    }
    const item = store.state.snapshot?.projects.find(
      (project) => project.id === id,
    );
    setSelection(id);
    setTitle(item?.title ?? "");
    setDescription(item?.description ?? "");
    setSaved({
      title: item?.title ?? "",
      description: item?.description ?? "",
      version: item?.version ?? 0,
    });
    setPreview(undefined);
    setPending(undefined);
  }
  const save = (status: string) =>
    run(async () => {
      const ok = await store.perform(
        project ? "project.update" : "project.create",
        {
          ...(project
            ? { id: project.id, expectedVersion: saved.version, status }
            : {}),
          title,
          description,
        },
      );
      if (ok) {
        if (project) {
          const updated = store.state.snapshot?.projects.find(
            (item) => item.id === project.id,
          );
          setSaved({
            title,
            description,
            version: updated?.version ?? saved.version + 1,
          });
        } else select("", true);
        setPreview(undefined);
        if (status === "archived") setArchived(true);
      }
    });
  return (
    <section className="page">
      <Header title="项目">
        <Button disabled={busy || !selection} onClick={() => select("")}>
          <Plus size={14} />
          新建项目
        </Button>
      </Header>
      <div className="page-scroll">
        <div className="page-content">
          <fieldset className="master-detail" disabled={busy}>
            <div className="master stack">
              <div className="row caption">
                <strong>{archived ? "全部项目" : "进行中"}</strong>
                <span className="spacer" />
                {projects.length} 个项目
              </div>
              {projects.map((item) => (
                <SelectionRow
                  key={item.id}
                  selected={item.id === selection}
                  onClick={() => select(item.id)}
                >
                  {item.status === "archived" ? (
                    <Archive size={16} />
                  ) : (
                    <Folder size={16} />
                  )}
                  <span>
                    {item.title}
                    {item.status === "archived" && <small>已归档</small>}
                  </span>
                </SelectionRow>
              ))}
              {!projects.length && <p className="caption">暂无项目</p>}
              <hr />
              <Toggle checked={archived} onChange={setArchived}>
                显示归档项目
              </Toggle>
            </div>
            <div className="compact-selector stack">
              <Picker
                label="选择项目"
                value={selection}
                onChange={select}
                options={[
                  { value: "", label: "创建新项目" },
                  ...(snapshot?.projects ?? []).map((item) => ({
                    value: item.id,
                    label: `${item.title}${item.status === "archived" ? "（已归档）" : ""}`,
                  })),
                ]}
              />
              <Toggle checked={archived} onChange={setArchived}>
                显示归档项目
              </Toggle>
            </div>
            <div className="editor stack spacious">
              <div className="row">
                <h2 className="ellipsis">{project?.title ?? "新建项目"}</h2>
                <span className="spacer" />
                <Button
                  kind="primary"
                  disabled={!title.trim()}
                  onClick={() => void save(project?.status ?? "open")}
                >
                  {project ? "保存修改" : "创建项目"}
                </Button>
              </div>
              <Field title="项目名称">
                <input
                  value={title}
                  onChange={(event) => setTitle(event.target.value)}
                  placeholder="名称"
                />
              </Field>
              <Field title="目标或说明">
                <textarea
                  value={description}
                  rows={5}
                  onChange={(event) => setDescription(event.target.value)}
                  placeholder="目标或背景"
                />
              </Field>
              {(dirty || project?.status === "archived") && (
                <p className="caption">
                  {project?.status === "archived" ? "已归档 · " : ""}
                  {dirty ? "未保存" : ""}
                </p>
              )}
              {project && (
                <>
                  <hr />
                  <div className="stack">
                    <Button
                      onClick={() =>
                        void save(
                          project.status === "archived" ? "open" : "archived",
                        )
                      }
                    >
                      {project.status === "archived" ? "恢复项目" : "归档项目"}
                    </Button>
                    <Button
                      kind="danger"
                      onClick={() =>
                        void run(async () =>
                          setPreview(
                            await rpc<ProjectDeletion>(
                              "project.deletePreview",
                              { id: project.id },
                            ),
                          ),
                        )
                      }
                    >
                      预览永久删除…
                    </Button>
                  </div>
                </>
              )}
              {preview && (
                <section className="card stack">
                  <h3>永久删除「{preview.title}」</h3>
                  <p>
                    将删除 {preview.interactions.length} 次交互、
                    {preview.messages.length} 条消息及 {preview.runs.length}{" "}
                    次执行；{preview.sharedSnapshots.length}{" "}
                    份快照含相关引用，将清理对应片段和{" "}
                    {preview.derivedMessages.length} 条派生回答内容。
                  </p>
                  <p>
                    将影响 {new Set(preview.tasks.map((item) => item.id)).size}{" "}
                    个任务，清理 {preview.memories.length}{" "}
                    条关联记忆、证据与派生副本。
                  </p>
                  <p className="caption">
                    此操作无法撤销。共享会话中的其他交互保留，外部文件不受影响。归属已纠正但实际使用过本项目上下文的交互也在清理范围内。已有遗忘标记继续保留；迁移保护副本、云端留存及
                    SQLite WAL 不承诺物理擦除。
                  </p>
                  <div className="row">
                    <Button
                      kind="danger"
                      onClick={() =>
                        void run(async () => {
                          if (
                            await store.perform("project.delete", {
                              token: preview.token,
                              confirm: true,
                            })
                          )
                            select("", true);
                        })
                      }
                    >
                      确认永久删除
                    </Button>
                    <Button onClick={() => setPreview(undefined)}>取消</Button>
                  </div>
                </section>
              )}
            </div>
          </fieldset>
        </div>
      </div>
      {pending !== undefined && (
        <Modal
          title="放弃当前项目的修改？"
          busy={busy}
          onClose={() => setPending(undefined)}
        >
          <p>当前项目的修改尚未保存。</p>
          <div className="row end">
            <Button onClick={() => setPending(undefined)}>继续编辑</Button>
            <Button
              kind="danger"
              disabled={busy}
              onClick={() => select(pending, true)}
            >
              放弃修改并切换
            </Button>
          </div>
        </Modal>
      )}
    </section>
  );
}
