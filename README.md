# clanker stuff

A personal collection of extensions and plugins for Pi, Claude Code, and Codex. This is an independent project that is not affiliated with or endorsed by OpenAI, Anthropic, or the Pi maintainers.

## Pi extensions

| Extension                                                                   | Description                                                                                         |
| --------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------- |
| [`@clanker-stuff/ask-question`](pi/extensions/ask-question)                 | Lets pi ask blocking or asynchronous questions and send attention messages.                         |
| [`@clanker-stuff/dollah-skills`](pi/extensions/dollah-skills)               | Adds Codex-style skill mentions that complete, highlight, and inject loaded skills into the prompt. |
| [`@clanker-stuff/history`](pi/extensions/history)                           | Adds persistent prompt history with native ↑/↓ recall and Ctrl+R search to pi's editor.             |
| [`@clanker-stuff/mcp`](pi/extensions/mcp)                                   | Connects selected MCP servers to pi and registers their tools.                                      |
| [`@clanker-stuff/shell-resume-history`](pi/extensions/shell-resume-history) | Adds pi's resume command to the invoking fish or zsh shell's history when pi exits.                 |
| [`@clanker-stuff/stash`](pi/extensions/stash)                               | Adds a Ctrl+S shortcut and /pop-stash command for stashing and restoring editor text.               |
| [`@clanker-stuff/timer`](pi/extensions/timer)                               | Tracks agent execution time and displays a live running timer in the status bar.                    |
| [`@clanker-stuff/tool-picker`](pi/extensions/tool-picker)                   | Adds /tools for choosing active tools, with selections saved per session branch.                    |

## Experimental pi extensions

| Extension                                                                        | Description                                                                                                                                                               |
| -------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| [`@clanker-stuff/background-tasks`](pi/extensions/experimental/background-tasks) | Runs session-owned background jobs and agent-authored watchers with bounded notifications.                                                                                |
| [`@clanker-stuff/codex-provider`](pi/extensions/experimental/codex-provider)     | Replaces Pi's OpenAI Codex provider with Codex-compatible requests, fast mode, transport, compaction, and durable checkpoint replay.                                      |
| [`@clanker-stuff/footer`](pi/extensions/experimental/footer)                     | Hosts a configurable cooperative footer for built-in, native, and rich extension widgets.                                                                                 |
| [`@clanker-stuff/plannotator`](pi/extensions/experimental/plannotator)           | Adds Plannotator review and annotation commands to pi.                                                                                                                    |
| [`@clanker-stuff/recap`](pi/extensions/experimental/recap)                       | Automatically adds durable conversation recap cards after settled Pi turns using a configured secondary model.                                                            |
| [`@clanker-stuff/shape-spinner`](pi/extensions/experimental/shape-spinner)       | Replaces Pi's working spinner with a selectable Rubik's cube or wireframe shape animation.                                                                                |
| [`@clanker-stuff/side`](pi/extensions/experimental/side)                         | Adds a concurrent multi-turn /side conversation with an adaptive side panel.                                                                                              |
| [`@clanker-stuff/subagents`](pi/extensions/experimental/subagents)               | Adds durable hierarchical subagents with independent pi sessions, modeled on the Codex collaboration tools; works with any provider but is tuned for OpenAI Codex models. |
| [`@clanker-stuff/usage`](pi/extensions/experimental/usage)                       | Shows subscription usage for supported providers and contributes quota widgets to cooperative footers.                                                                    |

Experimental extensions are not published to npm and are not stable daily drivers; they may change incompatibly or be deleted without notice.

## Claude Code plugins

| Plugin                                            | Description                                                        |
| ------------------------------------------------- | ------------------------------------------------------------------ |
| [`plannotator`](claude/plugins/plannotator)       | Adds Plannotator review and annotation workflows to Claude Code.   |
| [`resume-history`](claude/plugins/resume-history) | Adds Claude Code's resume command to the invoking shell's history. |

## Codex plugins

| Plugin                                           | Description                                                  |
| ------------------------------------------------ | ------------------------------------------------------------ |
| [`plannotator`](codex/plugins/plannotator)       | Adds Plannotator review and annotation workflows to Codex.   |
| [`resume-history`](codex/plugins/resume-history) | Adds Codex's resume command to the invoking shell's history. |

## Development

Requires Vite+ and Node.js 26 or newer. Run `vp install --frozen-lockfile`, then `vp run ready`.

## License

[MIT](LICENSE). Vendored and derived third-party code is listed in [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md).
