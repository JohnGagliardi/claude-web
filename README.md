# claude-web

A browser front end for Claude Code that mirrors the Claude desktop app's Code tab,
with nothing to install beyond Node. The Claude Agent SDK runs Claude Code
underneath, so tools, skills, CLAUDE.md, MCP servers and permissions behave the same
as in the CLI, and sessions are shared with it (`~/.claude/projects`).

## Run

```bash
npm install
npm start          # builds the UI and serves http://localhost:3737
npm run dev        # server with reload + Vite on http://localhost:5173
```

The server binds to `127.0.0.1` and rejects requests whose Host or Origin isn't the
app's own page, because it runs tools on this machine.

## Reauth

The app does no account management. The **Reauth** button runs whatever this device
configures in `~/.claude-web/config.json`:

```json
{ "reauth": { "label": "Reauth", "command": "\"C:\\path\\to\\claude-web\\reauth\\windows-claude-login.cmd\"" } }
```

The command runs in a shell with `CLAUDE_EXE` set to the SDK's bundled Claude Code
binary. `reauth/` has starter scripts that open Claude Code's own sign-in flow; a
device can instead rotate an API key, refresh a token from a vault, and so on.

## Layout

- `server/live.ts`: one Agent SDK `query()` per live session, streaming input, permission prompts
- `server/index.ts`: REST + WebSocket API, session list and metadata
- `server/state.ts`: app-only data (pins, archive, unread, projects) in `~/.claude-web`
- `web/src`: React UI (sidebar, transcript, composer, permission cards)

See [ROADMAP.md](ROADMAP.md) for what's built and what's next.

## Claude's tools

Each session gets an in-process MCP server (`claude-web`) so Claude can use the
terminal tabs, start dev servers from `.claude/launch.json`, and drive a headless
browser. The browser is an installed Edge or Chrome, picked automatically or set
with `"browser": { "channel": "chrome" }` in `~/.claude-web/config.json`.
