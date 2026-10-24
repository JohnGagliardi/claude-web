import { useEffect, useMemo, useState, type ReactNode } from "react";
import { api, type LiveSummary, type RawMsg } from "../api";
import type { Item } from "../transcript";
import { AgentIcon, BranchIcon, CodeIcon, FolderIcon, GearIcon, LaptopIcon, StopIcon, TerminalIcon, UndoIcon } from "./Icons";

// The detail cards beside the chat, after the desktop app: Environment,
// Context, Connectors, Outputs and Background tasks.

type Category = { id?: string; name: string; tokens: number; color: string; kind: "used" | "free" | "buffer" | "deferred" };
type ContextUsage = {
  totalTokens: number;
  maxTokens: number;
  percentage: number;
  categories: Category[];
  memoryFiles: { path: string; tokens: number }[];
  mcpTools: { name: string; serverName: string; tokens: number }[];
};
type McpServer = { name: string; status: "connected" | "failed" | "needs-auth" | "pending" | "disabled"; error?: string };
type Failed = { error: string };
type Info = { context: ContextUsage | Failed; mcp: McpServer[] | Failed };
type Task = { task_id: string; task_type: string; description: string; ambient?: boolean };

const failed = (v: unknown): v is Failed => !!v && typeof v === "object" && "error" in v;
const fmt = (n: number) => (n >= 1_000_000 ? `${+(n / 1_000_000).toFixed(1)}M` : n >= 1000 ? `${(n / 1000).toFixed(1)}k` : String(n));
const pct = (n: number, of: number) => `${((n / of) * 100).toFixed(1)}%`;
const base = (p: string) => p.split(/[\\/]/).filter(Boolean).pop() ?? p;
const FILE_TOOLS = /^(Write|Edit|MultiEdit|NotebookEdit)$/;
// The SDK sends terminal theme names, not CSS colors; these follow the desktop app.
const ID_COLORS: Record<string, string> = { messages: "#4f8ff7", system_tools: "#e0613f", mcp_tools: "#2fa36f" };
const KIND_COLORS: Record<Category["kind"], string> = { used: "#a8a69e", buffer: "#6e6d68", deferred: "#5c5b57", free: "transparent" };
const colorOf = (c: Category) => (c.id && ID_COLORS[c.id]) || KIND_COLORS[c.kind];
const KIND_ORDER: Record<Category["kind"], number> = { used: 0, buffer: 1, free: 2, deferred: 3 };
// The app's own tools server isn't a connector the user set up.
const INTERNAL_SERVERS = new Set(["claude-web"]);

function Card({ title, children }: { title: string; children: ReactNode }) {
  const [open, setOpen] = useState(true);
  return (
    <section className="card">
      <button className="card-head" onClick={() => setOpen(!open)}>
        {title}
        <span className={`card-chev ${open ? "" : "closed"}`}>⌄</span>
      </button>
      {open && <div className="card-body">{children}</div>}
    </section>
  );
}

// "source · ~" for C:\Users\me\source.
function folderLabel(cwd: string) {
  const norm = cwd.replace(/\\/g, "/").replace(/\/+$/, "");
  const name = norm.split("/").pop() || norm;
  let parent = norm.slice(0, norm.length - name.length).replace(/\/$/, "");
  const home = /^([A-Za-z]:)?\/(Users|home)\/[^/]+/i.exec(parent)?.[0];
  if (home) parent = "~" + parent.slice(home.length);
  return { name, parent: parent || "/" };
}

function Expander({ label, count, children }: { label: string; count: number; children: ReactNode }) {
  const [open, setOpen] = useState(false);
  return (
    <>
      <button className="ctx-expander" onClick={() => setOpen(!open)}>
        <span className="tree-chev">{open ? "⌄" : "›"}</span>
        <span>{label}</span>
        <span className="spacer" />
        <span className="muted">{count}</span>
      </button>
      {open && <div className="ctx-sub">{children}</div>}
    </>
  );
}

export function InfoPane(props: {
  cwd: string;
  branch?: string;
  live?: LiveSummary;
  log: RawMsg[];
  items: Item[];
  refresh: number;
  onOpenFile: (path: string) => void;
  onOpenPane: (pane: "changes" | "files") => void;
  onOpenSettings?: () => void;
  onToast: (t: string) => void;
}) {
  const { live, log } = props;
  const [info, setInfo] = useState<Info | null>(null);
  const [moreOutputs, setMoreOutputs] = useState(false);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (!live) return setInfo(null);
    let alive = true;
    void api<Info>(`/live/${live.key}/info`)
      .then((i) => alive && setInfo(i))
      .catch(() => alive && setInfo(null));
    return () => void (alive = false);
  }, [live?.key, live?.running, props.refresh]);

  // Files this session wrote or edited, most recent first.
  const outputs = useMemo(() => {
    const files = new Set<string>();
    for (const it of props.items) {
      if (it.kind !== "tool" || !FILE_TOOLS.test(it.name) || it.result?.isError) continue;
      const p = it.input?.file_path ?? it.input?.notebook_path;
      if (!p) continue;
      files.delete(p);
      files.add(p);
    }
    return [...files].reverse();
  }, [props.items]);

  // Without a live process, the last reply's usage is the best estimate.
  const lastUsage = useMemo(() => {
    for (let i = log.length - 1; i >= 0; i--) {
      const u = log[i].type === "assistant" && !log[i].parent_tool_use_id ? log[i].message?.usage : undefined;
      if (u) return (u.input_tokens ?? 0) + (u.cache_creation_input_tokens ?? 0) + (u.cache_read_input_tokens ?? 0) + (u.output_tokens ?? 0);
    }
    return undefined;
  }, [log]);

  const reconnect = async (name: string) => {
    if (!live) return;
    setBusy(true);
    try {
      const mcp = await api<McpServer[]>(`/live/${live.key}/mcp`, { json: { name, reconnect: true } });
      setInfo((i) => (i ? { ...i, mcp } : i));
    } catch (e) {
      props.onToast((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  const ctx = info && !failed(info.context) ? info.context : undefined;
  const servers = info && !failed(info.mcp) ? info.mcp.filter((s) => !INTERNAL_SERVERS.has(s.name)) : undefined;
  const connected = servers?.filter((s) => s.status === "connected") ?? [];
  const notConnected: McpServer[] = [];
  // Largest first, then the compaction buffer, then free space.
  const inWindow = (ctx?.categories.filter((c) => c.kind !== "deferred") ?? []).sort(
    (a, b) => KIND_ORDER[a.kind] - KIND_ORDER[b.kind] || b.tokens - a.tokens,
  );
  const deferred = ctx?.categories.filter((c) => c.kind === "deferred") ?? [];
  const folder = folderLabel(props.cwd);

  return (
    <div className="info-pane">
      <Card title="Environment">
        <div className="env-row">
          <LaptopIcon />
          <span className="env-name">Local</span>
          {props.onOpenSettings && (
            <button className="icon-btn tiny" onClick={props.onOpenSettings} title="Settings" aria-label="Settings">
              <GearIcon />
            </button>
          )}
        </div>
        <button className="env-row" onClick={() => props.onOpenPane("files")} title={props.cwd}>
          <FolderIcon />
          <span className="env-name">
            {folder.name} <span className="muted">· {folder.parent}</span>
          </span>
        </button>
        {props.branch && props.branch !== "HEAD" && (
          <button className="env-row" onClick={() => props.onOpenPane("changes")} title="Changes">
            <BranchIcon />
            <span className="env-name mono">{props.branch}</span>
          </button>
        )}
      </Card>

      <Card title="Context">
        {ctx ? (
          <>
            <div className="ctx-top">
              <span>{Math.round(ctx.percentage)}% used</span>
              <span className="muted">
                {fmt(ctx.totalTokens)} / {fmt(ctx.maxTokens)}
              </span>
            </div>
            <div className="ctx-bar">
              {inWindow
                .filter((c) => c.kind === "used")
                .map((c) => (
                  <span key={c.name} style={{ width: pct(c.tokens, ctx.maxTokens), background: colorOf(c) }} />
                ))}
            </div>
            <div className="ctx-rows">
              {inWindow.map((c) => (
                <div key={c.name} className={`ctx-row ${c.kind}`}>
                  <span className="swatch" style={{ background: colorOf(c) }} />
                  <span className="ctx-name">{c.name}</span>
                  <span className="muted">{fmt(c.tokens)}</span>
                  <span className="ctx-pct">{pct(c.tokens, ctx.maxTokens)}</span>
                </div>
              ))}
            </div>
            {deferred.length > 0 && (
              <div className="ctx-rows deferred">
                {deferred.map((c) => (
                  <div key={c.name} className="ctx-row">
                    <span className="swatch" style={{ background: colorOf(c) }} />
                    <span className="ctx-name">{c.name}</span>
                    <span>{fmt(c.tokens)}</span>
                    <span className="ctx-pct">—</span>
                  </div>
                ))}
              </div>
            )}
            {ctx.mcpTools.length > 0 && (
              <Expander label="MCP tools" count={ctx.mcpTools.length}>
                {ctx.mcpTools.map((t) => (
                  <div key={`${t.serverName}/${t.name}`} className="ctx-row">
                    <span className="ctx-name" title={t.serverName}>
                      {t.name}
                    </span>
                    <span className="muted">{fmt(t.tokens)}</span>
                  </div>
                ))}
              </Expander>
            )}
            {ctx.memoryFiles.length > 0 && (
              <Expander label="Memory files" count={ctx.memoryFiles.length}>
                {ctx.memoryFiles.map((f) => (
                  <div key={f.path} className="ctx-row">
                    <span className="ctx-name" title={f.path}>
                      {base(f.path)}
                    </span>
                    <span className="muted">{fmt(f.tokens)}</span>
                  </div>
                ))}
              </Expander>
            )}
          </>
        ) : lastUsage ? (
          <div className="muted">About {fmt(lastUsage)} tokens at the last reply. The full breakdown shows while the session is running.</div>
        ) : (
          <div className="muted">{info && failed(info.context) ? info.context.error : "Shows once the session has replied."}</div>
        )}
      </Card>

      <Card title="Connectors">
        {!live ? (
          <div className="muted">Shows while the session is running.</div>
        ) : !servers ? (
          <div className="muted">{info && failed(info.mcp) ? info.mcp.error : "Loading…"}</div>
        ) : connected.length + notConnected.length === 0 ? (
          <div className="muted">No connectors.</div>
        ) : (
          <>
            {connected.map((s) => (
              <div key={s.name} className="env-row">
                <span className="conn-tile">{s.name.replace(/^claude\.ai /, "")[0]?.toUpperCase()}</span>
                <span className="env-name">{s.name.replace(/^claude\.ai /, "")}</span>
              </div>
            ))}
            {notConnected.map((s) => (
              <div key={s.name} className="env-row muted" title={s.error ?? s.status}>
                <span className="conn-tile off">{s.name.replace(/^claude\.ai /, "")[0]?.toUpperCase()}</span>
                <span className="env-name">{s.name.replace(/^claude\.ai /, "")}</span>
                <button className="link small" disabled={busy} onClick={() => void reconnect(s.name)}>
                  {s.status === "needs-auth" ? "Sign in" : "Retry"}
                </button>
              </div>
            ))}
          </>
        )}
      </Card>

      <Card title="Outputs">
        {outputs.length === 0 ? (
          <div className="muted">Files Claude writes or edits show here.</div>
        ) : (
          <>
            {(moreOutputs ? outputs : outputs.slice(0, 5)).map((p) => (
              <button key={p} className="env-row" onClick={() => props.onOpenFile(p)} title={p}>
                <CodeIcon />
                <span className="env-name">{base(p)}</span>
              </button>
            ))}
            {outputs.length > 5 && (
              <button className="link show-more" onClick={() => setMoreOutputs(!moreOutputs)}>
                {moreOutputs ? "Show less" : "Show more"}
              </button>
            )}
          </>
        )}
      </Card>

      <Card title="Background tasks">
        <BackgroundTasks live={live} log={log} onToast={props.onToast} />
      </Card>
    </div>
  );
}

const elapsed = (ms: number) => {
  const s = Math.max(0, Math.floor(ms / 1000));
  return s >= 3600 ? `${Math.floor(s / 3600)}h ${Math.floor((s % 3600) / 60)}m` : s >= 60 ? `${Math.floor(s / 60)}m ${s % 60}s` : `${s}s`;
};

// Running background shells and agents with how long they've run and a stop
// button, then a fold-out count of finished ones.
export function BackgroundTasks({ live, log, onToast }: { live?: LiveSummary; log: RawMsg[]; onToast: (t: string) => void }) {
  const [now, setNow] = useState(Date.now());
  const [showDone, setShowDone] = useState(false);

  const running = useMemo(() => {
    if (!live) return [];
    const last = [...log].reverse().find((m) => m.type === "system" && m.subtype === "background_tasks_changed");
    const tasks = ((last?.tasks ?? []) as Task[]).filter((t) => !t.ambient);
    // A task's start is the first change message that listed it.
    return tasks.map((t) => {
      const first = log.find((m) => m.subtype === "background_tasks_changed" && (m.tasks as Task[] | undefined)?.some((x) => x.task_id === t.task_id));
      return { ...t, since: first?.received_at as number | undefined };
    });
  }, [log, live]);

  useEffect(() => {
    if (!running.length) return;
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, [running.length]);

  // Finished tasks: live notifications, plus the ones saved in the transcript.
  const finished = useMemo(() => {
    const out: { id: string; status: string; summary: string }[] = [];
    for (const m of log) {
      if (m.type === "system" && m.subtype === "task_notification") out.push({ id: m.task_id, status: m.status, summary: m.summary });
      const c = m.type === "user" ? m.message?.content : undefined;
      const text = typeof c === "string" ? c : Array.isArray(c) ? c.map((b: any) => (b?.type === "text" ? b.text : "")).join("") : "";
      if (text.trimStart().startsWith("<task-notification>")) {
        const tag = (n: string) => text.match(new RegExp(`<${n}>([\\s\\S]*?)</${n}>`))?.[1]?.trim() ?? "";
        out.push({ id: tag("task-id") || `${out.length}`, status: tag("status"), summary: tag("summary") });
      }
    }
    const seen = new Set<string>();
    return out.reverse().filter((t) => !seen.has(t.id) && !!seen.add(t.id));
  }, [log]);

  if (!running.length && !finished.length) return <div className="muted">No background tasks.</div>;
  return (
    <div className="task-list">
      {running.map((t) => (
        <div key={t.task_id} className="env-row">
          {t.task_type === "local_agent" ? <AgentIcon /> : <TerminalIcon />}
          <span className="env-name" title={t.description}>
            {t.description}
          </span>
          {t.since && <span className="muted small">{elapsed(now - t.since)}</span>}
          <button
            className="icon-btn tiny"
            title="Stop"
            aria-label="Stop"
            onClick={() => live && void api(`/live/${live.key}/tasks/${t.task_id}/stop`, { json: {} }).catch((e) => onToast(e.message))}
          >
            <StopIcon />
          </button>
        </div>
      ))}
      {finished.length > 0 && (
        <button className="env-row" onClick={() => setShowDone(!showDone)}>
          <UndoIcon />
          <span className="env-name">{finished.length} finished</span>
        </button>
      )}
      {showDone &&
        finished.map((t) => (
          <div key={t.id} className={`done-task ${t.status === "completed" ? "" : "err"}`} title={t.status}>
            {t.summary || t.status}
          </div>
        ))}
    </div>
  );
}
