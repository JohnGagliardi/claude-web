@echo off
rem Opens a console window running Claude Code's own sign-in flow.
rem Used by this device's "reauth.command" in %USERPROFILE%\.claude-web\config.json.
start "Claude sign-in" "%CLAUDE_EXE%" auth login
