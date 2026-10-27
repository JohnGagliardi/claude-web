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
  // Auto-fix watches the PR for this session's folder.
  autofix?: boolean;
  cwd?: string;
  // Side sessions point at the session that started them.
  parent?: string;
  scheduleId?: string;
  sideChat?: boolean;
  // Last Remote Control choice, restored when the session restarts.
  remote?: boolean;
};

export type AppState = {
  projects: string[];
  groups: string[];
  sessions: Record<string, SessionMeta>;
  // Folders outside a session's own that the user let the Files pane read.
  allowedDirs: string[];
};

export type DeviceConfig = {
  port?: number;
  // Each device decides how "Reauth" works. The command runs in a shell with
  // CLAUDE_EXE set to the SDK's bundled Claude Code binary.
  reauth?: { command: string; cwd?: string; label?: string };
  // Installed browser for Claude's headless browser tools: "msedge", "chrome"…
  browser?: { channel?: string };
};

const emptyState = (): AppState => ({ projects: [], groups: [], sessions: {}, allowedDirs: [] });

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

// App-wide preferences edited on the Settings page.
export type AppSettings = {
  defaultModel?: string;
  defaultEffort?: "low" | "medium" | "high" | "xhigh" | "max";
  defaultPermissionMode: "default" | "acceptEdits" | "plan" | "auto" | "bypassPermissions";
  newSessionWorktree: boolean;
  // Live sessions idle this long are shut down; 0 keeps them forever.
  idleMinutes: number;
  // Turn Remote Control on for every new session.
  remoteControl?: boolean;
};

const SETTINGS_FILE = path.join(DATA_DIR, "settings.json");
let settings = readJson<AppSettings>(SETTINGS_FILE, { defaultPermissionMode: "default", newSessionWorktree: false, idleMinutes: 30 });

export function getSettings(): AppSettings {
  return settings;
}

export function updateSettings(patch: Partial<AppSettings>): AppSettings {
  settings = { ...settings, ...patch };
  fs.mkdirSync(DATA_DIR, { recursive: true });
  fs.writeFileSync(SETTINGS_FILE, JSON.stringify(settings, null, 2));
  return settings;
}

export function readConfig(): DeviceConfig {
  return readJson<DeviceConfig>(CONFIG_FILE, {});
}

export const CONFIG_PATH = CONFIG_FILE;
