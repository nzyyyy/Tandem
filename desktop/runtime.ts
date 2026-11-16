import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import type { Socket } from "node:net";
import { mkdtempSync, chmodSync, rmSync } from "node:fs";
import { randomBytes, randomUUID } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { FrameDecoder, encodeFrame } from "../runtime/src/protocol.ts";
import { DirectoryAccess } from "./directories.ts";
import { connectRuntimeSocket } from "./macos-socket.ts";
import type { Payload, RuntimeStatus } from "../shared/bridge.ts";

class Connection {
  private pending = new Map<
    string,
    {
      resolve: (value: Payload) => void;
      reject: (error: Error) => void;
      timer: NodeJS.Timeout;
    }
  >();
  private socket: Socket;
  constructor(path: string, expectedPID: number) {
    this.socket = connectRuntimeSocket(path, expectedPID);
    const decoder = new FrameDecoder();
    this.socket.on("data", (chunk) => {
      try {
        for (const value of decoder.push(chunk)) {
          if (!value || typeof value !== "object")
            throw new Error("INVALID_RESPONSE");
          const response = value as Payload;
          if (
            response.protocolVersion !== 1 ||
            typeof response.requestId !== "string" ||
            typeof response.ok !== "boolean"
          )
            throw new Error("INVALID_RESPONSE");
          const job = this.pending.get(response.requestId);
          if (!job) continue;
          this.pending.delete(response.requestId);
          clearTimeout(job.timer);
          if (
            response.ok &&
            response.data &&
            typeof response.data === "object" &&
            !Array.isArray(response.data)
          )
            job.resolve(response.data as Payload);
          else if (response.ok) {
            job.reject(new Error("INVALID_RESPONSE"));
            this.close();
          } else
            job.reject(
              new Error(
                String(
                  (response.error as Payload)?.code ?? "LOCAL_STORAGE_ERROR",
                ),
              ),
            );
        }
      } catch {
        this.close();
      }
    });
    this.socket.on("error", () => this.close());
    this.socket.on("close", () => {
      for (const job of this.pending.values()) {
        clearTimeout(job.timer);
        job.reject(new Error("RUNTIME_DISCONNECTED"));
      }
      this.pending.clear();
    });
  }
  request(method: string, payload: Payload = {}): Promise<Payload> {
    if (this.socket.destroyed)
      return Promise.reject(new Error("RUNTIME_DISCONNECTED"));
    return new Promise((resolve, reject) => {
      const requestId = randomUUID();
      const timer = setTimeout(
        () => {
          this.pending.delete(requestId);
          reject(new Error("RUNTIME_DISCONNECTED"));
          this.close();
        },
        method.startsWith("backup.") ? 120000 : 10000,
      );
      this.pending.set(requestId, { resolve, reject, timer });
      try {
        this.socket.write(
          encodeFrame({ protocolVersion: 1, requestId, method, payload }),
        );
      } catch {
        this.pending.delete(requestId);
        clearTimeout(timer);
        reject(new Error("RUNTIME_DISCONNECTED"));
      }
    });
  }
  close() {
    this.socket.destroy();
  }
}
export class RuntimeSupervisor {
  readonly directories = new DirectoryAccess();
  readonly status: RuntimeStatus = {
    status: "未启动",
    connected: false,
    nodePID: 0,
    pongCount: 0,
    connectionCount: 0,
    restartCount: 0,
    logs: [],
  };
  private child?: ChildProcessWithoutNullStreams;
  private connection?: Connection;
  private stopping = false;
  private worker?: Promise<void>;
  private generation?: string;
  private node: string;
  private entry: string;
  private dataDirectory?: string;
  constructor(node: string, entry: string, dataDirectory?: string) {
    this.node = node;
    this.entry = entry;
    this.dataDirectory = dataDirectory;
  }
  private log(event: string) {
    const line = `${new Date().toISOString()} [host] ${event}`;
    this.status.logs.push(line);
    this.status.logs = this.status.logs.slice(-100);
    console.error(line);
  }
  start() {
    this.worker ??= this.supervise();
  }
  private updateGeneration(value: unknown) {
    if (typeof value !== "string") return;
    if (this.generation && this.generation !== value) this.directories.close();
    this.generation = value;
  }
  private async supervise() {
    let attempt = 0;
    while (!this.stopping) {
      const directory = mkdtempSync(join(tmpdir(), "tandem-"));
      chmodSync(directory, 0o700);
      const path = join(directory, "runtime.sock"),
        token = randomBytes(32).toString("hex");
      try {
        this.status.status = "启动中";
        const child = spawn(this.node, [this.entry], { stdio: "pipe" });
        this.child = child;
        child.on("error", () => this.log("runtime_start_failed"));
        child.stderr.on("data", (chunk) => process.stderr.write(chunk));
        child.stdout.resume();
        this.status.nodePID = child.pid ?? 0;
        this.log(`runtime_started pid=${this.status.nodePID}`);
        child.stdin.on("error", () => {});
        child.stdin.write(
          JSON.stringify({
            socketPath: path,
            token,
            hostPid: process.pid,
            ...(this.dataDirectory
              ? { dataDirectory: this.dataDirectory }
              : {}),
          }) + "\n",
        );
        let failures = 0,
          healthy = 0;
        while (
          !this.stopping &&
          child.exitCode === null &&
          child.signalCode === null &&
          child.pid
        ) {
          try {
            if (!this.connection) {
              const client = new Connection(path, child.pid);
              this.connection = client;
              const hello = await client.request("hello", { token });
              if (
                hello.pid !== child.pid ||
                hello.arch !== "arm64" ||
                hello.nodeVersion !== "v24.22.2"
              )
                throw new Error("INVALID_PEER");
              this.updateGeneration(
                (await client.request("runtime.info")).generation,
              );
              for (const grant of this.directories.registrations()) {
                try {
                  await client.request("directory.register", grant);
                } catch (error) {
                  if (
                    error instanceof Error &&
                    error.message === "PROJECT_UNAVAILABLE"
                  )
                    this.directories.revoke(grant.id);
                  else throw error;
                }
              }
              this.status.connected = true;
              this.status.connectionCount++;
              this.log("ipc_connected");
            }
            const client = this.connection;
            const pong = await client.request("ping");
            if (pong.pong !== true || pong.pid !== child.pid)
              throw new Error("INVALID_PEER");
            const work = await client.request("native.next");
            this.updateGeneration(work.generation);
            for (const request of work.requests as Payload[])
              await client.request("native.result", {
                id: request.id,
                result: this.directories.execute(request),
              });
            this.status.pongCount++;
            failures = 0;
            if (++healthy >= 5) attempt = 0;
            this.status.status = "已连接 · Ping/Pong 正常";
            await delay(250);
          } catch {
            this.reconnect();
            if (this.stopping) break;
            this.status.status = "连接中断，正在重连";
            if (++failures >= 5) break;
            await delay(250 * 2 ** Math.min(failures - 1, 3));
          }
        }
      } catch {
        this.log("runtime_start_or_transport_failed");
      } finally {
        this.reconnect();
        await this.reap();
        rmSync(directory, { recursive: true, force: true });
      }
      if (!this.stopping) {
        this.status.restartCount++;
        const seconds = Math.min(30, 2 ** Math.min(attempt++, 5));
        this.status.status = `Runtime 已退出，${seconds} 秒后重启`;
        this.log(`runtime_restart delay=${seconds}s`);
        for (let tick = 0; tick < seconds * 10 && !this.stopping; tick++)
          await delay(100);
      }
    }
    this.status.status = "已停止";
  }
  private async reap() {
    const child = this.child;
    if (!child) return;
    if (!child.pid) {
      this.child = undefined;
      this.status.nodePID = 0;
      return;
    }
    child.stdin.end();
    if (child.exitCode === null && child.signalCode === null)
      child.kill("SIGTERM");
    for (
      let index = 0;
      index < 20 && child.exitCode === null && child.signalCode === null;
      index++
    )
      await delay(100);
    if (child.exitCode === null && child.signalCode === null) {
      child.kill("SIGKILL");
      await new Promise<void>((resolve) => child.once("exit", () => resolve()));
    }
    this.child = undefined;
    this.status.nodePID = 0;
  }
  async request(method: string, payload: Payload = {}) {
    if (!this.status.connected || !this.connection || this.stopping)
      throw new Error("RUNTIME_DISCONNECTED");
    const result = await this.connection.request(method, payload);
    if (method === "backup.restore") this.updateGeneration(result.generation);
    return result;
  }
  reconnect() {
    this.status.connected = false;
    this.connection?.close();
    this.connection = undefined;
  }
  injectCrash() {
    this.child?.kill("SIGKILL");
  }
  async authorize(path: string, projectId: string | null, renewing?: string) {
    const id = this.directories.authorize(path, projectId, renewing);
    try {
      await this.request(
        "directory.register",
        this.directories.registrations().find((grant) => grant.id === id)!,
      );
      return id;
    } catch (error) {
      this.directories.revoke(id);
      throw error;
    }
  }
  async stop() {
    if (this.stopping) {
      await this.worker;
      return;
    }
    this.stopping = true;
    this.reconnect();
    await this.worker;
    this.directories.close();
    this.log("runtime_stopped");
  }
}
