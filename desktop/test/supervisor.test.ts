import { test } from "node:test";
import assert from "node:assert/strict";
import { setTimeout as delay } from "node:timers/promises";
import { RuntimeSupervisor } from "../runtime.ts";

test("a missing Node executable enters retry and remains cleanly stoppable", async () => {
  const runtime = new RuntimeSupervisor("/nonexistent-tandem-node", "/nonexistent-tandem-entry");
  runtime.start();
  try {
    for (let attempt = 0; attempt < 100 && runtime.status.restartCount === 0; attempt++)
      await delay(20);
    assert.ok(runtime.status.restartCount > 0);
    assert.equal(runtime.status.connected, false);
  } finally {
    await runtime.stop();
  }
  assert.equal(runtime.status.nodePID, 0);
  assert.equal(runtime.status.status, "已停止");
});
