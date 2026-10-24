import { useState } from "react";
import { api, type PermissionMode, type Schedule, type SessionInfo } from "../api";

const PRESETS: [string, string][] = [
  ["Every weekday at 9:00", "0 9 * * 1-5"],
  ["Every day at 8:00", "0 8 * * *"],
  ["Every hour", "0 * * * *"],
  ["Every 15 minutes", "*/15 * * * *"],
  ["Mondays at 9:00", "0 9 * * 1"],
];

type Draft = Omit<Schedule, "id" | "runs" | "nextRun"> & { id?: string };

const blank = (cwd: string): Draft => ({
  name: "",
  cron: PRESETS[0][1],
  prompt: "",
  cwd,
  target: "new",
  permissionMode: "default",
  enabled: true,
});

const when = (ms?: number) => (ms ? new Date(ms).toLocaleString() : "—");

function Editor(props: { draft: Draft; projects: string[]; sessions: SessionInfo[]; onDone: () => void; onToast: (t: string) => void }) {
  const [d, setD] = useState<Draft>(props.draft);
  const set = (patch: Partial<Draft>) => setD({ ...d, ...patch });
  const save = async () => {
    try {
      await api("/schedules", { json: d });
      props.onDone();
    } catch (e) {
      props.onToast((e as Error).message);
    }
  };
  const folderSessions = props.sessions.filter((s) => s.cwd === d.cwd).slice(0, 50);
  return (
    <div className="sched-editor">
      <label>
        Name
        <input value={d.name} onChange={(e) => set({ name: e.target.value })} placeholder="Morning dependency check" />
      </label>
      <label>
        Folder
        <select value={d.cwd} onChange={(e) => set({ cwd: e.target.value })}>
          {props.projects.map((p) => (
            <option key={p} value={p}>{p}</option>
          ))}
        </select>
      </label>
      <label>
        When
        <span className="row">
          <select value={PRESETS.some((p) => p[1] === d.cron) ? d.cron : ""} onChange={(e) => e.target.value && set({ cron: e.target.value })}>
            {PRESETS.map(([l, c]) => (
              <option key={c} value={c}>{l}</option>
            ))}
            <option value="">Custom…</option>
          </select>
          <input className="mono" value={d.cron} onChange={(e) => set({ cron: e.target.value })} title="Cron: minute hour day month weekday" />
        </span>
      </label>
      <label>
        Run in
        <span className="row">
          <select value={d.target} onChange={(e) => set({ target: e.target.value as Draft["target"] })}>
            <option value="new">A new session each time</option>
            <option value="session">An existing session</option>
          </select>
          {d.target === "session" && (
            <select value={d.sessionId ?? ""} onChange={(e) => set({ sessionId: e.target.value || undefined })}>
              <option value="">Pick a session…</option>
              {folderSessions.map((s) => (
                <option key={s.sessionId} value={s.sessionId}>{s.customTitle || s.summary}</option>
              ))}
            </select>
          )}
        </span>
      </label>
      <label>
        Permissions
        <select value={d.permissionMode ?? "default"} onChange={(e) => set({ permissionMode: e.target.value as PermissionMode })}>
          <option value="default">Ask (the run waits for your approval)</option>
          <option value="acceptEdits">Accept edits</option>
          <option value="auto">Auto</option>
          <option value="plan">Plan only</option>
        </select>
      </label>
      <label>
        Prompt
        <textarea rows={5} value={d.prompt} onChange={(e) => set({ prompt: e.target.value })} placeholder="What should Claude do each time?" />
      </label>
      <div className="perm-actions">
        <button className="primary" onClick={save}>Save</button>
        <button onClick={props.onDone}>Cancel</button>
      </div>
    </div>
  );
}

export function Schedules(props: {
  schedules: Schedule[];
  projects: string[];
  sessions: SessionInfo[];
  defaultCwd: string;
  onOpenSession: (sessionId: string, cwd: string) => void;
  onToast: (t: string) => void;
}) {
  const [editing, setEditing] = useState<Draft | null>(null);
  return (
    <div className="schedules">
      <div className="sched-head">
        <h2>Scheduled tasks</h2>
        <span className="spacer" />
        <button className="primary" onClick={() => setEditing(blank(props.defaultCwd))}>+ New schedule</button>
      </div>
      <p className="muted small">Runs while this server is running. Missed runs are skipped, not caught up.</p>
      {editing && (
        <Editor
          key={editing.id ?? "new"}
          draft={editing}
          projects={props.projects}
          sessions={props.sessions}
          onDone={() => setEditing(null)}
          onToast={props.onToast}
        />
      )}
      {props.schedules.length === 0 && !editing && <div className="pane-empty">No scheduled tasks yet.</div>}
      {props.schedules.map((s) => (
        <div key={s.id} className={`sched ${s.enabled ? "" : "off"}`}>
          <div className="sched-top">
            <label className="option" title={s.enabled ? "Pause" : "Resume"}>
              <input type="checkbox" checked={s.enabled} onChange={(e) => void api("/schedules", { json: { ...s, enabled: e.target.checked } })} />
            </label>
            <b>{s.name}</b>
            <span className="mono small muted">{s.cron}</span>
            <span className="spacer" />
            <button onClick={() => void api(`/schedules/${s.id}/run`, { json: {} }).catch((e) => props.onToast(e.message))}>Run now</button>
            <button onClick={() => setEditing({ ...s })}>Edit</button>
            <button
              className="link"
              onClick={() => confirm(`Delete schedule "${s.name}"?`) && void api(`/schedules/${s.id}`, { method: "DELETE" })}
            >
              Delete
            </button>
          </div>
          <div className="small muted">
            {s.cwd} · next {s.enabled ? when(s.nextRun) : "paused"}
          </div>
          <div className="small sched-prompt">{s.prompt}</div>
          {s.runs.length > 0 && (
            <div className="runs small">
              {s.runs.slice(0, 5).map((r) => (
                <div key={r.at}>
                  {when(r.at)} ·{" "}
                  {r.error ? (
                    <span className="err">{r.error}</span>
                  ) : r.sessionId ? (
                    <button className="link" onClick={() => props.onOpenSession(r.sessionId!, s.cwd)}>open session</button>
                  ) : (
                    "starting…"
                  )}
                </div>
              ))}
            </div>
          )}
        </div>
      ))}
    </div>
  );
}
