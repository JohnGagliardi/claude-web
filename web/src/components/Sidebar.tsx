import type React from "react";
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

export type SidebarItem = SessionInfo & { liveKey?: string; running?: boolean; needsYou?: boolean; depth?: number };

export function Sidebar(props: {
  sessions: SessionInfo[];
  live: LiveSummary[];
  projects: string[];
  selected: { sessionId?: string; liveKey?: string }[];
  onSplit: (s: SidebarItem) => void;
  footer?: React.ReactNode;
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
  // Side sessions sit right under the session that started them.
  const nest = (list: SidebarItem[]) => {
    const ids = new Set(list.map((s) => s.sessionId));
    const out: SidebarItem[] = [];
    const add = (s: SidebarItem, depth: number) => {
      out.push({ ...s, depth });
      if (depth < 3) for (const c of list.filter((c) => c.parent && c.parent === s.sessionId)) add(c, depth + 1);
    };
    for (const s of list) if (!s.parent || !ids.has(s.parent)) add(s, 0);
    return out;
  };

  const isSel = (s: SidebarItem) =>
    props.selected.some((v) => (!!s.sessionId && s.sessionId === v.sessionId) || (!!s.liveKey && s.liveKey === v.liveKey));

  const row = (s: SidebarItem) => (
    <div
      key={s.liveKey ?? s.sessionId}
      className={`session ${isSel(s) ? "sel" : ""}`}
      style={s.depth ? { paddingLeft: 8 + s.depth * 14 } : undefined}
      onClick={(e) => (e.ctrlKey || e.metaKey ? props.onSplit(s) : props.onSelect(s))}
      title={`${s.cwd ?? ""}
Ctrl+click to open in split view`}
    >
      {!!s.depth && <span className="wt">⑃</span>}
      <span className={`status ${s.needsYou ? "needs" : s.running ? "running" : s.unread ? "unread" : ""}`} />
      <span className="title">{s.customTitle || s.summary || s.firstPrompt || "Untitled"}</span>
      {repoOf(s.cwd) !== (s.cwd ?? "") && <span className="wt" title="Runs in its own worktree">⑂</span>}
      <span className="when">{ago(s.lastModified)}</span>
      {s.scheduleId && <span className="wt" title="Started by a schedule">⏱</span>}
      {(s.sessionId || s.liveKey) && (
        <span className="actions" onClick={(e) => e.stopPropagation()}>
          <button title="Open in split view" onClick={() => props.onSplit(s)}>
            ⧉
          </button>
          {s.sessionId && (
            <>
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
            </>
          )}
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
        <button className="new-session" onClick={props.onNew}>
          <span className="plus-icon">+</span> New session
        </button>
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
            {nest(pinned).map(row)}
          </div>
        )}
        {[...groups.entries()].map(([cwd, list]) => (
          <div key={cwd} className="group">
            <button className="group-head" onClick={() => setCollapsed({ ...collapsed, [cwd]: !collapsed[cwd] })} title={cwd}>
              {collapsed[cwd] ? "▸" : "▾"} {base(cwd)}
            </button>
            {!collapsed[cwd] && nest(list).map(row)}
          </div>
        ))}
        {items.length === 0 && <div className="muted pad">No sessions</div>}
      </div>
      <div className="sidebar-foot">
        <button className="link" onClick={() => setShowArchived(!showArchived)}>
          {showArchived ? "← Back to sessions" : "Archived"}
        </button>
        {props.footer}
      </div>
    </aside>
  );
}
