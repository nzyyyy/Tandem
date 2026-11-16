import { spawn } from "node:child_process";
import { createServer } from "vite";
import electron from "electron";
import { resolve } from "node:path";
import { compile } from "./compile.mjs";
compile();
const vite = await createServer();
await vite.listen();
const child = spawn(electron, [resolve("dist/app/desktop/main.js")], {
  stdio: "inherit",
  env: {
    ...process.env,
    TANDEM_NODE: process.execPath,
    TANDEM_RENDERER_URL: "http://127.0.0.1:5173",
  },
});
const stop = () => {
  child.kill("SIGTERM");
};
process.once("SIGINT", stop);
process.once("SIGTERM", stop);
child.once("exit", async (code) => {
  await vite.close();
  process.exitCode = code ?? 1;
});
