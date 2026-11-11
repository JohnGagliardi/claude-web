import type React from "react";
import { useEffect, useMemo, useState } from "react";
import type { LiveSummary, SessionInfo } from "../api";
import { store, stored } from "../storage";

// Worktree sessions are listed under the repo they came from.
const repoOf = (cwd?: string) => (cwd ?? "").split(/[\\/]\.claude[\\/]worktrees[\\/]/)[0];

function ago(ms: number) {
  const s = (Date.now() - ms) / 1000;
  if (s < 60) return "now";
  if (s < 3600) return `${Math.floor(s / 60)}m`;
  if (s < 86400) return `${Math.floor(s / 3600)}h`;
  return `${Math.floor(s / 86400)}d`;
}

export type SidebarItem = SessionInfo & {
  liveKey?: string;
  running?: boolean;
  needsYou?: boolean;
  depth?: number;
  // Set only for the placeholder row of a pane that's open but hasn't sent
  // its first message yet — there's no sessionId or liveKey to identify it
  // by, since nothing exists server-side for it yet. Holds that pane's own
  // (client-generated) id instead.
  draftId?: string;
};

export function Sidebar(props: {
  sessions: SessionInfo[];
  live: LiveSummary[];
  selected: { id?: string; sessionId?: string; liveKey?: string; cwd?: string; initialTitle?: string }[];
  onSplit: (s: SidebarItem) => void;
  footer?: React.ReactNode;
  onNew: () => void;
  onSelect: (s: SidebarItem) => void;
  onMeta: (s: SidebarItem, patch: Record<string, unknown>) => void;
  onDelete: (s: SidebarItem) => void;
  // Title for a brand-new session that hasn't written its first transcript
  // entry yet, keyed by its live key — what the user typed in the New
  // session modal, before the SDK has a persisted summary to report.
  pendingTitles?: Record<string, string>;
}) {
  const [q, setQ] = useState("");
  const [showArchived, setShowArchived] = useState(false);
  const [menu, setMenu] = useState<{ x: number; y: number; s: SidebarItem } | null>(null);
  const [collapsed, setCollapsed] = useState<{ pinned: boolean; rest: boolean }>(() => ({
    pinned: stored("sidebar.collapsed.pinned") === "1",
    rest: stored("sidebar.collapsed.rest") === "1",
  }));
  const toggleGroup = (g: "pinned" | "rest") =>
    setCollapsed((c) => {
      const next = { ...c, [g]: !c[g] };
      store(`sidebar.collapsed.${g}`, next[g] ? "1" : "");
      return next;
    });

  useEffect(() => {
    if (!menu) return;
    const close = () => setMenu(null);
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && close();
    window.addEventListener("click", close);
    window.addEventListener("keydown", onKey);
    return () => {
      window.removeEventListener("click", close);
      window.removeEventListener("keydown", onKey);
    };
  }, [menu]);

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
          summary: props.pendingTitles?.[l.key] || "New session",
          lastModified: Date.now(),
          cwd: l.cwd,
          liveKey: l.key,
          running: l.running,
          needsYou: !!l.pending.length,
          // Newly created sessions auto-pin server-side; show that immediately
          // instead of waiting on the first turn's sessions-changed refresh.
          pinned: true,
        });
      }
    }
    // Open panes that haven't sent a first message at all yet — nothing
    // exists server-side for these (no sessionId, no live Query), so they
    // can't come from props.sessions or props.live like the ones above.
    for (const v of props.selected) {
      if (!v.id || v.sessionId || v.liveKey) continue;
      list.unshift({
        sessionId: "",
        draftId: v.id,
        summary: v.initialTitle || "New session",
        lastModified: Date.now(),
        cwd: v.cwd ?? "",
        pinned: true,
      });
    }
    const needle = q.trim().toLowerCase();
    return list.filter(
      (s) =>
        !!s.archived === showArchived &&
        (!needle || `${s.customTitle ?? ""} ${s.summary} ${s.cwd ?? ""}`.toLowerCase().includes(needle)),
    );
  }, [props.sessions, props.live, props.selected, q, showArchived]);

  const byRecency = (a: SidebarItem, b: SidebarItem) => b.lastModified - a.lastModified;
  const pinned = items.filter((s) => s.pinned).sort(byRecency);
  const rest = items.filter((s) => !s.pinned).sort(byRecency);
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
    props.selected.some(
      (v) =>
        (!!s.sessionId && s.sessionId === v.sessionId) ||
        (!!s.liveKey && s.liveKey === v.liveKey) ||
        (!!s.draftId && s.draftId === v.id),
    );

  const row = (s: SidebarItem) => (
    <div
      key={s.liveKey ?? s.sessionId ?? s.draftId}
      className={`session ${isSel(s) ? "sel" : ""} ${s.pinned ? "pinned" : ""}`}
      style={s.depth ? { paddingLeft: 8 + s.depth * 14 } : undefined}
      onClick={(e) => (e.ctrlKey || e.metaKey ? props.onSplit(s) : props.onSelect(s))}
      onContextMenu={(e) => {
        if (!s.sessionId && !s.liveKey) return;
        e.preventDefault();
        const w = 180, h = 220;
        setMenu({ x: Math.min(e.clientX, window.innerWidth - w - 8), y: Math.min(e.clientY, window.innerHeight - h - 8), s });
      }}
      title={`${s.cwd ?? ""}
Ctrl+click to open in split view · Right-click for options`}
    >
      {!!s.depth && <span className="wt">⑃</span>}
      <span className={`status ${s.needsYou ? "needs" : s.running ? "running" : s.unread ? "unread" : ""}`} title={s.needsYou ? "Blocked — waiting for your answer" : undefined} />
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
              <button title={s.archived ? "Restore to sessions" : "Remove from sessions (moves it to Archived)"} onClick={() => props.onMeta(s, { archived: !s.archived })}>
                {s.archived ? "↺" : "✕"}
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
      <input className="search" placeholder="Search sessions" value={q} onChange={(e) => setQ(e.target.value)} />
      <div className="session-list">
        {pinned.length > 0 && (
          <div className="group">
            <button className="group-head" onClick={() => toggleGroup("pinned")}>
              <span className={`chev ${collapsed.pinned ? "closed" : ""}`}>▾</span>
              Pinned
              <span className="count">{pinned.length}</span>
            </button>
            {!collapsed.pinned && nest(pinned).map(row)}
          </div>
        )}
        <div className="group">
          <button className="group-head" onClick={() => toggleGroup("rest")}>
            <span className={`chev ${collapsed.rest ? "closed" : ""}`}>▾</span>
            {showArchived ? "Archived" : "Sessions"}
            <span className="count">{rest.length}</span>
          </button>
          {!collapsed.rest && nest(rest).map(row)}
        </div>
        {items.length === 0 && <div className="muted pad">No sessions</div>}
      </div>
      <div className="sidebar-foot">
        <button className="link" onClick={() => setShowArchived(!showArchived)}>
          {showArchived ? "← Back to sessions" : "Archived (removed)"}
        </button>
        {props.footer}
      </div>
      {menu && (
        <div className="ctx-menu" style={{ left: menu.x, top: menu.y }} onClick={(e) => e.stopPropagation()}>
          <button onClick={() => (props.onSelect(menu.s), setMenu(null))}>Open</button>
          <button onClick={() => (props.onSplit(menu.s), setMenu(null))}>Open in split view</button>
          {menu.s.sessionId && (
            <>
              <button onClick={() => (props.onMeta(menu.s, { pinned: !menu.s.pinned }), setMenu(null))}>
                {menu.s.pinned ? "Unpin" : "Pin"}
              </button>
              <button
                onClick={() => {
                  const t = prompt("Rename session", menu.s.customTitle || menu.s.summary);
                  setMenu(null);
                  if (t?.trim()) props.onMeta(menu.s, { title: t.trim(), dir: menu.s.cwd });
                }}
              >
                Rename
              </button>
              <button onClick={() => (props.onMeta(menu.s, { archived: !menu.s.archived }), setMenu(null))}>
                {menu.s.archived ? "Restore to sessions" : "Remove from sessions"}
              </button>
            </>
          )}
          {menu.s.sessionId && (
            <button
              className="danger"
              onClick={() => {
                props.onDelete(menu.s);
                setMenu(null);
              }}
            >
              Delete permanently
            </button>
          )}
        </div>
      )}
    </aside>
  );
}
