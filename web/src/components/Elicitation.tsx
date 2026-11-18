import type { ElicitationReply, PendingElicitation } from "../api";

// A server can have more than one place this could point (e.g. a prod Jira
// vs. a sandbox) — the host is the one thing that actually disambiguates
// that before you click, so surface it instead of a generic "sign in" button.
function hostOf(url?: string) {
  try {
    return url ? new URL(url).host : undefined;
  } catch {
    return undefined;
  }
}

// Opening the URL and sending "accept" happen in the same click so the
// window.open counts as a direct user gesture — doing it after an await
// (e.g. waiting on a server round-trip first) risks the popup blocker.
export function ElicitationCard({ p, onReply }: { p: PendingElicitation; onReply: (r: ElicitationReply) => void }) {
  const title = p.title || (p.mode === "url" ? `${p.displayName || p.serverName} needs you to sign in` : `${p.displayName || p.serverName} is asking for input`);
  if (p.mode === "url" && p.url) {
    const host = hostOf(p.url);
    return (
      <div className="perm">
        <div className="perm-title">{title}</div>
        {host && <span className="chip">{host}</span>}
        {p.description && <div className="muted small">{p.description}</div>}
        <div>{p.message}</div>
        <div className="muted small mono">{p.url}</div>
        <div className="perm-actions">
          <button
            className="primary"
            onClick={() => {
              window.open(p.url, "_blank", "noopener");
              onReply({ action: "accept" });
            }}
          >
            Open {host ?? "URL"} to sign in
          </button>
          <button onClick={() => onReply({ action: "decline" })}>Decline</button>
        </div>
      </div>
    );
  }
  // Form-mode elicitation: Clyde doesn't render a dynamic form for arbitrary
  // JSON Schema yet. Decline explicitly instead of leaving it to hang until
  // the MCP server's own timeout.
  return (
    <div className="perm">
      <div className="perm-title">{title}</div>
      <div>{p.message}</div>
      <div className="muted small">This kind of request isn't supported in Clyde yet.</div>
      <div className="perm-actions">
        <button onClick={() => onReply({ action: "decline" })}>Decline</button>
      </div>
    </div>
  );
}
