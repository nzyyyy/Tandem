import { test } from "node:test";
import assert from "node:assert/strict";
import {
  activeQuestion,
  allowsExternal,
  applySnapshot,
  mergeMessages,
} from "../conversation.ts";
import type { AssistantSnapshot, TimelineMessage } from "../model.ts";

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
