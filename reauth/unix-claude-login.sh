#!/bin/sh
# Runs Claude Code's sign-in flow in a new terminal (macOS / Linux).
if [ "$(uname)" = "Darwin" ]; then
  osascript -e "tell application \"Terminal\" to do script \"'$CLAUDE_EXE' auth login\""
else
  x-terminal-emulator -e "$CLAUDE_EXE" auth login
fi
