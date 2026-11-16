// Cross-process wire shapes. Keep this file free of Node/browser imports so the
// runtime, Electron host, renderer and tests can all include it.
export type ModelSelection = { connectionId: string; modelName: string };
export type ModelProtocol = "openai" | "anthropic";
export type ApiType = "chat_completions" | "responses" | "messages";
export type Connection = {
  id: string;
  name?: string;
  protocol: ModelProtocol;
  apiType: ApiType;
  url: string;
  key: string;
  modelNames: string[];
};
export type AppConfig = {
  schemaVersion: 1;
  modelConnections: Connection[];
  defaultModel: ModelSelection | null;
};
export type RestorePreview = {
  token: string;
  createdAt: string;
  appVersion: string;
  databaseSchema: number;
  messages: number;
  projects: number;
  memories: number;
  tasks: number;
  attachments: number;
};
export const rendererMethods = [
  "state.get",
  "timeline.list",
  "session.focus",
  "context.set",
  "message.send",
  "message.retry",
  "message.cancel",
  "project.create",
  "project.update",
  "project.deletePreview",
  "project.delete",
  "interaction.confirm",
  "interaction.correct",
  "interaction.history",
  "snapshot.get",
  "activity.get",
  "approval.decide",
  "run.continue",
  "task.history",
  "result.get",
  "memory.list",
  "memory.get",
  "memory.save",
  "memory.confirm",
  "memory.update",
  "memory.forget",
  "memory.allow",
  "config.get",
  "config.save",
  "backup.cancel",
  "backup.restore",
] as const;
export type RendererMethod = (typeof rendererMethods)[number];
