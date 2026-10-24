import { useCallback, useEffect, useMemo, useRef, useState, type ComponentType, type MouseEvent as ReactMouseEvent } from "react";
import { api, socket, type Bootstrap, type Catalog, type LiveSummary, type RawMsg } from "./api";
import { buildItems, latestTodos } from "./transcript";
import { Transcript } from "./components/Transcript";
import { Composer, type Attachment, type ComposerSettings } from "./components/Composer";
import { PermissionCard, type Reply } from "./components/Permission";
import { SidePane, parseFileRef, type OpenFile, type PaneKind } from "./components/SidePane";
import { BackgroundTasks, InfoPane } from "./components/InfoPane";
import { ChatIcon, CloseIcon, DiffIcon, FolderIcon, GlobeIcon, RailIcon, TasksIcon, TerminalIcon } from "./components/Icons";
import { OpenFileContext, ReplyContext, SessionContext } from "./fileLinks";
import { stored, store } from "./storage";

// forkOf: a side chat that branches off that session on its first message.
export type View = { id: string; sessionId?: string; liveKey?: string; cwd: string; forkOf?: string };

const emptyCatalog: Catalog = { models: [], commands: [] };
const catalogs = new Map<string, Promise<Catalog>>();
export const clearCatalogs = () => catalogs.clear();
const loadCatalog = (cwd: string) => {
  if (!catalogs.has(cwd)) catalogs.set(cwd, api<Catalog>(`/catalog?cwd=${encodeURIComponent(cwd)}`).catch(() => emptyCatalog));
  return catalogs.get(cwd)!;
};

export function findLive(live: LiveSummary[], v: Pick<View, "sessionId" | "liveKey"> | null | undefined) {
  if (!v) return undefined;
  return live.find((l) => (v.liveKey && l.key === v.liveKey) || (v.sessionId && l.sessionId === v.sessionId));
}

async function attachmentBlock(a: Attachment) {
  if (a.kind === "image") return { type: "image", source: { type: "base64", media_type: a.mediaType, data: a.data } };
  if (a.kind === "pdf") return { type: "document", source: { type: "base64", media_type: "application/pdf", data: a.data }, title: a.name };
  const { path } = await api<{ path: string }>("/uploads", { json: { name: a.name, data: a.data } });
  return { type: "text", text: `Attached file: ${path}` };
}

const PANE_BUTTONS: [PaneKind, string, ComponentType][] = [
  ["terminal", "Terminal", TerminalIcon],
  ["changes", "Changes", DiffIcon],
  ["browser", "Browser", GlobeIcon],
  ["files", "Files", FolderIcon],
  ["sidechat", "Side chat", ChatIcon],
  ["tasks", "Background tasks", TasksIcon],
];
const PANES = PANE_BUTTONS.map(([k]) => k);

// One session on screen: transcript, composer and its own side pane. Split view
// renders two of these side by side.
export function SessionView(props: {
  view: View;
  slot: number;
  boot: Bootstrap;
  useWorktree: boolean;
  focused: boolean;
  split: boolean;
  onFocus: () => void;
  onClose?: () => void;
  onChange: (v: View) => void;
  onOpenSide: (v: Omit<View, "id">) => void;
  onToast: (t: string) => void;
  // A side chat renders as a bare transcript and composer inside its pane.
  compact?: boolean;
  railHidden?: boolean;
  onToggleRail?: () => void;
}) {
  const { view, boot, onChange } = props;
  const [prior, setPrior] = useState<RawMsg[]>([]);
  const [liveLog, setLiveLog] = useState<RawMsg[]>([]);
  const [partial, setPartial] = useState("");
  const [catalog, setCatalog] = useState<Catalog>(emptyCatalog);
  const [draft, setDraft] = useState<ComposerSettings>({
    model: boot.settings.defaultModel,
    effort: boot.settings.defaultEffort,
    permissionMode: boot.settings.defaultPermissionMode,
  });
  // A pane splits the main view; with none open, the detail cards take the right column.
  const [pane, setPane] = useState<PaneKind | null>(() => {
    const p = stored(`pane${props.slot}`) as PaneKind;
    return !props.compact && PANES.includes(p) ? p : null;
  });
  useEffect(() => void (!props.compact && store(`pane${props.slot}`, pane ?? "")), [pane, props.slot]);
  const [paneWidth, setPaneWidth] = useState(() => Number(stored("paneWidth")) || 520);
  useEffect(() => store("paneWidth", String(paneWidth)), [paneWidth]);
  const [sideChat, setSideChat] = useState<View | undefined>();
  const [openFile, setOpenFile] = useState<OpenFile | undefined>();
  const [refresh, setRefresh] = useState(0);
  const [terminal, setTerminal] = useState<string | undefined>();

  const current = findLive(boot.live, view);
  const viewRef = useRef(view);
  const keyRef = useRef<string | undefined>(undefined);
  const pendingRef = useRef<string | undefined>(undefined);
  const sideRef = useRef<string | undefined>(undefined);
  viewRef.current = view;
  keyRef.current = current?.key ?? view.liveKey;

  useEffect(() => store(`pane${props.slot}`, pane ?? ""), [pane, props.slot]);

  // Initial load: the persisted transcript, then the live process's log if any.
  useEffect(() => {
    if (view.sessionId) {
      void api<RawMsg[]>(`/sessions/${view.sessionId}/messages?dir=${encodeURIComponent(view.cwd)}`)
        .then(setPrior)
        .catch((e) => props.onToast(String(e.message)));
      void api(`/sessions/${view.sessionId}/meta`, { json: { unread: false } }).catch(() => {});
    }
    const key = findLive(boot.live, view)?.key;
    if (key) socket.send({ t: "subscribe", key });
    // Mounted once per view id; later id changes come from this component itself.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    return socket.on((m) => {
      switch (m.t) {
        case "started":
          if (m.ref !== pendingRef.current) break;
          keyRef.current = m.session.key;
          // cwd can change here: a worktree session runs in its new folder.
          onChange({ ...viewRef.current, cwd: m.session.cwd, liveKey: m.session.key, sessionId: viewRef.current.sessionId ?? m.session.sessionId });
          break;
        case "live":
          if (m.session.key === keyRef.current && m.session.sessionId && !viewRef.current.sessionId)
            onChange({ ...viewRef.current, liveKey: m.session.key, sessionId: m.session.sessionId });
          break;
        case "side-started":
          if (m.ref === sideRef.current) props.onOpenSide({ liveKey: m.session.key, sessionId: m.session.sessionId, cwd: m.session.cwd });
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
          if (msg.type === "result" && viewRef.current.sessionId && document.visibilityState === "visible") {
            setTimeout(() => void api(`/sessions/${viewRef.current.sessionId}/meta`, { json: { unread: false } }), 500);
          }
          break;
        }
        case "reconnected":
          if (keyRef.current) socket.send({ t: "subscribe", key: keyRef.current });
          break;
      }
    });
  }, [onChange, props.onOpenSide]);

  // A live process can appear for this session later (Auto-fix, schedules, reports).
  const liveKey = current?.key;
  useEffect(() => {
    if (liveKey && liveKey !== view.liveKey) socket.send({ t: "subscribe", key: liveKey });
  }, [liveKey]);

  useEffect(() => {
    let alive = true;
    void loadCatalog(view.cwd).then((c) => alive && setCatalog(c));
    return () => void (alive = false);
  }, [view.cwd]);

  // Re-read the diff and git state after each tool result or finished turn.
  const lastType = liveLog[liveLog.length - 1]?.type;
  useEffect(() => {
    if (lastType !== "user" && lastType !== "result") return;
    const t = setTimeout(() => setRefresh((r) => r + 1), 600);
    return () => clearTimeout(t);
  }, [liveLog.length, lastType]);

  const showFile = useCallback((ref: string) => {
    setOpenFile(parseFileRef(ref));
    setPane("files");
  }, []);

  const send = async (text: string, attachments: Attachment[] = []) => {
    let content: string | unknown[] = text;
    if (attachments.length) {
      try {
        content = [...(await Promise.all(attachments.map((a) => attachmentBlock(a)))), ...(text ? [{ type: "text", text }] : [])];
      } catch (e) {
        return props.onToast(`Couldn't attach: ${(e as Error).message}`);
      }
    }
    setLiveLog((log) => [...log, { type: "user", uuid: `local-${Date.now()}`, message: { role: "user", content } }]);
    if (current) return socket.send({ t: "send", key: current.key, content });
    const ref = crypto.randomUUID();
    pendingRef.current = ref;
    const fork = !view.sessionId && !!view.forkOf;
    socket.send({
      t: "start",
      ref,
      cwd: view.cwd,
      resume: view.sessionId ?? view.forkOf,
      sideChat: fork,
      worktree: !view.sessionId && !fork && props.useWorktree,
      text,
      content,
      ...draft,
    });
  };

  const changeSettings = (patch: Partial<ComposerSettings>) => {
    setDraft((d) => ({ ...d, ...patch }));
    if (!current) return;
    if ("model" in patch) socket.send({ t: "setModel", key: current.key, model: patch.model });
    if (patch.permissionMode) socket.send({ t: "setMode", key: current.key, mode: patch.permissionMode });
    if (patch.effort) socket.send({ t: "setEffort", key: current.key, effort: patch.effort });
  };

  const reply = (id: string, r: Reply) => current && socket.send({ t: "permission", key: current.key, id, reply: r });

  const openPane = (k: PaneKind) => {
    if (k === "sidechat" && !sideChat) setSideChat({ id: crypto.randomUUID(), cwd: view.cwd, forkOf: view.sessionId });
    setPane(pane === k ? null : k);
  };

  // Dragging the divider resizes the pane; the chat keeps at least 360px.
  const startDrag = (e: ReactMouseEvent<HTMLDivElement>) => {
    e.preventDefault();
    const box = (e.currentTarget.parentElement as HTMLElement).getBoundingClientRect();
    const move = (ev: MouseEvent) => setPaneWidth(Math.round(Math.min(box.width - 360, Math.max(300, box.right - ev.clientX))));
    const up = () => {
      window.removeEventListener("mousemove", move);
      window.removeEventListener("mouseup", up);
      document.body.classList.remove("dragging");
    };
    document.body.classList.add("dragging");
    window.addEventListener("mousemove", move);
    window.addEventListener("mouseup", up);
  };

  const messages = useMemo(() => {
    const seen = new Set(prior.map((m) => m.uuid).filter(Boolean));
    return [...prior, ...liveLog.filter((m) => !m.uuid || !seen.has(m.uuid))];
  }, [prior, liveLog]);
  const items = useMemo(() => buildItems(messages), [messages]);
  const todos = latestTodos(items);
  const info = boot.sessions.find((s) => s.sessionId === view.sessionId);
  const parent = info?.parent ? boot.sessions.find((s) => s.sessionId === info.parent) : undefined;
  const running = !!current?.running;
  const settings: ComposerSettings = current
    ? { model: draft.model, effort: current.effort ?? draft.effort, permissionMode: current.permissionMode }
    : draft;

  const chat = (
    <div className="chat">
      <ReplyContext.Provider value={{ send: (t) => void send(t), running }}>
        <Transcript items={items} partial={partial} running={running} />
      </ReplyContext.Provider>
      <div className="dock">
        {current?.error && <div className="banner err">{current.error}</div>}
        {todos && todos.some((t) => t.status !== "completed") && (
          <div className="todos">
            {todos.map((t, i) => (
              <div key={i} className={`todo ${t.status}`}>
                <span className="todo-mark">{t.status === "completed" ? "✓" : t.status === "in_progress" ? "◐" : "○"}</span>
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
          placeholder={props.compact ? "Ask a side question. The main session isn't affected." : undefined}
          onSettings={changeSettings}
          onSend={(t, a) => void send(t, a)}
          onError={props.onToast}
          onStop={() => current && socket.send({ t: "interrupt", key: current.key })}
        />
      </div>
    </div>
  );

  if (props.compact)
    return (
      <SessionContext.Provider value={{ sessionId: view.sessionId, cwd: view.cwd }}>
        <OpenFileContext.Provider value={showFile}>
          <div className="session-view compact">{chat}</div>
        </OpenFileContext.Provider>
      </SessionContext.Provider>
    );

  return (
    <SessionContext.Provider value={{ sessionId: view.sessionId, cwd: view.cwd }}>
    <OpenFileContext.Provider value={showFile}>
      <section className={`session-view ${props.focused && props.split ? "focused" : ""}`} onMouseDown={props.onFocus}>
        <header className="topbar">
          {props.onToggleRail && (
            <button className="icon-btn" onClick={props.onToggleRail} title={props.railHidden ? "Show session rail" : "Hide session rail"} aria-label="Toggle session rail">
              <RailIcon />
            </button>
          )}
          <div className="topbar-title">
            <div className="title">{info?.customTitle || info?.summary || "New session"}</div>
            <div className="muted small mono">
              {parent && <span title="Started from this session">⑃ {parent.customTitle || parent.summary} · </span>}
              {view.cwd}
              {info?.gitBranch && ` · ${info.gitBranch}`}
            </div>
          </div>
          {PANE_BUTTONS.map(([k, label, Icon]) => (
            <button key={k} className={`icon-btn ${pane === k ? "on" : ""}`} onClick={() => openPane(k)} title={label} aria-label={label}>
              <Icon />
            </button>
          ))}
          {props.onClose && (
            <button className="icon-btn" onClick={props.onClose} title="Close this split" aria-label="Close this split">
              <CloseIcon />
            </button>
          )}
        </header>
        <div className="workspace">
          {chat}
          {pane ? (
            <>
              <div className="splitter" onMouseDown={startDrag} />
              <div className="pane-slot" style={{ width: paneWidth }}>
                <SidePane
                  kind={pane}
                  onClose={() => setPane(null)}
                  cwd={view.cwd}
                  sessionId={view.sessionId}
                  liveKey={current?.key}
                  autofix={info?.autofix}
                  file={openFile}
                  onFile={(f) => (setOpenFile(f), setPane("files"))}
                  terminals={boot.terminals}
                  terminal={terminal}
                  onTerminal={setTerminal}
                  previews={boot.previews}
                  refresh={refresh}
                  onAsk={(t) => void send(t)}
                  onToast={props.onToast}
                >
                  {pane === "tasks" && <BackgroundTasks live={current} log={messages} onToast={props.onToast} />}
                  {pane === "sidechat" &&
                    (view.sessionId && sideChat ? (
                      <SessionView
                        key={sideChat.id}
                        view={sideChat}
                        slot={props.slot + 10}
                        boot={boot}
                        useWorktree={false}
                        focused={false}
                        split={false}
                        compact
                        onFocus={() => {}}
                        onChange={setSideChat}
                        onOpenSide={props.onOpenSide}
                        onToast={props.onToast}
                      />
                    ) : (
                      <div className="pane-empty">Send a message first. A side chat branches off this conversation.</div>
                    ))}
                </SidePane>
              </div>
            </>
          ) : (
            <aside className="info-col">
              <InfoPane
                cwd={view.cwd}
                branch={info?.gitBranch}
                live={current}
                log={messages}
                items={items}
                refresh={refresh}
                onOpenFile={showFile}
                onOpenPane={() => setPane("changes")}
                onToast={props.onToast}
              />
            </aside>
          )}
        </div>
      </section>
    </OpenFileContext.Provider>
    </SessionContext.Provider>
  );
}
