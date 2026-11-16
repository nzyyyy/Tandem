import { useState } from "react";
import type { PendingInteraction } from "../../shared/model.ts";
import { useAssistant } from "../store.tsx";
import { Button, Picker } from "../components/ui.tsx";
import { useAction } from "../components/actions.ts";

export function Pending({ interaction }: { interaction: PendingInteraction }) {
  const { store, snapshot } = useAssistant();
  const [session, setSession] = useState("");
  const { busy, run } = useAction();
  const confirm = (sessionId: string | null) =>
    run(() =>
      store.perform("interaction.confirm", {
        interactionId: interaction.id,
        expectedVersion: interaction.version,
        expectedFocusVersion: snapshot?.focus.version,
        sessionId,
      }),
    );
  return (
    <section className="card selection stack">
      <h3>待确认话题</h3>
      <p>{interaction.input}</p>
      <p className="caption">{interaction.route.reason}</p>
      {interaction.route.candidates.map((candidate) => (
        <div className="stack tight" key={candidate.sessionId}>
          <Button
            disabled={busy}
            onClick={() => void confirm(candidate.sessionId)}
          >
            {candidate.title}
          </Button>
          <p className="caption">
            {store.projectTitle(candidate.projectId)} · {candidate.reason} ·{" "}
            {new Date(candidate.updatedAt).toLocaleString()}
          </p>
        </div>
      ))}
      <div className="row wrap">
        <Picker
          label="其他话题"
          value={session}
          onChange={setSession}
          options={[
            { value: "", label: "新建话题" },
            ...(snapshot?.sessions ?? []).map((item) => ({
              value: item.id,
              label: item.title,
            })),
          ]}
        />
        <Button disabled={busy} onClick={() => void confirm(session || null)}>
          确认归属并发送
        </Button>
      </div>
    </section>
  );
}
