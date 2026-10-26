import { useEffect, useState } from "react";
import { api, q, type BrowseResult } from "../api";
import { FolderIcon } from "./Icons";

function FolderPicker(props: { start: string; onCancel: () => void; onPick: (path: string) => void }) {
  const [result, setResult] = useState<BrowseResult | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [path, setPath] = useState(props.start);

  useEffect(() => {
    let alive = true;
    setError(null);
    api<BrowseResult>(`/browse${q({ path })}`)
      .then((r) => alive && setResult(r))
      .catch((e) => alive && setError(String(e.message ?? e)));
    return () => void (alive = false);
  }, [path]);

  return (
    <div className="modal browse">
      <h2>Choose a folder</h2>
      <div className="browse-path mono small">{result?.path ?? path}</div>
      <div className="browse-list">
        {error && <div className="muted small pad">{error}</div>}
        {!error && result?.parent && (
          <button className="browse-entry" onClick={() => setPath(result.parent!)}>
            <FolderIcon /> ..
          </button>
        )}
        {!error && result?.entries.map((name) => (
          <button key={name} className="browse-entry" onClick={() => setPath(`${result.path}/${name}`)}>
            <FolderIcon /> {name}
          </button>
        ))}
        {!error && result && result.entries.length === 0 && !result.parent && <div className="muted small pad">No subfolders</div>}
      </div>
      <div className="modal-actions">
        <button className="link" onClick={props.onCancel}>
          Cancel
        </button>
        <button className="primary" disabled={!result || !!error} onClick={() => result && props.onPick(result.path)}>
          Use this folder
        </button>
      </div>
    </div>
  );
}

export function NewSessionModal(props: {
  defaultCwd: string;
  defaultWorktree: boolean;
  onCancel: () => void;
  onStart: (opts: { cwd: string; name: string; worktree: boolean }) => void;
}) {
  const [cwd, setCwd] = useState(props.defaultCwd);
  const [name, setName] = useState("");
  const [worktree, setWorktree] = useState(props.defaultWorktree);
  const [browsing, setBrowsing] = useState(false);

  const canStart = name.trim().length > 0;
  const start = () => canStart && props.onStart({ cwd, name: name.trim(), worktree });

  if (browsing)
    return (
      <div className="modal-overlay">
        <FolderPicker
          start={cwd}
          onCancel={() => setBrowsing(false)}
          onPick={(p) => {
            setCwd(p);
            setBrowsing(false);
          }}
        />
      </div>
    );

  return (
    <div className="modal-overlay" onClick={props.onCancel}>
      <div className="modal" onClick={(e) => e.stopPropagation()}>
        <h2>New session</h2>
        <label className="field">
          Working directory
          <div className="field-row">
            <div className="field-value mono small" title={cwd}>{cwd}</div>
            <button onClick={() => setBrowsing(true)}>Browse…</button>
          </div>
        </label>
        <label className="field">
          Name
          <input
            autoFocus
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder="Required"
            onKeyDown={(e) => e.key === "Enter" && start()}
          />
        </label>
        <label className="option small" title="Start this session on its own branch in <repo>/.claude/worktrees">
          <input type="checkbox" checked={worktree} onChange={(e) => setWorktree(e.target.checked)} />
          Start in its own worktree
        </label>
        <div className="modal-actions">
          <button className="link" onClick={props.onCancel}>
            Cancel
          </button>
          <button className="primary" disabled={!canStart} onClick={start}>
            Start
          </button>
        </div>
      </div>
    </div>
  );
}
