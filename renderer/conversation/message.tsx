import { ChevronDown, Ellipsis } from "lucide-react";
import type { TimelineMessage } from "../../shared/model.ts";
import { errorText } from "../../shared/errors.ts";
import { useAssistant } from "../store.tsx";
import {
  Button,
  Menu,
  MenuItem,
  MenuSub,
} from "../components/ui.tsx";
import { Markdown } from "../components/markdown.tsx";

export function CorrectMenu({ message }: { message: TimelineMessage }) {
  return (
    <Menu
      label="纠正项目归属"
      trigger={
        <>
          纠正项目归属 <ChevronDown size={12} />
        </>
      }
    >
      <CorrectionItems message={message} />
    </Menu>
  );
}
function CorrectionItems({ message }: { message: TimelineMessage }) {
  const { store, snapshot } = useAssistant();
  return (
    <>
      <MenuItem
        onSelect={() =>
          void store.perform("interaction.correct", {
            interactionId: message.interactionId,
            expectedVersion: message.interactionVersion,
            projectId: null,
          })
        }
      >
        未关联项目
      </MenuItem>
      {snapshot?.projects
        .filter((project) => project.status === "open")
        .map((project) => (
          <MenuItem
            key={project.id}
            onSelect={() =>
              void store.perform("interaction.correct", {
                interactionId: message.interactionId,
                expectedVersion: message.interactionVersion,
                projectId: project.id,
              })
            }
          >
            {project.title}
          </MenuItem>
        ))}
    </>
  );
}
export function Message({
  message,
  onDetails,
}: {
  message: TimelineMessage;
  onDetails: () => void;
}) {
  const { store, selectedModel, sending } = useAssistant();
  const user = message.role === "user";
  return (
    <div className={`message ${user ? "user" : "assistant"}`}>
      <div className="message-body stack">
        {!user && (
          <div className="row message-author">
            <span className="tandem-symbol">◐</span>
            <strong>Tandem</strong>
            <span
              className="caption"
              title={`${message.modelName} · ${store.connectionTitle(message.connectionId)}`}
            >
              {message.modelName}
            </span>
          </div>
        )}
        {message.content &&
          (user ? (
            <p className="user-text">{message.content}</p>
          ) : (
            <Markdown source={message.content} />
          ))}
        {!user &&
          message.executionInteractionVersion !==
            message.interactionVersion && (
            <section className="card stack tight">
              <p className="caption">
                原回答使用：{store.projectTitle(message.executionProjectId)}
                。更改归属不会改写历史上下文。
              </p>
              {message.runId && (
                <Button
                  disabled={sending}
                  onClick={() => void store.retry(message.runId!)}
                >
                  按当前归属重新处理
                </Button>
              )}
            </section>
          )}
        {message.status && message.status !== "completed" && (
          <div className="stack tight">
            {["queued", "running"].includes(message.status) ? (
              <div className="row caption">
                <span className="spinner" />
                {message.status === "queued" ? "排队中" : "正在生成…"}
                <Button
                  kind="plain"
                  onClick={() =>
                    void store.perform("message.cancel", {
                      runId: message.runId,
                    })
                  }
                >
                  停止
                </Button>
              </div>
            ) : message.status === "waiting_approval" ? (
              <p className="caption">等待目录授权，请在审批卡片中处理。</p>
            ) : message.status === "paused" ? (
              <p className="caption">
                执行已暂停，请在 Activity 查看进度与预算。
              </p>
            ) : (
              <>
                <p
                  className={
                    message.status === "cancelled" ? "caption" : "error"
                  }
                >
                  {errorText(message.errorCode ?? "INTERRUPTED")}
                </p>
                {message.runId && (
                  <Button
                    disabled={sending}
                    onClick={() => void store.retry(message.runId!)}
                  >
                    {selectedModel ? "使用所选模型重试" : "使用原模型重试"}
                  </Button>
                )}
              </>
            )}
          </div>
        )}
      </div>
      <div className="row message-meta">
        <span>{store.projectTitle(message.projectId)}</span>
        <Button kind="plain" onClick={onDetails}>
          详情与来源
        </Button>
        <Menu label="消息操作" trigger={<Ellipsis size={17} />}>
          <MenuItem onSelect={() => void window.tandem.copy(message.content)}>
            {user ? "复制消息" : "复制 Markdown"}
          </MenuItem>
          <MenuItem onSelect={onDetails}>消息详情与来源</MenuItem>
          {message.interactionId && (
            <MenuSub title="纠正项目归属">
              <CorrectionItems message={message} />
            </MenuSub>
          )}
        </Menu>
      </div>
    </div>
  );
}
