import os from "node:os";
import { randomUUID } from "node:crypto";
import * as pty from "node-pty";

const SCROLLBACK = 256 * 1024;

export type TerminalInfo = { id: string; title: string; cwd: string; alive: boolean; exitCode?: number; byClaude?: boolean };

type Term = TerminalInfo & { proc: pty.IPty; buffer: string };

export type TerminalEvent =
  | { t: "term:data"; id: string; data: string }
  | { t: "term:list"; terminals: TerminalInfo[] };

const defaultShell = () =>
  process.platform === "win32" ? { file: "powershell.exe", args: ["-NoLogo"] } : { file: process.env.SHELL || "/bin/bash", args: ["-l"] };

const stripAnsi = (s: string) =>
  s.replace(/\x1b\][^\x07\x1b]*(\x07|\x1b\\)/g, "").replace(/\x1b\[[0-9;?]*[ -/]*[@-~]/g, "").replace(/\x1b[=>()][0-9A-Za-z]?/g, "");

// Shell tabs shared by the user (xterm in the browser) and Claude (MCP tools).
// They live as long as the server; reopening the page replays their scrollback.
export class Terminals {
  private terms = new Map<string, Term>();
  private counter = 0;

  constructor(private readonly emit: (e: TerminalEvent) => void) {}

  list(): TerminalInfo[] {
    return [...this.terms.values()].map(({ proc: _p, buffer: _b, ...info }) => info);
  }

  private changed() {
    this.emit({ t: "term:list", terminals: this.list() });
  }

  open(cwd: string, opts: { cols?: number; rows?: number; title?: string; byClaude?: boolean } = {}): TerminalInfo {
    const { file, args } = defaultShell();
    const proc = pty.spawn(file, args, {
      name: "xterm-256color",
      cols: opts.cols ?? 100,
      rows: opts.rows ?? 30,
      cwd: cwd || os.homedir(),
      env: { ...process.env, TERM: "xterm-256color" } as Record<string, string>,
    });
    const id = randomUUID().slice(0, 8);
    const term: Term = { id, title: opts.title ?? `Terminal ${++this.counter}`, cwd, alive: true, byClaude: opts.byClaude, proc, buffer: "" };
    proc.onData((data) => {
      term.buffer = (term.buffer + data).slice(-SCROLLBACK);
      this.emit({ t: "term:data", id, data });
    });
    proc.onExit(({ exitCode }) => {
      term.alive = false;
      term.exitCode = exitCode;
      this.changed();
    });
    this.terms.set(id, term);
    this.changed();
    return this.list().find((t) => t.id === id)!;
  }

  get(id?: string): Term | undefined {
    if (id) return this.terms.get(id);
    return [...this.terms.values()].reverse().find((t) => t.alive);
  }

  write(id: string, data: string) {
    this.terms.get(id)?.proc.write(data);
  }

  resize(id: string, cols: number, rows: number) {
    const t = this.terms.get(id);
    if (t?.alive && cols > 0 && rows > 0) t.proc.resize(cols, rows);
  }

  scrollback(id: string) {
    return this.terms.get(id)?.buffer ?? "";
  }

  // Plain-text tail for Claude: escape codes stripped, last N lines.
  read(id: string | undefined, lines = 200) {
    const t = this.get(id);
    if (!t) return undefined;
    const text = stripAnsi(t.buffer).replace(/\r\n?/g, "\n");
    return { info: this.list().find((x) => x.id === t.id)!, text: text.split("\n").slice(-lines).join("\n") };
  }

  close(id: string) {
    const t = this.terms.get(id);
    if (!t) return;
    if (t.alive) t.proc.kill();
    this.terms.delete(id);
    this.changed();
  }

  closeAll() {
    for (const t of this.terms.values()) if (t.alive) t.proc.kill();
  }
}
