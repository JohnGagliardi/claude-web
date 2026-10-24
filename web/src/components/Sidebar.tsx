import { useMemo, useState } from "react";
import type { LiveSummary, SessionInfo } from "../api";

const base = (p?: string) => (p ? p.split(/[\\/]/).filter(Boolean).pop() ?? p : "Other");
// Worktree sessions are listed under the repo they came from.
const repoOf = (cwd?: string) => (cwd ?? "").split(/[\\/]\.claude[\\/]worktrees[\\/]/)[0];

function ago(ms: number) {
  const s = (Date.now() - ms) / 1000;
  if (s < 60) return "now";
  if (s < 3600) return `${Math.floor(s / 60)}m`;
  if (s < 86400) return `${Math.floor(s / 3600)}h`;
  return `${Math.floor(s / 86400)}d`;
}

export type SidebarItem = SessionInfo & { liveKey?: string; running?: boolean; needsYou?: boolean };

export function Sidebar(props: {
  sessions: SessionInfo[];
  live: LiveSummary[];
  projects: string[];
  selected?: { sessionId?: string; liveKey?: string };
  newCwd: string;
  onNewCwd: (cwd: string) => void;
  useWorktree: boolean;
  onUseWorktree: (v: boolean) => void;
  onAddProject: () => void;
  onNew: () => void;
  onSelect: (s: SidebarItem) => void;
  onMeta: (s: SidebarItem, patch: Record<string, unknown>) => void;
  onDelete: (s: SidebarItem) => void;
}) {
  const [q, setQ] = useState("");
  const [showArchived, setShowArchived] = useState(false);
  const [collapsed, setCollapsed] = useState<Record<string, boolean>>({});

  const items = useMemo(() => {
    const bySession = new Map(props.live.filter((l) => l.sessionId).map((l) => [l.sessionId!, l]));
    const list: SidebarItem[] = props.sessions.map((s) => {
      const l = bySession.get(s.sessionId);
      return { ...s, liveKey: l?.key, running: l?.running, needsYou: !!l?.pending.length };
    });
    // Brand-new sessions that have not written their first transcript entry yet.
    for (const l of props.live) {
      if (!l.sessionId || !props.sessions.some((s) => s.sessionId === l.sessionId)) {
        list.unshift({
          sessionId: l.sessionId ?? "",
          summary: "New session",
          lastModified: Date.now(),
          cwd: l.cwd,
          liveKey: l.key,
          running: l.running,
          needsYou: !!l.pending.length,
        });
      }
    }
    const needle = q.trim().toLowerCase();
    return list.filter(
      (s) =>
        !!s.archived === showArchived &&
        (!needle || `${s.customTitle ?? ""} ${s.summary} ${s.cwd ?? ""}`.toLowerCase().includes(needle)),
    );
  }, [props.sessions, props.live, q, showArchived]);

  const pinned = items.filter((s) => s.pinned);
  const groups = new Map<string, SidebarItem[]>();
  for (const s of items.filter((s) => !s.pinned)) {
    const k = repoOf(s.cwd);
    groups.set(k, [...(groups.get(k) ?? []), s]);
  }

  const isSel = (s: SidebarItem) =>
    (!!s.sessionId && s.sessionId === props.selected?.sessionId) || (!!s.liveKey && s.liveKey === props.selected?.liveKey);

  const row = (s: SidebarItem) => (
    <div
      key={s.liveKey ?? s.sessionId}
      className={`session ${isSel(s) ? "sel" : ""}`}
      onClick={() => props.onSelect(s)}
      title={s.cwd}
    >
      <span className={`status ${s.needsYou ? "needs" : s.running ? "running" : s.unread ? "unread" : ""}`} />
      <span className="title">{s.customTitle || s.summary || s.firstPrompt || "Untitled"}</span>
      {repoOf(s.cwd) !== (s.cwd ?? "") && <span className="wt" title="Runs in its own worktree">⑂</span>}
      <span className="when">{ago(s.lastModified)}</span>
      {s.sessionId && (
        <span className="actions" onClick={(e) => e.stopPropagation()}>
          <button title={s.pinned ? "Unpin" : "Pin"} onClick={() => props.onMeta(s, { pinned: !s.pinned })}>
            {s.pinned ? "★" : "☆"}
          </button>
          <button
            title="Rename"
            onClick={() => {
              const t = prompt("Rename session", s.customTitle || s.summary);
              if (t?.trim()) props.onMeta(s, { title: t.trim(), dir: s.cwd });
            }}
          >
            ✎
          </button>
          <button title={s.archived ? "Unarchive" : "Archive"} onClick={() => props.onMeta(s, { archived: !s.archived })}>
            {s.archived ? "↺" : "⌫"}
          </button>
          {s.archived && (
            <button title="Delete permanently" onClick={() => props.onDelete(s)}>
              🗑
            </button>
          )}
        </span>
      )}
    </div>
  );

  return (
    <aside className="sidebar">
      <div className="new-row">
        <button className="primary" onClick={props.onNew}>+ New session</button>
      </div>
      <div className="new-row">
        <select value={props.newCwd} onChange={(e) => (e.target.value === "__add" ? props.onAddProject() : props.onNewCwd(e.target.value))}>
          {props.projects.map((p) => (
            <option key={p} value={p}>{base(p)} — {p}</option>
          ))}
          <option value="__add">Add folder…</option>
        </select>
      </div>
      <label className="option small" title="Start new sessions on their own branch in <repo>/.claude/worktrees">
        <input type="checkbox" checked={props.useWorktree} onChange={(e) => props.onUseWorktree(e.target.checked)} />
        New session in its own worktree
      </label>
      <input className="search" placeholder="Search sessions" value={q} onChange={(e) => setQ(e.target.value)} />
      <div className="session-list">
        {pinned.length > 0 && (
          <div className="group">
            <div className="group-head">Pinned</div>
            {pinned.map(row)}
          </div>
        )}
        {[...groups.entries()].map(([cwd, list]) => (
          <div key={cwd} className="group">
            <button className="group-head" onClick={() => setCollapsed({ ...collapsed, [cwd]: !collapsed[cwd] })} title={cwd}>
              {collapsed[cwd] ? "▸" : "▾"} {base(cwd)}
            </button>
            {!collapsed[cwd] && list.map(row)}
          </div>
        ))}
        {items.length === 0 && <div className="muted pad">No sessions</div>}
      </div>
      <button className="link archived-toggle" onClick={() => setShowArchived(!showArchived)}>
        {showArchived ? "← Back to sessions" : "Archived sessions"}
      </button>
    </aside>
  );
}
