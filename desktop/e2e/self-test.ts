import assert from "node:assert/strict";
import { once } from "node:events";
import { mkdirSync, writeFileSync, readFileSync, existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import type { BrowserWindow } from "electron";
import type { RuntimeSupervisor } from "../runtime.ts";
import type { Payload } from "../../shared/bridge.ts";
import type {
  AssistantSnapshot,
  TimelineMessage,
  RunContext,
} from "../../shared/model.ts";
import { startMockModel } from "./mock-model.ts";

async function waitFor<T>(
  read: () => Promise<T> | T,
  check: (value: T) => boolean,
): Promise<T> {
  for (let attempt = 0; attempt < 200; attempt++) {
    const value = await read();
    if (check(value)) return value;
    await delay(100);
  }
  throw new Error("SMOKE_TIMEOUT");
}
export async function selfTest(
  runtime: RuntimeSupervisor,
  createWindow: () => BrowserWindow,
  lifecycle: boolean,
  windowReady: (window: BrowserWindow) => boolean,
) {
  const directory = process.env.TANDEM_TEST_DATA_DIR!;
  const mock = await startMockModel();
  const paths = mock.paths;
  const call = async <T = Payload>(method: string, payload: Payload = {}) =>
    (await runtime.request(method, payload)) as unknown as T;
  const state = (surfaceId = "smoke") =>
    call<AssistantSnapshot>("state.get", { surfaceId });
  const send = async (text: string, extras: Payload = {}) =>
    call("message.send", {
      surfaceId: "smoke",
      text,
      idempotencyKey: crypto.randomUUID(),
      ...extras,
    });
  const completed = () =>
    waitFor(
      state,
      (snapshot) => snapshot.messages.at(-1)?.status === "completed",
    );
  try {
    const start = Date.now();
    await waitFor(() => runtime.status.connected, Boolean);
    assert.ok(Date.now() - start < 5000);
    const config = await call<{ revision: string }>("config.get");
    assert.equal(config.revision, "missing");
    const url = `http://127.0.0.1:${mock.port}/v1`;
    await call("config.save", {
      expectedRevision: config.revision,
      config: {
        schemaVersion: 1,
        modelConnections: ["responses", "chat_completions", "messages"].map(
          (apiType) => ({
            id: apiType,
            protocol: apiType === "messages" ? "anthropic" : "openai",
            apiType,
            url,
            key: "smoke-private-key",
            modelNames: ["smoke-model"],
          }),
        ),
        defaultModel: { connectionId: "responses", modelName: "smoke-model" },
      },
    });
    if (lifecycle) {
      const win = createWindow();
      await once(win.webContents, "did-finish-load");
      await waitFor(() => windowReady(win), Boolean);
      await send("background-task", {
        selection: {
          connectionId: "chat_completions",
          modelName: "smoke-model",
        },
        task: { deliverable: "后台报告", criteria: ["报告生成并保存"] },
      });
      win.destroy();
      const pongs = runtime.status.pongCount;
      await waitFor(state, (snapshot) =>
        snapshot.activity.tasks.some((task) => task.status === "completed"),
      );
      assert.ok(runtime.status.pongCount > pongs);
      const reopened = createWindow();
      await once(reopened.webContents, "did-finish-load");
      await waitFor(() => windowReady(reopened), Boolean);
      assert.ok(
        (await state()).activity.tasks.some(
          (task) => task.status === "completed",
        ),
      );
      await send("lifecycle-hold", {
        newTopic: true,
        selection: {
          connectionId: "chat_completions",
          modelName: "smoke-model",
        },
        idempotencyKey: "lifecycle-hold",
      });
      await waitFor(
        state,
        (snapshot) => snapshot.messages.at(-1)?.content === "partial",
      );
      reopened.destroy();
      // Keep the mock endpoint alive until quit has interrupted the in-flight run.
      await runtime.stop();
      console.log("PASS App lifecycle: background task, reopen, shutdown");
      return;
    }
    for (const connectionId of ["responses", "chat_completions", "messages"]) {
      await send(`你好 ${connectionId}`, {
        selection: { connectionId, modelName: "smoke-model" },
      });
      assert.equal((await completed()).messages.at(-1)?.content, "你好，M1");
    }
    const firstPID = runtime.status.nodePID,
      count = runtime.status.connectionCount;
    runtime.reconnect();
    await waitFor(
      () => runtime.status.connectionCount,
      (value) => value > count,
    );
    assert.equal(runtime.status.nodePID, firstPID);
    await send("crash-request", {
      selection: { connectionId: "chat_completions", modelName: "smoke-model" },
    });
    await waitFor(
      state,
      (snapshot) => snapshot.messages.at(-1)?.content === "partial",
    );
    runtime.injectCrash();
    await waitFor(
      () => runtime.status.connected && runtime.status.nodePID !== firstPID,
      Boolean,
    );
    assert.equal((await state()).messages.at(-1)?.status, "interrupted");
    let snapshot = await state();
    await call("context.set", {
      surfaceId: "smoke",
      mode: "isolated",
      projectId: null,
      expectedVersion: snapshot.focus.version,
    });
    await send("M2 scoped question");
    snapshot = await state();
    assert.equal(snapshot.pendingInteractions.length, 1);
    const pending = snapshot.pendingInteractions[0]!;
    const project = await call<{ id: string }>("project.create", {
      title: "M2 project",
      description: "",
    });
    await call("context.set", {
      surfaceId: "smoke",
      mode: "isolated",
      projectId: project.id,
      expectedVersion: snapshot.focus.version,
    });
    snapshot = await state();
    await call("interaction.confirm", {
      surfaceId: "smoke",
      interactionId: pending.id,
      expectedVersion: pending.version,
      expectedFocusVersion: snapshot.focus.version,
      sessionId: null,
    });
    snapshot = await completed();
    const scoped = snapshot.messages.at(-1)!;
    const context = await call<RunContext>("snapshot.get", {
      id: scoped.snapshotId,
      surfaceId: "smoke",
    });
    assert.equal(context.projectId, project.id);
    assert.equal(context.fragments.length, 1);
    const target = await call<{ id: string }>("project.create", {
      title: "M2 target",
      description: "",
    });
    await call("context.set", {
      surfaceId: "smoke",
      mode: "automatic",
      projectId: target.id,
      expectedVersion: snapshot.focus.version,
    });
    await call("interaction.correct", {
      surfaceId: "smoke",
      interactionId: scoped.interactionId,
      expectedVersion: scoped.interactionVersion,
      projectId: target.id,
    });
    await call("message.retry", {
      runId: scoped.runId,
      idempotencyKey: "retry-corrected",
    });
    snapshot = await completed();
    assert.equal(snapshot.messages.at(-1)?.executionProjectId, target.id);
    assert.equal(
      (
        await call<RunContext>("snapshot.get", {
          id: scoped.snapshotId,
          surfaceId: "smoke",
        })
      ).projectId,
      project.id,
    );
    const resources = join(dirname(directory), "resources");
    mkdirSync(resources);
    writeFileSync(join(resources, "notes.md"), "原生读取资料\n第二行");
    await runtime.authorize(resources, target.id);
    await send("M3 native read", {
      newTopic: true,
      selection: { connectionId: "chat_completions", modelName: "smoke-model" },
      task: { deliverable: "原生读取报告", criteria: ["引用原生文件与版本"] },
    });
    snapshot = await waitFor(state, (value) =>
      value.activity.tasks.some((task) => task.status === "completed"),
    );
    const task = snapshot.activity.tasks[0]!;
    assert.match(
      (
        await call<{ content: string }>("result.get", {
          surfaceId: "smoke",
          messageId: task.result_ref,
        })
      ).content,
      /原生读取资料/,
    );
    const allMessages: TimelineMessage[] = [...snapshot.messages];
    let before = allMessages[0]!.sequence;
    while (
      !allMessages.some(
        (message) =>
          message.role === "user" &&
          message.interactionId === scoped.interactionId,
      )
    ) {
      const page = await call<{ messages: TimelineMessage[] }>(
        "timeline.list",
        { beforeSequence: before },
      );
      assert.ok(page.messages.length);
      allMessages.unshift(...page.messages);
      before = page.messages[0]!.sequence;
    }
    const evidence = allMessages.find(
      (message) =>
        message.role === "user" &&
        message.interactionId === scoped.interactionId,
    )!;
    const memory = await call<{ id: string }>("memory.save", {
      surfaceId: "smoke",
      messageId: evidence.id,
      expectedInteractionVersion: evidence.interactionVersion,
      kind: "decision",
      subject: "项目",
      predicate: "数据库",
      content: "SQLite",
      confirmed: true,
    });
    await send("M4 current decision", {
      newTopic: true,
      selection: { connectionId: "chat_completions", modelName: "smoke-model" },
    });
    snapshot = await completed();
    const memorySnapshot = snapshot.messages.at(-1)!.snapshotId;
    assert.ok(
      (
        await call<RunContext>("snapshot.get", {
          id: memorySnapshot,
          surfaceId: "smoke",
        })
      ).fragments.some((fragment) => fragment.sourceId === memory.id),
    );
    const backup = join(dirname(directory), "backup.json");
    await call("backup.export", { path: backup });
    const detail = await call<{ version: number }>("memory.get", {
      surfaceId: "smoke",
      id: memory.id,
    });
    await call("memory.forget", {
      surfaceId: "smoke",
      id: memory.id,
      expectedVersion: detail.version,
    });
    assert.ok(
      (
        await call<RunContext>("snapshot.get", {
          id: memorySnapshot,
          surfaceId: "smoke",
        })
      ).fragments.some(
        (fragment) => fragment.sourceId === memory.id && fragment.deleted,
      ),
    );
    await send("Core after backup", { newTopic: true });
    await completed();
    assert.ok(
      (await state("other-window")).messages.some(
        (message) => message.content === "Core after backup",
      ),
    );
    const preview = await call<{ token: string }>("backup.preview", {
      path: backup,
    });
    const restoration = await call<{ protectionPath: string }>(
      "backup.restore",
      { token: preview.token, confirm: true },
    );
    for (const surface of ["smoke", "other-window"]) {
      const restored = await state(surface);
      assert.notEqual(restored.generation, snapshot.generation);
      assert.ok(
        !restored.messages.some(
          (message) => message.content === "Core after backup",
        ),
      );
    }
    assert.equal(runtime.directories.registrations().length, 0);
    assert.ok(existsSync(join(restoration.protectionPath, "config.json")));
    const forgotten = await call<{ memories: unknown[]; markers: unknown[] }>(
      "memory.list",
      { surfaceId: "smoke" },
    );
    assert.equal(forgotten.memories.length, 0);
    assert.equal(forgotten.markers.length, 1);
    const restoredConfig = await call<{
      config: { modelConnections: { key: string }[] };
    }>("config.get");
    assert.ok(
      restoredConfig.config.modelConnections.every((item) => item.key === ""),
    );
    assert.equal(
      readFileSync(join(resources, "notes.md"), "utf8"),
      "原生读取资料\n第二行",
    );
    let history = (await state()).messages;
    while (history[0]!.sequence > 1)
      history = [
        ...(
          await call<{ messages: TimelineMessage[] }>("timeline.list", {
            beforeSequence: history[0]!.sequence,
          })
        ).messages,
        ...history,
      ];
    assert.ok(history.length > 10);
    assert.ok(
      ["/v1/responses", "/v1/chat/completions", "/v1/messages"].every((path) =>
        paths.includes(path),
      ),
    );
    console.log(
      "PASS Electron → Node: three APIs, routing/correction, native task, memory, backup/restore/forget protection, multi-window reload, history, reconnect, crash restart",
    );
  } finally {
    mock.close();
  }
}
