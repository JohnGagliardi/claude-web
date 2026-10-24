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
  pending: PendingPermission[];
  error?: string;
};

export type LiveEvent =
  | { t: "sdk"; key: string; msg: SDKMessage }
  | { t: "live"; session: LiveSummary }
  | { t: "closed"; key: string; sessionId?: string };

export type StartOptions = {
  cwd: string;
  resume?: string;
  model?: string;
  effort?: EffortLevel;
  permissionMode?: PermissionMode;
  title?: string;
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
  permissionMode: PermissionMode;
  effort?: EffortLevel;
  // Messages seen since this process started, replayed to late subscribers.
  readonly log: SDKMessage[] = [];
  private readonly input = new InputQueue();
  private readonly q: Query;
  private readonly pending = new Map<string, PendingPermission & { resolve: (r: PermissionResult) => void }>();

  constructor(readonly opts: StartOptions, private readonly emit: (e: LiveEvent) => void) {
    this.sessionId = opts.resume;
    this.permissionMode = opts.permissionMode ?? "default";
    this.effort = opts.effort;
    this.q = query({
      prompt: this.input,
      options: {
        ...opts.extra?.(this.key),
        cwd: opts.cwd,
        resume: opts.resume,
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
      pending: [...this.pending.values()].map(({ resolve: _r, ...p }) => p),
      error: this.error,
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
        }
        if (msg.type === "result") {
          this.running = false;
          this.changed();
        }
        if (msg.type !== "stream_event") this.log.push(msg);
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
  }

  async setPermissionMode(mode: PermissionMode) {
    await this.q.setPermissionMode(mode);
    this.permissionMode = mode;
    this.changed();
  }

  async setEffort(effort: EffortLevel) {
    await this.q.applyFlagSettings({ effortLevel: effort });
    this.effort = effort;
    this.changed();
  }

  supportedModels() {
    return this.q.supportedModels();
  }

  supportedCommands() {
    return this.q.supportedCommands();
  }

  close() {
    this.input.close();
    this.q.close();
  }
}
