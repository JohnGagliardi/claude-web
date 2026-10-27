import { randomUUID } from "node:crypto";
import {
  query,
  type EffortLevel,
  type Options,
  type PermissionMode,
  type PermissionResult,
  type PermissionUpdate,
  type Query,
  type SDKMessage,
  type SDKUserMessage,
} from "@anthropic-ai/claude-agent-sdk";

// Push-based async iterable: the SDK pulls user turns from it for as long as the
// session lives, so one Claude Code process serves the whole conversation.
class InputQueue implements AsyncIterable<SDKUserMessage> {
  private items: SDKUserMessage[] = [];
  private waiter?: (r: IteratorResult<SDKUserMessage>) => void;
  private closed = false;

  push(m: SDKUserMessage) {
    if (this.waiter) {
      const w = this.waiter;
      this.waiter = undefined;
      w({ value: m, done: false });
    } else this.items.push(m);
  }

  close() {
    this.closed = true;
    this.waiter?.({ value: undefined, done: true });
  }

  [Symbol.asyncIterator](): AsyncIterator<SDKUserMessage> {
    return {
      next: () => {
        if (this.items.length) return Promise.resolve({ value: this.items.shift()!, done: false });
        if (this.closed) return Promise.resolve({ value: undefined, done: true });
        return new Promise((r) => (this.waiter = r));
      },
    };
  }
}

export type PendingPermission = {
  id: string;
  toolName: string;
  input: Record<string, unknown>;
  suggestions?: PermissionUpdate[];
  blockedPath?: string;
};

export type LiveSummary = {
  key: string;
  sessionId?: string;
  cwd: string;
  running: boolean;
  model?: string;
  permissionMode: PermissionMode;
  effort?: EffortLevel;
  // The effort actually sent once defaults are resolved; null when the model takes none.
  appliedEffort?: EffortLevel | null;
  pending: PendingPermission[];
  error?: string;
  // A side chat: a fork that stays out of the sidebar.
  sideChat?: boolean;
  // Remote Control: the session also shows in claude.ai/code and the Claude app.
  remote?: RemoteState;
};

// `state` is the CLI's bridge_state (ready, connected, failed, ...), or
// "connecting" until it reports one.
export type RemoteState = { state: string; url?: string; detail?: string };

export type LiveEvent =
  | { t: "sdk"; key: string; msg: SDKMessage }
  | { t: "live"; session: LiveSummary }
  | { t: "external-turn"; key: string }
  | { t: "closed"; key: string; sessionId?: string };

export type StartOptions = {
  cwd: string;
  resume?: string;
  model?: string;
  effort?: EffortLevel;
  permissionMode?: PermissionMode;
  title?: string;
  // With resume: branch off a copy of that conversation instead of continuing it.
  fork?: boolean;
  // Turn Remote Control on as soon as the session starts.
  remoteControl?: boolean;
  // Per-session extras such as the app's MCP tools, built with the session key.
  extra?: (key: string) => Partial<Options>;
};

export type PermissionReply =
  | { decision: "allow" | "always"; updatedInput?: Record<string, unknown> }
  | { decision: "deny"; message?: string };

export class LiveSession {
  readonly key = randomUUID();
  sessionId?: string;
  running = false;
  model?: string;
  error?: string;
  lastActive = Date.now();
  // Non-ambient background shells and agents; idle shutdown waits for them.
  backgroundTasks = 0;
  permissionMode: PermissionMode;
  effort?: EffortLevel;
  appliedEffort?: EffortLevel | null;
  remote?: RemoteState;
  // Messages seen since this process started, replayed to late subscribers.
  readonly log: SDKMessage[] = [];
  private readonly input = new InputQueue();
  private readonly q: Query;
  private readonly pending = new Map<string, PendingPermission & { resolve: (r: PermissionResult) => void }>();

  constructor(readonly opts: StartOptions, private readonly emit: (e: LiveEvent) => void) {
    this.sessionId = opts.fork ? undefined : opts.resume;
    this.permissionMode = opts.permissionMode ?? "default";
    this.effort = opts.effort;
    this.q = query({
      prompt: this.input,
      options: {
        ...opts.extra?.(this.key),
        cwd: opts.cwd,
        resume: opts.resume,
        forkSession: opts.fork,
        title: opts.title,
        model: opts.model,
        effort: opts.effort,
        permissionMode: this.permissionMode,
        allowDangerouslySkipPermissions: true,
        includePartialMessages: true,
        settingSources: ["user", "project", "local"],
        systemPrompt: { type: "preset", preset: "claude_code" },
        canUseTool: (toolName, input, { signal, suggestions, blockedPath }) =>
          this.askPermission(toolName, input, signal, suggestions, blockedPath),
      },
    });
    void this.pump();
  }

  summary(): LiveSummary {
    return {
      key: this.key,
      sessionId: this.sessionId,
      cwd: this.opts.cwd,
      running: this.running,
      model: this.model,
      permissionMode: this.permissionMode,
      effort: this.effort,
      appliedEffort: this.appliedEffort,
      pending: [...this.pending.values()].map(({ resolve: _r, ...p }) => p),
      error: this.error,
      sideChat: this.opts.fork || undefined,
      remote: this.remote,
    };
  }

  private changed() {
    this.emit({ t: "live", session: this.summary() });
  }

  private idWaiters: ((id: string) => void)[] = [];

  // Resolves once Claude Code has assigned (or resumed) the session id.
  sessionIdReady(timeoutMs = 60_000): Promise<string | undefined> {
    if (this.sessionId) return Promise.resolve(this.sessionId);
    return new Promise((resolve) => {
      this.idWaiters.push(resolve);
      setTimeout(() => resolve(this.sessionId), timeoutMs);
    });
  }

  private async pump() {
    try {
      for await (const msg of this.q) {
        this.lastActive = Date.now();
        if (msg.type === "system" && msg.subtype === "init") {
          this.sessionId = msg.session_id;
          this.model = msg.model;
          this.permissionMode = msg.permissionMode;
          for (const w of this.idWaiters.splice(0)) w(msg.session_id);
          this.changed();
          void this.refreshApplied();
          if (this.opts.remoteControl && !this.remote) void this.setRemoteControl(true).catch(() => {});
        }
        // A prompt sent from the phone starts a turn this side didn't. The SDK
        // never echoes that prompt, but the CLI has saved it to the transcript by
        // now, so clients re-read it from there.
        if (!this.running && (msg.type === "assistant" || msg.type === "stream_event")) {
          this.running = true;
          this.changed();
          this.emit({ t: "external-turn", key: this.key });
        }
        if (msg.type === "system" && (msg as { subtype?: string }).subtype === "bridge_state") {
          const b = msg as unknown as { state: string; detail?: string };
          if (this.remote) {
            this.remote = { ...this.remote, state: b.state, detail: b.detail };
            this.changed();
          }
        }
        if (msg.type === "result") {
          this.running = false;
          this.changed();
        }
        if (msg.type === "system" && msg.subtype === "background_tasks_changed") {
          this.backgroundTasks = msg.tasks.filter((t) => !t.ambient).length;
        }
        if (msg.type !== "stream_event") {
          // Arrival time lets the UI show how long background tasks have run.
          (msg as { received_at?: number }).received_at = Date.now();
          this.log.push(msg);
        }
        this.emit({ t: "sdk", key: this.key, msg });
      }
    } catch (e) {
      this.error = e instanceof Error ? e.message : String(e);
      this.running = false;
      this.changed();
    } finally {
      this.emit({ t: "closed", key: this.key, sessionId: this.sessionId });
    }
  }

  // Plain text, or content blocks when the user attached images or documents.
  send(content: SDKUserMessage["message"]["content"]) {
    this.running = true;
    this.error = undefined;
    this.lastActive = Date.now();
    this.input.push({
      type: "user",
      message: { role: "user", content },
      parent_tool_use_id: null,
    });
    this.changed();
  }

  private askPermission(
    toolName: string,
    input: Record<string, unknown>,
    signal: AbortSignal,
    suggestions?: PermissionUpdate[],
    blockedPath?: string,
  ): Promise<PermissionResult> {
    return new Promise((resolve) => {
      const id = randomUUID();
      const settle = (r: PermissionResult) => {
        if (!this.pending.delete(id)) return;
        resolve(r);
        this.changed();
      };
      this.pending.set(id, { id, toolName, input, suggestions, blockedPath, resolve: settle });
      signal.addEventListener("abort", () => settle({ behavior: "deny", message: "Cancelled" }));
      this.changed();
    });
  }

  answerPermission(id: string, reply: PermissionReply) {
    this.lastActive = Date.now();
    const p = this.pending.get(id);
    if (!p) return;
    if (reply.decision === "deny") {
      p.resolve({ behavior: "deny", message: reply.message || "The user denied this action." });
    } else {
      p.resolve({
        behavior: "allow",
        updatedInput: reply.updatedInput ?? p.input,
        updatedPermissions: reply.decision === "always" ? p.suggestions : undefined,
      });
    }
  }

  async interrupt() {
    for (const p of this.pending.values()) p.resolve({ behavior: "deny", message: "Interrupted", interrupt: true });
    await this.q.interrupt();
  }

  async setModel(model?: string) {
    await this.q.setModel(model);
    this.model = model;
    this.changed();
    void this.refreshApplied();
  }

  async setPermissionMode(mode: PermissionMode) {
    await this.q.setPermissionMode(mode);
    this.permissionMode = mode;
    this.changed();
  }

  // No effort goes back to the model's default.
  async setEffort(effort?: EffortLevel) {
    await this.q.applyFlagSettings({ effortLevel: effort ?? null });
    this.effort = effort;
    this.changed();
    void this.refreshApplied();
  }

  // The model and effort the session really uses, after defaults and settings.
  // getSettings exists at runtime but isn't on the typed Query.
  async applied(): Promise<{ model?: string; effort?: EffortLevel | null }> {
    const r = await (this.q as unknown as { getSettings(): Promise<{ applied?: { model?: string; effort?: EffortLevel | null } }> }).getSettings();
    return r.applied ?? {};
  }

  private async refreshApplied() {
    try {
      this.appliedEffort = (await this.applied()).effort ?? null;
      this.changed();
    } catch {}
  }

  // Remote Control, as the desktop app's toggle does it: the CLI runs the
  // bridge (and its sign-in and device checks) itself. Not on the typed Query.
  async setRemoteControl(enabled: boolean) {
    const request = (r: object) => (this.q as unknown as { request(r: object): Promise<{ response?: { session_url?: string } }> }).request(r);
    if (!enabled) {
      this.remote = undefined;
      this.changed();
      await request({ subtype: "remote_control", enabled: false });
      return;
    }
    this.remote = { state: "connecting" };
    this.changed();
    try {
      const r = await request({ subtype: "remote_control", enabled: true });
      // bridge_state may already have moved past "connecting".
      if (this.remote) this.remote = { ...this.remote, state: this.remote.state === "connecting" ? "ready" : this.remote.state, url: r.response?.session_url };
    } catch (e) {
      this.remote = { state: "failed", detail: e instanceof Error ? e.message : String(e) };
    }
    this.changed();
  }

  supportedModels() {
    return this.q.supportedModels();
  }

  supportedCommands() {
    return this.q.supportedCommands();
  }

  // Session details for the Info pane.
  contextUsage() {
    return this.q.getContextUsage({ detail: "full" });
  }

  mcpStatus() {
    return this.q.mcpServerStatus();
  }

  toggleMcp(name: string, enabled: boolean) {
    return this.q.toggleMcpServer(name, enabled);
  }

  reconnectMcp(name: string) {
    return this.q.reconnectMcpServer(name);
  }

  stopTask(taskId: string) {
    return this.q.stopTask(taskId);
  }

  // Last 8 KiB a shell or Monitor task wrote; not in the typed Query surface yet.
  taskOutput(taskId: string): Promise<{ output: string; total_bytes: number; truncated: boolean }> {
    return (this.q as unknown as { getTaskOutput(id: string): Promise<{ output: string; total_bytes: number; truncated: boolean }> }).getTaskOutput(taskId);
  }

  close() {
    this.input.close();
    this.q.close();
  }
}
