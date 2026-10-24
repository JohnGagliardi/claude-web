import express from "express";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { WebSocketServer, type WebSocket } from "ws";
import {
  deleteSession,
  getSessionMessages,
  listSessions,
  renameSession,
  type ModelInfo,
  type SlashCommand,
} from "@anthropic-ai/claude-agent-sdk";
import { LiveSession, type LiveEvent } from "./live.js";
import { getState, readConfig, updateSessionMeta, updateState } from "./state.js";
import { reauthInfo, runReauth } from "./reauth.js";
import { commitAll, createPr, createWorktree, prStatus, push, readFileFor, repoInfo, syncWithBase, workingDiff } from "./git.js";
import { startAutofix } from "./autofix.js";

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
  }
  if (ev.t === "closed") {
    live.delete(ev.key);
    broadcast({ t: "sessions-changed" });
  }
  broadcast(ev);
}

// Resuming a session that already has a live process reuses it.
function startSession(opts: ConstructorParameters<typeof LiveSession>[0]) {
  const existing = opts.resume ? [...live.values()].find((x) => x.sessionId === opts.resume) : undefined;
  const session = existing ?? new LiveSession(opts, onLiveEvent);
  live.set(session.key, session);
  return session;
}

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
    res.json(await getSessionMessages(String(req.params.id), { dir }));
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
          if (m.text) session.send(m.text);
          break;
        }
        case "send":
          s?.send(m.text);
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
      }
    } catch (e) {
      ws.send(JSON.stringify({ t: "error", key: m.key, error: String((e as Error)?.message ?? e) }));
    }
  });
});

server.listen(PORT, "127.0.0.1", () => {
  console.log(`claude-web listening on http://localhost:${PORT}`);
});

process.on("SIGINT", () => {
  for (const s of live.values()) s.close();
  process.exit(0);
});
