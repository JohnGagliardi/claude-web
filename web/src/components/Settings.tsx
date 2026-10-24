import { useEffect, useState } from "react";
import { api, q, type AppSettings, type Bootstrap, type Catalog, type Effort, type PermissionMode } from "../api";

const MODES: [PermissionMode, string][] = [
  ["default", "Ask permissions"],
  ["acceptEdits", "Accept edits"],
  ["plan", "Plan mode"],
  ["auto", "Auto"],
  ["bypassPermissions", "Bypass permissions"],
];
const EFFORTS: Effort[] = ["low", "medium", "high", "xhigh", "max"];

export function Settings({ boot, notifications, onToast }: { boot: Bootstrap; notifications: { enabled: boolean; toggle: () => void }; onToast: (t: string) => void }) {
  const s = boot.settings;
  const [models, setModels] = useState<Catalog["models"]>([]);
  const [auth, setAuth] = useState<string | null>(null);

  useEffect(() => {
    void api<Catalog>(`/catalog${q({ cwd: boot.home })}`).then((c) => setModels(c.models)).catch(() => {});
  }, [boot.home]);

  const save = (patch: Partial<AppSettings>) => void api("/settings", { json: patch }).catch((e) => onToast(e.message));

  return (
    <div className="settings">
      <h2>Settings</h2>

      <section>
        <h3>New sessions</h3>
        <label>
          Default model
          <select value={s.defaultModel ?? ""} onChange={(e) => save({ defaultModel: e.target.value || undefined })}>
            <option value="">Claude Code's default</option>
            {models.map((m) => (
              <option key={m.value} value={m.value}>{m.displayName}</option>
            ))}
          </select>
        </label>
        <label>
          Default effort
          <select value={s.defaultEffort ?? ""} onChange={(e) => save({ defaultEffort: (e.target.value || undefined) as Effort })}>
            <option value="">Model default</option>
            {EFFORTS.map((e) => (
              <option key={e} value={e}>{e}</option>
            ))}
          </select>
        </label>
        <label>
          Default permission mode
          <select value={s.defaultPermissionMode} onChange={(e) => save({ defaultPermissionMode: e.target.value as PermissionMode })}>
            {MODES.map(([v, l]) => (
              <option key={v} value={v}>{l}</option>
            ))}
          </select>
        </label>
        <label className="option">
          <input type="checkbox" checked={s.newSessionWorktree} onChange={(e) => save({ newSessionWorktree: e.target.checked })} />
          Start new sessions in their own git worktree
        </label>
      </section>

      <section>
        <h3>Background</h3>
        <label>
          Shut down idle sessions after
          <span className="row">
            <input
              type="number"
              min={0}
              value={s.idleMinutes}
              onChange={(e) => save({ idleMinutes: Math.max(0, Number(e.target.value) || 0) })}
            />
            <span className="muted small">minutes (0 = never). A closed session resumes when you send it a message.</span>
          </span>
        </label>
        <label className="option">
          <input type="checkbox" checked={notifications.enabled} onChange={notifications.toggle} />
          Desktop notifications when a session finishes or needs approval (this browser)
        </label>
      </section>

      <section>
        <h3>This device</h3>
        <div className="kv">
          <span className="muted">Reauth</span>
          <span>{boot.reauth.configured ? `"${boot.reauth.label}" command configured` : "Not set up"}</span>
        </div>
        <div className="kv">
          <span className="muted">Config</span>
          <span className="mono small">{boot.reauth.configPath}</span>
        </div>
        <p className="muted small">
          Reauth and the headless browser (<span className="mono">"browser": {"{ \"channel\": \"chrome\" }"}</span>) are set per device in that file, not
          here.
        </p>
        <div>
          <button
            onClick={() => {
              setAuth("Checking…");
              void api<{ ok: boolean; output: string }>("/auth-status").then((r) => setAuth(r.output), (e) => setAuth(e.message));
            }}
          >
            Check Claude Code sign-in
          </button>
        </div>
        {auth && <pre className="auth-out">{auth}</pre>}
      </section>
    </div>
  );
}
