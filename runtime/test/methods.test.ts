import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { AppService } from "../src/service.ts";
import { rendererMethods } from "../src/contract.ts";

// Guards the allowlist: a method the renderer may call must reach a handler,
// not fall through to METHOD_NOT_FOUND.
test("every renderer method has a runtime handler", async () => {
  const directory = mkdtempSync("/tmp/tandem-methods-");
  const service = new AppService(directory);
  try {
    for (const method of rendererMethods) {
      let code: unknown;
      try {
        service.dispatch(method, { surfaceId: "method-test" });
      } catch (error) {
        code = (error as { code?: string }).code;
      }
      assert.notEqual(code, "METHOD_NOT_FOUND", method);
    }
  } finally {
    await service.stop();
    rmSync(directory, { recursive: true, force: true });
  }
});
