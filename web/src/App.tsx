import { useCallback, useEffect, useRef, useState } from "react";
import { api, socket, type Bootstrap, type LiveSummary } from "./api";
import { Sidebar, type SidebarItem } from "./components/Sidebar";
import { Schedules } from "./components/Schedules";
import { Settings } from "./components/Settings";
import { SessionView, clearCatalogs, findLive, type View } from "./SessionView";
import { stored, store } from "./storage";

const newId = () => crypto.randomUUID();

// Desktop notifications for sessions that finish or need approval while you're
// looking elsewhere.
function useNotifications(boot: Bootstrap | null, panes: View[], onOpen: (sessionId?: string, liveKey?: string) => void) {
  const [enabled, setEnabled] = useState(stored("notify") === "1" && typeof Notification !== "undefined" && Notification.permission === "granted");
  const pendingCount = useRef(new Map<string, number>());
  const ctx = useRef({ boot, panes, onOpen, enabled });
  ctx.current = { boot, panes, onOpen, enabled };

  useEffect(() => {
    const titleOf = (sessionId?: string) => {
      const s = ctx.current.boot?.sessions.find((x) => x.sessionId === sessionId);
      return s?.customTitle || s?.summary || "New session";
    };
    const onScreen = (key: string, sessionId?: string) =>
      document.visibilityState === "visible" &&
      document.hasFocus() &&
      ctx.current.panes.some((v) => v.liveKey === key || (sessionId && v.sessionId === sessionId));
    const notify = (title: string, body: string, l: Pick<LiveSummary, "key" | "sessionId">) => {
      if (!ctx.current.enabled || onScreen(l.key, l.sessionId)) return;
      const n = new Notification(title, { body, tag: l.key });
      n.onclick = () => {
        window.focus();
        ctx.current.onOpen(l.sessionId, l.key);
        n.close();
      };
    };
    return socket.on((m) => {
      if (m.t === "live") {
        const l = m.session as LiveSummary;
        const before = pendingCount.current.get(l.key) ?? 0;
        pendingCount.current.set(l.key, l.pending.length);
        if (l.pending.length > before) notify(`Needs your approval: ${titleOf(l.sessionId)}`, l.pending[l.pending.length - 1].toolName, l);
      } else if (m.t === "sdk" && m.msg.type === "result") {
        const l = ctx.current.boot?.live.find((x) => x.key === m.key);
        const ok = m.msg.subtype === "success";
        notify(`${ok ? "Finished" : "Stopped"}: ${titleOf(l?.sessionId)}`, String(m.msg.result ?? m.msg.subtype).slice(0, 180), { key: m.key, sessionId: l?.sessionId });
      }
    });
  }, []);

  const toggle = async () => {
    if (enabled) {
      setEnabled(false);
      store("notify", "");
      return;
    }
    if (typeof Notification === "undefined") return;
    const p = Notification.permission === "granted" ? "granted" : await Notification.requestPermission();
    setEnabled(p === "granted");
    store("notify", p === "granted" ? "1" : "");
  };
  return { enabled, toggle };
}

export function App() {
  const [boot, setBoot] = useState<Bootstrap | null>(null);
  const [panes, setPanes] = useState<View[]>([]);
  const [focus, setFocus] = useState(0);
  const [panel, setPanel] = useState<"schedules" | "settings" | null>(null);
  const [newCwd, setNewCwd] = useState("");
  const [toast, setToast] = useState<string | null>(null);
  const [connected, setConnected] = useState(true);

  const refreshSessions = useCallback(async () => {
    const s = await api<Pick<Bootstrap, "sessions" | "projects" | "groups">>("/sessions");
    setBoot((b) => (b ? { ...b, ...s } : b));
  }, []);

  const loadBoot = useCallback(async () => {
    const b = await api<Bootstrap>("/bootstrap");
    setBoot(b);
    setNewCwd((c) => c || b.projects[0] || b.home);
  }, []);

  useEffect(() => {
    void loadBoot();
  }, [loadBoot]);

  useEffect(() => {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const upsertLive = (s: LiveSummary) => setBoot((b) => (b ? { ...b, live: [...b.live.filter((l) => l.key !== s.key), s] } : b));
    return socket.on((m) => {
      switch (m.t) {
        case "live":
        case "started":
        case "side-started":
          upsertLive(m.session);
          break;
        case "closed":
          setBoot((b) => (b ? { ...b, live: b.live.filter((l) => l.key !== m.key) } : b));
          break;
        case "sessions-changed":
          clearTimeout(timer);
          timer = setTimeout(() => void refreshSessions(), 300);
          break;
        case "term:list":
          setBoot((b) => (b ? { ...b, terminals: m.terminals } : b));
          break;
        case "preview:list":
          setBoot((b) => (b ? { ...b, previews: m.previews } : b));
          break;
        case "settings":
          setBoot((b) => (b ? { ...b, settings: m.settings } : b));
          break;
        case "schedules":
          setBoot((b) => (b ? { ...b, schedules: m.schedules } : b));
          break;
        case "error":
          setToast(m.error);
          break;
        case "disconnected":
          setConnected(false);
          break;
        case "reconnected":
          setConnected(true);
          void loadBoot();
          break;
      }
    });
  }, [loadBoot, refreshSessions]);

  // Opening a session reuses a pane that already shows it; otherwise it replaces
  // the focused pane, or fills the second pane when split is asked for.
  const open = useCallback((target: Omit<View, "id">, split = false) => {
    setPanel(null);
    setPanes((ps) => {
      const at = ps.findIndex(
        (v) => (target.sessionId && v.sessionId === target.sessionId) || (target.liveKey && v.liveKey === target.liveKey),
      );
      if (at >= 0) {
        setFocus(at);
        return ps;
      }
      const v = { ...target, id: newId() };
      if (ps.length === 0) {
        setFocus(0);
        return [v];
      }
      if (split) {
        const slot = ps.length < 2 ? ps.length : 1 - focusRef.current;
        setFocus(slot);
        return ps.length < 2 ? [...ps, v] : ps.map((p, i) => (i === slot ? v : p));
      }
      return ps.map((p, i) => (i === Math.min(focusRef.current, ps.length - 1) ? v : p));
    });
  }, []);
  const focusRef = useRef(focus);
  focusRef.current = focus;

  const fromItem = (s: SidebarItem): Omit<View, "id"> => ({ sessionId: s.sessionId || undefined, liveKey: s.liveKey, cwd: s.cwd ?? boot?.home ?? "" });

  const notifications = useNotifications(boot, panes, (sessionId, liveKey) => {
    const s = boot?.sessions.find((x) => x.sessionId === sessionId);
    open({ sessionId, liveKey, cwd: s?.cwd ?? findLive(boot?.live ?? [], { sessionId, liveKey })?.cwd ?? boot?.home ?? "" });
  });

  // "(2) Claude Web" when sessions need you or have unread results.
  useEffect(() => {
    if (!boot) return;
    const waiting = boot.live.filter((l) => l.pending.length).length + boot.sessions.filter((s) => s.unread && !s.archived).length;
    document.title = waiting ? `(${waiting}) Claude Web` : "Claude Web";
  }, [boot]);

  const reauth = async () => {
    if (!boot?.reauth.configured) {
      setToast(`Reauth isn't set up on this device. Add "reauth": { "command": "…" } to ${boot?.reauth.configPath}.`);
      return;
    }
    setToast("Reauthenticating…");
    try {
      const r = await api<{ ok: boolean; output: string }>("/reauth", { json: {} });
      clearCatalogs();
      setToast(`${r.ok ? "Reauth finished" : "Reauth failed"}: ${r.output}`);
    } catch (e) {
      setToast(`Reauth failed: ${(e as Error).message}`);
    }
  };

  const addProject = async () => {
    const p = prompt("Folder path", boot?.home);
    if (!p) return;
    try {
      const r = await api<{ path: string }>("/projects", { json: { path: p } });
      setNewCwd(r.path);
      await refreshSessions();
    } catch (e) {
      setToast((e as Error).message);
    }
  };

  const updatePane = useCallback((v: View) => setPanes((ps) => ps.map((p) => (p.id === v.id ? v : p))), []);
  const openSide = useCallback((v: Omit<View, "id">) => open(v, true), [open]);

  const useWorktree = !!boot?.settings.newSessionWorktree;
  const setUseWorktree = (v: boolean) => void api("/settings", { json: { newSessionWorktree: v } });

  if (!boot) return <div className="boot">{connected ? "Loading…" : "Can't reach the claude-web server."}</div>;
  const projects = boot.projects.length ? boot.projects : [boot.home];

  return (
    <div className="app">
      <Sidebar
        sessions={boot.sessions}
        live={boot.live}
        projects={projects}
        selected={panes}
        newCwd={newCwd}
        onNewCwd={setNewCwd}
        useWorktree={useWorktree}
        onUseWorktree={setUseWorktree}
        onAddProject={addProject}
        onNew={() => {
          setPanel(null);
          setPanes((ps) => {
            const v = { id: newId(), cwd: newCwd || boot.home };
            return ps.length ? ps.map((p, i) => (i === Math.min(focus, ps.length - 1) ? v : p)) : [v];
          });
        }}
        onSelect={(s) => open(fromItem(s))}
        onSplit={(s) => open(fromItem(s), true)}
        onMeta={(s, patch) => void api(`/sessions/${s.sessionId}/meta`, { json: patch }).catch((e) => setToast(e.message))}
        onDelete={(s) => {
          if (confirm(`Permanently delete "${s.customTitle || s.summary}"? This removes the transcript file.`))
            void api(`/sessions/${s.sessionId}?dir=${encodeURIComponent(s.cwd ?? "")}`, { method: "DELETE" }).catch((e) => setToast(e.message));
        }}
        footer={
          <>
            <button className={`link ${panel === "schedules" ? "on" : ""}`} onClick={() => setPanel(panel === "schedules" ? null : "schedules")}>
              ⏱ Scheduled{boot.schedules.length ? ` (${boot.schedules.length})` : ""}
            </button>
            <button className="link" onClick={() => void notifications.toggle()} title="Desktop notifications when a session finishes or needs approval">
              {notifications.enabled ? "🔔 On" : "🔕 Off"}
            </button>
            <button className={`link ${panel === "settings" ? "on" : ""}`} onClick={() => setPanel(panel === "settings" ? null : "settings")}>
              ⚙ Settings
            </button>
            <button className="link" onClick={reauth} title={boot.reauth.configured ? "Run this device's reauth command" : "Not set up on this device"}>
              ⟳ {boot.reauth.label}
            </button>
            {!connected && <span className="chip warn">Reconnecting…</span>}
          </>
        }
      />
      <main className={`main ${panes.length > 1 && !panel ? "split" : ""}`}>
        {panel === "settings" ? (
          <Settings boot={boot} notifications={{ enabled: notifications.enabled, toggle: () => void notifications.toggle() }} onToast={setToast} />
        ) : panel === "schedules" ? (
          <Schedules
            schedules={boot.schedules}
            projects={projects}
            sessions={boot.sessions}
            defaultCwd={newCwd || boot.home}
            onOpenSession={(sessionId, cwd) => open({ sessionId, cwd })}
            onToast={setToast}
          />
        ) : panes.length ? (
          panes.map((v, i) => (
            <SessionView
              key={v.id}
              view={v}
              slot={i}
              boot={boot}
              useWorktree={useWorktree}
              focused={i === focus}
              split={panes.length > 1}
              onFocus={() => setFocus(i)}
              onClose={panes.length > 1 ? () => (setPanes((ps) => ps.filter((p) => p.id !== v.id)), setFocus(0)) : undefined}
              onChange={updatePane}
              onOpenSide={openSide}
              onToast={setToast}
            />
          ))
        ) : (
          <div className="empty">
            <h1>Claude Web</h1>
            <p className="muted">Pick a session on the left, or start a new one in {newCwd || boot.home}.</p>
            <p className="muted small">Ctrl+click a session (or ⧉) to open it side by side.</p>
          </div>
        )}
      </main>
      {toast && (
        <div className="toast" onClick={() => setToast(null)}>
          <pre>{toast}</pre>
          <span className="muted small">click to dismiss</span>
        </div>
      )}
    </div>
  );
}
