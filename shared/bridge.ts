import type { ConversationPosition } from "./conversation.ts";

export type Payload = Record<string, unknown>;
export type RuntimeStatus = {
  status: string;
  connected: boolean;
  nodePID: number;
  pongCount: number;
  connectionCount: number;
  restartCount: number;
  logs: string[];
};
export type Preferences = {
  appearance: "auto" | "light" | "dark";
  sidebarWidth: number;
  lastSurface?: string;
  positions: Record<string, ConversationPosition>;
};
export type Bootstrap = { surfaceId: string; preferences: Preferences };
export type Reply = { ok: true; data: unknown } | { ok: false; error: string };
export interface DesktopBridge {
  bootstrap(): Promise<Bootstrap>;
  ready(): Promise<void>;
  onPreferences(
    listener: (value: Pick<Preferences, "appearance" | "sidebarWidth">) => void,
  ): () => void;
  request(method: string, payload?: Payload): Promise<Reply>;
  status(): Promise<RuntimeStatus>;
  chooseDirectory(projectId: string | null, renewing?: string): Promise<Reply>;
  revokeDirectory(id: string): Promise<Reply>;
  backup(action: "export" | "preview"): Promise<Reply>;
  preferences(value: Partial<Pick<Preferences, "appearance" | "sidebarWidth">>): Promise<void>;
  position(value: ConversationPosition): Promise<void>;
  openExternal(url: string): Promise<void>;
  copy(text: string): Promise<void>;
  diagnostics(action: "reconnect" | "crash"): Promise<void>;
}
declare global {
  interface Window {
    tandem: DesktopBridge;
  }
}
