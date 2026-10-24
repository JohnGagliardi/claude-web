import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { api, socket, type Bootstrap, type Catalog, type LiveSummary, type RawMsg, type SessionInfo } from "./api";
import { buildItems, latestTodos } from "./transcript";
import { Sidebar, type SidebarItem } from "./components/Sidebar";
import { Transcript } from "./components/Transcript";
import { Composer, type ComposerSettings } from "./components/Composer";
import { PermissionCard, type Reply } from "./components/Permission";
import { SidePane, parseFileRef, type OpenFile, type PaneTab } from "./components/SidePane";
import { OpenFileContext } from "./fileLinks";

const stored = (k: string) => {
  try {
    return localStorage.getItem(k);
  } catch {
    return null;
  }
};
const store = (k: string, v: string) => {
  try {
    localStorage.setItem(k, v);
  } catch {}
};

type View = { sessionId?: string; liveKey?: string; cwd: string };

const emptyCatalog: Catalog = { models: [], commands: [] };
const catalogs = new Map<string, Promise<Catalog>>();
const loadCatalog = (cwd: string) => {
  if (!catalogs.has(cwd))
    catalogs.set(
      cwd,
      api<Catalog>(`/catalog?cwd=${encodeURIComponent(cwd)}`).catch(() => emptyCatalog),
    );
  return catalogs.get(cwd)!;
};

function findLive(live: LiveSummary[], v: View | null) {
  if (!v) return undefined;
  return live.find((l) => (v.liveKey && l.key === v.liveKey) || (v.sessionId && l.sessionId === v.sessionId));
}

export function App() {
  const [boot, setBoot] = useState<Bootstrap | null>(null);
  const [view, setView] = useState<View | null>(null);
  const [prior, setPrior] = useState<RawMsg[]>([]);
  const [liveLog, setLiveLog] = useState<RawMsg[]>([]);
  const [partial, setPartial] = useState("");
  const [catalog, setCatalog] = useState<Catalog>(emptyCatalog);
  const [draft, setDraft] = useState<ComposerSettings>({ permissionMode: "default" });
  const [newCwd, setNewCwd] = useState("");
  const [toast, setToast] = useState<string | null>(null);
  const [connected, setConnected] = useState(true);
  const [useWorktree, setUseWorktree] = useState(stored("useWorktree") === "1");
  const [pane, setPane] = useState<PaneTab | null>((stored("pane") as PaneTab) || null);
  const [openFile, setOpenFile] = useState<OpenFile | undefined>();
  const [refresh, setRefresh] = useState(0);

  useEffect(() => store("pane", pane ?? ""), [pane]);
  useEffect(() => store("useWorktree", useWorktree ? "1" : ""), [useWorktree]);

  // Re-read the diff and git state after each tool result or finished turn.
  const lastType = liveLog[liveLog.length - 1]?.type;
  useEffect(() => {
    if (lastType !== "user" && lastType !== "result") return;
    const t = setTimeout(() => setRefresh((r) => r + 1), 600);
    return () => clearTimeout(t);
  }, [liveLog.length, lastType]);

  const showFile = useCallback((ref: string) => {
    setOpenFile(parseFileRef(ref));
    setPane("file");
  }, []);

  const live = boot?.live ?? [];
  const current = findLive(live, view);
  const viewRef = useRef(view);
  const keyRef = useRef<string | undefined>(undefined);
  const pendingRef = useRef<string | undefined>(undefined);
  viewRef.current = view;
  keyRef.current = current?.key ?? view?.liveKey;

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
        case "live": {
          upsertLive(m.session);
          const v = viewRef.current;
          if (v && v.liveKey === m.session.key && m.session.sessionId && !v.sessionId) setView({ ...v, sessionId: m.session.sessionId });
          break;
        }
        case "started":
          if (m.ref !== pendingRef.current) break;
          upsertLive(m.session);
          // cwd can change here: a worktree session runs in its new folder.
          setView((v) => (v ? { ...v, cwd: m.session.cwd, liveKey: m.session.key, sessionId: v.sessionId ?? m.session.sessionId } : v));
          keyRef.current = m.session.key;
          break;
        case "closed":
          setBoot((b) => (b ? { ...b, live: b.live.filter((l) => l.key !== m.key) } : b));
          break;
        case "sessions-changed":
          clearTimeout(timer);
          timer = setTimeout(() => void refreshSessions(), 300);
          break;
        case "log":
          if (m.key === keyRef.current) setLiveLog(m.log);
          break;
        case "sdk": {
          if (m.key !== keyRef.current) break;
          const msg = m.msg as RawMsg;
          if (msg.type === "stream_event") {
            if (msg.parent_tool_use_id) break;
            const ev = msg.event;
            if (ev?.type === "message_start") setPartial("");
            else if (ev?.type === "content_block_delta" && ev.delta?.type === "text_delta") setPartial((p) => p + ev.delta.text);
            break;
          }
          if (msg.type === "assistant" && !msg.parent_tool_use_id) setPartial("");
          setLiveLog((log) => [...log, msg]);
          if (msg.type === "result" && viewRef.current?.sessionId && document.visibilityState === "visible") {
            setTimeout(() => void api(`/sessions/${viewRef.current!.sessionId}/meta`, { json: { unread: false } }), 500);
          }
          break;
        }
        case "error":
          setToast(m.error);
          break;
        case "disconnected":
          setConnected(false);
          break;
        case "reconnected":
          setConnected(true);
          void loadBoot();
          if (keyRef.current) socket.send({ t: "subscribe", key: keyRef.current });
          break;
      }
    });
  }, [loadBoot, refreshSessions]);

  useEffect(() => {
    if (!view?.cwd) return;
    let alive = true;
    void loadCatalog(view.cwd).then((c) => alive && setCatalog(c));
    return () => void (alive = false);
  }, [view?.cwd]);

  const select = (s: SidebarItem) => {
    setView({ sessionId: s.sessionId || undefined, liveKey: s.liveKey, cwd: s.cwd ?? boot?.home ?? "" });
    setPrior([]);
    setLiveLog([]);
    setPartial("");
    pendingRef.current = undefined;
    if (s.sessionId) {
      void api<RawMsg[]>(`/sessions/${s.sessionId}/messages?dir=${encodeURIComponent(s.cwd ?? "")}`)
        .then(setPrior)
        .catch((e) => setToast(String(e.message)));
      if (s.unread) void api(`/sessions/${s.sessionId}/meta`, { json: { unread: false } });
    }
    if (s.liveKey) socket.send({ t: "subscribe", key: s.liveKey });
  };

  const newSession = () => {
    setView({ cwd: newCwd || boot?.home || "" });
    setPrior([]);
    setLiveLog([]);
    setPartial("");
    pendingRef.current = undefined;
  };

  const send = (text: string) => {
    if (!view) return;
    setLiveLog((log) => [...log, { type: "user", uuid: `local-${Date.now()}`, message: { role: "user", content: text } }]);
    if (current) return socket.send({ t: "send", key: current.key, text });
    const ref = crypto.randomUUID();
    pendingRef.current = ref;
    socket.send({ t: "start", ref, cwd: view.cwd, resume: view.sessionId, worktree: !view.sessionId && useWorktree, text, ...draft });
  };

  const changeSettings = (patch: Partial<ComposerSettings>) => {
    setDraft((d) => ({ ...d, ...patch }));
    if (!current) return;
    if ("model" in patch) socket.send({ t: "setModel", key: current.key, model: patch.model });
    if (patch.permissionMode) socket.send({ t: "setMode", key: current.key, mode: patch.permissionMode });
    if (patch.effort) socket.send({ t: "setEffort", key: current.key, effort: patch.effort });
  };

  const reply = (id: string, r: Reply) => current && socket.send({ t: "permission", key: current.key, id, reply: r });

  const reauth = async () => {
    if (!boot?.reauth.configured) {
      setToast(`Reauth isn't set up on this device. Add "reauth": { "command": "…" } to ${boot?.reauth.configPath}.`);
      return;
    }
    setToast("Reauthenticating…");
    try {
      const r = await api<{ ok: boolean; output: string }>("/reauth", { json: {} });
      catalogs.clear();
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

  const items = useMemo(() => {
    const seen = new Set(prior.map((m) => m.uuid).filter(Boolean));
    return buildItems([...prior, ...liveLog.filter((m) => !m.uuid || !seen.has(m.uuid))]);
  }, [prior, liveLog]);
  const todos = latestTodos(items);
  const info: SessionInfo | undefined = boot?.sessions.find((s) => s.sessionId === view?.sessionId);
  const running = !!current?.running;
  const settings: ComposerSettings = current
    ? { model: draft.model, effort: current.effort ?? draft.effort, permissionMode: current.permissionMode }
    : draft;

  if (!boot) return <div className="boot">{connected ? "Loading…" : "Can't reach the claude-web server."}</div>;

  return (
    <OpenFileContext.Provider value={showFile}>
      <div className="app">
        <Sidebar
          sessions={boot.sessions}
          live={live}
          projects={boot.projects.length ? boot.projects : [boot.home]}
          selected={view ?? undefined}
          newCwd={newCwd}
          onNewCwd={setNewCwd}
          useWorktree={useWorktree}
          onUseWorktree={setUseWorktree}
          onAddProject={addProject}
          onNew={newSession}
          onSelect={select}
          onMeta={(s, patch) => void api(`/sessions/${s.sessionId}/meta`, { json: patch }).catch((e) => setToast(e.message))}
          onDelete={(s) => {
            if (confirm(`Permanently delete "${s.customTitle || s.summary}"? This removes the transcript file.`))
              void api(`/sessions/${s.sessionId}?dir=${encodeURIComponent(s.cwd ?? "")}`, { method: "DELETE" }).catch((e) =>
                setToast(e.message),
              );
          }}
        />
        <main className="main">
          <header className="topbar">
            <div className="topbar-title">
              <div className="title">{view ? info?.customTitle || info?.summary || "New session" : "Claude Web"}</div>
              {view && (
                <div className="muted small mono">
                  {view.cwd}
                  {info?.gitBranch && ` · ${info.gitBranch}`}
                </div>
              )}
            </div>
            {!connected && <span className="chip warn">Reconnecting…</span>}
            {view && (
              <>
                <button className={pane === "diff" ? "on" : ""} onClick={() => setPane(pane === "diff" ? null : "diff")}>
                  Diff
                </button>
                <button className={pane === "git" ? "on" : ""} onClick={() => setPane(pane === "git" ? null : "git")}>
                  Git
                </button>
              </>
            )}
            <button onClick={reauth} title={boot.reauth.configured ? "Run this device's reauth command" : "Not set up on this device"}>
              ⟳ {boot.reauth.label}
            </button>
          </header>
          {view ? (
            <div className="workspace">
              <div className="chat">
                <Transcript items={items} partial={partial} running={running} />
                <div className="dock">
                  {current?.error && <div className="banner err">{current.error}</div>}
                  {todos && (
                    <div className="todos">
                      {todos.map((t, i) => (
                        <div key={i} className={`todo ${t.status}`}>
                          <span>{t.status === "completed" ? "✓" : t.status === "in_progress" ? "◐" : "○"}</span>
                          {t.status === "in_progress" ? (t.activeForm ?? t.content) : t.content}
                        </div>
                      ))}
                    </div>
                  )}
                  {current?.pending.map((p) => <PermissionCard key={p.id} p={p} onReply={(r) => reply(p.id, r)} />)}
                  <Composer
                    running={running}
                    settings={settings}
                    models={catalog.models}
                    commands={catalog.commands}
                    onSettings={changeSettings}
                    onSend={send}
                    onStop={() => current && socket.send({ t: "interrupt", key: current.key })}
                  />
                </div>
              </div>
              {pane && (
                <SidePane
                  tab={pane}
                  onTab={setPane}
                  onClose={() => setPane(null)}
                  cwd={view.cwd}
                  sessionId={view.sessionId}
                  autofix={info?.autofix}
                  file={openFile}
                  refresh={refresh}
                  onOpenFile={(f) => (setOpenFile(f), setPane("file"))}
                  onAsk={send}
                  onToast={setToast}
                />
              )}
            </div>
          ) : (
            <div className="empty">
              <h1>Claude Web</h1>
              <p className="muted">Pick a session on the left, or start a new one in {newCwd || boot.home}.</p>
              <button className="primary" onClick={newSession}>
                + New session
              </button>
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
    </OpenFileContext.Provider>
  );
}
