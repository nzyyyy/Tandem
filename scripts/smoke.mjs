import { spawn } from "node:child_process";
import { once } from "node:events";
import { resolve } from "node:path";
import assert from "node:assert/strict";
import {
  cpSync,
  mkdtempSync,
  readdirSync,
  realpathSync,
  rmSync,
} from "node:fs";
import { compile } from "./compile.mjs";
import electron from "electron";

const bundled = process.argv.includes("--bundled"),
  lifecycle = process.argv.includes("--lifecycle");
const directory = mkdtempSync("/tmp/tandem-electron-test-");
let timer;
try {
  let binary = electron,
    args = [resolve("dist/app/desktop/main.js")];
  if (bundled) {
    const app = `${directory}/Tandem.app`;
    cpSync("dist/Tandem.app", app, { recursive: true, verbatimSymlinks: true });
    const root = realpathSync(app);
    function checkLinks(path) {
      for (const entry of readdirSync(path, { withFileTypes: true })) {
        const child = `${path}/${entry.name}`;
        if (entry.isSymbolicLink())
          assert.ok(
            realpathSync(child).startsWith(`${root}/`),
            `External bundle link: ${child}`,
          );
        else if (entry.isDirectory()) checkLinks(child);
      }
    }
    checkLinks(app);
    binary = `${app}/Contents/MacOS/Tandem`;
    args = [];
  } else compile();
  const child = spawn(
    binary,
    [...args, lifecycle ? "--lifecycle-test" : "--smoke-test"],
    {
      cwd: directory,
      env: {
        ...process.env,
        PATH: "/usr/bin:/bin",
        NODE_PATH: "",
        TANDEM_NODE: process.execPath,
        TANDEM_TEST_DATA_DIR: `${directory}/live`,
      },
      stdio: ["ignore", "pipe", "pipe"],
    },
  );
  let stdout = "",
    stderr = "";
  child.stdout.on("data", (chunk) => {
    stdout += chunk;
    process.stdout.write(chunk);
  });
  child.stderr.on("data", (chunk) => {
    stderr += chunk;
    process.stderr.write(chunk);
  });
  timer = setTimeout(() => child.kill("SIGKILL"), 90000);
  const [code] = await once(child, "exit");
  assert.equal(code, 0);
  assert.match(
    stdout,
    lifecycle ? /PASS App lifecycle/ : /PASS Electron → Node/,
  );
  const pids = [...stderr.matchAll(/runtime_started pid=(\d+)/g)].map((match) =>
    Number(match[1]),
  );
  assert.ok(pids.length > 0);
  for (const pid of pids)
    assert.throws(() => process.kill(pid, 0), { code: "ESRCH" });
  if (lifecycle) {
    const { DatabaseSync } = await import("node:sqlite");
    const db = new DatabaseSync(`${directory}/live/tandem.sqlite`, {
      readOnly: true,
    });
    try {
      assert.equal(
        db.prepare("SELECT status FROM tasks").get().status,
        "completed",
      );
      assert.equal(
        db
          .prepare("SELECT status FROM runs WHERE request_key='lifecycle-hold'")
          .get().status,
        "interrupted",
      );
    } finally {
      db.close();
    }
  }
  console.log("PASS independent bundle and child-process cleanup");
} finally {
  clearTimeout(timer);
  rmSync(directory, { recursive: true, force: true });
}
