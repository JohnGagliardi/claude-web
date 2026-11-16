import fs from "node:fs";
import path from "node:path";
import { DATA_DIR } from "./state";

// Raw click-tracking log, kept separate from state.json since it grows
// continuously rather than changing shape. A capped ring buffer, not a
// full history — this is for "what do I click a lot", not an audit log.
const FILE = path.join(DATA_DIR, "usage.json");
const MAX_EVENTS = 20_000;

type UsageEvent = { ts: number; action: string; area?: string };
type UsageState = { events: UsageEvent[] };

function load(): UsageState {
  try {
    const parsed = JSON.parse(fs.readFileSync(FILE, "utf8"));
    return { events: Array.isArray(parsed.events) ? parsed.events : [] };
  } catch {
    return { events: [] };
  }
}

let state = load();
let saveTimer: NodeJS.Timeout | undefined;

// Clicks can come in bursts; debounce the disk write instead of doing one
// fs.writeFileSync per click.
function scheduleSave() {
  if (saveTimer) return;
  saveTimer = setTimeout(() => {
    saveTimer = undefined;
    fs.mkdirSync(DATA_DIR, { recursive: true });
    fs.writeFileSync(FILE, JSON.stringify(state));
  }, 2000);
}

export function track(action: string, area?: string, ts?: number) {
  if (!action) return;
  state.events.push({ ts: ts && Number.isFinite(ts) ? ts : Date.now(), action, area });
  if (state.events.length > MAX_EVENTS) state.events.splice(0, state.events.length - MAX_EVENTS);
  scheduleSave();
}

export type UsageSummary = {
  total: number;
  since: number;
  firstEventAt?: number;
  top: { action: string; area?: string; count: number; last: number }[];
};

export function summary(days = 30): UsageSummary {
  const since = Date.now() - days * 86_400_000;
  const recent = state.events.filter((e) => e.ts >= since);
  const byKey = new Map<string, { action: string; area?: string; count: number; last: number }>();
  for (const e of recent) {
    const key = `${e.area ?? ""}\u0000${e.action}`;
    const row = byKey.get(key) ?? { action: e.action, area: e.area, count: 0, last: 0 };
    row.count++;
    row.last = Math.max(row.last, e.ts);
    byKey.set(key, row);
  }
  return {
    total: recent.length,
    since,
    firstEventAt: state.events[0]?.ts,
    top: [...byKey.values()].sort((a, b) => b.count - a.count),
  };
}

export function clear() {
  state = { events: [] };
  fs.mkdirSync(DATA_DIR, { recursive: true });
  fs.writeFileSync(FILE, JSON.stringify(state));
}
