import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, render, screen, waitFor, fireEvent, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { Tooltip } from "radix-ui";
import { App } from "../app.tsx";
import { Conversation } from "../conversation/index.tsx";
import { Settings, modelAdditionError, providerName } from "../settings.tsx";
import { Markdown } from "../components/markdown.tsx";
import { AssistantStore, StoreContext } from "../store.tsx";
import type {
  ActivityRun,
  AssistantSnapshot,
  AppConfiguration,
  TimelineMessage,
} from "../../shared/model.ts";
import type { DesktopBridge, Payload } from "../../shared/bridge.ts";

const snapshot = (): AssistantSnapshot => ({
  generation: "generation-a",
  activity: { runs: [], tasks: [], grants: [], approvals: [] },
  projects: [],
  pendingInteractions: [],
  focus: {
    activeSessionId: null,
    activeProjectId: null,
    contextMode: "automatic",
    interruptedSessionId: null,
    version: 1,
  },
  models: [],
  defaultModel: null,
  configError: null,
  sessions: [],
  messages: [],
  changedMessages: [],
  cursor: 0,
  hasMore: false,
});
const config = (): AppConfiguration => ({
  schemaVersion: 1,
  modelConnections: [],
  defaultModel: null,
});
function setup(configuration = config()) {
  const store = new AssistantStore({
    surfaceId: "window-a",
    preferences: { appearance: "auto", sidebarWidth: 238, positions: {} },
  });
  store.set({ snapshot: snapshot() });
  const request = vi.fn<DesktopBridge["request"]>(async (method: string, _payload?: Payload) => ({
    ok: true as const,
    data:
      method === "config.get"
        ? { config: configuration, revision: "revision-a" }
        : method === "state.get"
          ? snapshot()
          : {},
  }));
  window.tandem = {
    request,
    ready: vi.fn(async () => {}),
    onPreferences: () => () => {},
    status: vi.fn(async () => store.state.status),
    copy: vi.fn(async () => {}),
    openExternal: vi.fn(async () => {}),
    preferences: vi.fn(async () => {}),
    position: vi.fn(async () => {}),
  } as unknown as DesktopBridge;
  const wrap = (element: React.ReactNode) =>
    render(
      <StoreContext.Provider value={store}>
        <Tooltip.Provider>{element}</Tooltip.Provider>
      </StoreContext.Provider>,
    );
  return { store, request, wrap };
}
beforeEach(() => {
  vi.stubGlobal(
    "ResizeObserver",
    class {
      observe() {}
      disconnect() {}
      unobserve() {}
    },
  );
  HTMLElement.prototype.scrollIntoView = vi.fn();
  HTMLElement.prototype.hasPointerCapture = () => false;
  HTMLElement.prototype.setPointerCapture = vi.fn();
  HTMLElement.prototype.releasePointerCapture = vi.fn();
});
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});
describe("preserved interactions", () => {
  it("opens run outputs and shared approval details from the Activity layout", async () => {
    const { store, request, wrap } = setup();
    vi.spyOn(store, "start").mockResolvedValue();
    const state = snapshot();
    const run: ActivityRun = {
      id: "run",
      title: "整理会议纪要",
      output_preview: "提取了行动项",
      created_at: Date.now(),
      status: "completed",
      error_code: null,
      project_id: null,
      assistant_message_id: "result",
      version: 1,
      steps: 5,
      tokens: 100,
      active_ms: 17000,
      step_limit: 24,
      token_limit: 64000,
      time_limit: 300000,
      pause_reason: null,
      estimated: 0,
      modelName: "测试模型",
      task_id: null,
      revision: null,
      stepsDetail: [],
    };
    state.activity.runs = [
      {
        ...run,
        id: "waiting",
        title: "整理访谈资料",
        status: "waiting_approval",
        assistant_message_id: "waiting-output",
        output_preview: null,
        task_id: "task",
        revision: 1,
      },
      { ...run, id: "other", title: "整理其他资料", status: "waiting_approval" },
      run,
    ];
    state.activity.approvals = [
      {
        id: "approval",
        run_id: "waiting",
        name: "request_directory",
        args: '{"reason":"读取文本纪要"}',
        expires_at: Date.now() + 600000,
      },
      {
        id: "other-approval",
        run_id: "other",
        name: "request_directory",
        args: '{"reason":"读取其他资料"}',
        expires_at: Date.now() + 600000,
      },
    ];
    state.activity.tasks = [
      {
        id: "task",
        session_id: "session",
        created_at: run.created_at,
        project_id: null,
        revision: 1,
        status: "open",
        deliverable: "访谈报告",
        criteria: '["标注来源"]',
        evidence: null,
        result_ref: null,
      },
    ];
    state.activity.grants = [
      { id: "downloads", project_id: null, label: "Downloads", status: "inactive" },
    ];
    request.mockResolvedValueOnce({ ok: true, data: { content: "**完整行动项**" } });
    store.set({ snapshot: state });
    wrap(<App />);
    const user = userEvent.setup();

    await user.click(screen.getByRole("button", { name: "活动" }));
    const detailPanel = screen.getByRole("complementary", { name: "活动详情" });
    const detail = within(detailPanel);
    await user.click(screen.getByRole("button", { name: /整理会议纪要/ }));
    expect(detail.getByText("提取了行动项")).toBeTruthy();
    await user.click(detail.getByText("步骤、来源与用量"));
    expect(detail.getByText(/步骤 5\/24/)).toBeTruthy();
    await user.click(detail.getByRole("button", { name: "查看完整输出" }));
    expect((await screen.findByRole("dialog")).textContent).toContain("完整行动项");
    expect(request).toHaveBeenCalledWith("result.get", { messageId: "result" });
    const close = screen.getByRole("button", { name: "关闭" });
    await waitFor(() => expect(document.activeElement).toBe(close));
    expect(screen.queryByRole("tooltip", { hidden: true })).toBeNull();
    await user.click(close);

    const attention = within(screen.getByRole("region", { name: "待处理的审批" }));
    await user.click(attention.getByRole("button", { name: "处理审批" }));
    expect(detail.getByText("读取文本纪要")).toBeTruthy();
    expect(detail.getByText("读取其他资料")).toBeTruthy();
    await user.click(screen.getByRole("tab", { name: "持续任务" }));
    expect(detail.getByRole("heading", { name: "访谈报告" })).toBeTruthy();
    expect(detail.getByText("标注来源")).toBeTruthy();
    await user.click(detail.getByRole("button", { name: "处理审批" }));
    expect(detail.getByText("读取文本纪要")).toBeTruthy();
    expect(detail.queryByText("读取其他资料")).toBeNull();
    expect(detail.getByRole("button", { name: "拒绝" })).toBeTruthy();
    await waitFor(() => expect(document.activeElement).toBe(detailPanel));
    await user.click(detail.getByRole("button", { name: "返回列表" }));
    await user.keyboard("{ArrowRight}");
    expect(await detail.findByRole("heading", { name: "Downloads" })).toBeTruthy();
    expect(detail.getByRole("button", { name: "重新选择同一目录" })).toBeTruthy();
    await user.click(screen.getByRole("tab", { name: "执行记录" }));
    expect(detail.getByRole("heading", { name: "整理会议纪要" })).toBeTruthy();
  });

  it("offers a jump to latest only while more conversation is below the viewport", async () => {
    const { store, wrap } = setup();
    const observe = vi.fn();
    let resize: (() => void) | undefined;
    vi.stubGlobal(
      "ResizeObserver",
      class {
        constructor(callback: (entries: ResizeObserverEntry[]) => void) {
          resize = () => callback([]);
        }
        observe = observe;
        disconnect() {}
      },
    );
    store.set({
      messages: [{ id: "message", sequence: 1, role: "user", content: "你好" } as TimelineMessage],
    });
    const { container } = wrap(<Conversation active navigate={vi.fn()} />);
    const viewport = container.querySelector<HTMLElement>(".timeline-scroll")!;
    let viewportHeight = 300;
    let scrollTop = 0;
    Object.defineProperties(viewport, {
      scrollHeight: { value: 600 },
      clientHeight: { get: () => viewportHeight },
      scrollTop: {
        get: () => scrollTop,
        set: (value: number) => (scrollTop = Math.min(value, 600 - viewportHeight)),
      },
    });
    const latest = () => screen.queryByRole("button", { name: "跳转到最新消息" });
    await waitFor(() => expect(observe).toHaveBeenCalledWith(viewport));
    expect(latest()).toBeNull();

    viewport.scrollTop = 0;
    fireEvent.scroll(viewport);
    fireEvent.click(screen.getByRole("button", { name: "跳转到最新消息" }));
    expect(viewport.scrollTop).toBe(300);
    fireEvent.scroll(viewport);
    expect(latest()).toBeNull();

    viewport.scrollTop = 0;
    fireEvent.scroll(viewport);
    expect(latest()).toBeTruthy();
    viewportHeight = 600;
    act(() => resize?.());
    expect(latest()).toBeNull();
  });
  it("previews the matching conversation turn on hover and keyboard focus", async () => {
    const { store, wrap } = setup();
    const message = (sequence: number, role: string, interactionId: string, content: string) =>
      ({ id: String(sequence), sequence, role, interactionId, content }) as TimelineMessage;
    store.set({
      messages: [
        message(1, "user", "first", "第一问"),
        message(2, "assistant", "first", "第一问的回答"),
        message(3, "user", "second", "尚未回复的问题"),
      ],
    });
    wrap(<Conversation active navigate={vi.fn()} />);
    const user = userEvent.setup();
    const first = screen.getByRole("button", { name: "跳转到：第一问" });
    const second = screen.getByRole("button", { name: "跳转到：尚未回复的问题" });

    await user.hover(first);
    const preview = await screen.findByRole("tooltip");
    expect(preview.textContent).toBe("第一问第一问的回答");
    expect(first.getAttribute("data-state")).toMatch(/-open$/);
    expect(second.getAttribute("aria-current")).toBe("true");
    await user.keyboard("{Escape}");
    expect(screen.queryByRole("tooltip")).toBeNull();

    act(() => second.focus());
    expect((await screen.findByRole("tooltip")).textContent).toBe("尚未回复的问题");
    expect(first.getAttribute("data-state")).toBe("closed");
  });
  it("keeps an unsaved project until navigation is explicitly discarded", async () => {
    const { store, wrap } = setup();
    vi.spyOn(store, "start").mockResolvedValue();
    wrap(<App />);
    const user = userEvent.setup();
    await user.click(screen.getByRole("button", { name: "项目" }));
    await user.type(screen.getByLabelText("项目名称"), "未保存的项目");
    await user.click(screen.getByRole("button", { name: "模型设置" }));
    expect(screen.getByRole("dialog")).toBeTruthy();
    await user.click(screen.getByRole("button", { name: "继续编辑" }));
    expect((screen.getByLabelText("项目名称") as HTMLInputElement).value).toBe("未保存的项目");
    await user.click(screen.getByRole("button", { name: "模型设置" }));
    await user.click(screen.getByRole("button", { name: "放弃修改并离开" }));
    await screen.findByRole("button", { name: "保存配置" });
  });
  it("confirms discarding project edits before switching projects or creating a new one", async () => {
    const { store, request, wrap } = setup();
    vi.spyOn(store, "start").mockResolvedValue();
    const state = snapshot();
    state.projects = [
      {
        id: "a",
        title: "项目 A",
        description: "说明 A",
        status: "open",
        version: 1,
      },
      {
        id: "b",
        title: "项目 B",
        description: "说明 B",
        status: "open",
        version: 1,
      },
    ];
    store.set({ snapshot: state });
    wrap(<App />);
    const user = userEvent.setup();
    const title = () => screen.getByLabelText("项目名称") as HTMLInputElement;
    const description = () => screen.getByLabelText("目标或说明") as HTMLTextAreaElement;

    await user.click(screen.getByRole("button", { name: "项目" }));
    await user.click(screen.getByRole("button", { name: "项目 A" }));
    await user.type(title(), " 修改");
    await user.type(description(), " 修改");
    await user.click(screen.getByRole("button", { name: "项目 B" }));
    await screen.findByRole("dialog", { name: "放弃当前项目的修改？" });
    await user.click(screen.getByRole("button", { name: "继续编辑" }));
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(title().value).toBe("项目 A 修改");
    expect(description().value).toBe("说明 A 修改");

    await user.click(screen.getByRole("button", { name: "项目 B" }));
    await user.click(screen.getByRole("button", { name: "放弃修改并切换" }));
    expect(title().value).toBe("项目 B");
    expect(description().value).toBe("说明 B");
    expect(screen.queryByRole("dialog")).toBeNull();

    await user.type(title(), " 修改");
    await user.click(screen.getByRole("button", { name: "新建项目" }));
    await screen.findByRole("dialog", { name: "放弃当前项目的修改？" });
    await user.click(screen.getByRole("button", { name: "放弃修改并切换" }));
    expect(title().value).toBe("");
    expect(description().value).toBe("");
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(screen.getByRole("button", { name: "创建项目" })).toBeTruthy();
    expect(request).not.toHaveBeenCalled();
  });
  it("adds named providers and trims model names before saving with a revision", async () => {
    const { wrap, request } = setup();
    wrap(<Settings onDirty={() => {}} onBusy={() => {}} />);
    const user = userEvent.setup();
    await waitFor(() =>
      expect(
        (
          screen.getByRole("button", {
            name: "添加供应商",
          }) as HTMLButtonElement
        ).disabled,
      ).toBe(false),
    );
    await user.click(screen.getByRole("button", { name: "添加供应商" }));
    await user.type(screen.getByLabelText("供应商名称"), "我的模型");
    await user.type(screen.getByLabelText("新模型名称"), " model-a ");
    expect((screen.getByRole("button", { name: "保存配置" }) as HTMLButtonElement).disabled).toBe(
      true,
    );
    await user.click(screen.getByRole("button", { name: "添加" }));
    request.mockImplementation(async (method, payload) => ({
      ok: true,
      data:
        method === "config.save" ? { config: payload!.config, revision: "revision-b" } : snapshot(),
    }));
    await user.click(screen.getByRole("button", { name: "保存配置" }));
    await screen.findByText("已保存。");
    const payload = request.mock.calls.find(([method]) => method === "config.save")![1]!;
    expect(payload.expectedRevision).toBe("revision-a");
    expect((payload.config as AppConfiguration).modelConnections[0]!.modelNames).toEqual([
      "model-a",
    ]);
    expect((payload.config as AppConfiguration).modelConnections[0]!.name).toBe("我的模型");
  });
  it("removing the default model clears only its matching default selection", async () => {
    const configuration: AppConfiguration = {
      schemaVersion: 1,
      modelConnections: [
        {
          id: "provider",
          protocol: "openai",
          apiType: "responses",
          url: "https://example.com/v1",
          key: "",
          modelNames: ["a", "b"],
        },
      ],
      defaultModel: { connectionId: "provider", modelName: "a" },
    };
    const { wrap, request } = setup(configuration);
    wrap(<Settings onDirty={() => {}} onBusy={() => {}} />);
    const user = userEvent.setup();
    await user.click(await screen.findByRole("button", { name: "移除模型 a" }));
    request.mockImplementation(async (method, payload) => ({
      ok: true,
      data: method === "config.save" ? { config: payload!.config, revision: "b" } : snapshot(),
    }));
    await user.click(screen.getByRole("button", { name: "保存配置" }));
    await screen.findByText("已保存。");
    const saved = request.mock.calls.find(([method]) => method === "config.save")![1]!
      .config as AppConfiguration;
    expect(saved.defaultModel).toBeNull();
    expect(saved.modelConnections[0]!.id).toBe("provider");
    expect(saved.modelConnections[0]!.modelNames).toEqual(["b"]);
  });
  it("blocks destructive project deletion behind a complete preview", async () => {
    const { store, request, wrap } = setup();
    vi.spyOn(store, "start").mockResolvedValue();
    const state = snapshot();
    state.projects = [
      {
        id: "project",
        title: "测试项目",
        description: "",
        status: "open",
        version: 1,
      },
    ];
    store.set({ snapshot: state });
    request.mockImplementation(async (method) => ({
      ok: true,
      data:
        method === "project.deletePreview"
          ? {
              token: "preview",
              title: "测试项目",
              interactions: [{ id: "i" }],
              messages: [{ id: "m" }],
              runs: [],
              tasks: [],
              memories: [],
              sharedSnapshots: [],
              derivedMessages: [],
            }
          : state,
    }));
    wrap(<App />);
    const user = userEvent.setup();
    await user.click(screen.getByRole("button", { name: "项目" }));
    await user.click(screen.getByRole("button", { name: "测试项目" }));
    expect(screen.queryByRole("button", { name: "确认永久删除" })).toBeNull();
    await user.click(screen.getByRole("button", { name: "预览永久删除…" }));
    await screen.findByRole("button", { name: "确认永久删除" });
    expect(request.mock.calls.some(([method]) => method === "project.delete")).toBe(false);
  });
  it("does not send while composing Chinese input", async () => {
    const { store, wrap } = setup();
    vi.spyOn(store, "start").mockResolvedValue();
    const send = vi.spyOn(store, "send").mockResolvedValue();
    wrap(<App />);
    const input = screen.getByLabelText("消息内容");
    fireEvent.keyDown(input, { key: "Enter", isComposing: true });
    expect(send).not.toHaveBeenCalled();
    fireEvent.keyDown(input, { key: "Enter", metaKey: true });
    expect(send).toHaveBeenCalledTimes(1);
  });
});
describe("content and delivery boundaries", () => {
  it("renders Markdown tables and code while suppressing HTML, image loads and unsafe links", async () => {
    setup();
    render(
      <Markdown
        source={
          "# 标题\n\n| 名称 | 值 |\n| --- | --- |\n| A | B |\n\n```ts\nconst value = 1;\n```\n\n![图片说明](https://example.com/tracker.png)\n\n[危险](javascript:alert(1)) [文档](https://example.com/docs)\n\n<script>alert(1)</script>"
        }
      />,
    );
    expect(screen.getByRole("heading", { name: "标题" })).toBeTruthy();
    expect(screen.getByRole("table")).toBeTruthy();
    expect(document.querySelector("img")).toBeNull();
    expect(document.querySelector("script")).toBeNull();
    expect(screen.queryByRole("link", { name: "危险" })).toBeNull();
    const user = userEvent.setup();
    await user.click(screen.getByRole("button", { name: "复制代码" }));
    expect(window.tandem.copy).toHaveBeenCalledWith("const value = 1;");
    await user.click(screen.getByRole("link", { name: "文档" }));
    expect(window.tandem.openExternal).toHaveBeenCalledWith("https://example.com/docs");
  });
  it("reuses an idempotency key after a lost send acknowledgement and preserves edits made in flight", async () => {
    const { store, request } = setup();
    store.set({ draft: "hello" });
    let fail = true;
    request.mockImplementation(async (method) => {
      if (method === "message.send") {
        if (fail) {
          fail = false;
          return { ok: false, error: "RUNTIME_DISCONNECTED" };
        }
        store.set({ draft: "new draft" });
      }
      return { ok: true, data: snapshot() };
    });
    await store.send();
    expect(store.state.draft).toBe("hello");
    await store.send();
    const sends = request.mock.calls.filter(([method]) => method === "message.send");
    expect(sends[0]![1]!.idempotencyKey).toBe(sends[1]![1]!.idempotencyKey);
    expect(store.state.draft).toBe("new draft");
    expect(store.state.sending).toBe(false);
  });
  it("preserves legacy provider identity and validates model name bounds", () => {
    expect(
      providerName({
        id: "a",
        protocol: "openai",
        apiType: "responses",
        url: "https://example.com/v1",
        key: "",
        modelNames: [],
      }),
    ).toBe("example.com");
    expect(modelAdditionError(" model-a ", [])).toBeNull();
    for (const name of ["", "bad\nname", "x".repeat(257), "😀".repeat(129)])
      expect(modelAdditionError(name, [])).toBeTruthy();
    expect(modelAdditionError("a", ["a"])).toBeTruthy();
    expect(
      modelAdditionError(
        "new",
        Array.from({ length: 20 }, (_, i) => String(i)),
      ),
    ).toBeTruthy();
  });
});
