import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, statSync, readFileSync } from "node:fs";
import { scopedPayload } from "../security.ts";
import { PreferenceStore } from "../preferences.ts";
import {
  applySnapshot,
  allowsExternal,
  mergeMessages,
  activeQuestion,
} from "../../shared/conversation.ts";
import type { AssistantSnapshot, TimelineMessage } from "../../shared/model.ts";

test("message navigation tracks the question while reading its answer and the last question at the bottom", () => {
  const messages = [1, 2, 3, 4].map(
    (sequence) =>
      ({
        sequence,
        role: sequence % 2 ? "user" : "assistant",
      }) as TimelineMessage,
  );
  assert.equal(activeQuestion(messages, 2, false), 1);
  assert.equal(activeQuestion(messages, 4, false), 3);
  assert.equal(activeQuestion(messages, 2, true), 3);
  assert.equal(activeQuestion(messages.slice(0, 2), 2, true), 1);
  assert.equal(activeQuestion([], undefined, true), undefined);
});

test("renderer methods cannot access host file paths or impersonate another window", () => {
  for (const method of [
    "hello",
    "native.next",
    "native.result",
    "directory.register",
    "backup.export",
    "backup.preview",
    "__proto__",
  ])
    assert.throws(
      () => scopedPayload(method, {}, "window-a"),
      /INVALID_REQUEST/,
    );
  assert.deepEqual(
    scopedPayload(
      "message.send",
      { surfaceId: "window-b", text: "hello" },
      "window-a",
    ),
    { surfaceId: "window-a", text: "hello" },
  );
  assert.throws(
    () => scopedPayload("state.get", [], "window-a"),
    /INVALID_REQUEST/,
  );
  assert.throws(
    () =>
      scopedPayload(
        "state.get",
        { text: "x".repeat(8 * 1024 * 1024) },
        "window-a",
      ),
    /INVALID_REQUEST/,
  );
});
test("messages retain identities/order and discard stale generations on restore", () => {
  const message = (id: string, sequence: number, content = id) =>
    ({ id, sequence, content }) as TimelineMessage;
  const merged = mergeMessages(
    [message("a", 1), message("b", 2)],
    [message("b", 2, "stream"), message("c", 3)],
  );
  assert.deepEqual(
    merged.map((value) => value.content),
    ["a", "stream", "c"],
  );
  const state = {
    generation: "new",
    messages: [message("c", 3)],
    changedMessages: [],
    cursor: 4,
  } as unknown as AssistantSnapshot;
  assert.deepEqual(
    applySnapshot(merged, "old", state).map((value) => value.id),
    ["c"],
  );
});
test("external links only allow deliberate HTTP(S) opens without credentials", () => {
  for (const url of ["https://example.com/a", "http://127.0.0.1:8080"])
    assert.ok(allowsExternal(url));
  for (const url of [
    "javascript:alert(1)",
    "file:///etc/passwd",
    "data:text/html,hello",
    "https://user:pass@example.com",
    "relative/path",
  ])
    assert.equal(allowsExternal(url), false);
});
test("window reading positions and appearance persist independently with private permissions", () => {
  const root = mkdtempSync("/tmp/tandem-preferences-");
  try {
    const store = new PreferenceStore(root);
    store.update({
      appearance: "dark",
      sidebarWidth: 999,
      lastSurface: "b",
      positions: {
        a: {
          generation: "one",
          sequence: 2,
          atBottom: false,
          projectFilter: "*",
        },
        b: {
          generation: "one",
          sequence: 9,
          atBottom: true,
          projectFilter: "project",
        },
      },
    });
    const reopened = new PreferenceStore(root);
    assert.equal(reopened.value.sidebarWidth, 360);
    assert.equal(reopened.value.appearance, "dark");
    assert.equal(reopened.value.lastSurface, "b");
    assert.equal(reopened.value.positions.a!.sequence, 2);
    assert.equal(reopened.value.positions.b!.sequence, 9);
    assert.equal(statSync(`${root}/ui-preferences.json`).mode & 0o777, 0o600);
    assert.ok(
      !readFileSync(`${root}/ui-preferences.json`, "utf8").includes("key"),
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("SwiftUI plist preferences migrate data anchors without changing the surface identity", () => {
  const root = mkdtempSync("/tmp/tandem-legacy-preferences-");
  try {
    const store = new PreferenceStore(root);
    const anchor = Buffer.from(
      JSON.stringify({
        generation: "g",
        sequence: 7,
        atBottom: false,
        projectFilter: "*",
      }),
    ).toString("base64");
    store.importLegacyDocument(
      `<?xml version="1.0"?><plist version="1.0"><dict><key>tandem.appearance</key><string>dark</string><key>tandem.sidebarWidth</key><real>280</real><key>tandem.lastConversationSurface</key><string>legacy</string><key>tandem.conversationPosition.legacy</key><data>${anchor}</data></dict></plist>`,
    );
    const reopened = new PreferenceStore(root);
    assert.equal(reopened.value.appearance, "dark");
    assert.equal(reopened.value.sidebarWidth, 280);
    assert.equal(reopened.value.lastSurface, "legacy");
    assert.equal(reopened.value.positions.legacy!.sequence, 7);
    reopened.update({
      positions: {
        bad: {
          generation: "g",
          sequence: -1,
          atBottom: false,
          projectFilter: "*",
        },
      },
    });
    assert.deepEqual(reopened.value.positions, {});
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
