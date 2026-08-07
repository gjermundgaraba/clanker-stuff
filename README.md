# clanker stuff

A personal collection of extensions and plugins for Pi, Claude Code, and Codex.

## Pi extensions

| Extension | Description |
| --- | --- |
| [`@clanker-stuff/ask-question`](pi/extensions/ask-question) | Lets pi ask multiple-choice or free-text questions before continuing. |
| [`@clanker-stuff/codex-fast`](pi/extensions/codex-fast) | Adds /fast to toggle OpenAI Codex fast mode and shows a lightning status while active. |
| [`@clanker-stuff/codex-reverse-i-search`](pi/extensions/codex-reverse-i-search) | Adds Codex-style Ctrl+R reverse history search to pi's prompt editor. |
| [`@clanker-stuff/codex-skills`](pi/extensions/codex-skills) | Injects complete SKILL.md instructions when prompts explicitly mention $skill-name. |
| [`@clanker-stuff/decorated-editor`](pi/extensions/decorated-editor) | Provides a shared custom editor for inline prompt decorations from Clanker extensions. |
| [`@clanker-stuff/footer`](pi/extensions/footer) | Hosts a configurable cooperative footer for built-in, native, and rich extension widgets. |
| [`@clanker-stuff/mcp`](pi/extensions/mcp) | Connects selected MCP servers to pi and registers their tools. |
| [`@clanker-stuff/plannotator`](pi/extensions/plannotator) | Adds Plannotator review and annotation commands to pi. |
| [`@clanker-stuff/shell-resume-history`](pi/extensions/shell-resume-history) | Adds pi's resume command to the invoking fish or zsh shell's history when pi exits. |
| [`@clanker-stuff/side`](pi/extensions/side) | Adds a concurrent multi-turn /side conversation with an adaptive side panel. |
| [`@clanker-stuff/stash`](pi/extensions/stash) | Adds a Ctrl+S shortcut and /pop-stash command for stashing and restoring editor text. |
| [`@clanker-stuff/timer`](pi/extensions/timer) | Tracks agent execution time and displays a live running timer in the status bar. |
| [`@clanker-stuff/tool-picker`](pi/extensions/tool-picker) | Adds /tools to choose which registered tools are active in the current session. |
| [`@clanker-stuff/tools`](pi/extensions/tools) | Wraps pi's coding capabilities in the tool interfaces exposed by model labs' own coding harnesses. |
| [`@clanker-stuff/usage`](pi/extensions/usage) | Shows subscription usage for supported providers and contributes quota widgets to cooperative footers. |
| [`@clanker-stuff/voice`](pi/extensions/voice) | Adds Codex-style realtime voice conversations backed by the current pi session. |

## Claude Code plugins

| Plugin | Description |
| --- | --- |
| [`plannotator`](claude/plugins/plannotator) | Adds Plannotator review and annotation workflows to Claude Code. |
| [`resume-history`](claude/plugins/resume-history) | Adds Claude Code's resume command to the invoking shell's history. |

## Codex plugins

| Plugin | Description |
| --- | --- |
| [`plannotator`](codex/plugins/plannotator) | Adds Plannotator review and annotation workflows to Codex. |
| [`resume-history`](codex/plugins/resume-history) | Adds Codex's resume command to the invoking shell's history. |

## Development

Requires Node.js 24 or newer and pnpm. Run `pnpm install --frozen-lockfile`, then `pnpm check:all`.

## License

[MIT](LICENSE)
