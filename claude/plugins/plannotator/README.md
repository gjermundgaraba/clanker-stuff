# plannotator

Plannotator review and annotation workflows for Claude Code.

## Install

```bash
ln -s /path/to/clanker-stuff/claude/plugins/plannotator ~/.claude/skills/plannotator
```

## Usage

- `/plannotator:plannotator-review` reviews current changes or a pull request.
- `/plannotator:plannotator-annotate <target>` annotates a file, folder, or URL.
- `/plannotator:plannotator-last` annotates the last assistant response.

## Requirements

The `plannotator` CLI must be available on `PATH`.
