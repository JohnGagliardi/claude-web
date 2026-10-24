# Roadmap

Mirror of the Claude desktop app's Code tab, minus account management.

## Phase 1: core chat and sessions (done)

- [x] Live sessions over the Agent SDK with streaming input; resume any CLI/desktop session
- [x] Sidebar: sessions grouped by folder, pin, rename, archive, delete, search, unread and running dots
- [x] Transcript: streaming text, markdown, thinking, tool cards with Edit diffs, results
- [x] Permission prompts: allow, always allow, deny with a note; AskUserQuestion form; plan approval
- [x] Composer: slash-command autocomplete, permission mode, model, effort, stop
- [x] Task list from TodoWrite
- [x] Reauth button backed by a per-device command
- [x] Loopback-only server with Host and Origin checks

## Phase 2: git, worktrees, diff (done)

- [x] Option to start a session in a new git worktree (`<repo>/.claude/worktrees/<name>`, branch `claude/<name>`)
- [x] Diff pane: uncommitted or all-vs-base changes, per file, untracked files included
- [x] File viewer pane, opened from `path:line` links and tool cards in the transcript
- [x] Sync with base (conflicts go to Claude), commit (or ask Claude to), push, create PR via `gh`
- [x] PR status and CI checks; Auto-fix polls every 90s and messages the session on new CI failures or conflicts

## Phase 3: terminal and browser panes

- [ ] Terminal tabs (xterm.js, plus node-pty or a pipe fallback on Windows)
- [ ] Preview pane for local dev servers (`.claude/launch.json`)
- [ ] Headless browser tools exposed to Claude as an in-process MCP server

## Phase 4: scheduling and side sessions

- [ ] Scheduled tasks (cron) that start or message sessions
- [ ] Side sessions started from a session, with linked status
- [ ] Split view of two sessions
- [ ] Browser notifications when a session finishes or needs approval

## Later

- [ ] Image paste and file attachments in the composer
- [ ] Subagent transcripts nested in Agent tool cards
- [ ] Idle shutdown of live sessions; usage and cost view
- [ ] Settings page (default model, effort, mode, notifications)
