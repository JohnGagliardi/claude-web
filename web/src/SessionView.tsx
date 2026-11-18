import { useCallback, useEffect, useMemo, useRef, useState, type ComponentType, type MouseEvent as ReactMouseEvent } from "react";
import { api, defaultModelName, pickableModels, socket, type Bootstrap, type Catalog, type ElicitationReply, type LiveSummary, type RawMsg } from "./api";
import { buildItems, latestTodos } from "./transcript";
import { Transcript } from "./components/Transcript";
import { SummaryView } from "./components/SummaryView";
import { Composer, type Attachment, type ComposerSettings } from "./components/Composer";
import { PermissionCard, type Reply } from "./components/Permission";
import { ElicitationCard } from "./components/Elicitation";
import { SidePane, parseFileRef, type OpenFile, type PaneKind } from "./components/SidePane";
import { BackgroundTasks, InfoPane } from "./components/InfoPane";
import { ChatIcon, CloseIcon, DiffIcon, FolderIcon, GlobeIcon, RailIcon, RestartIcon, TasksIcon, TerminalIcon } from "./components/Icons";
import { OpenFileContext, ReplyContext, RewindContext, RunContext, SessionContext } from "./fileLinks";
import { stored, store } from "./storage";

// forkOf: a side chat that branches off that session on its first message.
// worktree/initialTitle: chosen in the New session modal, applied once on creation.
export type View = {
  id: string;
  sessionId?: string;
  liveKey?: string;
  cwd: string;
  forkOf?: string;
  worktree?: boolean;
  initialTitle?: string;
};

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
  // Rewind replaces this specific pane in place (fresh id, so it fully
  // remounts and drops this session's old local state) rather than opening
  // the rewound session beside it.
  onRewind: (paneId: string, next: Omit<View, "id">) => void;
  onToast: (t: string) => void;
  // A side chat renders as a bare transcript and composer inside its pane.
  compact?: boolean;
  railHidden?: boolean;
  onToggleRail?: () => void;
  onOpenSettings?: () => void;
}) {
  const { view, boot, onChange } = props;
  const [prior, setPrior] = useState<RawMsg[]>([]);
  const [liveLog, setLiveLog] = useState<RawMsg[]>([]);
  const [partial, setPartial] = useState("");
  const [tokens, setTokens] = useState(0);
  const [catalog, setCatalog] = useState<Catalog>(emptyCatalog);
  const [draft, setDraft] = useState<ComposerSettings>({
    model: boot.settings.defaultModel,
    effort: boot.settings.defaultEffort,
    permissionMode: boot.sessions.find((s) => s.sessionId === view.sessionId)?.permissionMode ?? boot.settings.defaultPermissionMode,
  });
  // A pane splits the main view; with none open, the detail cards take the right column.
  const [pane, setPane] = useState<PaneKind | null>(() => {
    const p = stored(`pane${props.slot}`) as PaneKind;
    return !props.compact && PANES.includes(p) ? p : null;
  });
  useEffect(() => void (!props.compact && store(`pane${props.slot}`, pane ?? "")), [pane, props.slot]);
  const [paneWidth, setPaneWidth] = useState(() => Number(stored("paneWidth")) || 520);
  useEffect(() => store("paneWidth", String(paneWidth)), [paneWidth]);
  // Summary shows only what Claude tells the user; console shows every step.
  const [summary, setSummary] = useState(() => stored("viewMode") !== "console");
  useEffect(() => store("viewMode", summary ? "summary" : "console"), [summary]);
  const [sideChat, setSideChat] = useState<View | undefined>();
  const [openFile, setOpenFile] = useState<OpenFile | undefined>();
  const [previewFile, setPreviewFile] = useState<OpenFile | undefined>();
  const [refresh, setRefresh] = useState(0);
  const [terminal, setTerminal] = useState<string | undefined>();

  const current = findLive(boot.live, view);
  const viewRef = useRef(view);
  const keyRef = useRef<string | undefined>(undefined);
  const pendingRef = useRef<string | undefined>(undefined);
  const sideRef = useRef<string | undefined>(undefined);
  const restartingRef = useRef(false);
  viewRef.current = view;
  keyRef.current = current?.key ?? view.liveKey;

  useEffect(() => store(`pane${props.slot}`, pane ?? ""), [pane, props.slot]);

  // The persisted transcript. It's re-read whenever the live log is replayed,
  // because that replay holds only Claude's side: the user's own prompts come
  // from the transcript file.
  const loadPrior = () => {
    const { sessionId, cwd } = viewRef.current;
    if (!sessionId) return;
    void api<RawMsg[]>(`/sessions/${sessionId}/messages?dir=${encodeURIComponent(cwd)}`)
      .then((msgs) => {
        setPrior(msgs);
        // Once the real transcript has caught up, drop the optimistic
        // "local-<timestamp>" placeholder send() pushed for immediate
        // feedback — prior now has the real entry (with a real uuid, which
        // is what RewindButton needs), so the placeholder would otherwise
        // just linger forever as a duplicate with no rewind option.
        setLiveLog((log) => log.filter((m) => !m.uuid?.startsWith("local-")));
      })
      .catch((e) => props.onToast(String(e.message)));
  };

  // Initial load: the live process's log (which re-reads the transcript), or
  // just the transcript when nothing is running.
  useEffect(() => {
    if (view.sessionId) void api(`/sessions/${view.sessionId}/meta`, { json: { unread: false } }).catch(() => {});
    const key = findLive(boot.live, view)?.key;
    if (key) socket.send({ t: "subscribe", key });
    else loadPrior();
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
          if (m.key !== keyRef.current) break;
          setLiveLog(m.log);
          loadPrior();
          break;
        case "sdk": {
          if (m.key !== keyRef.current) break;
          const msg = m.msg as RawMsg;
          if (msg.type === "stream_event") {
            if (msg.parent_tool_use_id) break;
            const ev = msg.event;
            if (ev?.type === "message_start") {
              setPartial("");
              setTokens(0);
            } else if (ev?.type === "content_block_delta" && ev.delta?.type === "text_delta") setPartial((p) => p + ev.delta.text);
            else if (ev?.type === "message_delta" && typeof ev.usage?.output_tokens === "number") setTokens(ev.usage.output_tokens);
            break;
          }
          if (msg.type === "assistant" && !msg.parent_tool_use_id) setPartial("");
          setLiveLog((log) => [...log, msg]);
          if (msg.type === "result") loadPrior();
          if (msg.type === "result" && viewRef.current.sessionId && document.visibilityState === "visible") {
            setTimeout(() => void api(`/sessions/${viewRef.current.sessionId}/meta`, { json: { unread: false } }), 500);
          }
          break;
        }
        case "reconnected":
          if (keyRef.current) socket.send({ t: "subscribe", key: keyRef.current });
          break;
        // A turn started elsewhere (the phone, over Remote Control): its prompt
        // is only in the transcript, so replay the log and re-read that.
        case "external-turn":
          if (m.key === keyRef.current) socket.send({ t: "subscribe", key: m.key });
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
    const f = parseFileRef(ref);
    if (/\.html?$/i.test(f.path)) {
      setPreviewFile(f);
      setPane("browser");
    } else {
      setOpenFile(f);
      setPane("files");
    }
  }, []);

  const send = async (text: string, attachments: Attachment[] = []) => {
    // "/mcp" here would just hit the chat's own non-interactive fallback
    // text; redirect it to a real interactive CLI in the terminal instead.
    if (text.trim() === "/mcp" && !attachments.length) return openMcpTerminal();
    let content: string | unknown[] = text;
    if (attachments.length) {
      try {
        content = [...(await Promise.all(attachments.map((a) => attachmentBlock(a)))), ...(text ? [{ type: "text", text }] : [])];
      } catch (e) {
        return props.onToast(`Couldn't attach: ${(e as Error).message}`);
      }
    }
    setLiveLog((log) => [...log, { type: "user", uuid: `local-${Date.now()}`, message: { role: "user", content } }]);
    // sessionId and cwd let the server resume the session if the key went stale.
    if (current) return socket.send({ t: "send", key: current.key, sessionId: view.sessionId, cwd: view.cwd, content });
    const ref = crypto.randomUUID();
    pendingRef.current = ref;
    const fork = !view.sessionId && !!view.forkOf;
    socket.send({
      t: "start",
      ref,
      cwd: view.cwd,
      resume: view.sessionId ?? view.forkOf,
      sideChat: fork,
      worktree: !view.sessionId && !fork && (view.worktree ?? props.useWorktree),
      title: !view.sessionId && !fork ? view.initialTitle : undefined,
      text,
      content,
      ...draft,
    });
  };

  // Follow mode changes made while running (e.g. Claude leaving plan mode), so the
  // composer still shows them once the process closes.
  const liveMode = current?.permissionMode;
  useEffect(() => {
    if (liveMode) setDraft((d) => (d.permissionMode === liveMode ? d : { ...d, permissionMode: liveMode }));
  }, [liveMode]);

  const changeSettings = (patch: Partial<ComposerSettings>) => {
    setDraft((d) => ({ ...d, ...patch }));
    if (!current) return;
    if ("model" in patch) socket.send({ t: "setModel", key: current.key, model: patch.model });
    if (patch.permissionMode) socket.send({ t: "setMode", key: current.key, mode: patch.permissionMode });
    if ("effort" in patch) socket.send({ t: "setEffort", key: current.key, effort: patch.effort });
  };

  const reply = (id: string, r: Reply) => current && socket.send({ t: "permission", key: current.key, id, reply: r });
  const replyElicitation = (id: string, r: ElicitationReply) => current && socket.send({ t: "elicitation", key: current.key, id, result: r });

  // Kills the live process (if any) and resumes the same conversation in a
  // fresh one — for when a session is stuck and Stop doesn't help.
  const restart = () => {
    if (!view.sessionId || restartingRef.current) return;
    restartingRef.current = true;
    const sessionId = view.sessionId;
    const cwd = view.cwd;
    const doStart = () => {
      const ref = crypto.randomUUID();
      pendingRef.current = ref;
      socket.send({ t: "start", ref, cwd, resume: sessionId, ...draft });
      restartingRef.current = false;
      props.onToast("Session restarted.");
    };
    if (current) {
      const keyToClose = current.key;
      const off = socket.on((m) => {
        if (m.t === "closed" && m.key === keyToClose) {
          off();
          doStart();
        }
      });
      socket.send({ t: "close", key: keyToClose });
    } else {
      doStart();
    }
  };

  const statusReport = () => void send("Give me a status report: what you've done so far, what's currently in progress, what's left, and any blockers.");

  // The real /compact runs async and can take a while; this is just a quick,
  // purely cosmetic "whoosh" so the click feels like it did something right away.
  const [compacting, setCompacting] = useState(false);
  const compact = () => {
    setCompacting(true);
    void send("/compact");
    setTimeout(() => setCompacting(false), 1500);
  };

  const openPane = (k: PaneKind) => setPane(pane === k ? null : k);

  // A "run" button on a shell command shown in the transcript sends it to this
  // session's terminal: reuse an alive one in this cwd, or open a new one first.
  const runInTerminal = useCallback(
    (command: string) => {
      const go = (id: string) => {
        setTerminal(id);
        setPane("terminal");
        // term:run (not term:input) — typing the command's literal text would
        // make the shell echo the whole thing back verbatim before running it,
        // unreadable for anything long. The server drops it into a throwaway
        // script and types just the short "bash '<path>'" line instead.
        socket.send({ t: "term:run", id, command });
      };
      const existing = boot.terminals.find((t) => t.cwd === view.cwd && t.alive);
      if (existing) return go(existing.id);
      const ref = crypto.randomUUID();
      const off = socket.on((m) => {
        if (m.t === "term:opened" && m.ref === ref) {
          off();
          go(m.id);
        }
      });
      socket.send({ t: "term:open", ref, cwd: view.cwd });
    },
    [boot.terminals, view.cwd],
  );

  // Typing "/mcp" opens a dedicated terminal running a fresh `claude` CLI and
  // types "/mcp" into it once it's up: the real interactive menu only renders
  // against an actual TTY, which the chat's own non-interactive /mcp can't
  // give you. Always a new terminal (never reused), since this types into it
  // without knowing what else might already be running there.
  const openMcpTerminal = useCallback(() => {
    const ref = crypto.randomUUID();
    const off = socket.on((m) => {
      if (m.t !== "term:opened" || m.ref !== ref) return;
      off();
      const id = m.id;
      setTerminal(id);
      setPane("terminal");
      socket.send({ t: "term:input", id, data: "claude\r" });

      // The shell's own echo of what we just typed counts as "output," so a
      // naive wait-for-output-then-settle races claude's actual startup and
      // fires too early. A directory's first-ever bare launch also shows a
      // one-time "do you trust this folder" prompt defaulted to "No, exit" —
      // sending Enter blind would hit that and quit claude outright. So:
      // check the buffered output for that prompt's text, confirm it if
      // present (Down, Enter -> "Yes, I trust this folder"), then give the
      // interactive UI time to finish loading before typing /mcp.
      let buf = "";
      const offData = socket.on((e) => {
        if (e.t === "term:data" && e.id === id) buf += e.data;
      });
      setTimeout(() => {
        const trusted = /trust this folder/i.test(buf);
        if (trusted) socket.send({ t: "term:input", id, data: "\x1b[B\r" });
        setTimeout(() => {
          offData();
          socket.send({ t: "term:input", id, data: "/mcp\r" });
        }, trusted ? 3500 : 2000);
      }, 1800);
    });
    socket.send({ t: "term:open", ref, cwd: view.cwd });
  }, [view.cwd]);

  // A "Rewind here" click branches a new session from that point
  // (forkSession slices the transcript there) — non-destructive on disk —
  // but takes over this pane in place rather than opening beside it: the
  // old live process is closed, and this pane gets a fresh id so it fully
  // remounts onto the forked session instead of mixing its state in.
  const rewindTo = useCallback(
    (uuid: string) => {
      if (!view.sessionId) return;
      const info = boot.sessions.find((s) => s.sessionId === view.sessionId);
      const title = info?.customTitle || info?.summary || view.initialTitle;
      const ref = crypto.randomUUID();
      const oldKey = current?.key;
      const off = socket.on((m) => {
        if (m.t !== "started" || m.ref !== ref) return;
        off();
        if (oldKey) socket.send({ t: "close", key: oldKey });
        props.onRewind(view.id, { liveKey: m.session.key, sessionId: m.session.sessionId, cwd: m.session.cwd });
      });
      socket.send({ t: "rewind", ref, sessionId: view.sessionId, cwd: view.cwd, uuid, title });
    },
    [view.sessionId, view.cwd, view.id, view.initialTitle, boot.sessions, current?.key, props.onRewind],
  );

  // The side chat forks this session, so it's created only once the session
  // has an id; opened earlier, the pane waits for the first message.
  useEffect(() => {
    if (pane === "sidechat" && view.sessionId && !sideChat) setSideChat({ id: crypto.randomUUID(), cwd: view.cwd, forkOf: view.sessionId });
  }, [pane, view.sessionId, sideChat, view.cwd]);

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
    <div className={`chat ${compacting ? "compacting" : ""}`}>
      <RunContext.Provider value={runInTerminal}>
        <RewindContext.Provider value={view.sessionId ? rewindTo : undefined}>
          <ReplyContext.Provider value={{ send: (t) => void send(t), running }}>
            {summary && !props.compact ? (
              <SummaryView items={items} partial={partial} running={running} tokens={tokens} pendingCount={(current?.pending.length ?? 0) + (current?.elicitations.length ?? 0)} compacting={compacting} />
            ) : (
              <Transcript items={items} partial={partial} running={running} tokens={tokens} pendingCount={(current?.pending.length ?? 0) + (current?.elicitations.length ?? 0)} compacting={compacting} />
            )}
          </ReplyContext.Provider>
        </RewindContext.Provider>
      </RunContext.Provider>
      {compacting && (
        <div className="compact-fx" aria-hidden="true">
          <FolderIcon />
        </div>
      )}
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
        {current?.elicitations.map((p) => <ElicitationCard key={p.id} p={p} onReply={(r) => replyElicitation(p.id, r)} />)}
        <Composer
          running={running}
          settings={settings}
          models={pickableModels(catalog.models)}
          defaultModel={defaultModelName(catalog)}
          // A running session knows its model's real default; before that, the catalog's.
          defaultEffort={current && !current.effort && current.appliedEffort !== undefined ? current.appliedEffort : catalog.defaults?.effort}
          commands={catalog.commands}
          placeholder={props.compact ? "Ask a side question. The main session isn't affected." : undefined}
          onSettings={changeSettings}
          onSend={(t, a) => void send(t, a)}
          onError={props.onToast}
          onStop={() => current && socket.send({ t: "interrupt", key: current.key })}
          onStatusReport={view.sessionId && !props.compact ? statusReport : undefined}
          onCompact={view.sessionId && !props.compact ? compact : undefined}
          draftKey={view.sessionId ?? view.id}
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
            <div className="title">{info?.customTitle || info?.summary || view.initialTitle || "New session"}</div>
            <div className="muted small mono">
              {parent && <span title="Started from this session">⑃ {parent.customTitle || parent.summary} · </span>}
              {view.cwd}
              {info?.gitBranch && ` · ${info.gitBranch}`}
            </div>
          </div>
          <div className="segmented view-toggle" role="group" aria-label="Transcript view">
            <button className={summary ? "on" : ""} onClick={() => setSummary(true)} title="Only what Claude tells you">
              Summary
            </button>
            <button className={summary ? "" : "on"} onClick={() => setSummary(false)} title="Every step and tool call">
              Console
            </button>
          </div>
          {PANE_BUTTONS.map(([k, label, Icon]) => (
            <button key={k} className={`icon-btn ${pane === k ? "on" : ""}`} onClick={() => openPane(k)} title={label} aria-label={label}>
              <Icon />
            </button>
          ))}
          {view.sessionId && (
            <button className="icon-btn" onClick={restart} title="Restart this session's process (keeps the conversation)" aria-label="Restart session">
              <RestartIcon />
            </button>
          )}
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
                  previewFile={previewFile}
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
                        onRewind={(_, next) => setSideChat({ ...next, id: crypto.randomUUID() })}
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
                onOpenPane={(k) => (k === "files" && setOpenFile(undefined), setPane(k))}
                onOpenSettings={props.onOpenSettings}
                onToast={props.onToast}
                onRunInTerminal={runInTerminal}
              />
            </aside>
          )}
        </div>
      </section>
    </OpenFileContext.Provider>
    </SessionContext.Provider>
  );
}
