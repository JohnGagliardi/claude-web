export type PermissionMode = "default" | "acceptEdits" | "bypassPermissions" | "plan" | "dontAsk" | "auto";
export type Effort = "low" | "medium" | "high" | "xhigh" | "max";

export type SessionInfo = {
  sessionId: string;
  summary: string;
  lastModified: number;
  customTitle?: string;
  firstPrompt?: string;
  gitBranch?: string;
  cwd?: string;
  createdAt?: number;
  pinned?: boolean;
  archived?: boolean;
  unread?: boolean;
  group?: string;
  autofix?: boolean;
};

export type PendingPermission = {
  id: string;
  toolName: string;
  input: Record<string, any>;
  suggestions?: unknown[];
  blockedPath?: string;
};

export type LiveSummary = {
  key: string;
  sessionId?: string;
  cwd: string;
  running: boolean;
  model?: string;
  permissionMode: PermissionMode;
  effort?: Effort;
  pending: PendingPermission[];
  error?: string;
};

export type Bootstrap = {
  sessions: SessionInfo[];
  projects: string[];
  groups: string[];
  live: LiveSummary[];
  reauth: { configured: boolean; label: string; configPath: string };
  home: string;
};

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
export type FileDiff = { path: string; oldPath?: string; status: string; added: number; removed: number; patch: string; binary: boolean };
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

export const q = (params: Record<string, string | undefined>) =>
  "?" + new URLSearchParams(Object.entries(params).filter((e): e is [string, string] => e[1] !== undefined)).toString();

export type ModelInfo ={ value: string; displayName: string; description: string; supportsEffort?: boolean };
export type SlashCommand = { name: string; description: string; argumentHint: string };
export type Catalog = { models: ModelInfo[]; commands: SlashCommand[] };

// Loose shape shared by persisted SessionMessages and live SDKMessages.
export type RawMsg = {
  type: string;
  subtype?: string;
  uuid?: string;
  message?: any;
  parent_tool_use_id?: string | null;
  [k: string]: any;
};

export async function api<T = unknown>(path: string, opts: { method?: string; json?: unknown } = {}): Promise<T> {
  const res = await fetch(`/api${path}`, {
    method: opts.method ?? (opts.json === undefined ? "GET" : "POST"),
    headers: opts.json === undefined ? undefined : { "content-type": "application/json" },
    body: opts.json === undefined ? undefined : JSON.stringify(opts.json),
  });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(body.error ?? `${res.status} ${res.statusText}`);
  return body as T;
}

type Listener = (m: any) => void;

// One WebSocket for the whole app; reconnects and tells listeners so they can resync.
class Socket {
  private ws?: WebSocket;
  private queue: string[] = [];
  private listeners = new Set<Listener>();
  private retry = 500;

  constructor() {
    this.connect();
  }

  private connect() {
    const ws = new WebSocket(`${location.protocol === "https:" ? "wss" : "ws"}://${location.host}/ws`);
    this.ws = ws;
    ws.onopen = () => {
      if (this.retry > 500) this.emit({ t: "reconnected" });
      this.retry = 500;
      for (const q of this.queue.splice(0)) ws.send(q);
    };
    ws.onmessage = (e) => this.emit(JSON.parse(e.data));
    ws.onclose = () => {
      this.emit({ t: "disconnected" });
      setTimeout(() => this.connect(), this.retry);
      this.retry = Math.min(this.retry * 2, 8000);
    };
  }

  private emit(m: any) {
    for (const l of this.listeners) l(m);
  }

  send(m: unknown) {
    const data = JSON.stringify(m);
    if (this.ws?.readyState === WebSocket.OPEN) this.ws.send(data);
    else this.queue.push(data);
  }

  on(l: Listener) {
    this.listeners.add(l);
    return () => void this.listeners.delete(l);
  }
}

export const socket = new Socket();
