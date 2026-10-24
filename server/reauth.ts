import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { CONFIG_PATH, readConfig } from "./state.js";

// The SDK ships a platform-specific Claude Code binary; reauth scripts can use it
// through %CLAUDE_EXE% / $CLAUDE_EXE without Claude Code being on PATH.
export function bundledClaudeExe(): string | undefined {
  const pkg = `claude-agent-sdk-${process.platform}-${process.arch}`;
  const exe = process.platform === "win32" ? "claude.exe" : "claude";
  const p = path.resolve("node_modules", "@anthropic-ai", pkg, exe);
  return fs.existsSync(p) ? p : undefined;
}

export type ReauthResult = { ok: boolean; output: string };

export function reauthInfo() {
  const r = readConfig().reauth;
  return { configured: !!r?.command, label: r?.label ?? "Reauth", configPath: CONFIG_PATH };
}

export function runReauth(): Promise<ReauthResult> {
  const cfg = readConfig().reauth;
  if (!cfg?.command) {
    return Promise.resolve({
      ok: false,
      output: `No reauth command is configured on this device. Add "reauth": { "command": "..." } to ${CONFIG_PATH}.`,
    });
  }
  return new Promise((resolve) => {
    const env = { ...process.env, CLAUDE_EXE: bundledClaudeExe() ?? "claude" };
    const child = spawn(cfg.command, { shell: true, cwd: cfg.cwd, env });
    let output = "";
    child.stdout.on("data", (d) => (output += d));
    child.stderr.on("data", (d) => (output += d));
    const timer = setTimeout(() => child.kill(), 5 * 60_000);
    child.on("error", (e) => {
      clearTimeout(timer);
      resolve({ ok: false, output: String(e) });
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      resolve({ ok: code === 0, output: output.trim() || `exited with code ${code}` });
    });
  });
}
