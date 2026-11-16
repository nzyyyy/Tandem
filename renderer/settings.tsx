import { useEffect, useState } from "react";
import { Globe, MinusCircle, Plus, RotateCw } from "lucide-react";
import type {
  AppConfiguration,
  ConfigDocument,
  ModelConnection,
  RestorePreview,
} from "../shared/model.ts";
import { modelId, modelSelection } from "../shared/conversation.ts";
import { rpc, unwrap, useAssistant } from "./store.tsx";
import {
  Button,
  Field,
  Header,
  IconButton,
  Modal,
  Notice,
  Picker,
  SelectionRow,
} from "./components/ui.tsx";
import { useAction } from "./components/actions.ts";

const emptyConfig = (): AppConfiguration => ({
  schemaVersion: 1,
  modelConnections: [],
  defaultModel: null,
});
export const providerName = (connection: ModelConnection) =>
  (connection.name != null ? connection.name.trim() || "未命名供应商" : undefined) ||
  (() => {
    try {
      return new URL(connection.url).hostname;
    } catch {
      return "未命名供应商";
    }
  })();
export function modelAdditionError(value: string, names: string[]) {
  const name = value.trim();
  if (!name) return "请输入模型名。";
  if (name.length > 256 || /[\x00-\x1f\x7f]/.test(name))
    return "模型名不能超过 256 个字符或包含控制字符。";
  if (names.includes(name)) return "该模型已添加。";
  if (names.length >= 20) return "每个供应商最多添加 20 个模型。";
  return null;
}
export function Settings({
  onDirty,
  onBusy,
}: {
  onDirty: (value: boolean) => void;
  onBusy: (value: boolean) => void;
}) {
  const { store, snapshot } = useAssistant();
  const { busy, run } = useAction();
  const [config, setConfig] = useState(emptyConfig),
    [saved, setSaved] = useState(emptyConfig),
    [revision, setRevision] = useState<string>(),
    [selected, setSelected] = useState(""),
    [drafts, setDrafts] = useState<Record<string, string>>({}),
    [notice, setNotice] = useState(""),
    [confirmReload, setConfirmReload] = useState(false),
    [preview, setPreview] = useState<RestorePreview>();
  const hasDrafts = Object.values(drafts).some((value) => value.trim()),
    dirty = JSON.stringify(config) !== JSON.stringify(saved) || hasDrafts;
  useEffect(() => {
    onDirty(dirty);
  }, [dirty, onDirty]);
  useEffect(() => {
    onBusy(busy);
  }, [busy, onBusy]);
  const load = async () => {
    const document = await rpc<ConfigDocument>("config.get");
    setConfig(document.config);
    setSaved(document.config);
    setRevision(document.revision);
    setDrafts({});
    setNotice("");
    setSelected((previous) =>
      document.config.modelConnections.some((connection) => connection.id === previous)
        ? previous
        : (document.config.modelConnections[0]?.id ?? ""),
    );
  };
  useEffect(() => {
    void run(load);
  }, []);
  const [generation, setGeneration] = useState(snapshot?.generation);
  useEffect(() => {
    if (snapshot?.generation !== generation) {
      setGeneration(snapshot?.generation);
      setPreview(undefined);
      if (!dirty) void run(load);
      else setNotice("数据已恢复，当前编辑尚未保存，请重新加载后核对。");
    }
  }, [snapshot?.generation]);
  useEffect(
    () => () => {
      if (preview) void rpc("backup.cancel", { token: preview.token }).catch(() => {});
    },
    [preview?.token],
  );
  const current = config.modelConnections.find((connection) => connection.id === selected);
  const update = (patch: Partial<ModelConnection>) =>
    setConfig((value) => ({
      ...value,
      modelConnections: value.modelConnections.map((connection) =>
        connection.id === selected ? { ...connection, ...patch } : connection,
      ),
    }));
  const removeModel = (name: string) =>
    setConfig((value) => ({
      ...value,
      defaultModel:
        value.defaultModel?.connectionId === selected && value.defaultModel.modelName === name
          ? null
          : value.defaultModel,
      modelConnections: value.modelConnections.map((connection) =>
        connection.id === selected
          ? {
              ...connection,
              modelNames: connection.modelNames.filter((model) => model !== name),
            }
          : connection,
      ),
    }));
  const addModel = () => {
    if (current && !modelAdditionError(drafts[selected] ?? "", current.modelNames)) {
      update({ modelNames: [...current.modelNames, drafts[selected]!.trim()] });
      setDrafts((value) => ({ ...value, [selected]: "" }));
    }
  };
  const save = () =>
    run(async () => {
      const document = await rpc<ConfigDocument>("config.save", {
        config,
        expectedRevision: revision,
      });
      setConfig(document.config);
      setSaved(document.config);
      setRevision(document.revision);
      setNotice("已保存。");
      await store.refresh();
    });
  return (
    <section className="page">
      <Header title="模型设置">
        {dirty && <span className="caption">未保存</span>}
        <IconButton
          label="重新加载"
          disabled={busy}
          onClick={() => (dirty ? setConfirmReload(true) : void run(load))}
        >
          <RotateCw size={16} />
        </IconButton>
        <Button
          kind="primary"
          disabled={busy || !revision || hasDrafts}
          onClick={() => void save()}
        >
          保存配置
        </Button>
      </Header>
      <div className="page-scroll">
        <div className="page-content stack spacious">
          <fieldset disabled={busy} className="stack spacious">
            <Field title="全局默认模型">
              <Picker
                label="全局默认模型"
                value={modelId(config.defaultModel)}
                onChange={(value) =>
                  setConfig((previous) => ({
                    ...previous,
                    defaultModel: modelSelection(value),
                  }))
                }
                disabled={!revision}
                options={[
                  { value: "", label: "未设置" },
                  ...config.modelConnections.flatMap((connection) =>
                    connection.modelNames.map((name) => ({
                      value: modelId({
                        connectionId: connection.id,
                        modelName: name,
                      }),
                      label: `${name} · ${providerName(connection)}`,
                    })),
                  ),
                ]}
                className="default-model-picker"
              />
            </Field>
            <div className="row">
              <h2>模型供应商</h2>
              <span className="spacer" />
              <Button
                disabled={!revision}
                onClick={() => {
                  const connection: ModelConnection = {
                    id: crypto.randomUUID(),
                    name: "",
                    protocol: "openai",
                    apiType: "chat_completions",
                    url: "https://api.openai.com/v1",
                    key: "",
                    modelNames: [],
                  };
                  setConfig((value) => ({
                    ...value,
                    modelConnections: [...value.modelConnections, connection],
                  }));
                  setSelected(connection.id);
                }}
              >
                <Plus size={14} />
                添加供应商
              </Button>
            </div>
            {!config.modelConnections.length ? (
              <section className="card">还没有供应商</section>
            ) : (
              <div className="master-detail">
                <div className="master stack tight">
                  {config.modelConnections.map((connection) => (
                    <SelectionRow
                      key={connection.id}
                      selected={selected === connection.id}
                      onClick={() => setSelected(connection.id)}
                    >
                      <Globe size={16} />
                      <span>
                        {providerName(connection)}
                        <small>
                          {connection.protocol === "anthropic" ? "Anthropic 兼容" : "OpenAI 兼容"}
                        </small>
                      </span>
                    </SelectionRow>
                  ))}
                </div>
                <div className="compact-selector">
                  <Picker
                    label="模型供应商"
                    value={selected}
                    onChange={setSelected}
                    options={config.modelConnections.map((connection) => ({
                      value: connection.id,
                      label: providerName(connection),
                    }))}
                  />
                </div>
                {current && (
                  <div className="editor stack spacious">
                    <h2>{providerName(current)}</h2>
                    <Field title="供应商名称">
                      <input
                        aria-label="供应商名称"
                        value={current.name ?? providerName(current)}
                        placeholder="例如 OpenAI、我的模型服务"
                        onChange={(event) => update({ name: event.target.value })}
                      />
                    </Field>
                    <div className="form-columns">
                      <Field title="协议">
                        <Picker
                          label="协议"
                          value={current.protocol}
                          options={[
                            { value: "openai", label: "OpenAI 兼容" },
                            { value: "anthropic", label: "Anthropic 兼容" },
                          ]}
                          onChange={(protocol) =>
                            update({
                              protocol,
                              apiType: protocol === "anthropic" ? "messages" : "chat_completions",
                              url:
                                protocol === "anthropic" &&
                                current.url === "https://api.openai.com/v1"
                                  ? "https://api.anthropic.com/v1"
                                  : protocol === "openai" &&
                                      current.url === "https://api.anthropic.com/v1"
                                    ? "https://api.openai.com/v1"
                                    : current.url,
                            })
                          }
                        />
                      </Field>
                      <Field title="API 类型">
                        <Picker
                          label="API 类型"
                          value={current.apiType}
                          onChange={(apiType) => update({ apiType })}
                          options={
                            current.protocol === "anthropic"
                              ? [{ value: "messages", label: "Messages" }]
                              : [
                                  {
                                    value: "chat_completions",
                                    label: "Chat Completions",
                                  },
                                  { value: "responses", label: "Responses" },
                                ]
                          }
                        />
                      </Field>
                    </div>
                    <Field title="API Base URL">
                      <input
                        aria-label="API Base URL"
                        value={current.url}
                        onChange={(event) => update({ url: event.target.value })}
                        placeholder="https://api.example.com/v1"
                      />
                    </Field>
                    <Field title="API Key">
                      <input
                        type="password"
                        autoComplete="off"
                        aria-label="API Key"
                        value={current.key}
                        onChange={(event) => update({ key: event.target.value })}
                        placeholder="输入 API Key"
                      />
                    </Field>
                    <Field title={`模型（${current.modelNames.length}/20）`}>
                      <div className="model-list">
                        {current.modelNames.map((name) => (
                          <div className="row" key={name}>
                            <span>{name}</span>
                            <span className="spacer" />
                            <IconButton
                              label={`移除模型 ${name}`}
                              onClick={() => removeModel(name)}
                            >
                              <MinusCircle size={16} />
                            </IconButton>
                          </div>
                        ))}
                      </div>
                      <div className="row">
                        <input
                          aria-label="新模型名称"
                          value={drafts[selected] ?? ""}
                          onChange={(event) =>
                            setDrafts((value) => ({
                              ...value,
                              [selected]: event.target.value,
                            }))
                          }
                          onKeyDown={(event) => {
                            if (event.key === "Enter" && !event.nativeEvent.isComposing) addModel();
                          }}
                          placeholder="输入模型名，例如 model-a"
                        />
                        <Button
                          disabled={
                            !!modelAdditionError(drafts[selected] ?? "", current.modelNames)
                          }
                          onClick={addModel}
                        >
                          <Plus size={14} />
                          添加
                        </Button>
                      </div>
                      {drafts[selected] && (
                        <p className="caption">
                          {modelAdditionError(drafts[selected]!, current.modelNames) ??
                            "模型尚未添加"}
                        </p>
                      )}
                    </Field>
                    <Button
                      kind="danger"
                      onClick={() => {
                        setConfig((value) => ({
                          ...value,
                          modelConnections: value.modelConnections.filter(
                            (connection) => connection.id !== selected,
                          ),
                          defaultModel:
                            value.defaultModel?.connectionId === selected
                              ? null
                              : value.defaultModel,
                        }));
                        setDrafts((value) => {
                          const next = { ...value };
                          delete next[selected];
                          return next;
                        });
                        setSelected(
                          config.modelConnections.find((connection) => connection.id !== selected)
                            ?.id ?? "",
                        );
                      }}
                    >
                      移除此供应商
                    </Button>
                  </div>
                )}
              </div>
            )}
            <Notice>{notice}</Notice>
            <p className="caption prewrap">
              本机明文存储{"\n"}
              <span className="monospace">~/.tandem/config.json</span>
              {"\n"}API Key 正常退出后保留，不写入聊天数据库或日志。
            </p>
            <section className="card stack">
              <h2>备份与恢复</h2>
              <p className="caption">
                明文备份：包含聊天、项目、记忆、证据、执行历史及受管附件。API Key
                会清空，外部授权目录不复制。请妥善保管备份文件。
              </p>
              <div className="row wrap">
                <Button
                  disabled={dirty}
                  onClick={() =>
                    void run(async () => {
                      const result = unwrap<{ path: string } | null>(
                        await window.tandem.backup("export"),
                      );
                      if (result) setNotice(`备份已导出：${result.path}`);
                    })
                  }
                >
                  导出备份…
                </Button>
                <Button
                  disabled={dirty}
                  onClick={() =>
                    void run(async () => {
                      if (preview) await rpc("backup.cancel", { token: preview.token });
                      const result = unwrap<RestorePreview | null>(
                        await window.tandem.backup("preview"),
                      );
                      setPreview(result ?? undefined);
                    })
                  }
                >
                  选择备份并预览…
                </Button>
              </div>
              {dirty && <p className="caption">请先保存或放弃模型设置的修改，再进行备份或恢复。</p>}
              {preview && (
                <div className="restore-preview stack">
                  <h3>备份预览</h3>
                  <p className="caption">
                    {preview.createdAt} · {preview.appVersion} · Schema {preview.databaseSchema}
                  </p>
                  <p>
                    {preview.messages} 条消息 · {preview.projects} 个项目 · {preview.memories}{" "}
                    条记忆 · {preview.tasks} 个任务 · {preview.attachments} 个附件
                  </p>
                  <p className="caption">
                    恢复将替换当前全部业务数据和模型配置，切换前保留本机保护副本。当前尚未解除的遗忘标记继续生效。恢复后需重新填写
                    API Key、选择目录，并手动继续任务；预算用量保留。
                  </p>
                  <div className="row">
                    <Button
                      kind="danger"
                      disabled={dirty}
                      onClick={() =>
                        void run(async () => {
                          const result = await rpc<{ protectionPath: string }>("backup.restore", {
                            token: preview.token,
                            confirm: true,
                          });
                          setPreview(undefined);
                          await load();
                          setNotice(`恢复完成。本机保护副本：${result.protectionPath}`);
                          await store.refresh();
                        })
                      }
                    >
                      确认替换并恢复
                    </Button>
                    <Button
                      onClick={() =>
                        void run(async () => {
                          await rpc("backup.cancel", { token: preview.token });
                          setPreview(undefined);
                        })
                      }
                    >
                      取消
                    </Button>
                  </div>
                </div>
              )}
            </section>
          </fieldset>
        </div>
      </div>
      {confirmReload && (
        <Modal title="放弃修改并重新加载？" busy={busy} onClose={() => setConfirmReload(false)}>
          <p>将从本机配置重新读取所有接入项。</p>
          <div className="row end">
            <Button onClick={() => setConfirmReload(false)}>继续编辑</Button>
            <Button
              kind="danger"
              disabled={busy}
              onClick={() =>
                void run(async () => {
                  await load();
                  setConfirmReload(false);
                })
              }
            >
              放弃修改并重新加载
            </Button>
          </div>
        </Modal>
      )}
    </section>
  );
}
