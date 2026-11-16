import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:net";
import { once } from "node:events";
import { mkdtempSync, rmSync } from "node:fs";
import { connectRuntimeSocket } from "../macos-socket.ts";

test("macOS socket checks the kernel peer PID before exposing any authentication token", async () => {
  const directory = mkdtempSync("/tmp/tandem-peer-");
  const path = `${directory}/runtime.sock`;
  let received = "";
  const server = createServer((socket) => {
    socket.on("data", (data) => {
      received += data.toString();
      socket.end("pong");
    });
  });
  server.listen(path);
  await once(server, "listening");
  try {
    assert.throws(
      () => connectRuntimeSocket(path, process.pid + 999999),
      /INVALID_PEER/,
    );
    assert.equal(received, "");
    const client = connectRuntimeSocket(path, process.pid);
    client.write("ping");
    const [data] = await once(client, "data");
    assert.equal(data.toString(), "pong");
    client.destroy();
    assert.throws(
      () => connectRuntimeSocket("/" + "x".repeat(104), process.pid),
      /INVALID_SOCKET_PATH/,
    );
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    rmSync(directory, { recursive: true, force: true });
  }
});
