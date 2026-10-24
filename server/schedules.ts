import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { Cron } from "croner";
import type { PermissionMode } from "@anthropic-ai/claude-agent-sdk";
import { DATA_DIR } from "./state.js";

const FILE = path.join(DATA_DIR, "schedules.json");

export type ScheduleRun = { at: number; sessionId?: string; error?: string };

export type Schedule = {
  id: string;
  name: string;
  cron: string;
  prompt: string;
  cwd: string;
  // "new" starts a fresh session each time; "session" sends to an existing one.
  target: "new" | "session";
  sessionId?: string;
  model?: string;
  permissionMode?: PermissionMode;
  enabled: boolean;
  runs: ScheduleRun[];
};

export type ScheduleView = Schedule & { nextRun?: number };

export type ScheduleInput = Omit<Schedule, "id" | "runs"> & { id?: string };

// Starts the run and resolves to the session it ran in (once known).
export type Runner = (s: Schedule) => Promise<string | undefined>;

export class Scheduler {
  private schedules: Schedule[] = [];
  private jobs = new Map<string, Cron>();

  constructor(private readonly runner: Runner, private readonly onChange: (list: ScheduleView[]) => void) {
    try {
      this.schedules = JSON.parse(fs.readFileSync(FILE, "utf8"));
    } catch {
      this.schedules = [];
    }
    for (const s of this.schedules) this.arm(s);
  }

  list(): ScheduleView[] {
    return this.schedules.map((s) => ({ ...s, nextRun: this.jobs.get(s.id)?.nextRun()?.getTime() }));
  }

  private save() {
    fs.mkdirSync(DATA_DIR, { recursive: true });
    fs.writeFileSync(FILE, JSON.stringify(this.schedules, null, 2));
    this.onChange(this.list());
  }

  private arm(s: Schedule) {
    this.jobs.get(s.id)?.stop();
    this.jobs.delete(s.id);
    if (!s.enabled) return;
    this.jobs.set(s.id, new Cron(s.cron, { protect: true }, () => void this.run(s.id)));
  }

  static validate(input: ScheduleInput) {
    if (!input.name?.trim()) throw new Error("A name is required.");
    if (!input.prompt?.trim()) throw new Error("A prompt is required.");
    if (!input.cwd || !fs.existsSync(input.cwd)) throw new Error(`Folder not found: ${input.cwd}`);
    if (input.target === "session" && !input.sessionId) throw new Error("Pick the session to send to.");
    try {
      new Cron(input.cron, { paused: true }).stop();
    } catch (e) {
      throw new Error(`Invalid cron expression "${input.cron}": ${(e as Error).message}`);
    }
  }

  upsert(input: ScheduleInput): Schedule {
    Scheduler.validate(input);
    const existing = input.id ? this.schedules.find((s) => s.id === input.id) : undefined;
    const s: Schedule = { ...input, id: existing?.id ?? randomUUID().slice(0, 8), runs: existing?.runs ?? [] };
    this.schedules = existing ? this.schedules.map((x) => (x.id === s.id ? s : x)) : [...this.schedules, s];
    this.arm(s);
    this.save();
    return s;
  }

  remove(id: string) {
    this.jobs.get(id)?.stop();
    this.jobs.delete(id);
    this.schedules = this.schedules.filter((s) => s.id !== id);
    this.save();
  }

  async run(id: string) {
    const s = this.schedules.find((x) => x.id === id);
    if (!s) throw new Error("No such schedule.");
    const run: ScheduleRun = { at: Date.now() };
    s.runs = [run, ...s.runs].slice(0, 20);
    this.save();
    try {
      run.sessionId = await this.runner(s);
    } catch (e) {
      run.error = String((e as Error).message ?? e);
    }
    this.save();
    return run;
  }
}
