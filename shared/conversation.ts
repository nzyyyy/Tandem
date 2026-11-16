import type { TimelineMessage, AssistantSnapshot } from "./model.ts";

export type ConversationPosition = {
  generation: string;
  sequence: number;
  atBottom: boolean;
  projectFilter: string;
};
export function mergeMessages(
  current: TimelineMessage[],
  incoming: TimelineMessage[],
) {
  const messages = new Map(current.map((message) => [message.id, message]));
  for (const message of incoming) messages.set(message.id, message);
  return [...messages.values()].sort((a, b) => a.sequence - b.sequence);
}
export function activeQuestion(
  messages: TimelineMessage[],
  visibleSequence: number | undefined,
  atBottom: boolean,
) {
  return messages.findLast(
    (message) =>
      message.role === "user" &&
      (atBottom ||
        (visibleSequence !== undefined && message.sequence <= visibleSequence)),
  )?.sequence;
}
export function applySnapshot(
  current: TimelineMessage[],
  previousGeneration: string | undefined,
  state: AssistantSnapshot,
) {
  return mergeMessages(previousGeneration === state.generation ? current : [], [
    ...state.messages,
    ...state.changedMessages,
  ]);
}
export function allowsExternal(value: string) {
  try {
    const url = new URL(value);
    return (
      ["http:", "https:"].includes(url.protocol) &&
      !!url.hostname &&
      !url.username &&
      !url.password
    );
  } catch {
    return false;
  }
}
export const modelId = (
  value: { connectionId: string; modelName: string } | null,
) => (value ? `${value.connectionId}\0${value.modelName}` : "");
export function modelSelection(value: string) {
  if (!value) return null;
  const [connectionId, modelName] = value.split("\0");
  return { connectionId, modelName };
}
export const executionStatus = (value: string) =>
  ({
    queued: "排队",
    running: "执行中",
    waiting_approval: "等待审批",
    paused: "预算暂停",
    completed: "已完成",
    failed: "失败",
    cancelled: "已取消",
    interrupted: "已中断",
    open: "未完成",
  })[value] ?? value;
