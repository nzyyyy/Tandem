const { contextBridge, ipcRenderer } =
  require("electron") as typeof import("electron");
import type { DesktopBridge } from "../shared/bridge.js";
const bridge: DesktopBridge = {
  bootstrap: () => ipcRenderer.invoke("tandem:bootstrap"),
  ready: () => ipcRenderer.invoke("tandem:ready"),
  onPreferences: (listener) => {
    const receive = (
      _event: Electron.IpcRendererEvent,
      value: Parameters<typeof listener>[0],
    ) => listener(value);
    ipcRenderer.on("tandem:preferences-changed", receive);
    return () => {
      ipcRenderer.removeListener("tandem:preferences-changed", receive);
    };
  },
  request: (method, payload = {}) =>
    ipcRenderer.invoke("tandem:request", method, payload),
  status: () => ipcRenderer.invoke("tandem:status"),
  chooseDirectory: (projectId, renewing) =>
    ipcRenderer.invoke("tandem:directory", projectId, renewing),
  revokeDirectory: (id) => ipcRenderer.invoke("tandem:revoke", id),
  backup: (action) => ipcRenderer.invoke("tandem:backup", action),
  preferences: (value) => ipcRenderer.invoke("tandem:preferences", value),
  position: (value) => ipcRenderer.invoke("tandem:position", value),
  openExternal: (url) => ipcRenderer.invoke("tandem:external", url),
  copy: (text) => ipcRenderer.invoke("tandem:copy", text),
  diagnostics: (action) => ipcRenderer.invoke("tandem:diagnostics", action),
};
contextBridge.exposeInMainWorld("tandem", bridge);
