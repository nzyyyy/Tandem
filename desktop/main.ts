import {
  app,
  BrowserWindow,
  Menu,
  ipcMain,
  dialog,
  shell,
  clipboard,
  nativeTheme,
} from "electron";
import { join, dirname, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { randomUUID } from "node:crypto";
import { RuntimeSupervisor } from "./runtime.ts";
import { PreferenceStore } from "./preferences.ts";
import { scopedPayload } from "./security.ts";
import { allowsExternal } from "../shared/conversation.ts";
import type { Payload, Preferences, Reply } from "../shared/bridge.ts";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const testing =
  process.argv.includes("--smoke-test") ||
  process.argv.includes("--lifecycle-test");
const dataDirectory = testing ? process.env.TANDEM_TEST_DATA_DIR : undefined;
if (testing && !dataDirectory) throw new Error("TEST_DATA_DIRECTORY_REQUIRED");
app.setName("Tandem");
if (testing) app.setPath("userData", join(dataDirectory!, "electron-ui"));
if (!app.requestSingleInstanceLock()) app.quit();
else {
  const runtime = new RuntimeSupervisor(
    app.isPackaged
      ? join(root, "node")
      : (process.env.TANDEM_NODE ?? join(root, "node")),
    join(root, "runtime/main.js"),
    dataDirectory,
  );
  const preferences = new PreferenceStore(app.getPath("userData"), !testing);
  const surfaces = new Map<number, string>();
  const readyWindows = new Set<number>();
  const devURL = !app.isPackaged ? process.env.TANDEM_RENDERER_URL : undefined;
  const rendererURL = pathToFileURL(join(root, "renderer/index.html")).href;
  const validURL = (url: string) =>
    devURL ? url === devURL || url === devURL + "/" : url === rendererURL;
  let quitting = false,
    quitReady = false;
  function createWindow() {
    const claimed = new Set(surfaces.values());
    const preferred =
      surfaces.size === 0 ? preferences.value.lastSurface : undefined;
    const surface =
      preferred && !claimed.has(preferred) ? preferred : randomUUID();
    const win = new BrowserWindow({
      title: "Tandem",
      width: 1280,
      height: 820,
      minWidth: 860,
      minHeight: 600,
      titleBarStyle: "hiddenInset",
      backgroundColor: nativeTheme.shouldUseDarkColors ? "#1f1f1f" : "#ffffff",
      show: false,
      webPreferences: {
        preload: join(root, "desktop/preload.cjs"),
        contextIsolation: true,
        nodeIntegration: false,
        sandbox: true,
        spellcheck: false,
      },
    });
    const contentsId = win.webContents.id;
    surfaces.set(contentsId, surface);
    win.on("focus", () => preferences.update({ lastSurface: surface }));
    win.on("closed", () => {
      surfaces.delete(contentsId);
      readyWindows.delete(contentsId);
    });
    win.once("ready-to-show", () => win.show());
    win.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
    win.webContents.on("will-navigate", (event, url) => {
      if (!validURL(url)) event.preventDefault();
    });
    win.webContents.session.setPermissionRequestHandler(
      (_contents, _permission, callback) => callback(false),
    );
    win.webContents.on("will-attach-webview", (event) =>
      event.preventDefault(),
    );
    if (devURL) void win.loadURL(devURL);
    else void win.loadFile(join(root, "renderer/index.html"));
    return win;
  }
  function host(event: Electron.IpcMainInvokeEvent) {
    const win = BrowserWindow.fromWebContents(event.sender);
    if (
      !win ||
      event.senderFrame !== event.sender.mainFrame ||
      !validURL(event.senderFrame.url) ||
      !surfaces.has(event.sender.id)
    )
      throw new Error("UNAUTHORIZED");
    return { win, surfaceId: surfaces.get(event.sender.id)! };
  }
  const reply = async (
    action: () => Promise<unknown> | unknown,
  ): Promise<Reply> => {
    try {
      return { ok: true, data: await action() };
    } catch (error) {
      const message = error instanceof Error ? error.message : "";
      return {
        ok: false,
        error: /^[A-Z][A-Z0-9_]*$/.test(message)
          ? message
          : "LOCAL_STORAGE_ERROR",
      };
    }
  };
  ipcMain.handle("tandem:bootstrap", (event) => {
    const { surfaceId } = host(event);
    return { surfaceId, preferences: preferences.value };
  });
  ipcMain.handle("tandem:ready", (event) => {
    host(event);
    readyWindows.add(event.sender.id);
  });
  ipcMain.handle("tandem:status", (event) => {
    host(event);
    return runtime.status;
  });
  ipcMain.handle("tandem:request", (event, method: unknown, payload: unknown) =>
    reply(() => {
      const { surfaceId } = host(event);
      return runtime.request(
        String(method),
        scopedPayload(method, payload, surfaceId),
      );
    }),
  );
  ipcMain.handle(
    "tandem:directory",
    (event, projectId: unknown, renewing: unknown) =>
      reply(async () => {
        const { win } = host(event);
        if (
          (projectId !== null && typeof projectId !== "string") ||
          (renewing !== undefined && typeof renewing !== "string")
        )
          throw new Error("INVALID_REQUEST");
        const result = await dialog.showOpenDialog(win, {
          properties: ["openDirectory"],
          buttonLabel: "授权只读",
        });
        if (result.canceled) return null;
        return runtime.authorize(result.filePaths[0]!, projectId, renewing);
      }),
  );
  ipcMain.handle("tandem:revoke", (event, id: unknown) =>
    reply(async () => {
      host(event);
      if (typeof id !== "string") throw new Error("INVALID_REQUEST");
      runtime.directories.revoke(id);
      return runtime.request("directory.revoke", { id });
    }),
  );
  ipcMain.handle("tandem:backup", (event, action: unknown) =>
    reply(async () => {
      const { win } = host(event);
      if (action === "export") {
        const result = await dialog.showSaveDialog(win, {
          defaultPath: `Tandem-${new Date().toISOString().replaceAll(":", "-")}-backup.json`,
          filters: [{ name: "JSON", extensions: ["json"] }],
        });
        if (result.canceled || !result.filePath) return null;
        await runtime.request("backup.export", { path: result.filePath });
        return { path: result.filePath };
      }
      if (action !== "preview") throw new Error("INVALID_REQUEST");
      const result = await dialog.showOpenDialog(win, {
        properties: ["openFile"],
        filters: [{ name: "JSON", extensions: ["json"] }],
      });
      return result.canceled
        ? null
        : runtime.request("backup.preview", { path: result.filePaths[0] });
    }),
  );
  ipcMain.handle("tandem:preferences", (event, value: unknown) => {
    host(event);
    if (!value || typeof value !== "object") throw new Error("INVALID_REQUEST");
    const input = value as Payload;
    const updates: Partial<Preferences> = {};
    if (["auto", "light", "dark"].includes(String(input.appearance)))
      updates.appearance = input.appearance as Preferences["appearance"];
    if (
      typeof input.sidebarWidth === "number" &&
      Number.isFinite(input.sidebarWidth)
    )
      updates.sidebarWidth = input.sidebarWidth;
    preferences.update(updates);
    nativeTheme.themeSource =
      preferences.value.appearance === "auto"
        ? "system"
        : preferences.value.appearance;
    for (const win of BrowserWindow.getAllWindows())
      win.webContents.send("tandem:preferences-changed", {
        appearance: preferences.value.appearance,
        sidebarWidth: preferences.value.sidebarWidth,
      });
  });
  ipcMain.handle("tandem:position", (event, value: unknown) => {
    const { surfaceId } = host(event);
    const input = value as Payload;
    if (
      !input ||
      typeof input.generation !== "string" ||
      !Number.isSafeInteger(input.sequence) ||
      Number(input.sequence) <= 0 ||
      typeof input.atBottom !== "boolean" ||
      typeof input.projectFilter !== "string"
    )
      throw new Error("INVALID_REQUEST");
    preferences.update({
      positions: {
        ...preferences.value.positions,
        [surfaceId]: input as Preferences["positions"][string],
      },
    });
  });
  ipcMain.handle("tandem:external", async (event, url: unknown) => {
    host(event);
    if (typeof url !== "string" || !allowsExternal(url))
      throw new Error("INVALID_REQUEST");
    await shell.openExternal(url);
  });
  ipcMain.handle("tandem:copy", (event, text: unknown) => {
    host(event);
    if (typeof text !== "string" || text.length > 8 * 1024 * 1024)
      throw new Error("INVALID_REQUEST");
    clipboard.writeText(text);
  });
  ipcMain.handle("tandem:diagnostics", (event, action: unknown) => {
    host(event);
    if (action === "crash") runtime.injectCrash();
    else if (action === "reconnect") runtime.reconnect();
    else throw new Error("INVALID_REQUEST");
  });
  app.on("second-instance", () => {
    const win = BrowserWindow.getAllWindows()[0];
    if (win) {
      win.restore();
      win.focus();
    } else createWindow();
  });
  app.on("activate", () => {
    if (!BrowserWindow.getAllWindows().length && !testing) createWindow();
  });
  app.on("window-all-closed", () => {});
  app.on("before-quit", (event) => {
    if (quitReady) return;
    event.preventDefault();
    if (quitting) return;
    quitting = true;
    void runtime.stop().finally(() => {
      quitReady = true;
      app.quit();
    });
  });
  app
    .whenReady()
    .then(async () => {
      nativeTheme.themeSource =
        preferences.value.appearance === "auto"
          ? "system"
          : preferences.value.appearance;
      Menu.setApplicationMenu(
        Menu.buildFromTemplate([
          { role: "appMenu" },
          {
            label: "文件",
            submenu: [
              {
                label: "新建窗口",
                accelerator: "CmdOrCtrl+N",
                click: () => createWindow(),
              },
              { role: "close" },
            ],
          },
          { role: "editMenu" },
          { role: "viewMenu" },
          { role: "windowMenu" },
        ]),
      );
      runtime.start();
      if (testing) {
        try {
          const { selfTest } = await import("./e2e/self-test.ts");
          await selfTest(
            runtime,
            createWindow,
            process.argv.includes("--lifecycle-test"),
            (window) => readyWindows.has(window.webContents.id),
          );
        } catch (error) {
          console.error(error);
          process.exitCode = 1;
        }
        app.quit();
      } else createWindow();
    })
    .catch((error) => {
      console.error(error);
      app.exit(1);
    });
}
