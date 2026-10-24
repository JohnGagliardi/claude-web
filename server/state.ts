import fs from "node:fs";
import os from "node:os";
import path from "node:path";

// App-only data lives here. Session transcripts themselves stay in Claude Code's
// own store (~/.claude/projects), so the CLI and this app see the same sessions.
export const DATA_DIR = path.join(os.homedir(), ".claude-web");
const STATE_FILE = path.join(DATA_DIR, "state.json");
const CONFIG_FILE = path.join(DATA_DIR, "config.json");

export type SessionMeta = {
  pinned?: boolean;
  archived?: boolean;
  unread?: boolean;
  group?: string;
};

export type AppState = {
  projects: string[];
  groups: string[];
  sessions: Record<string, SessionMeta>;
};

export type DeviceConfig = {
  port?: number;
  // Each device decides how "Reauth" works. The command runs in a shell with
  // CLAUDE_EXE set to the SDK's bundled Claude Code binary.
  reauth?: { command: string; cwd?: string; label?: string };
};

const emptyState = (): AppState => ({ projects: [], groups: [], sessions: {} });

function readJson<T>(file: string, fallback: T): T {
  try {
    return { ...fallback, ...JSON.parse(fs.readFileSync(file, "utf8")) };
  } catch {
    return fallback;
  }
}

let state = readJson(STATE_FILE, emptyState());

export function getState(): AppState {
  return state;
}

export function updateState(fn: (s: AppState) => void): AppState {
  fn(state);
  fs.mkdirSync(DATA_DIR, { recursive: true });
  fs.writeFileSync(STATE_FILE, JSON.stringify(state, null, 2));
  return state;
}

export function updateSessionMeta(sessionId: string, patch: Partial<SessionMeta>) {
  return updateState((s) => {
    s.sessions[sessionId] = { ...s.sessions[sessionId], ...patch };
  });
}

export function readConfig(): DeviceConfig {
  return readJson<DeviceConfig>(CONFIG_FILE, {});
}

export const CONFIG_PATH = CONFIG_FILE;
