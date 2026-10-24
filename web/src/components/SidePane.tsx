import { useEffect, useRef, useState } from "react";
import { api, q, type FileDiff, type PreviewInfo, type PrStatus, type RepoInfo, type TerminalInfo } from "../api";
import { TerminalPane } from "./TerminalPane";
import { PreviewPane } from "./PreviewPane";

export type PaneTab = "diff" | "file" | "git" | "terminal" | "preview";
export type OpenFile = { path: string; line?: number };

// "src/a.ts:42" or "src/a.ts#L42" → path + line.
export function parseFileRef(ref: string): OpenFile {
  const m = ref.match(/^(.*?)(?::(\d+)(?::\d+)?|#L(\d+))?$/);
  return { path: decodeURIComponent(m?.[1] ?? ref), line: Number(m?.[2] ?? m?.[3]) || undefined };
}

function DiffView({ cwd, refresh, onOpen }: { cwd: string; refresh: number; onOpen: (f: OpenFile) => void }) {
  const [against, setAgainst] = useState<"HEAD" | "base">("HEAD");
  const [data, setData] = useState<{ ref: string; files: FileDiff[] } | null>(null);
  const [error, setError] = useState("");
  const [closed, setClosed] = useState<Record<string, boolean>>({});

  useEffect(() => {
    let alive = true;
    api<{ ref: string; files: FileDiff[] }>(`/git/diff${q({ cwd, against })}`)
      .then((d) => alive && (setData(d), setError("")))
      .catch((e) => alive && setError(e.message));
    return () => void (alive = false);
  }, [cwd, against, refresh]);

  if (error) return <div className="pane-empty">{/not a git repository/i.test(error) ? "This folder isn't a git repository." : error}</div>;
  if (!data) return <div className="pane-empty">Loading…</div>;
  const totals = data.files.reduce((t, f) => [t[0] + f.added, t[1] + f.removed], [0, 0]);
  return (
    <div className="diff-pane">
      <div className="pane-bar">
        <span className="muted small">
          {data.files.length} files · <span className="plus">+{totals[0]}</span> <span className="minus">−{totals[1]}</span>
        </span>
        <span className="spacer" />
        <select value={against} onChange={(e) => setAgainst(e.target.value as "HEAD" | "base")}>
          <option value="HEAD">Uncommitted</option>
          <option value="base">All changes vs base</option>
        </select>
      </div>
      {data.files.length === 0 && <div className="pane-empty">No changes</div>}
      {data.files.map((f) => (
        <div key={f.path} className="diff-file">
          <div className="diff-file-head">
            <button className="link" onClick={() => setClosed({ ...closed, [f.path]: !closed[f.path] })}>
              {closed[f.path] ? "▸" : "▾"}
            </button>
            <span className={`st st-${f.status === "?" ? "U" : f.status}`}>{f.status === "?" ? "U" : f.status}</span>
            <button className="link mono path" onClick={() => onOpen({ path: f.path })} title="Open file">
              {f.oldPath ? `${f.oldPath} → ` : ""}
              {f.path}
            </button>
            <span className="plus small">+{f.added}</span>
            <span className="minus small">−{f.removed}</span>
          </div>
          {!closed[f.path] && (
            <pre className="patch">
              {f.binary
                ? "Binary file"
                : f.patch
                    .split("\n")
                    .filter((l) => !/^(diff --git|index |--- |\+\+\+ |new file mode|deleted file mode|similarity index|rename (from|to) )/.test(l))
                    .map((l, i) => (
                      <div key={i} className={l.startsWith("+") ? "add" : l.startsWith("-") ? "del" : l.startsWith("@@") ? "hunk" : ""}>
                        {l || " "}
                      </div>
                    ))}
            </pre>
          )}
        </div>
      ))}
    </div>
  );
}

function FileView({ cwd, file }: { cwd: string; file?: OpenFile }) {
  const [data, setData] = useState<{ path: string; content: string; truncated: boolean } | null>(null);
  const [error, setError] = useState("");
  const target = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!file) return;
    let alive = true;
    setData(null);
    api<{ path: string; content: string; truncated: boolean }>(`/git/file${q({ cwd, path: file.path })}`)
      .then((d) => alive && (setData(d), setError("")))
      .catch((e) => alive && setError(e.message));
    return () => void (alive = false);
  }, [cwd, file?.path]);

  useEffect(() => target.current?.scrollIntoView({ block: "center" }), [data, file?.line]);

  if (!file) return <div className="pane-empty">Click a file path in the chat or the diff to open it here.</div>;
  if (error) return <div className="pane-empty">{error}</div>;
  if (!data) return <div className="pane-empty">Loading…</div>;
  return (
    <div className="file-pane">
      <div className="pane-bar mono small">{data.path}</div>
      <pre className="code">
        {data.content.split("\n").map((l, i) => (
          <div key={i} ref={i + 1 === file.line ? target : undefined} className={i + 1 === file.line ? "hl" : ""}>
            <span className="ln">{i + 1}</span>
            {l || " "}
          </div>
        ))}
      </pre>
      {data.truncated && <div className="muted small">File truncated at 2 MB.</div>}
    </div>
  );
}

const checkIcon = (c: { status: string; conclusion: string }) => {
  const s = c.conclusion.toUpperCase();
  if (c.status.toUpperCase() !== "COMPLETED") return <span className="ck run">◌</span>;
  if (s === "SUCCESS" || s === "NEUTRAL" || s === "SKIPPED") return <span className="ck ok">✓</span>;
  return <span className="ck bad">✕</span>;
};

function GitView(props: {
  cwd: string;
  sessionId?: string;
  autofix?: boolean;
  refresh: number;
  onAsk: (text: string) => void;
  onToast: (text: string) => void;
}) {
  const { cwd } = props;
  const [info, setInfo] = useState<RepoInfo | null>(null);
  const [pr, setPr] = useState<PrStatus | null | undefined>(undefined);
  const [prError, setPrError] = useState("");
  const [busy, setBusy] = useState("");
  const [tick, setTick] = useState(0);

  useEffect(() => {
    void api<RepoInfo>(`/git/info${q({ cwd })}`).then(setInfo).catch(() => setInfo({ isRepo: false }));
  }, [cwd, props.refresh, tick]);

  useEffect(() => {
    if (!info?.hasRemote) return;
    let alive = true;
    const load = () =>
      api<PrStatus | null>(`/git/pr${q({ cwd })}`)
        .then((p) => alive && (setPr(p), setPrError("")))
        .catch((e) => alive && setPrError(e.message));
    void load();
    const t = setInterval(load, 30_000);
    return () => {
      alive = false;
      clearInterval(t);
    };
  }, [cwd, info?.hasRemote, tick]);

  const act = async (label: string, fn: () => Promise<string>) => {
    setBusy(label);
    try {
      props.onToast(await fn());
    } catch (e) {
      props.onToast(`${label} failed: ${(e as Error).message}`);
    } finally {
      setBusy("");
      setTick((t) => t + 1);
    }
  };

  if (!info) return <div className="pane-empty">Loading…</div>;
  if (!info.isRepo) return <div className="pane-empty">This folder isn't a git repository.</div>;

  return (
    <div className="git-pane">
      <section>
        <div className="kv">
          <span className="muted">Branch</span>
          <span className="mono">{info.branch}</span>
          {info.isWorktree && <span className="chip">worktree</span>}
        </div>
        {info.base && (
          <div className="kv">
            <span className="muted">Base</span>
            <span className="mono">{info.base}</span>
            <span className="small muted">
              {info.ahead ?? 0} ahead · {info.behind ?? 0} behind
            </span>
          </div>
        )}
        <div className="kv">
          <span className="muted">Changes</span>
          <span>{info.dirty ? `${info.dirty} uncommitted files` : "Clean"}</span>
        </div>
      </section>

      <section className="git-actions">
        <button
          disabled={!!busy || !info.base}
          onClick={() =>
            act("Sync", async () => {
              const r = await api<{ ok: boolean; output: string; conflicts: string[] }>("/git/sync", { json: { cwd } });
              if (!r.ok && r.conflicts.length) {
                props.onAsk(`Merging ${info.base} left conflicts in: ${r.conflicts.join(", ")}. Resolve them, verify the result, and commit the merge.`);
                return `Conflicts in ${r.conflicts.length} files. Asked Claude to resolve them.`;
              }
              return r.output;
            })
          }
        >
          Sync with base
        </button>
        <button
          disabled={!!busy || !info.dirty}
          onClick={() => {
            const message = prompt("Commit message (leave empty to have Claude write one)");
            if (message === null) return;
            if (!message.trim()) return props.onAsk("Commit the current changes with a clear commit message.");
            void act("Commit", async () => (await api<{ output: string }>("/git/commit", { json: { cwd, message } })).output);
          }}
        >
          Commit
        </button>
        <button disabled={!!busy || !info.hasRemote} onClick={() => act("Push", async () => (await api<{ output: string }>("/git/push", { json: { cwd } })).output || "Pushed.")}>
          Push
        </button>
        <button
          disabled={!!busy || !info.hasRemote || !!pr}
          onClick={() => act("Create PR", async () => `Opened ${(await api<{ url: string }>("/git/pr", { json: { cwd, draft: false } })).url}`)}
        >
          Create PR
        </button>
        {busy && <span className="muted small">{busy}…</span>}
      </section>

      {info.hasRemote && (
        <section>
          <div className="section-title">Pull request</div>
          {prError && <div className="err small">{prError}</div>}
          {pr === undefined && !prError && <div className="muted small">Loading…</div>}
          {pr === null && <div className="muted small">No pull request for this branch.</div>}
          {pr && (
            <>
              <a href={pr.url} target="_blank" rel="noreferrer" className="pr-title">
                #{pr.number} {pr.title}
              </a>
              <div className="small muted">
                {pr.isDraft ? "Draft" : pr.state.toLowerCase()} · {pr.mergeable === "CONFLICTING" ? "has conflicts" : pr.mergeable.toLowerCase()}
                {pr.reviewDecision && ` · ${pr.reviewDecision.toLowerCase().replace(/_/g, " ")}`}
              </div>
              <div className="checks">
                {pr.checks.length === 0 && <div className="muted small">No checks</div>}
                {pr.checks.map((c, i) => (
                  <a key={i} className="check" href={c.url} target="_blank" rel="noreferrer">
                    {checkIcon(c)} {c.name}
                  </a>
                ))}
              </div>
              <label className="option" title={props.sessionId ? "" : "Send a message first so this session has an id"}>
                <input
                  type="checkbox"
                  disabled={!props.sessionId}
                  checked={!!props.autofix}
                  onChange={(e) =>
                    void api(`/sessions/${props.sessionId}/meta`, { json: { autofix: e.target.checked, cwd } }).catch((err) => props.onToast(err.message))
                  }
                />
                <span>
                  <b>Auto-fix</b> <span className="muted small">— when CI fails or conflicts appear, ask Claude to fix and push</span>
                </span>
              </label>
            </>
          )}
        </section>
      )}
    </div>
  );
}

const TAB_LABELS: Record<PaneTab, string> = { diff: "Diff", file: "File", git: "Git", terminal: "Terminal", preview: "Preview" };

export function SidePane(props: {
  tab: PaneTab;
  onTab: (t: PaneTab) => void;
  onClose: () => void;
  cwd: string;
  sessionId?: string;
  liveKey?: string;
  autofix?: boolean;
  file?: OpenFile;
  refresh: number;
  terminals: TerminalInfo[];
  terminal?: string;
  onTerminal: (id?: string) => void;
  previews: PreviewInfo[];
  onOpenFile: (f: OpenFile) => void;
  onAsk: (text: string) => void;
  onToast: (text: string) => void;
}) {
  return (
    <aside className="side-pane">
      <div className="tabs">
        {(Object.keys(TAB_LABELS) as PaneTab[]).map((t) => (
          <button key={t} className={props.tab === t ? "on" : ""} onClick={() => props.onTab(t)}>
            {TAB_LABELS[t]}
          </button>
        ))}
        <span className="spacer" />
        <button className="link" onClick={props.onClose} title="Close pane">✕</button>
      </div>
      <div className="pane-body">
        {props.tab === "diff" && <DiffView cwd={props.cwd} refresh={props.refresh} onOpen={props.onOpenFile} />}
        {props.tab === "file" && <FileView cwd={props.cwd} file={props.file} />}
        {props.tab === "git" && (
          <GitView cwd={props.cwd} sessionId={props.sessionId} autofix={props.autofix} refresh={props.refresh} onAsk={props.onAsk} onToast={props.onToast} />
        )}
        {props.tab === "terminal" && (
          <TerminalPane cwd={props.cwd} terminals={props.terminals} selected={props.terminal} onSelect={props.onTerminal} />
        )}
        {props.tab === "preview" && <PreviewPane cwd={props.cwd} previews={props.previews} liveKey={props.liveKey} onToast={props.onToast} />}
      </div>
    </aside>
  );
}
