import { useEffect, useState } from "react";
import { api, defaultModelName, pickableModels, q, type AppSettings, type Bootstrap, type Catalog, type Effort, type PermissionMode, type UsageSummary } from "../api";
import { BackIcon } from "./Icons";

// "2h ago" / "3d ago" — coarse is fine, this is just "when did I last do this".
function relTime(ts: number) {
  const mins = Math.max(0, Math.round((Date.now() - ts) / 60_000));
  if (mins < 1) return "just now";
  if (mins < 60) return `${mins}m ago`;
  const hours = Math.round(mins / 60);
  if (hours < 24) return `${hours}h ago`;
  return `${Math.round(hours / 24)}d ago`;
}

const MODES: [PermissionMode, string][] = [
  ["default", "Ask permissions"],
  ["acceptEdits", "Accept edits"],
  ["plan", "Plan mode"],
  ["auto", "Auto"],
  ["bypassPermissions", "Bypass permissions"],
];
const EFFORTS: Effort[] = ["low", "medium", "high", "xhigh", "max"];

export function Settings({
  boot,
  notifications,
  onToast,
  onBack,
}: {
  boot: Bootstrap;
  notifications: { enabled: boolean; toggle: () => void };
  onToast: (t: string) => void;
  onBack: () => void;
}) {
  const s = boot.settings;
  const [catalog, setCatalog] = useState<Catalog>({ models: [], commands: [] });
  const models = pickableModels(catalog.models);
  const defaultModel = defaultModelName(catalog);
  const [auth, setAuth] = useState<string | null>(null);
  const [usage, setUsage] = useState<UsageSummary | null>(null);

  useEffect(() => {
    void api<Catalog>(`/catalog${q({ cwd: boot.home })}`).then(setCatalog).catch(() => {});
  }, [boot.home]);

  const loadUsage = () => void api<UsageSummary>("/usage").then(setUsage).catch(() => {});
  useEffect(loadUsage, []);

  const save = (patch: Partial<AppSettings>) => void api("/settings", { json: patch }).catch((e) => onToast(e.message));

  return (
    <div className="settings">
      <div className="panel-head">
        <button className="icon-btn" onClick={onBack} title="Back" aria-label="Back">
          <BackIcon />
        </button>
        <h2>Settings</h2>
      </div>

      <section>
        <h3>New sessions</h3>
        <label>
          Default model
          <select value={s.defaultModel ?? ""} onChange={(e) => save({ defaultModel: e.target.value || undefined })}>
            <option value="">Claude Code's default{defaultModel ? ` (${defaultModel})` : ""}</option>
            {models.map((m) => (
              <option key={m.value} value={m.value}>{m.displayName}</option>
            ))}
          </select>
        </label>
        <label>
          Default effort
          <select value={s.defaultEffort ?? ""} onChange={(e) => save({ defaultEffort: (e.target.value || undefined) as Effort })}>
            <option value="">Model default{catalog.defaults?.effort ? ` (${catalog.defaults.effort})` : ""}</option>
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
        <label className="option">
          <input type="checkbox" checked={!!s.remoteControl} onChange={(e) => save({ remoteControl: e.target.checked })} />
          Turn on Remote Control for new sessions, so they show in the Claude app
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

      <section>
        <h3>Usage</h3>
        <p className="muted small">
          What you click most, last 30 days — meant to surface which parts of the app earn their keep and which don't. Tracked locally only;
          nothing leaves this device.
        </p>
        {usage && usage.top.length > 0 ? (
          <>
            <div className="kv">
              <span className="muted">Clicks tracked</span>
              <span>
                {usage.total}
                {usage.firstEventAt ? ` since ${new Date(usage.firstEventAt).toLocaleDateString()}` : ""}
              </span>
            </div>
            <div className="usage-list">
              {usage.top.slice(0, 20).map((row) => (
                <div key={`${row.area ?? ""}:${row.action}`} className="usage-row">
                  <span className="usage-count">{row.count}</span>
                  <span className="usage-action">{row.action}</span>
                  {row.area && <span className="chip">{row.area}</span>}
                  <span className="muted small usage-last">{relTime(row.last)}</span>
                </div>
              ))}
            </div>
          </>
        ) : (
          <p className="muted small">Nothing tracked yet — click around and check back.</p>
        )}
        <div className="row">
          <button onClick={loadUsage}>Refresh</button>
          <button
            onClick={() => {
              if (confirm("Clear all tracked usage data?")) void api("/usage/clear", { method: "POST" }).then(loadUsage).catch((e) => onToast(e.message));
            }}
          >
            Clear
          </button>
        </div>
      </section>
    </div>
  );
}
