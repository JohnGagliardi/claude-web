import { readFile, readdir, access } from "node:fs/promises";
import { homedir } from "node:os";
import path from "node:path";

// The SDK's getSessionMessages stops at the last compaction, but the transcript
// file keeps the whole conversation. This walks the file's parent chain across
// compact boundaries so the UI can show everything, like the desktop app does.

const projectsDir = () => path.join(process.env.CLAUDE_CONFIG_DIR ?? path.join(homedir(), ".claude"), "projects");

async function exists(p: string) {
  return access(p).then(
    () => true,
    () => false,
  );
}

async function findFile(sessionId: string, dir?: string) {
  if (!/^[\w-]+$/.test(sessionId)) return undefined;
  const root = projectsDir();
  if (dir) {
    const p = path.join(root, dir.replace(/[^a-zA-Z0-9]/g, "-"), `${sessionId}.jsonl`);
    if (await exists(p)) return p;
  }
  for (const d of await readdir(root).catch(() => [] as string[])) {
    const p = path.join(root, d, `${sessionId}.jsonl`);
    if (await exists(p)) return p;
  }
  return undefined;
}

type Entry = { uuid?: string; parentUuid?: string | null; logicalParentUuid?: string; type: string; [k: string]: any };

export async function fullHistory(sessionId: string, dir?: string) {
  const file = await findFile(sessionId, dir);
  if (!file) return undefined;
  const entries: Entry[] = [];
  for (const line of (await readFile(file, "utf8")).split("\n")) {
    if (!line.trim()) continue;
    try {
      entries.push(JSON.parse(line));
    } catch {
      // A line still being written.
    }
  }
  const byId = new Map<string, Entry>();
  for (const e of entries) if (e.uuid) byId.set(e.uuid, e);
  const isMsg = (e: Entry) => (e.type === "user" || e.type === "assistant") && !e.isSidechain;
  let cur: Entry | undefined;
  for (let i = entries.length - 1; i >= 0 && !cur; i--) if (isMsg(entries[i])) cur = entries[i];
  const chain: Entry[] = [];
  const seen = new Set<string>();
  while (cur && cur.uuid && !seen.has(cur.uuid)) {
    seen.add(cur.uuid);
    chain.push(cur);
    const next = cur.parentUuid ?? cur.logicalParentUuid;
    cur = next ? byId.get(next) : undefined;
  }
  // Parallel tool calls branch the tree: each result hangs off its own call, so
  // one chain misses the siblings. Pull in assistant pieces of the same API
  // message and the results of calls already included, until nothing changes.
  const msgIds = new Set<string>();
  const useIds = new Set<string>();
  const note = (e: Entry) => {
    if (e.type === "assistant" && e.message?.id) msgIds.add(e.message.id);
    for (const b of Array.isArray(e.message?.content) ? e.message.content : []) if (b?.type === "tool_use") useIds.add(b.id);
  };
  chain.forEach(note);
  const belongs = (e: Entry) =>
    e.type === "assistant"
      ? msgIds.has(e.message?.id)
      : Array.isArray(e.message?.content) && e.message.content.some((b: any) => b?.type === "tool_result" && useIds.has(b.tool_use_id));
  for (let changed = true; changed; ) {
    changed = false;
    for (const e of entries) {
      if (!e.uuid || seen.has(e.uuid) || !isMsg(e) || !e.parentUuid || !seen.has(e.parentUuid) || !belongs(e)) continue;
      seen.add(e.uuid);
      note(e);
      changed = true;
    }
  }
  const emitted = new Set<string>();
  return entries
    .filter((e) => e.uuid && seen.has(e.uuid) && !emitted.has(e.uuid) && !!emitted.add(e.uuid))
    .filter((e) => isMsg(e) || (e.type === "system" && e.subtype === "compact_boundary"))
    .map((e) =>
      e.type === "system"
        ? { type: "system", subtype: e.subtype, uuid: e.uuid, timestamp: e.timestamp, compact_metadata: e.compactMetadata }
        : {
            type: e.type,
            uuid: e.uuid,
            session_id: sessionId,
            message: e.message,
            parent_tool_use_id: null,
            isCompactSummary: e.isCompactSummary || undefined,
            is_meta: e.isMeta || undefined,
            thinkingDurationMs: e.thinkingDurationMs,
            timestamp: e.timestamp,
          },
    );
}
