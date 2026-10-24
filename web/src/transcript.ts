import type { RawMsg } from "./api";

export type ToolResult = { text: string; isError: boolean };

export type Item =
  | { kind: "user"; id: string; text: string; images: string[]; documents: number }
  | { kind: "command"; id: string; text: string }
  | { kind: "text"; id: string; text: string }
  | { kind: "thinking"; id: string; text: string }
  | { kind: "tool"; id: string; name: string; input: any; result?: ToolResult; children: RawMsg[]; agentId?: string }
  | { kind: "result"; id: string; ok: boolean; text: string }
  | { kind: "system"; id: string; text: string };

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
      if (m.isMeta) return;
      const content = m.message?.content;
      if (Array.isArray(content)) {
        for (const b of content) {
          if (b?.type !== "tool_result") continue;
          const t = tools.get(b.tool_use_id);
          if (t) {
            t.result = { text: blockText(b.content), isError: !!b.is_error };
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
      const images = blocks
        .filter((b) => b?.type === "image" && b.source?.type === "base64")
        .map((b) => `data:${b.source.media_type};base64,${b.source.data}`);
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
        else if (b.type === "thinking" && b.thinking?.trim()) items.push({ kind: "thinking", id: bid, text: b.thinking });
        else if (b.type === "tool_use") {
          const t = { kind: "tool" as const, id: b.id ?? bid, name: b.name, input: b.input, children: nested.get(b.id) ?? [] };
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
      items.push({ kind: "system", id, text: "Conversation compacted" });
    }
  });
  return items;
}

export type Todo = { content: string; status: "pending" | "in_progress" | "completed"; activeForm?: string };

export function latestTodos(items: Item[]): Todo[] | undefined {
  for (let i = items.length - 1; i >= 0; i--) {
    const it = items[i];
    if (it.kind === "tool" && it.name === "TodoWrite" && Array.isArray(it.input?.todos)) return it.input.todos;
  }
  return undefined;
}

export function toolSummary(name: string, input: any): string {
  if (!input || typeof input !== "object") return "";
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
