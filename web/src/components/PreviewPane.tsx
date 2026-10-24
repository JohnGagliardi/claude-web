import { useEffect, useState } from "react";
import { api, q, socket, type LaunchConfig, type PreviewInfo } from "../api";

type Shot = { data: string; url: string } | null;

function ClaudeBrowser({ liveKey }: { liveKey?: string }) {
  const [shot, setShot] = useState<Shot>(null);
  useEffect(() => {
    setShot(null);
    if (!liveKey) return;
    void api<Shot>(`/browser/shot${q({ key: liveKey })}`).then(setShot);
    return socket.on((m) => {
      if (m.t === "browser:shot" && m.key === liveKey) setShot({ data: m.data, url: m.url });
    });
  }, [liveKey]);
  if (!shot) return <div className="pane-empty">Claude hasn't opened a page in its browser yet this session.</div>;
  return (
    <div className="shot">
      <div className="pane-bar mono small">{shot.url}</div>
      <img src={`data:image/jpeg;base64,${shot.data}`} alt="Claude's browser" />
    </div>
  );
}

export function PreviewPane({ cwd, previews, liveKey, onToast }: { cwd: string; previews: PreviewInfo[]; liveKey?: string; onToast: (t: string) => void }) {
  const [configs, setConfigs] = useState<LaunchConfig[]>([]);
  const [mode, setMode] = useState<"page" | "claude">("page");
  const [url, setUrl] = useState("");
  const [frameUrl, setFrameUrl] = useState("");
  const [frameKey, setFrameKey] = useState(0);
  const [logsFor, setLogsFor] = useState<string | null>(null);
  const [logs, setLogs] = useState<string[]>([]);
  const [starting, setStarting] = useState("");

  const mine = previews.filter((p) => p.cwd === cwd);

  useEffect(() => {
    void api<{ configs: LaunchConfig[] }>(`/preview${q({ cwd })}`)
      .then((r) => setConfigs(r.configs))
      .catch(() => setConfigs([]));
  }, [cwd]);

  // Show the first running server unless the user picked a URL.
  useEffect(() => {
    const first = mine.find((p) => p.status !== "exited");
    if (first && !frameUrl) {
      setUrl(first.url);
      setFrameUrl(first.url);
    }
  }, [mine.map((p) => p.id + p.status).join()]);

  useEffect(() => {
    if (!logsFor) return;
    const load = () => void api<string[]>(`/preview/logs${q({ id: logsFor })}`).then(setLogs);
    load();
    const t = setInterval(load, 2000);
    return () => clearInterval(t);
  }, [logsFor]);

  const start = async (name: string) => {
    setStarting(name);
    try {
      const p = await api<PreviewInfo>("/preview/start", { json: { cwd, name } });
      setUrl(p.url);
      setFrameUrl(p.url);
      setFrameKey((k) => k + 1);
    } catch (e) {
      onToast((e as Error).message);
    } finally {
      setStarting("");
    }
  };

  return (
    <div className="preview-pane">
      <div className="pane-bar">
        <button className={mode === "page" ? "on" : ""} onClick={() => setMode("page")}>Preview</button>
        <button className={mode === "claude" ? "on" : ""} onClick={() => setMode("claude")}>Claude's browser</button>
      </div>
      {mode === "claude" ? (
        <ClaudeBrowser liveKey={liveKey} />
      ) : (
        <>
          <div className="servers">
            {configs.length === 0 && (
              <div className="muted small">
                No <span className="mono">.claude/launch.json</span> in this folder. Ask Claude to create one, or enter a URL below.
              </div>
            )}
            {configs.map((c) => {
              const p = mine.find((x) => x.name === c.name);
              const up = p && p.status !== "exited";
              return (
                <div key={c.name} className="server">
                  <span className={`status ${up ? "unread" : ""}`} />
                  <b>{c.name}</b>
                  <span className="muted small mono">{c.url ?? (c.port ? `:${c.port}` : "")}</span>
                  <span className="spacer" />
                  {p?.status === "exited" && <span className="err small">exited {p.exitCode}</span>}
                  {p && <button className="link" onClick={() => setLogsFor(logsFor === p.id ? null : p.id)}>logs</button>}
                  {up ? (
                    <button onClick={() => void api("/preview/stop", { json: { id: p!.id } })}>Stop</button>
                  ) : (
                    <button disabled={!!starting} onClick={() => void start(c.name)}>
                      {starting === c.name ? "Starting…" : "Start"}
                    </button>
                  )}
                </div>
              );
            })}
          </div>
          {logsFor && <pre className="logs">{logs.join("\n") || "(no output yet)"}</pre>}
          <form
            className="pane-bar url-bar"
            onSubmit={(e) => {
              e.preventDefault();
              const u = /^https?:\/\//.test(url) ? url : `http://${url}`;
              setUrl(u);
              setFrameUrl(u);
              setFrameKey((k) => k + 1);
            }}
          >
            <button type="button" className="link" title="Reload" onClick={() => setFrameKey((k) => k + 1)}>⟳</button>
            <input value={url} onChange={(e) => setUrl(e.target.value)} placeholder="http://localhost:5173" />
            {frameUrl && (
              <a href={frameUrl} target="_blank" rel="noreferrer" className="small">
                open ↗
              </a>
            )}
          </form>
          {frameUrl ? (
            <iframe key={frameKey} className="frame" src={frameUrl} title="Preview" />
          ) : (
            <div className="pane-empty">Start a server or enter a URL.</div>
          )}
        </>
      )}
    </div>
  );
}
