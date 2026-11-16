import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, statSync, chmodSync } from "node:fs";
import { connect } from "node:net";
import { once } from "node:events";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { startRuntime } from "../src/server.ts";
import { FrameDecoder, encodeFrame } from "../src/protocol.ts";

test(
  "private socket, authentication, protocol errors and clean shutdown",
  { timeout: 8000 },
  async () => {
    const dir = mkdtempSync("/tmp/tandem-test-");
    chmodSync(dir, 0o700);
    const path = `${dir}/runtime.sock`;
    const token = "a".repeat(64);
    const runtime = startRuntime({ socketPath: path, token, hostPid: process.ppid });
    await once(runtime.server, "listening");
    try {
      assert.equal(statSync(path).mode & 0o777, 0o600);
      for (const request of [
        { protocolVersion: 1, requestId: "x", method: "ping", payload: {} },
        { protocolVersion: 1, requestId: "x", method: "hello", payload: { token: "b".repeat(64) } },
        { protocolVersion: 2, requestId: "x", method: "hello", payload: { token } },
      ]) {
        const socket = connect(path);
        await once(socket, "connect");
        const closed = once(socket, "close");
        socket.write(encodeFrame(request));
        await closed;
      }
      const socket = connect(path);
      await once(socket, "connect");
      async function request(method: string, payload = {}) {
        const incoming = once(socket, "data");
        socket.write(encodeFrame({ protocolVersion: 1, requestId: "test", method, payload }));
        const [data] = await incoming;
        return new FrameDecoder().push(data)[0] as Record<string, any>;
      }
      assert.equal((await request("hello", { token })).data.pid, process.pid);
      assert.equal((await request("ping")).data.pong, true);
      const unknown = await request("shell");
      assert.equal(unknown.ok, false);
      assert.equal(unknown.error.code, "METHOD_NOT_FOUND");
      socket.destroy();
    } finally {
      const closed = once(runtime.server, "close");
      runtime.stop();
      await closed;
      rmSync(dir, { recursive: true, force: true });
    }
  },
);

test("refuse an unsafe socket directory or incorrect host PID", () => {
  const dir = mkdtempSync("/tmp/tandem-test-");
  try {
    chmodSync(dir, 0o755);
    assert.throws(() =>
      startRuntime({ socketPath: `${dir}/s`, token: "a".repeat(64), hostPid: process.ppid }),
    );
    chmodSync(dir, 0o700);
    assert.throws(() =>
      startRuntime({ socketPath: `${dir}/s`, token: "a".repeat(64), hostPid: 0 }),
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("runtime exits when its inherited host pipe closes", { timeout: 8000 }, async () => {
  const dir = mkdtempSync("/tmp/tandem-parent-");
  chmodSync(dir, 0o700);
  const child = spawn(
    process.execPath,
    [fileURLToPath(new URL("../src/main.ts", import.meta.url))],
    { stdio: ["pipe", "ignore", "pipe"] },
  );
  try {
    const output = once(child.stderr, "data");
    child.stdin.write(
      JSON.stringify({
        socketPath: `${dir}/s`,
        token: "a".repeat(64),
        hostPid: process.pid,
        dataDirectory: `${dir}/data`,
      }) + "\n",
    );
    const [message] = await output;
    assert.match(message.toString(), /\[runtime\] ready/);
    const exited = once(child, "exit");
    child.stdin.end();
    const [code] = await exited;
    assert.equal(code, 0);
  } finally {
    if (child.exitCode === null) child.kill("SIGKILL");
    rmSync(dir, { recursive: true, force: true });
  }
});
