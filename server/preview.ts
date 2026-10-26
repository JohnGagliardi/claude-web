import { spawn, execFile, type ChildProcess } from "node:child_process";
import fs from "node:fs";
import net from "node:net";
import path from "node:path";

// Same file the desktop app uses: <folder>/.claude/launch.json
export type LaunchConfig = { name: string; runtimeExecutable?: string; runtimeArgs?: string[]; port?: number; url?: string; cwd?: string };

export type PreviewInfo = {
  id: string;
  name: string;
  cwd: string;
  url: string;
  status: "starting" | "running" | "exited" | "attached";
  exitCode?: number | null;
};

type Preview = PreviewInfo & { proc?: ChildProcess; logs: string[] };

const MAX_LOG_LINES = 2000;

export function launchConfigs(cwd: string): LaunchConfig[] {
  const file = path.join(cwd, ".claude", "launch.json");
  try {
    return JSON.parse(fs.readFileSync(file, "utf8")).configurations ?? [];
  } catch {
    return [];
  }
}

function portOpen(port: number, host = "127.0.0.1"): Promise<boolean> {
  return new Promise((resolve) => {
    const s = net.connect(port, host);
    s.once("connect", () => (s.destroy(), resolve(true)));
    s.once("error", () => resolve(false));
    s.setTimeout(1000, () => (s.destroy(), resolve(false)));
  });
}

const quote = (a: string) => (/[\s"&|<>^]/.test(a) ? `"${a.replace(/"/g, '\\"')}"` : a);

export class Previews {
  private servers = new Map<string, Preview>();

  constructor(private readonly onChange: (list: PreviewInfo[]) => void) {}

  list(): PreviewInfo[] {
    return [...this.servers.values()].map(({ proc: _p, logs: _l, ...info }) => info);
  }

  private changed() {
    this.onChange(this.list());
  }

  async start(cwd: string, name: string): Promise<PreviewInfo> {
    const cfg = launchConfigs(cwd).find((c) => c.name === name);
    if (!cfg) throw new Error(`No configuration named "${name}" in ${path.join(cwd, ".claude", "launch.json")}`);
    const id = `${cwd}::${name}`;
    const existing = this.servers.get(id);
    if (existing && (existing.status === "running" || existing.status === "starting" || existing.status === "attached")) return this.info(id)!;

    const url = cfg.url ?? `http://localhost:${cfg.port}`;
    const p: Preview = { id, name, cwd, url, status: cfg.runtimeExecutable ? "starting" : "attached", logs: [] };
    this.servers.set(id, p);
    if (cfg.runtimeExecutable) {
      // A shell resolves npm.cmd and friends on Windows.
      const cmd = [cfg.runtimeExecutable, ...(cfg.runtimeArgs ?? [])].map(quote).join(" ");
      // Elsewhere it gets its own process group so stop() can end its children too.
      const proc = spawn(cmd, {
        cwd: path.resolve(cwd, cfg.cwd ?? "."),
        shell: true,
        windowsHide: true,
        detached: process.platform !== "win32",
        env: { ...process.env, PORT: String(cfg.port ?? "") },
      });
      p.proc = proc;
      const log = (d: Buffer) => {
        p.logs.push(...d.toString().split(/\r?\n/).filter(Boolean));
        if (p.logs.length > MAX_LOG_LINES) p.logs.splice(0, p.logs.length - MAX_LOG_LINES);
      };
      proc.stdout?.on("data", log);
      proc.stderr?.on("data", log);
      // A spawn failure (say, a launch.json cwd that doesn't exist) must not
      // become an unhandled 'error' event, which would take the server down.
      proc.on("error", (e) => {
        log(Buffer.from(`Failed to start: ${e.message}`));
        p.status = "exited";
        p.exitCode = null;
        this.changed();
      });
      proc.on("exit", (code) => {
        p.status = "exited";
        p.exitCode = code;
        this.changed();
      });
      if (cfg.port) {
        for (let i = 0; i < 60 && p.status === "starting"; i++) {
          if (await portOpen(cfg.port)) break;
          await new Promise((r) => setTimeout(r, 500));
        }
      }
      if (p.status === "starting") p.status = "running";
    }
    this.changed();
    return this.info(id)!;
  }

  info(id: string): PreviewInfo | undefined {
    return this.list().find((p) => p.id === id);
  }

  logs(id: string, opts: { lines?: number; search?: string; errorsOnly?: boolean } = {}): string[] {
    let lines = this.servers.get(id)?.logs ?? [];
    if (opts.search) lines = lines.filter((l) => l.includes(opts.search!));
    if (opts.errorsOnly) lines = lines.filter((l) => /error|exception|failed|fatal/i.test(l));
    return lines.slice(-(opts.lines ?? 100));
  }

  stop(id: string) {
    const p = this.servers.get(id);
    if (!p) return;
    const pid = p.proc?.pid;
    if (pid && p.status !== "exited") {
      // The shell wrapper's children (node, vite…) must go too.
      if (process.platform === "win32") execFile("taskkill", ["/pid", String(pid), "/T", "/F"], { windowsHide: true }, () => {});
      else {
        try {
          process.kill(-pid, "SIGTERM");
        } catch {
          p.proc!.kill("SIGTERM");
        }
      }
    }
    this.servers.delete(id);
    this.changed();
  }

  stopAll() {
    for (const id of [...this.servers.keys()]) this.stop(id);
  }
}
