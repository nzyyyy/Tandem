import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { ArrowUp, Plus, SlidersHorizontal, X } from "lucide-react";
import { useAssistant } from "../store.tsx";
import { modelId } from "../../shared/conversation.ts";
import { errorText } from "../../shared/errors.ts";
import { Button, Menu, MenuItem, Notice, Picker, Popup } from "../components/ui.tsx";
import { useAction } from "../components/actions.ts";

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
          ...(snapshot?.projects.filter((item) => item.status === "open") ?? []).map((item) => ({
            value: item.id,
            label: item.title,
          })),
        ]}
      />
      <p className="caption">当前：{summary}</p>
      {mode === "isolated" && <p className="caption">仅限所选项目 · 不加载全局记忆</p>}
      <Button
        kind="primary"
        disabled={
          busy ||
          !focus ||
          (mode === focus.contextMode && projectId === (focus.activeProjectId ?? ""))
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
export function Composer({ active }: { active: boolean }) {
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
  if (selectedModel && !options.some((option) => option.value === selectedModel))
    options.push({ value: selectedModel, label: "所选模型已失效" });
  return (
    <div className="composer-wrap">
      <div className="composer-notice">
        <Notice error>{error}</Notice>
        {!status.connected && <p className="caption">{status.status}</p>}
        {snapshot?.configError && <Notice error>{errorText(snapshot.configError)}</Notice>}
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
              onChange={(event) => store.set({ taskDeliverable: event.target.value })}
            />
            <textarea
              aria-label="完成标准"
              placeholder="完成标准，每行一条"
              rows={2}
              value={taskCriteria}
              onChange={(event) => store.set({ taskCriteria: event.target.value })}
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
            <MenuItem onSelect={() => store.set({ newTopic: true, temporary: false })}>
              新话题
            </MenuItem>
            <MenuItem onSelect={() => store.set({ newTopic: false, temporary: true })}>
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
            disabled={sending || !snapshot || !status.connected || !draft.trim()}
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
