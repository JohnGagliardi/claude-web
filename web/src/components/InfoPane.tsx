import { useEffect, useMemo, useState, type ReactNode } from "react";
import { api, type LiveSummary, type RawMsg } from "../api";
import type { Item } from "../transcript";

// Session details, after the desktop app's info panel: Environment, Context,
// Connectors, Outputs and Background tasks.

type ContextUsage = {
  totalTokens: number;
  maxTokens: number;
  percentage: number;
  model: string;
  categories: { id?: string; name: string; tokens: number; color: string; kind: "used" | "free" | "buffer" | "deferred" }[];
};
type McpServer = { name: string; status: "connected" | "failed" | "needs-auth" | "pending" | "disabled"; error?: string; source?: string; serverInfo?: { name: string; version: string } };
type Failed = { error: string };
type Info = { context: ContextUsage | Failed; mcp: McpServer[] | Failed };
type Task = { task_id: string; task_type: string; description: string; subagent_type?: string; ambient?: boolean };
type Finished = { task_id: string; status: string; summary: string; output_file?: string };

const failed = (v: unknown): v is Failed => !!v && typeof v === "object" && "error" in v;
const fmt = (n: number) => (n >= 1000 ? `${(n / 1000).toFixed(n >= 100_000 ? 0 : 1)}k` : String(n));
const FILE_TOOLS = /^(Write|Edit|MultiEdit|NotebookEdit)$/;

function Section({ title, count, children, open: initial = true }: { title: string; count?: number; children: ReactNode; open?: boolean }) {
  const [open, setOpen] = useState(initial);
  return (
    <section className="info-section">
      <button className="info-head" onClick={() => setOpen(!open)}>
        <span>{title}</span>
        {count !== undefined && <span className="muted small">{count}</span>}
        <span className="spacer" />
        <span className="chev">{open ? "▾" : "▸"}</span>
      </button>
      {open && <div className="info-body">{children}</div>}
    </section>
  );
}

const Row = ({ k, children }: { k: string; children: ReactNode }) => (
  <div className="kv">
    <span className="muted">{k}</span>
    <span className="kv-val">{children}</span>
  </div>
);

export function InfoPane(props: {
  cwd: string;
  branch?: string;
  live?: LiveSummary;
  log: RawMsg[];
  items: Item[];
  refresh: number;
  onOpenFile: (path: string) => void;
  onOpenPane: (pane: "diff" | "git") => void;
  onToast: (t: string) => void;
}) {
  const { live, log } = props;
  const [info, setInfo] = useState<Info | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (!live) return setInfo(null);
    let alive = true;
    void api<Info>(`/live/${live.key}/info`)
      .then((i) => alive && setInfo(i))
      .catch(() => alive && setInfo(null));
    return () => void (alive = false);
  }, [live?.key, live?.running, props.refresh]);

  const init = useMemo(() => [...log].reverse().find((m) => m.type === "system" && m.subtype === "init"), [log]);
  const running: Task[] = useMemo(() => {
    const last = [...log].reverse().find((m) => m.type === "system" && m.subtype === "background_tasks_changed");
    return live ? ((last?.tasks ?? []) as Task[]).filter((t) => !t.ambient) : [];
  }, [log, live]);
  const finished: Finished[] = useMemo(
    () => log.filter((m) => m.type === "system" && m.subtype === "task_notification").reverse().slice(0, 10) as unknown as Finished[],
    [log],
  );

  // Files this session wrote or edited, most recent first.
  const outputs = useMemo(() => {
    const files = new Map<string, number>();
    for (const it of props.items) {
      if (it.kind !== "tool" || !FILE_TOOLS.test(it.name) || it.result?.isError) continue;
      const p = it.input?.file_path ?? it.input?.notebook_path;
      if (!p) continue;
      files.set(p, (files.get(p) ?? 0) + 1);
      const n = files.get(p)!;
      files.delete(p);
      files.set(p, n);
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

  const mcpAction = async (body: { name: string; enabled?: boolean; reconnect?: boolean }) => {
    if (!live) return;
    setBusy(true);
    try {
      const mcp = await api<McpServer[]>(`/live/${live.key}/mcp`, { json: body });
      setInfo((i) => (i ? { ...i, mcp } : i));
    } catch (e) {
      props.onToast((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  const ctx = info && !failed(info.context) ? info.context : undefined;
  const mcp = info && !failed(info.mcp) ? info.mcp : undefined;
  const usedCats = ctx?.categories.filter((c) => c.kind === "used" && c.tokens > 0).sort((a, b) => b.tokens - a.tokens) ?? [];

  return (
    <div className="info-pane">
      <Section title="Environment">
        <Row k="Folder">
          <span className="mono small">{props.cwd}</span>
        </Row>
        {props.branch && (
          <Row k="Branch">
            <button className="link mono small" onClick={() => props.onOpenPane("git")} title="Open Git">
              {props.branch}
            </button>
          </Row>
        )}
        <Row k="Model">{live?.model ?? init?.model ?? "Default"}</Row>
        {live && <Row k="Mode">{live.permissionMode}</Row>}
        {live?.effort && <Row k="Effort">{live.effort}</Row>}
        {init?.claude_code_version && <Row k="Claude Code">{init.claude_code_version}</Row>}
        {init?.output_style && init.output_style !== "default" && <Row k="Style">{init.output_style}</Row>}
        {init && (
          <Row k="Loaded">
            {init.tools?.length ?? 0} tools · {init.skills?.length ?? 0} skills · {init.plugins?.length ?? 0} plugins
          </Row>
        )}
        <Row k="Process">{live ? (live.running ? "Running" : "Idle") : "Not running"}</Row>
      </Section>

      <Section title="Context">
        {ctx ? (
          <>
            <div className="ctx-bar" title={`${ctx.percentage.toFixed(0)}% used`}>
              {usedCats.map((c) => (
                <span key={c.name} style={{ width: `${(c.tokens / ctx.maxTokens) * 100}%`, background: c.color }} title={`${c.name}: ${fmt(c.tokens)}`} />
              ))}
            </div>
            <div className="small">
              {fmt(ctx.totalTokens)} of {fmt(ctx.maxTokens)} tokens ({ctx.percentage.toFixed(0)}%)
            </div>
            <div className="ctx-cats">
              {usedCats.map((c) => (
                <div key={c.name} className="ctx-cat small">
                  <span className="swatch" style={{ background: c.color }} />
                  <span>{c.name}</span>
                  <span className="spacer" />
                  <span className="muted">{fmt(c.tokens)}</span>
                </div>
              ))}
            </div>
          </>
        ) : lastUsage ? (
          <div className="small">About {fmt(lastUsage)} tokens at the last reply. Exact breakdown shows while the session is running.</div>
        ) : (
          <div className="muted small">{info && failed(info.context) ? info.context.error : "Shows once the session has replied."}</div>
        )}
      </Section>

      <Section title="Connectors" count={mcp?.length}>
        {!live ? (
          <div className="muted small">Shows while the session is running. Send a message to start it.</div>
        ) : !mcp ? (
          <div className="muted small">{info && failed(info.mcp) ? info.mcp.error : "Loading…"}</div>
        ) : mcp.length === 0 ? (
          <div className="muted small">No MCP servers.</div>
        ) : (
          mcp.map((s) => (
            <div key={s.name} className="connector">
              <span className={`conn-dot ${s.status}`} title={s.status} />
              <span className="conn-name" title={s.error ?? s.serverInfo?.name}>
                {s.name}
                {s.source && <span className="muted small"> · {s.source}</span>}
              </span>
              {(s.status === "failed" || s.status === "needs-auth") && (
                <button className="small" disabled={busy} onClick={() => void mcpAction({ name: s.name, reconnect: true })}>
                  Reconnect
                </button>
              )}
              <input
                type="checkbox"
                title={s.status === "disabled" ? "Enable" : "Disable"}
                disabled={busy}
                checked={s.status !== "disabled"}
                onChange={(e) => void mcpAction({ name: s.name, enabled: e.target.checked })}
              />
            </div>
          ))
        )}
      </Section>

      <Section title="Outputs" count={outputs.length} open={outputs.length > 0}>
        {outputs.length === 0 ? (
          <div className="muted small">Files Claude writes or edits show here.</div>
        ) : (
          outputs.map(([p, n]) => (
            <button key={p} className="output link mono small" onClick={() => props.onOpenFile(p)} title={p}>
              {p.split(/[\\/]/).pop()}
              <span className="muted"> {n > 1 ? `· ${n} edits` : ""}</span>
            </button>
          ))
        )}
      </Section>

      <Section title="Background tasks" count={running.length}>
        {running.length === 0 && finished.length === 0 && <div className="muted small">No background shells or agents.</div>}
        {running.map((t) => (
          <div key={t.task_id} className="task">
            <span className="conn-dot pending" />
            <span className="conn-name">
              {t.description}
              <span className="muted small"> · {t.subagent_type ?? t.task_type.replace(/^local_/, "")}</span>
            </span>
            <button
              className="small"
              onClick={() => live && void api(`/live/${live.key}/tasks/${t.task_id}/stop`, { json: {} }).catch((e) => props.onToast(e.message))}
            >
              Stop
            </button>
          </div>
        ))}
        {finished.map((t, i) => (
          <div key={`${t.task_id}${i}`} className="task">
            <span className={`conn-dot ${t.status === "completed" ? "connected" : "failed"}`} title={t.status} />
            <span className="conn-name muted">{t.summary || t.status}</span>
          </div>
        ))}
      </Section>
    </div>
  );
}
