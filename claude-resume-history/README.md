# claude-resume-history

Adds Claude Code's resume command to the invoking fish or zsh shell's history when Claude Code exits. Companion to [shell-resume-history](../shell-resume-history/); reuses its shell-side inbox hook unchanged.

## Install

```bash
mkdir -p ~/.claude/hooks
ln -s "$PWD/resume-history.sh" ~/.claude/hooks/resume-history.sh
```

Then register it as a `SessionEnd` hook in `~/.claude/settings.json`:

```json
"SessionEnd": [
  { "hooks": [{ "type": "command", "command": "bash ~/.claude/hooks/resume-history.sh" }] }
]
```

## Usage

- Install the shell hook from [shell-resume-history's setup guide](../shell-resume-history/docs/setup.md) if not already present.
- Exit Claude Code normally; `claude --resume <session-id>` appears in that shell's history at the next prompt.

## Requirements

`jq` on `PATH`. Not a pi extension and not published; local symlink install only.
