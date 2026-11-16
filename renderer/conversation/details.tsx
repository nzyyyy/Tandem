import { useEffect, useState } from "react";
import { X } from "lucide-react";
import type { CorrectionHistory, RunContext, TimelineMessage } from "../../shared/model.ts";
import { rpc, useAssistant } from "../store.tsx";
import { IconButton, Notice } from "../components/ui.tsx";
import { ContextFragments } from "../components/context-fragments.tsx";
import { CorrectMenu } from "./message.tsx";

export function Details({ message, onClose }: { message: TimelineMessage; onClose: () => void }) {
  const { snapshot, store } = useAssistant();
  const [context, setContext] = useState<RunContext>(),
    [history, setHistory] = useState<CorrectionHistory>(),
    [error, setError] = useState("");
  useEffect(() => {
    let alive = true;
    setContext(undefined);
    setHistory(undefined);
    setError("");
    void Promise.allSettled([
      message.snapshotId
        ? rpc<RunContext>("snapshot.get", { id: message.snapshotId })
        : Promise.resolve(undefined),
      message.interactionId
        ? rpc<CorrectionHistory>("interaction.history", {
            interactionId: message.interactionId,
          })
        : Promise.resolve(undefined),
    ]).then(([a, b]) => {
      if (!alive) return;
      if (a.status === "fulfilled") setContext(a.value);
      else setError("当前范围无法查看此快照，请先明确切换项目或模式。");
      if (b.status === "fulfilled") setHistory(b.value);
      else setError("无法读取纠正记录，请重试。");
    });
    return () => {
      alive = false;
    };
  }, [
    message.id,
    message.snapshotId,
    message.interactionId,
    message.interactionVersion,
    snapshot?.focus.version,
  ]);
  return (
    <aside className="inspector">
      <div className="row inspector-header">
        <h3>消息详情</h3>
        <span className="spacer" />
        <IconButton label="关闭消息详情" onClick={onClose}>
          <X size={16} />
        </IconButton>
      </div>
      <div className="inspector-content stack">
        <h3>{message.role === "user" ? "你的消息" : "Tandem 的回答"}</h3>
        <p>
          {snapshot?.sessions.find((session) => session.id === message.sessionId)?.title ??
            "历史话题"}
        </p>
        <p className="caption">
          {message.modelName} · {store.connectionTitle(message.connectionId)}
        </p>
        <p className="prewrap detail-excerpt">{message.content}</p>
        <h3>项目归属</h3>
        <p>{store.projectTitle(message.projectId)}</p>
        {message.interactionId && <CorrectMenu message={message} />}
        <p className="caption">{message.routeReason}</p>
        <Notice error>{error}</Notice>
        {context && (
          <>
            <h3>执行上下文</h3>
            <p className="caption">
              {store.projectTitle(context.projectId)} · {context.mode}
            </p>
            <ContextFragments context={context} />
          </>
        )}
        {history && (
          <>
            <h3>纠正记录</h3>
            {history.corrections.map((item) => (
              <p className="caption" key={item.id}>
                {store.projectTitle(item.from_project)} → {store.projectTitle(item.to_project)} ·
                修订 {item.version} · {new Date(item.created_at).toLocaleString()}
              </p>
            ))}
          </>
        )}
      </div>
    </aside>
  );
}
