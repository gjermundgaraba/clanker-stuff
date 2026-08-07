# resume-history

Adds Claude Code's resume command to the invoking fish or zsh shell's history when Claude Code exits.

## Install

```bash
ln -s /path/to/clanker-stuff/claude/plugins/resume-history ~/.claude/skills/resume-history
```

Auto-loads next session as `resume-history@skills-dir` with its bundled `SessionEnd` hook.

## Usage

Install the [shell history hook](../../../pi/extensions/shell-resume-history/docs/setup.md), then exit Claude Code normally.

## Requirements

`jq` on `PATH` and the fish or zsh hook from `shell-resume-history`.
