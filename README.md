# clanker extensions

A collection of independently installable extensions for [pi](https://github.com/earendil-works/pi).

## Extensions

| Extension | Description |
| --- | --- |
| [`@clanker-extensions/ask-question`](ask-question) | Lets pi ask multiple-choice or free-text questions before continuing. |
| [`@clanker-extensions/footer`](footer) | Replaces the pi footer with a compact context gauge, git status, and subscription usage bars for the active provider. |
| [`@clanker-extensions/mcp`](mcp) | Connects selected MCP servers to pi and registers their tools. |
| [`@clanker-extensions/plannotator`](plannotator) | Adds Plannotator review and annotation commands to pi. |
| [`@clanker-extensions/stash`](stash) | Adds a Ctrl+S shortcut and /pop-stash command for stashing and restoring editor text. |
| [`@clanker-extensions/timer`](timer) | Tracks agent execution time and displays a live running timer in the status bar. |
| [`@clanker-extensions/tool-picker`](tool-picker) | Adds /tools to choose which tools are active in the current session. |

## Install

```bash
pi install npm:@clanker-extensions/<package-name>
```

See each extension's README for its package name, requirements, and usage.

## Development

Requires Node.js 24 or newer and pnpm. Run `pnpm install --frozen-lockfile`, then `pnpm check:all`.

## License

[MIT](LICENSE)
