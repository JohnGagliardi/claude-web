import { execFile } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

export class CmdError extends Error {
  constructor(message: string, readonly output: string) {
    super(message);
  }
}

function run(cmd: string, args: string[], cwd: string, timeout = 60_000): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(cmd, args, { cwd, timeout, maxBuffer: 64 * 1024 * 1024, windowsHide: true }, (err, stdout, stderr) => {
      if (err) reject(new CmdError(`${cmd} ${args[0]} failed: ${(stderr || err.message).trim()}`, `${stdout}${stderr}`));
      else resolve(stdout);
    });
  });
}

export const git = (cwd: string, ...args: string[]) => run("git", args, cwd);
const gh = (cwd: string, ...args: string[]) => run("gh", args, cwd);

export type RepoInfo = {
  isRepo: boolean;
  root?: string;
  branch?: string;
  base?: string;
  ahead?: number;
  behind?: number;
  dirty?: number;
  isWorktree?: boolean;
  hasRemote?: boolean;
};

export async function repoInfo(cwd: string): Promise<RepoInfo> {
  let root: string;
  try {
    root = (await git(cwd, "rev-parse", "--show-toplevel")).trim();
  } catch {
    return { isRepo: false };
  }
  const [branch, status, gitDir, commonDir, remotes] = await Promise.all([
    git(cwd, "branch", "--show-current").then((s) => s.trim()).catch(() => ""),
    git(cwd, "status", "--porcelain").catch(() => ""),
    git(cwd, "rev-parse", "--absolute-git-dir").then((s) => s.trim()),
    git(cwd, "rev-parse", "--path-format=absolute", "--git-common-dir").then((s) => s.trim()),
    git(cwd, "remote").catch(() => ""),
  ]);
  const base = await baseBranch(cwd);
  let ahead: number | undefined, behind: number | undefined;
  if (base) {
    const counts = await git(cwd, "rev-list", "--left-right", "--count", `${base}...HEAD`).catch(() => "");
    [behind, ahead] = counts.trim().split(/\s+/).map(Number);
  }
  return {
    isRepo: true,
    root: path.normalize(root),
    branch: branch || "(detached)",
    base,
    ahead,
    behind,
    dirty: status.split("\n").filter(Boolean).length,
    isWorktree: path.normalize(gitDir) !== path.normalize(commonDir),
    hasRemote: remotes.trim().length > 0,
  };
}

// The branch a session's work is compared against: origin's default if known,
// else a local main/master.
export async function baseBranch(cwd: string): Promise<string | undefined> {
  const head = await git(cwd, "symbolic-ref", "--short", "refs/remotes/origin/HEAD").catch(() => "");
  if (head.trim()) return head.trim();
  for (const b of ["origin/main", "origin/master", "main", "master"]) {
    if (await git(cwd, "rev-parse", "--verify", "--quiet", b).then(() => true, () => false)) return b;
  }
  return undefined;
}

const slug = (s: string) =>
  s.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 40) || "session";

// Same layout as the desktop app: <repo>/.claude/worktrees/<name> on branch claude/<name>.
export async function createWorktree(cwd: string, name: string): Promise<{ path: string; branch: string }> {
  const root = (await git(cwd, "rev-parse", "--show-toplevel")).trim();
  const base = slug(name);
  let n = 0;
  let dir: string, branch: string;
  do {
    const suffix = n ? `-${n}` : "";
    dir = path.join(root, ".claude", "worktrees", base + suffix);
    branch = `claude/${base}${suffix}`;
    n++;
  } while (fs.existsSync(dir) || (await git(root, "rev-parse", "--verify", "--quiet", branch).then(() => true, () => false)));
  const exclude = path.join((await git(root, "rev-parse", "--path-format=absolute", "--git-common-dir")).trim(), "info", "exclude");
  const current = fs.existsSync(exclude) ? fs.readFileSync(exclude, "utf8") : "";
  if (!current.includes(".claude/worktrees")) {
    fs.mkdirSync(path.dirname(exclude), { recursive: true });
    fs.appendFileSync(exclude, `${current.endsWith("\n") || !current ? "" : "\n"}.claude/worktrees/\n`);
  }
  await git(root, "worktree", "add", "-b", branch, dir, "HEAD");
  return { path: dir, branch };
}

export type FileDiff = { path: string; oldPath?: string; status: string; added: number; removed: number; patch: string; binary: boolean };

function splitPatch(patch: string): FileDiff[] {
  const files: FileDiff[] = [];
  for (const chunk of patch.split(/^(?=diff --git )/m)) {
    if (!chunk.startsWith("diff --git")) continue;
    const m = chunk.match(/^diff --git a\/(.+?) b\/(.+)$/m);
    const lines = chunk.split("\n");
    const status = /^new file/m.test(chunk) ? "A" : /^deleted file/m.test(chunk) ? "D" : /^rename from/m.test(chunk) ? "R" : "M";
    files.push({
      path: m?.[2] ?? "?",
      oldPath: status === "R" ? m?.[1] : undefined,
      status,
      added: lines.filter((l) => l.startsWith("+") && !l.startsWith("+++")).length,
      removed: lines.filter((l) => l.startsWith("-") && !l.startsWith("---")).length,
      patch: chunk,
      binary: /^Binary files /m.test(chunk),
    });
  }
  return files;
}

// Working-tree changes against HEAD, untracked files included (shown as additions).
export async function workingDiff(cwd: string, against: "HEAD" | "base" = "HEAD"): Promise<{ ref: string; files: FileDiff[] }> {
  let ref = "HEAD";
  if (against === "base") {
    const base = await baseBranch(cwd);
    if (base) ref = (await git(cwd, "merge-base", base, "HEAD")).trim();
  }
  const tracked = await git(cwd, "-c", "core.quotepath=off", "diff", ref, "--no-color", "--find-renames");
  const untracked = (await git(cwd, "ls-files", "--others", "--exclude-standard", "-z")).split("\0").filter(Boolean);
  const files = splitPatch(tracked);
  for (const f of untracked.slice(0, 200)) {
    const full = path.join(cwd, f);
    let body = "";
    let binary = false;
    try {
      const buf = fs.readFileSync(full);
      binary = buf.includes(0) || buf.length > 1_000_000;
      body = binary ? "" : buf.toString("utf8");
    } catch {
      continue;
    }
    const lines = body ? body.replace(/\n$/, "").split("\n") : [];
    files.push({
      path: f.replace(/\\/g, "/"),
      status: "?",
      added: lines.length,
      removed: 0,
      patch: binary ? "Binary file" : `@@ -0,0 +1,${lines.length} @@\n${lines.map((l) => "+" + l).join("\n")}`,
      binary,
    });
  }
  return { ref: against === "base" ? ref.slice(0, 8) : "HEAD", files };
}

// Reads a file for the viewer. Only paths inside the session's folder are served.
export function readFileFor(cwd: string, file: string): { path: string; content: string; truncated: boolean } {
  const full = path.resolve(cwd, file);
  const rel = path.relative(path.resolve(cwd), full);
  if (rel.startsWith("..") || path.isAbsolute(rel)) throw new Error("That file is outside this session's folder.");
  const buf = fs.readFileSync(full);
  if (buf.includes(0)) throw new Error("Binary file");
  const limit = 2_000_000;
  return { path: full, content: buf.subarray(0, limit).toString("utf8"), truncated: buf.length > limit };
}

export async function syncWithBase(cwd: string): Promise<{ ok: boolean; output: string; conflicts: string[] }> {
  const base = await baseBranch(cwd);
  if (!base) throw new Error("No base branch found (origin/HEAD, main or master).");
  let output = "";
  if (base.startsWith("origin/")) output += await git(cwd, "fetch", "origin", base.slice("origin/".length)).catch((e) => e.output ?? "");
  try {
    output += await git(cwd, "merge", "--no-edit", base);
    return { ok: true, output: output.trim() || "Up to date.", conflicts: [] };
  } catch (e) {
    const conflicts = (await git(cwd, "diff", "--name-only", "--diff-filter=U").catch(() => "")).split("\n").filter(Boolean);
    return { ok: false, output: (e as CmdError).output ?? String(e), conflicts };
  }
}

export async function commitAll(cwd: string, message: string) {
  await git(cwd, "add", "-A");
  return git(cwd, "commit", "-m", message);
}

export async function push(cwd: string) {
  return run("git", ["push", "-u", "origin", "HEAD"], cwd, 120_000);
}

export type Check = { name: string; status: string; conclusion: string; url?: string };
export type PrStatus = {
  number: number;
  url: string;
  title: string;
  state: string;
  isDraft: boolean;
  mergeable: string;
  reviewDecision: string;
  checks: Check[];
};

export async function prStatus(cwd: string): Promise<PrStatus | null> {
  let raw: string;
  try {
    raw = await gh(cwd, "pr", "view", "--json", "number,url,title,state,isDraft,mergeable,reviewDecision,statusCheckRollup");
  } catch (e) {
    const msg = String((e as Error).message);
    if (/no pull requests found/i.test(msg)) return null;
    if (/known GitHub host/i.test(msg)) throw new Error("This repo's remote isn't on GitHub, so pull requests aren't available.");
    throw e;
  }
  const j = JSON.parse(raw);
  return {
    number: j.number,
    url: j.url,
    title: j.title,
    state: j.state,
    isDraft: j.isDraft,
    mergeable: j.mergeable,
    reviewDecision: j.reviewDecision,
    checks: (j.statusCheckRollup ?? []).map((c: any) => ({
      name: c.name ?? c.context,
      status: c.status ?? (c.state === "PENDING" ? "IN_PROGRESS" : "COMPLETED"),
      conclusion: c.conclusion ?? c.state ?? "",
      url: c.detailsUrl ?? c.targetUrl,
    })),
  };
}

export async function createPr(cwd: string, draft: boolean) {
  const args = ["pr", "create", "--fill"];
  if (draft) args.push("--draft");
  return (await run("gh", args, cwd, 120_000)).trim();
}

export const failedChecks = (pr: PrStatus) =>
  pr.checks.filter((c) => ["FAILURE", "ERROR", "TIMED_OUT", "CANCELLED", "ACTION_REQUIRED"].includes(c.conclusion.toUpperCase()));
