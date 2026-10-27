import type { RawMsg } from "./api";

export type ToolResult = { text: string; isError: boolean; images: string[] };

const imagesOf = (content: any): string[] =>
  Array.isArray(content)
    ? content.filter((b) => b?.type === "image" && b.source?.type === "base64").map((b) => `data:${b.source.media_type};base64,${b.source.data}`)
    : [];

export type Item =
  | { kind: "user"; id: string; text: string; images: string[]; documents: number }
  | { kind: "command"; id: string; text: string }
  | { kind: "text"; id: string; text: string }
  | { kind: "thinking"; id: string; text: string; durationMs?: number }
  | { kind: "tool"; id: string; name: string; input: any; result?: ToolResult; children: RawMsg[]; agentId?: string; hidden?: boolean }
  | { kind: "result"; id: string; ok: boolean; text: string }
  | { kind: "system"; id: string; text: string }
  | { kind: "compact"; id: string; summary?: string }
  | { kind: "chapter"; id: string; title: string; summary?: string }
  | { kind: "wrap"; id: string; recap: string; ask?: string; actions: WrapAction[]; stale: boolean };

export type WrapAction = { label: string; message: string };

// Desktop-app tools that draw part of the screen rather than doing work. They
// show up in sessions started from the Code tab.
// Clyde's own tool server offers the same update_plan for its sessions.
const isPlanTool = (name: string) => name === "mcp__ccd_turn__update_plan" || name === "mcp__claude-web__update_plan";
const WRAP_TOOL = "mcp__ccd_turn__wrap_up";
const CHAPTER_TOOL = "mcp__ccd_session__mark_chapter";
const APP_ACTIONS: Record<string, string> = {
  commit: "Commit these changes.",
  create_pr: "Open a pull request for this.",
  merge: "Merge the pull request.",
  verify: "Verify the change works.",
};

function wrapActions(actions: any): WrapAction[] {
  let list = actions;
  if (typeof list === "string") {
    try {
      list = JSON.parse(list);
    } catch {
      list = [];
    }
  }
  if (!Array.isArray(list)) return [];
  const out: WrapAction[] = [];
  for (const a of list) {
    const label = a?.label ?? (a?.action ? String(a.action).replace(/_/g, " ") : "");
    const message = a?.message ?? a?.label ?? APP_ACTIONS[a?.action];
    if (label && message) out.push({ label: label[0].toUpperCase() + label.slice(1), message });
  }
  return out;
}

function blockText(content: any): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .map((b) => (b?.type === "text" ? b.text : b?.type === "image" ? "[image]" : ""))
    .filter(Boolean)
    .join("\n");
}

const tag = (s: string, name: string) => s.match(new RegExp(`<${name}>([\\s\\S]*?)</${name}>`))?.[1]?.trim();

// Claude Code stores slash commands and their output as tagged user messages.
function userText(text: string): { kind: "user" | "command" | "skip"; text: string } {
  const cmd = tag(text, "command-name");
  if (cmd) return { kind: "command", text: [cmd, tag(text, "command-args")].filter(Boolean).join(" ") };
  const out = tag(text, "local-command-stdout");
  if (out !== undefined) return out ? { kind: "command", text: out } : { kind: "skip", text: "" };
  if (/^\s*<(system-reminder|local-command-caveat)>/.test(text)) return { kind: "skip", text: "" };
  // Background agents and shells report back through these.
  if (/^\s*<task-notification>/.test(text)) {
    const summary = tag(text, "summary") ?? tag(text, "status") ?? "update";
    return { kind: "command", text: `Background task: ${summary}` };
  }
  return { kind: "user", text };
}

export const isAgentTool = (name: string) => name === "Agent" || name === "Task";

export function buildItems(msgs: RawMsg[]): Item[] {
  const items: Item[] = [];
  const tools = new Map<string, Extract<Item, { kind: "tool" }>>();
  // Live subagent traffic is tagged with the Agent call that spawned it.
  const nested = new Map<string, RawMsg[]>();
  for (const m of msgs) if (m.parent_tool_use_id) nested.set(m.parent_tool_use_id, [...(nested.get(m.parent_tool_use_id) ?? []), m]);
  msgs.forEach((m, i) => {
    if (m.parent_tool_use_id) return;
    const id = m.uuid ?? `m${i}`;
    if (m.type === "user") {
      if (m.isCompactSummary) {
        const summary = blockText(m.message?.content).replace(/^This session is being continued[^\n]*\n+(Summary:\n)?/, "");
        const last = items[items.length - 1];
        if (last?.kind === "compact" && !last.summary) last.summary = summary;
        else items.push({ kind: "compact", id, summary });
        return;
      }
      if (m.isMeta || m.is_meta) return;
      const content = m.message?.content;
      if (Array.isArray(content)) {
        for (const b of content) {
          if (b?.type !== "tool_result") continue;
          const t = tools.get(b.tool_use_id);
          if (t) {
            t.result = { text: blockText(b.content).replace(/\n?\[image\]/g, ""), isError: !!b.is_error, images: imagesOf(b.content) };
            t.agentId = t.result.text.match(/agentId: ([a-z0-9]+)/)?.[1];
          }
        }
      }
      const text = Array.isArray(content)
        ? content.filter((b: any) => b?.type === "text").map((b: any) => b.text).join("\n")
        : typeof content === "string"
          ? content
          : "";
      const blocks: any[] = Array.isArray(content) ? content : [];
      const images = imagesOf(blocks);
      const documents = blocks.filter((b) => b?.type === "document").length;
      if (!text && !images.length && !documents) return;
      const u = userText(text);
      if (u.kind === "skip") return;
      items.push(u.kind === "command" ? { kind: "command", id, text: u.text } : { kind: "user", id, text: u.text, images, documents });
    } else if (m.type === "assistant") {
      const content = m.message?.content;
      if (!Array.isArray(content)) return;
      content.forEach((b: any, j: number) => {
        const bid = `${id}:${j}`;
        if (b.type === "text" && b.text?.trim()) items.push({ kind: "text", id: bid, text: b.text });
        else if (b.type === "thinking" && (b.thinking?.trim() || m.thinkingDurationMs))
          items.push({ kind: "thinking", id: bid, text: b.thinking ?? "", durationMs: m.thinkingDurationMs });
        else if (b.type === "tool_use" && b.name === WRAP_TOOL)
          items.push({ kind: "wrap", id: bid, recap: String(b.input?.recap ?? ""), ask: b.input?.ask, actions: wrapActions(b.input?.actions), stale: false });
        else if (b.type === "tool_use" && b.name === CHAPTER_TOOL)
          items.push({ kind: "chapter", id: bid, title: String(b.input?.title ?? ""), summary: b.input?.summary });
        else if (b.type === "tool_use") {
          const t = {
            kind: "tool" as const,
            id: b.id ?? bid,
            name: b.name,
            input: b.input,
            children: nested.get(b.id) ?? [],
            hidden: isPlanTool(b.name) || b.name === "TodoWrite",
          };
          tools.set(t.id, t);
          items.push(t);
        }
      });
    } else if (m.type === "result") {
      const ok = m.subtype === "success" && !m.is_error;
      const secs = m.duration_ms ? `${Math.round(m.duration_ms / 1000)}s` : "";
      const text = ok ? `Done${secs ? ` in ${secs}` : ""}` : `Stopped: ${m.errors?.join("; ") || m.result || m.subtype}`;
      items.push({ kind: "result", id, ok, text });
    } else if (m.type === "system" && m.subtype === "compact_boundary") {
      items.push({ kind: "compact", id });
    }
  });
  // A next-step box only takes answers until the user says something else.
  let userAfter = false;
  for (let i = items.length - 1; i >= 0; i--) {
    const it = items[i];
    if (it.kind === "user") userAfter = true;
    else if (it.kind === "wrap") it.stale = userAfter;
  }
  return items;
}

export type Todo = { content: string; status: "pending" | "in_progress" | "completed"; activeForm?: string };

// The current task list: TodoWrite replaces it whole, while the desktop app's
// update_plan also advances it step by step, and its wrap-up checks off the rest.
// A list belongs to the turn that last touched it, so one left unfinished by an
// interrupted turn goes away once the user moves on.
export function latestTodos(items: Item[]): Todo[] | undefined {
  let todos: Todo[] | undefined;
  for (const it of items) {
    if (it.kind === "user") {
      todos = undefined;
      continue;
    }
    if (it.kind === "wrap" && todos) todos = todos.map((t) => ({ ...t, status: "completed" }));
    if (it.kind !== "tool") continue;
    const input = it.input ?? {};
    if (it.name === "TodoWrite" && Array.isArray(input.todos)) todos = input.todos;
    if (!isPlanTool(it.name)) continue;
    if (Array.isArray(input.items)) todos = input.items.map((x: any) => ({ content: String(x.content ?? ""), status: x.status ?? "pending" }));
    if (!todos) continue;
    const next = todos.map((t) => ({ ...t }));
    const at = (n: unknown) => (typeof n === "number" ? next[n - 1] : undefined);
    if (input.advance) {
      const cur = next.find((t) => t.status === "in_progress");
      if (cur) cur.status = "completed";
      const p = next.find((t) => t.status === "pending");
      if (p) p.status = "in_progress";
    }
    for (const n of Array.isArray(input.done) ? input.done : []) {
      const t = at(n);
      if (t) t.status = "completed";
    }
    const s = at(input.start);
    if (s) {
      for (const t of next) if (t.status === "in_progress") t.status = "pending";
      s.status = "in_progress";
    }
    todos = next;
  }
  return todos;
}

// "mcp__ccd_session__start_session" → "start_session".
export const toolLabel = (name: string) => name.match(/^mcp__.+?__(.+)$/)?.[1] ?? name;

const VERBS: [RegExp, string, string][] = [
  [/^(Read|NotebookRead)$/, "read", "file"],
  [/^(Edit|MultiEdit|Write|NotebookEdit)$/, "edited", "file"],
  [/^(Bash|PowerShell)$/, "ran", "command"],
  [/^(Grep|Glob)$/, "searched", "pattern"],
  [/^(WebFetch|WebSearch)$/, "looked up", "page"],
];

// "Read 2 files, ran 3 commands" for a run of tool calls.
export function groupSummary(tools: { name: string }[]): string {
  const counts = new Map<string, { noun: string; n: number }>();
  for (const t of tools) {
    const v = VERBS.find(([re]) => re.test(t.name));
    const verb = v ? v[1] : "used";
    const c = counts.get(verb) ?? { noun: v ? v[2] : "tool", n: 0 };
    c.n++;
    counts.set(verb, c);
  }
  const s = [...counts].map(([verb, { noun, n }]) => `${verb} ${n} ${noun}${n === 1 ? "" : "s"}`).join(", ");
  return s ? s[0].toUpperCase() + s.slice(1) : "";
}

export function toolSummary(name: string, input: any): string {
  if (!input || typeof input !== "object") return "";
  // Batched browser steps: "navigate → computer → screenshot".
  if (Array.isArray(input.actions))
    return input.actions.map((a: any) => a?.input?.action_summary ?? a?.input?.action ?? a?.name).filter(Boolean).join(" → ");
  const v =
    input.description ??
    input.command ??
    input.file_path ??
    input.notebook_path ??
    input.pattern ??
    input.url ??
    input.query ??
    input.prompt ??
    input.skill ??
    "";
  const s = String(v).split("\n")[0];
  return name === "Bash" && input.description && input.command ? input.description : s.length > 120 ? s.slice(0, 117) + "…" : s;
}
