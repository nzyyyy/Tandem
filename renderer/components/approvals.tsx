import { useAssistant } from "../store.tsx";
import { Button } from "./ui.tsx";
import { useAction } from "./actions.ts";

export function Approvals({ runId }: { runId?: string }) {
  const { store, snapshot } = useAssistant();
  const { busy, run } = useAction();
  return (
    <>
      {snapshot?.activity.approvals.map((approval) => {
        if (runId && approval.run_id !== runId) return null;
        let reason = "读取本地资料";
        try {
          reason = JSON.parse(approval.args).reason ?? reason;
        } catch {
          /* Use the safe default. */
        }
        return (
          <section className="card stack" key={approval.id}>
            <h3>待审批 · 选择只读目录</h3>
            <p>{reason}</p>
            <p className="caption">
              工具：{approval.name} ·{" "}
              {store.projectTitle(
                snapshot.activity.runs.find((item) => item.id === approval.run_id)?.project_id,
              )}
            </p>
            <p className="caption">
              批准后由你选择目录；只允许读取 UTF-8
              文本，不修改源文件。文件片段可能发送给所选模型。审批十分钟有效。
            </p>
            <div className="row">
              <Button
                disabled={busy || Date.now() >= approval.expires_at}
                onClick={() => void run(() => store.approve(approval, true))}
              >
                批准一次并选择目录
              </Button>
              <Button
                disabled={busy}
                onClick={() => void run(() => store.approve(approval, false))}
              >
                拒绝
              </Button>
            </div>
          </section>
        );
      })}
    </>
  );
}
