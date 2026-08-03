# plannotator-claude

Plannotator review and annotation commands for Claude Code. Commands only; no plan-mode hooks.

## Install

```bash
claude --plugin-dir /path/to/clanker-extensions/plannotator-claude
```

## Usage

- `/plannotator-review [--base <ref>]` reviews current Git changes or, without `--base`, a pull request.
- `/plannotator-annotate <target>` annotates a file, folder, or URL.
- `/plannotator-last` annotates the last assistant response.

## Requirements

The `plannotator` CLI must be available on `PATH`, and Node.js 24 or newer is required. This is not a pi extension; it is a Claude Code plugin and is not part of the pnpm workspace.
