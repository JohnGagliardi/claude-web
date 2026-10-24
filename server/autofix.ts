import { failedChecks, prStatus } from "./git.js";
import { getState } from "./state.js";

const INTERVAL = 90_000;

// Last problem reported per session, so each new failure is sent to Claude once.
const reported = new Map<string, string>();

// Watches the PR of every session with Auto-fix on and, when CI newly fails or
// the PR picks up merge conflicts, sends the session a message to fix it.
export function startAutofix(deliver: (sessionId: string, cwd: string, text: string) => void, isBusy: (sessionId: string) => boolean) {
  const tick = async () => {
    const watched = Object.entries(getState().sessions).filter(([, m]) => m.autofix && m.cwd);
    for (const [sessionId, meta] of watched) {
      if (isBusy(sessionId)) continue;
      try {
        const pr = await prStatus(meta.cwd!);
        if (!pr || pr.state !== "OPEN") continue;
        const failed = failedChecks(pr);
        const running = pr.checks.some((c) => c.status.toUpperCase() !== "COMPLETED");
        let problem = "";
        let text = "";
        if (failed.length && !running) {
          problem = `ci:${failed.map((c) => c.name).sort().join(",")}`;
          text =
            `CI failed on PR #${pr.number} (${pr.url}): ${failed.map((c) => c.name).join(", ")}. ` +
            "Find the cause with `gh pr checks` and `gh run view --log-failed`, fix it, run the relevant checks locally, then commit and push.";
        } else if (pr.mergeable === "CONFLICTING") {
          problem = "conflict";
          text = `PR #${pr.number} has merge conflicts with its base branch. Merge the base branch in, resolve the conflicts, verify, then commit and push.`;
        }
        if (!problem) {
          reported.delete(sessionId);
          continue;
        }
        if (reported.get(sessionId) === problem) continue;
        reported.set(sessionId, problem);
        deliver(sessionId, meta.cwd!, `[Auto-fix] ${text}`);
      } catch {
        // gh missing, offline or not authenticated: try again next tick.
      }
    }
  };
  setInterval(() => void tick(), INTERVAL);
}
