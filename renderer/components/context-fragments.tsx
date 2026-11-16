import { useAssistant } from "../store.tsx";
import type { RunContext } from "../../shared/model.ts";

export function ContextFragments({ context }: { context: RunContext }) {
  const { store } = useAssistant();
  return (
    <div className="stack">
      {context.fragments.map((fragment, index) => (
        <section className="stack tight" key={`${fragment.sourceId}:${index}`}>
          <h3>
            {fragment.sourceType === "memory"
              ? "长期记忆"
              : fragment.role === "user"
                ? "用户输入"
                : fragment.role === "tool"
                  ? "工具结果"
                  : "回答"}
          </h3>
          <p className="caption">{store.projectTitle(fragment.projectId)}</p>
          <p className="prewrap">{fragment.content}</p>
          <p className="caption monospace prewrap">
            来源 {fragment.sourceId}
            {"\n"}版本 {fragment.sourceVersion}
          </p>
        </section>
      ))}
    </div>
  );
}
