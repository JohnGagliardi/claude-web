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

## Phase 3: terminal and browser panes (done)

- [x] Terminal tabs (xterm.js + node-pty prebuilds), shared with Claude, scrollback replayed on reload
- [x] Preview pane: start/stop dev servers from `.claude/launch.json`, logs, URL bar, iframe
- [x] Claude's headless browser (installed Edge/Chrome via playwright-core), shown live in the Preview pane
- [x] In-process MCP tools for Claude: terminal_list/read/run, preview_list/start/stop/logs, browser_navigate/screenshot/text/click/type/eval/console (read-only ones pre-approved)

## Phase 4: scheduling and side sessions (done)

- [x] Scheduled tasks (cron, via croner) that start a new session or message an existing one; Run now, pause, history
- [x] Side sessions from the UI (⑃ Side) or by Claude (`start_side_session`), nested in the sidebar; each finished turn is reported to the parent
- [x] Split view: two sessions side by side (⧉ or Ctrl+click), each with its own side pane
- [x] Desktop notifications when a session finishes or needs approval while off screen; unread count in the tab title

## Later

- [ ] Image paste and file attachments in the composer
- [ ] Subagent transcripts nested in Agent tool cards
- [ ] Idle shutdown of live sessions; usage and cost view
- [ ] Settings page (default model, effort, mode, notifications)
