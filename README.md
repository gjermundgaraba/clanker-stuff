# clanker extensions

A collection of independently installable extensions for [pi](https://github.com/earendil-works/pi).

## Extensions

| Extension | Description |
| --- | --- |
| [`@clanker-extensions/ask-question`](ask-question) | Lets pi ask multiple-choice or free-text questions before continuing. |
| [`@clanker-extensions/codex-fast`](codex-fast) | Adds /fast to toggle OpenAI Codex fast mode and shows a lightning status while active. |
| [`@clanker-extensions/codex-reverse-i-search`](codex-reverse-i-search) | Adds Codex-style Ctrl+R reverse history search to pi's prompt editor. |
| [`@clanker-extensions/codex-skills`](codex-skills) | Injects complete SKILL.md instructions when prompts explicitly mention $skill-name. |
| [`@clanker-extensions/decorated-editor`](decorated-editor) | Provides a shared custom editor for inline prompt decorations from Clanker extensions. |
| [`@clanker-extensions/footer`](footer) | Hosts a configurable cooperative footer for built-in, native, and rich extension widgets. |
| [`@clanker-extensions/mcp`](mcp) | Connects selected MCP servers to pi and registers their tools. |
| [`@clanker-extensions/plannotator`](plannotator) | Adds Plannotator review and annotation commands to pi. |
| [`@clanker-extensions/shell-resume-history`](shell-resume-history) | Adds pi's resume command to the invoking fish or zsh shell's history when pi exits. |
| [`@clanker-extensions/side`](side) | Adds a concurrent multi-turn /side conversation with an adaptive side panel. |
| [`@clanker-extensions/stash`](stash) | Adds a Ctrl+S shortcut and /pop-stash command for stashing and restoring editor text. |
| [`@clanker-extensions/timer`](timer) | Tracks agent execution time and displays a live running timer in the status bar. |
| [`@clanker-extensions/tool-picker`](tool-picker) | Adds /tools to choose which registered tools are active in the current session. |
| [`@clanker-extensions/tools`](tools) | Wraps pi's coding capabilities in the tool interfaces exposed by model labs' own coding harnesses. |
| [`@clanker-extensions/usage`](usage) | Shows subscription usage for supported providers and contributes quota widgets to cooperative footers. |
| [`@clanker-extensions/voice`](voice) | Adds Codex-style realtime voice conversations backed by the current pi session. |

## Install

```bash
pi install npm:@clanker-extensions/<package-name>
```

See each extension's README for its package name, requirements, and usage.

## Development

Requires Node.js 24 or newer and pnpm. Run `pnpm install --frozen-lockfile`, then `pnpm check:all`.

## License

[MIT](LICENSE)
