import { rendererMethods } from "../runtime/src/contract.ts";
import type { Payload } from "../shared/bridge.ts";
const allowed = new Set<string>(rendererMethods);
export function scopedPayload(method: unknown, payload: unknown, surfaceId: string): Payload {
  if (
    typeof method !== "string" ||
    !allowed.has(method) ||
    !payload ||
    typeof payload !== "object" ||
    Array.isArray(payload) ||
    Buffer.byteLength(JSON.stringify(payload)) > 8 * 1024 * 1024
  )
    throw new Error("INVALID_REQUEST");
  return { ...(payload as Payload), surfaceId };
}
