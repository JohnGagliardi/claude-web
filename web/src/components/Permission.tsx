import { useState } from "react";
import type { PendingPermission } from "../api";
import { toolSummary } from "../transcript";
import { Markdown } from "./Markdown";

export type Reply =
  | { decision: "allow" | "always"; updatedInput?: Record<string, unknown> }
  | { decision: "deny"; message?: string };

type Q = { question: string; header?: string; multiSelect?: boolean; options: { label: string; description?: string }[] };

function Questions({ p, onReply }: { p: PendingPermission; onReply: (r: Reply) => void }) {
  const qs: Q[] = p.input.questions ?? [];
  const [picked, setPicked] = useState<Record<string, string[]>>({});
  const [other, setOther] = useState<Record<string, string>>({});
  const toggle = (q: Q, label: string) =>
    setPicked((s) => {
      const cur = s[q.question] ?? [];
      const next = q.multiSelect ? (cur.includes(label) ? cur.filter((l) => l !== label) : [...cur, label]) : [label];
      return { ...s, [q.question]: next };
    });
  const answers = Object.fromEntries(
    qs.map((q) => [q.question, [...(picked[q.question] ?? []), other[q.question]].filter(Boolean).join(", ")]),
  );
  const complete = qs.every((q) => answers[q.question]);
  return (
    <div className="perm">
      {qs.map((q) => (
        <div key={q.question} className="question">
          {q.header && <span className="chip">{q.header}</span>}
          <div className="q-text">{q.question}</div>
          {q.options.map((o) => (
            <label key={o.label} className="option">
              <input
                type={q.multiSelect ? "checkbox" : "radio"}
                name={q.question}
                checked={(picked[q.question] ?? []).includes(o.label)}
                onChange={() => toggle(q, o.label)}
              />
              <span>
                <b>{o.label}</b>
                {o.description && <span className="muted"> — {o.description}</span>}
              </span>
            </label>
          ))}
          <input
            className="other"
            placeholder="Other…"
            value={other[q.question] ?? ""}
            onChange={(e) => setOther({ ...other, [q.question]: e.target.value })}
          />
        </div>
      ))}
      <div className="perm-actions">
        <button className="primary" disabled={!complete} onClick={() => onReply({ decision: "allow", updatedInput: { ...p.input, answers } })}>
          Submit
        </button>
        <button onClick={() => onReply({ decision: "deny", message: "The user dismissed the question." })}>Dismiss</button>
      </div>
    </div>
  );
}

export function PermissionCard({ p, onReply }: { p: PendingPermission; onReply: (r: Reply) => void }) {
  const [note, setNote] = useState("");
  if (p.toolName === "AskUserQuestion") return <Questions p={p} onReply={onReply} />;
  if (p.toolName === "ExitPlanMode") {
    return (
      <div className="perm">
        <div className="perm-title">Ready to leave plan mode and start working?</div>
        {p.input.plan && <Markdown text={String(p.input.plan)} />}
        <input className="other" placeholder="Feedback (optional, sent if you keep planning)" value={note} onChange={(e) => setNote(e.target.value)} />
        <div className="perm-actions">
          <button className="primary" onClick={() => onReply({ decision: "allow" })}>Approve plan</button>
          <button onClick={() => onReply({ decision: "deny", message: note || "Keep planning." })}>Keep planning</button>
        </div>
      </div>
    );
  }
  return (
    <div className="perm">
      <div className="perm-title">
        Allow <b>{p.toolName}</b>?
      </div>
      <pre className="perm-input">{toolSummary(p.toolName, p.input) || JSON.stringify(p.input, null, 2)}</pre>
      {p.blockedPath && <div className="muted">Path outside allowed folders: {p.blockedPath}</div>}
      <input className="other" placeholder="Tell Claude what to do instead (optional)" value={note} onChange={(e) => setNote(e.target.value)} />
      <div className="perm-actions">
        <button className="primary" onClick={() => onReply({ decision: "allow" })}>Allow</button>
        {!!p.suggestions?.length && <button onClick={() => onReply({ decision: "always" })}>Always allow</button>}
        <button onClick={() => onReply({ decision: "deny", message: note || undefined })}>Deny</button>
      </div>
    </div>
  );
}
