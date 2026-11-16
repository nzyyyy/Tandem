import { useRef, useState } from "react";
import { useAssistant } from "../store.tsx";
export function useAction() {
  const { store } = useAssistant();
  const [busy, setBusy] = useState(false);
  const running = useRef(false);
  async function run<T>(action: () => Promise<T>): Promise<T | undefined> {
    if (running.current) return;
    running.current = true;
    setBusy(true);
    try {
      return await action();
    } catch (error) {
      store.showError(error);
      return undefined;
    } finally {
      running.current = false;
      setBusy(false);
    }
  }
  return { busy, run };
}
