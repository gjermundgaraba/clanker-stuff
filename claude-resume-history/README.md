# claude-resume-history

Claude Code plugin: adds Claude Code's resume command to the invoking fish or zsh shell's history when Claude Code exits. Companion to [shell-resume-history](../shell-resume-history/); reuses its shell-side inbox hook unchanged.

## Install

```bash
ln -s "$PWD" ~/.claude/skills/claude-resume-history
```

Auto-loads next session as `claude-resume-history@skills-dir` with its bundled `SessionEnd` hook; no `settings.json` entry needed.

## Usage

- Install the shell hook from [shell-resume-history's setup guide](../shell-resume-history/docs/setup.md) if not already present.
- Exit Claude Code normally; `claude --resume <session-id>` appears in that shell's history at the next prompt.

## Requirements

`jq` on `PATH`. Not a pi extension and not published; local symlink install only.
