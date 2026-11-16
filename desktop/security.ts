import type { Payload } from "../shared/bridge.ts";
export const rendererMethods = new Set([
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
]);
export function scopedPayload(
  method: unknown,
  payload: unknown,
  surfaceId: string,
): Payload {
  if (
    typeof method !== "string" ||
    !rendererMethods.has(method) ||
    !payload ||
    typeof payload !== "object" ||
    Array.isArray(payload) ||
    Buffer.byteLength(JSON.stringify(payload)) > 8 * 1024 * 1024
  )
    throw new Error("INVALID_REQUEST");
  return { ...(payload as Payload), surfaceId };
}
