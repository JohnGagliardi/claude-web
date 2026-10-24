import express from "express";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { WebSocketServer, type WebSocket } from "ws";
import {
  deleteSession,
  getSessionMessages,
  getSubagentMessages,
  listSessions,
  renameSession,
  type ModelInfo,
  type SlashCommand,
} from "@anthropic-ai/claude-agent-sdk";
import { LiveSession, type LiveEvent, type LiveSummary } from "./live.js";
import { DATA_DIR, getSettings, getState, readConfig, updateSessionMeta, updateSettings, updateState } from "./state.js";
import { bundledClaudeExe, reauthInfo, runReauth } from "./reauth.js";
import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { commitAll, createPr, createWorktree, prStatus, push, readFileFor, repoInfo, syncWithBase, workingDiff } from "./git.js";
import { startAutofix } from "./autofix.js";
import { Terminals } from "./terminals.js";
import { Previews, launchConfigs } from "./preview.js";
import { closeBrowser, closeTab } from "./browser.js";
import { READ_ONLY_TOOLS, SERVER_NAME, sessionTools, type SideArgs } from "./tools.js";
import { Scheduler } from "./schedules.js";
import { fullHistory } from "./history.js";

const PORT = Number(process.env.PORT ?? readConfig().port ?? 3737);
const DEV_PORT = 5173;

// The server runs tools on this machine, so only the app's own pages may talk to
// it: bind to loopback, pin the Host header (DNS rebinding) and the Origin (CSRF,
// cross-site WebSockets).
const allowedHosts = new Set([PORT, DEV_PORT].flatMap((p) => [`localhost:${p}`, `127.0.0.1:${p}`]));
const allowedOrigins = new Set([...allowedHosts].map((h) => `http://${h}`));
function trusted(req: http.IncomingMessage) {
  const origin = req.headers.origin;
  return allowedHosts.has(req.headers.host ?? "") && (!origin || allowedOrigins.has(origin));
}

const live = new Map<string, LiveSession>();
const sockets = new Set<WebSocket>();

function broadcast(ev: unknown) {
  const data = JSON.stringify(ev);
  for (const s of sockets) if (s.readyState === s.OPEN) s.send(data);
}

function onLiveEvent(ev: LiveEvent) {
  if (ev.t === "sdk" && ev.msg.type === "result") {
    const s = live.get(ev.key);
    if (s?.sessionId) updateSessionMeta(s.sessionId, { unread: true });
    broadcast({ t: "sessions-changed" });
    const link = sideLinks.get(ev.key);
    if (link && s) {
      const body = ev.msg.subtype === "success" ? ev.msg.result : `Stopped: ${ev.msg.subtype}`;
      reportToParent(link, `[Side session "${link.title}" (${s.sessionId}) finished a turn]\n${body.slice(0, 1500)}`);
    }
    flushReports(ev.key);
  }
  if (ev.t === "closed") {
    live.delete(ev.key);
    sideLinks.delete(ev.key);
    lastShot.delete(ev.key);
    void closeTab(ev.key);
    broadcast({ t: "sessions-changed" });
  }
  broadcast(ev);
}

const terminals = new Terminals(broadcast);
const previews = new Previews((list) => broadcast({ t: "preview:list", previews: list }));
// Latest frame of each session's headless browser, for the Preview pane.
const lastShot = new Map<string, { data: string; url: string }>();

// Resuming a session that already has a live process reuses it.
function startSession(opts: ConstructorParameters<typeof LiveSession>[0]): LiveSession {
  const existing = opts.resume ? [...live.values()].find((x) => x.sessionId === opts.resume) : undefined;
  const session =
    existing ??
    new LiveSession(
      {
        ...opts,
        extra: (key) => ({
          mcpServers: {
            [SERVER_NAME]: sessionTools({
              key,
              cwd: opts.cwd,
              terminals,
              previews,
              sides: {
                start: (args) => startSide({ ...args, parentKey: key, cwd: args.cwd ?? opts.cwd }),
                list: () => sideList(key),
                send: (target, text) => sideSend(key, target, text),
              },
              onShot: (k, data, url) => {
                lastShot.set(k, { data, url });
                broadcast({ t: "browser:shot", key: k, data, url });
              },
            }),
          },
          allowedTools: READ_ONLY_TOOLS,
        }),
      },
      onLiveEvent,
    );
  live.set(session.key, session);
  return session;
}

// --- Side sessions: sessions started from another session, which hear back
// whenever a side session finishes a turn.
type SideLink = { parentKey?: string; parentSessionId?: string; title: string };
const sideLinks = new Map<string, SideLink>();
const pendingReports = new Map<string, string[]>();

const findLive = (keyOrId?: string) => (keyOrId ? live.get(keyOrId) ?? [...live.values()].find((s) => s.sessionId === keyOrId) : undefined);

function reportToParent(link: SideLink, report: string) {
  const parent = findLive(link.parentKey) ?? findLive(link.parentSessionId);
  if (!parent) return; // The parent isn't open; the sidebar still shows the side session's state.
  if (!parent.running && !parent.summary().pending.length) parent.send(report);
  else pendingReports.set(parent.key, [...(pendingReports.get(parent.key) ?? []), report]);
}

function flushReports(key: string) {
  const reports = pendingReports.get(key);
  const s = live.get(key);
  if (!reports?.length || !s) return;
  pendingReports.delete(key);
  s.send(reports.join("\n\n"));
}

async function startSide(args: SideArgs & { cwd: string; parentKey?: string; parentSessionId?: string }): Promise<LiveSummary> {
  const parent = findLive(args.parentKey) ?? findLive(args.parentSessionId);
  const parentSessionId = args.parentSessionId ?? parent?.sessionId;
  let cwd = args.cwd;
  if (args.worktree) cwd = (await createWorktree(cwd, args.title)).path;
  const child = startSession({ cwd, title: args.title, permissionMode: parent?.permissionMode });
  sideLinks.set(child.key, { parentKey: parent?.key, parentSessionId, title: args.title });
  child.send(args.prompt);
  void child.sessionIdReady().then((id) => {
    if (id && parentSessionId) updateSessionMeta(id, { parent: parentSessionId, cwd });
    broadcast({ t: "sessions-changed" });
  });
  return child.summary();
}

function sideList(parentKey: string) {
  const parentId = live.get(parentKey)?.sessionId;
  const fromLive = [...sideLinks.entries()]
    .filter(([, l]) => l.parentKey === parentKey || (parentId && l.parentSessionId === parentId))
    .map(([key, l]) => ({ ...live.get(key)?.summary(), title: l.title }));
  const stored = Object.entries(getState().sessions)
    .filter(([id, m]) => parentId && m.parent === parentId && !fromLive.some((s) => s.sessionId === id))
    .map(([id, m]) => ({ sessionId: id, cwd: m.cwd, running: false, closed: true }));
  return [...fromLive, ...stored];
}

function sideSend(parentKey: string, target: string, text: string) {
  const parentId = live.get(parentKey)?.sessionId;
  const child = findLive(target);
  if (child) {
    const link = sideLinks.get(child.key);
    if (!link || (link.parentKey !== parentKey && link.parentSessionId !== parentId)) throw new Error("That session isn't one of yours.");
    child.send(text);
    return "Sent.";
  }
  const meta = getState().sessions[target];
  if (!meta || meta.parent !== parentId || !meta.cwd) throw new Error("No such side session.");
  const resumed = startSession({ cwd: meta.cwd, resume: target });
  sideLinks.set(resumed.key, { parentKey, parentSessionId: parentId, title: target });
  resumed.send(text);
  return "Resumed and sent.";
}

const scheduler = new Scheduler(
  async (s) => {
    const session =
      s.target === "session" && s.sessionId
        ? startSession({ cwd: s.cwd, resume: s.sessionId })
        : startSession({ cwd: s.cwd, model: s.model, permissionMode: s.permissionMode, title: `${s.name} · ${new Date().toLocaleString()}` });
    session.send(s.prompt);
    const id = await session.sessionIdReady();
    if (id) updateSessionMeta(id, { scheduleId: s.id, cwd: s.cwd });
    broadcast({ t: "sessions-changed" });
    return id;
  },
  (list) => broadcast({ t: "schedules", schedules: list }),
);

// Shut down live sessions nobody is using; the next message resumes them.
setInterval(() => {
  const minutes = getSettings().idleMinutes;
  if (!minutes) return;
  for (const s of live.values()) {
    if (!s.running && !s.backgroundTasks && !s.summary().pending.length && Date.now() - s.lastActive > minutes * 60_000) s.close();
  }
}, 60_000);

startAutofix(
  (sessionId, cwd, text) => startSession({ cwd, resume: sessionId }).send(text),
  (sessionId) => [...live.values()].some((s) => s.sessionId === sessionId && (s.running || s.summary().pending.length > 0)),
);

async function sessionList() {
  const state = getState();
  const infos = await listSessions({ limit: 300, includeProgrammatic: true });
  const sessions = infos.map((i) => ({ ...i, ...state.sessions[i.sessionId] }));
  const projects = [...new Set([...state.projects, ...infos.map((i) => i.cwd).filter((c): c is string => !!c)])];
  return { sessions, projects, groups: state.groups };
}

const catalogCache = new Map<string, { models: ModelInfo[]; commands: SlashCommand[] }>();
async function catalog(cwd: string) {
  const hit = catalogCache.get(cwd);
  if (hit) return hit;
  const running = [...live.values()].find((s) => s.opts.cwd === cwd);
  const probe = running ?? new LiveSession({ cwd }, () => {});
  try {
    const [models, commands] = await Promise.all([probe.supportedModels(), probe.supportedCommands()]);
    const result = { models, commands };
    catalogCache.set(cwd, result);
    return result;
  } finally {
    if (!running) probe.close();
  }
}

const app = express();
app.use((req, res, next) => (trusted(req) ? next() : res.status(403).end()));
app.use(express.json({ limit: "20mb" }));

const api = express.Router();
const wrap =
  (fn: (req: express.Request, res: express.Response) => Promise<unknown>) =>
  (req: express.Request, res: express.Response) =>
    fn(req, res).catch((e) => res.status(500).json({ error: String(e?.message ?? e) }));

api.get(
  "/bootstrap",
  wrap(async (_req, res) => {
    res.json({
      ...(await sessionList()),
      live: [...live.values()].map((s) => s.summary()),
      terminals: terminals.list(),
      previews: previews.list(),
      schedules: scheduler.list(),
      settings: getSettings(),
      reauth: reauthInfo(),
      home: os.homedir(),
    });
  }),
);

api.get("/sessions", wrap(async (_req, res) => res.json(await sessionList())));

api.get(
  "/sessions/:id/messages",
  wrap(async (req, res) => {
    const dir = typeof req.query.dir === "string" ? req.query.dir : undefined;
    const id = String(req.params.id);
    const full = await fullHistory(id, dir).catch(() => undefined);
    res.json(full ?? (await getSessionMessages(id, { dir })));
  }),
);

api.post(
  "/sessions/:id/meta",
  wrap(async (req, res) => {
    const id = String(req.params.id);
    const { title, dir, ...meta } = req.body ?? {};
    if (typeof title === "string" && title.trim()) await renameSession(id, title.trim(), { dir });
    if (Object.keys(meta).length) updateSessionMeta(id, meta);
    broadcast({ t: "sessions-changed" });
    res.json({ ok: true });
  }),
);

api.delete(
  "/sessions/:id",
  wrap(async (req, res) => {
    const id = String(req.params.id);
    const dir = typeof req.query.dir === "string" ? req.query.dir : undefined;
    for (const s of live.values()) if (s.sessionId === id) s.close();
    await deleteSession(id, { dir });
    updateState((s) => delete s.sessions[id]);
    broadcast({ t: "sessions-changed" });
    res.json({ ok: true });
  }),
);

api.post(
  "/projects",
  wrap(async (req, res) => {
    const dir = path.resolve(String(req.body?.path ?? "").replace(/^~(?=$|[\\/])/, os.homedir()));
    if (!fs.existsSync(dir) || !fs.statSync(dir).isDirectory()) return res.status(400).json({ error: `Not a folder: ${dir}` });
    updateState((s) => {
      if (!s.projects.includes(dir)) s.projects.push(dir);
    });
    broadcast({ t: "sessions-changed" });
    res.json({ path: dir });
  }),
);

api.get(
  "/catalog",
  wrap(async (req, res) => {
    res.json(await catalog(typeof req.query.cwd === "string" ? req.query.cwd : os.homedir()));
  }),
);

api.post("/reauth", wrap(async (_req, res) => res.json(await runReauth())));

// Info pane: context usage, connectors and background tasks of a live session.
function liveFor(req: express.Request) {
  const s = live.get(String(req.params.key));
  if (!s) throw new Error("That session isn't running.");
  return s;
}
const settle = <T,>(p: Promise<T>) => p.then((v) => v, (e) => ({ error: e instanceof Error ? e.message : String(e) }));
api.get(
  "/live/:key/info",
  wrap(async (req, res) => {
    const s = liveFor(req);
    const [context, mcp] = await Promise.all([settle(s.contextUsage()), settle(s.mcpStatus())]);
    res.json({ context, mcp });
  }),
);
api.post(
  "/live/:key/mcp",
  wrap(async (req, res) => {
    const s = liveFor(req);
    const name = String(req.body?.name ?? "");
    if (req.body?.reconnect) await s.reconnectMcp(name);
    else await s.toggleMcp(name, !!req.body?.enabled);
    res.json(await s.mcpStatus());
  }),
);
api.post(
  "/live/:key/tasks/:taskId/stop",
  wrap(async (req, res) => {
    await liveFor(req).stopTask(String(req.params.taskId));
    res.json({ ok: true });
  }),
);

// Git endpoints act on a session's folder, passed as ?cwd= or { cwd }.
function folder(req: express.Request): string {
  const cwd = String((req.method === "GET" ? req.query.cwd : req.body?.cwd) ?? "");
  if (!cwd || !fs.existsSync(cwd) || !fs.statSync(cwd).isDirectory()) throw new Error(`Not a folder: ${cwd}`);
  return cwd;
}

api.get("/git/info", wrap(async (req, res) => res.json(await repoInfo(folder(req)))));
api.get(
  "/git/diff",
  wrap(async (req, res) => res.json(await workingDiff(folder(req), req.query.against === "base" ? "base" : "HEAD"))),
);
api.get("/git/file", wrap(async (req, res) => res.json(readFileFor(folder(req), String(req.query.path ?? "")))));
api.post("/git/sync", wrap(async (req, res) => res.json(await syncWithBase(folder(req)))));
api.post(
  "/git/commit",
  wrap(async (req, res) => {
    const message = String(req.body?.message ?? "").trim();
    if (!message) return res.status(400).json({ error: "A commit message is required." });
    res.json({ output: await commitAll(folder(req), message) });
  }),
);
api.post("/git/push", wrap(async (req, res) => res.json({ output: await push(folder(req)) })));
api.get("/git/pr", wrap(async (req, res) => res.json(await prStatus(folder(req)))));
api.post("/git/pr", wrap(async (req, res) => res.json({ url: await createPr(folder(req), !!req.body?.draft) })));

api.get("/terminals", (_req, res) => res.json(terminals.list()));
api.get(
  "/preview",
  wrap(async (req, res) => {
    const cwd = folder(req);
    res.json({ configs: launchConfigs(cwd), running: previews.list() });
  }),
);
api.post("/preview/start", wrap(async (req, res) => res.json(await previews.start(folder(req), String(req.body?.name)))));
api.post(
  "/preview/stop",
  wrap(async (req, res) => {
    previews.stop(String(req.body?.id));
    res.json({ ok: true });
  }),
);
api.get("/preview/logs", (req, res) => res.json(previews.logs(String(req.query.id), { lines: 300 })));
api.get("/settings", (_req, res) => res.json(getSettings()));
api.post("/settings", (req, res) => {
  const next = updateSettings(req.body ?? {});
  broadcast({ t: "settings", settings: next });
  res.json(next);
});

// Read-only check of the credentials Claude Code will use on this device.
api.get("/auth-status", (_req, res) => {
  execFile(bundledClaudeExe() ?? "claude", ["auth", "status"], { timeout: 30_000, windowsHide: true }, (err, stdout, stderr) =>
    res.json({ ok: !err, output: (stdout + stderr).trim() || String(err?.message ?? "") }),
  );
});

// Non-image attachments are saved here and handed to Claude by path.
api.post(
  "/uploads",
  wrap(async (req, res) => {
    const name = path.basename(String(req.body?.name ?? "file")).replace(/[^\w.\- ]+/g, "_") || "file";
    const dir = path.join(DATA_DIR, "uploads", randomUUID().slice(0, 8));
    fs.mkdirSync(dir, { recursive: true });
    const file = path.join(dir, name);
    fs.writeFileSync(file, Buffer.from(String(req.body?.data ?? ""), "base64"));
    res.json({ path: file });
  }),
);

api.get(
  "/sessions/:id/subagents/:agentId",
  wrap(async (req, res) => {
    const dir = typeof req.query.dir === "string" ? req.query.dir : undefined;
    res.json(await getSubagentMessages(String(req.params.id), String(req.params.agentId), { dir }));
  }),
);

api.get("/schedules", (_req, res) => res.json(scheduler.list()));
api.post("/schedules", wrap(async (req, res) => res.json(scheduler.upsert(req.body))));
api.delete("/schedules/:id", (req, res) => {
  scheduler.remove(String(req.params.id));
  res.json({ ok: true });
});
api.post("/schedules/:id/run", wrap(async (req, res) => res.json(await scheduler.run(String(req.params.id)))));

api.get("/browser/shot", (req, res) => res.json(lastShot.get(String(req.query.key)) ?? null));

app.use("/api", api);

const dist = path.resolve("dist");
if (fs.existsSync(dist)) {
  app.use(express.static(dist));
  app.get(/^(?!\/api).*/, (_req, res) => res.sendFile(path.join(dist, "index.html")));
}

const server = http.createServer(app);
const wss = new WebSocketServer({ noServer: true });

server.on("upgrade", (req, socket, head) => {
  if (req.url !== "/ws" || !trusted(req)) return socket.destroy();
  wss.handleUpgrade(req, socket, head, (ws) => wss.emit("connection", ws, req));
});

type ClientMsg = { t: string; key?: string; [k: string]: any };

wss.on("connection", (ws) => {
  sockets.add(ws);
  ws.on("close", () => sockets.delete(ws));
  ws.on("message", async (raw) => {
    let m: ClientMsg;
    try {
      m = JSON.parse(String(raw));
    } catch {
      return;
    }
    const s = m.key ? live.get(m.key) : undefined;
    try {
      switch (m.t) {
        case "start": {
          let cwd: string = m.cwd;
          if (m.worktree && !m.resume) {
            const wt = await createWorktree(cwd, String(m.text ?? "session").split(/\s+/).slice(0, 5).join(" "));
            cwd = wt.path;
          }
          const session = startSession({ cwd, resume: m.resume, model: m.model, effort: m.effort, permissionMode: m.permissionMode });
          ws.send(JSON.stringify({ t: "started", ref: m.ref, session: session.summary() }));
          if (m.content || m.text) session.send(m.content ?? m.text);
          break;
        }
        case "send":
          s?.send(m.content ?? m.text);
          break;
        case "permission":
          s?.answerPermission(m.id, m.reply);
          break;
        case "interrupt":
          await s?.interrupt();
          break;
        case "setModel":
          await s?.setModel(m.model);
          break;
        case "setMode":
          await s?.setPermissionMode(m.mode);
          break;
        case "setEffort":
          await s?.setEffort(m.effort);
          break;
        case "subscribe":
          if (s) ws.send(JSON.stringify({ t: "log", key: s.key, log: s.log, session: s.summary() }));
          break;
        case "close":
          s?.close();
          break;
        case "side": {
          const session = await startSide({ title: m.title, prompt: m.text, cwd: m.cwd, worktree: m.worktree, parentKey: m.parentKey, parentSessionId: m.parentSessionId });
          ws.send(JSON.stringify({ t: "side-started", ref: m.ref, session }));
          break;
        }
        case "term:open": {
          const t = terminals.open(m.cwd, { cols: m.cols, rows: m.rows });
          ws.send(JSON.stringify({ t: "term:opened", ref: m.ref, id: t.id }));
          break;
        }
        case "term:input":
          terminals.write(m.id, m.data);
          break;
        case "term:resize":
          terminals.resize(m.id, m.cols, m.rows);
          break;
        case "term:attach":
          ws.send(JSON.stringify({ t: "term:replay", id: m.id, data: terminals.scrollback(m.id) }));
          break;
        case "term:close":
          terminals.close(m.id);
          break;
      }
    } catch (e) {
      ws.send(JSON.stringify({ t: "error", key: m.key, error: String((e as Error)?.message ?? e) }));
    }
  });
});

server.listen(PORT, "127.0.0.1", () => {
  console.log(`claude-web listening on http://localhost:${PORT}`);
});

const shutdown = async () => {
  for (const s of live.values()) s.close();
  terminals.closeAll();
  previews.stopAll();
  await closeBrowser();
  process.exit(0);
};
process.on("SIGINT", () => void shutdown());
process.on("SIGTERM", () => void shutdown());
