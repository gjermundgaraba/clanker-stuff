# clanker stuff

A personal collection of extensions and plugins for Pi, Claude Code, and Codex. This is an independent project that is not affiliated with or endorsed by OpenAI, Anthropic, or the Pi maintainers.

## Pi extensions

| Extension                                                                   | Description                                                                                         |
| --------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------- |
| [`@clanker-stuff/ask-question`](pi/extensions/ask-question)                 | Lets pi ask multiple-choice clarification questions before continuing.                              |
| [`@clanker-stuff/dollah-skills`](pi/extensions/dollah-skills)               | Adds Codex-style skill mentions that complete, highlight, and inject loaded skills into the prompt. |
| [`@clanker-stuff/mcp`](pi/extensions/mcp)                                   | Connects selected MCP servers to pi and registers their tools.                                      |
| [`@clanker-stuff/reverse-i-search`](pi/extensions/reverse-i-search)         | Adds Codex-style Ctrl+R reverse history search to pi's prompt editor.                               |
| [`@clanker-stuff/shell-resume-history`](pi/extensions/shell-resume-history) | Adds pi's resume command to the invoking fish or zsh shell's history when pi exits.                 |
| [`@clanker-stuff/stash`](pi/extensions/stash)                               | Adds a Ctrl+S shortcut and /pop-stash command for stashing and restoring editor text.               |
| [`@clanker-stuff/timer`](pi/extensions/timer)                               | Tracks agent execution time and displays a live running timer in the status bar.                    |

## Experimental pi extensions

| Extension                                                                    | Description                                                                                                                                                               |
| ---------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| [`@clanker-stuff/codex-provider`](pi/extensions/experimental/codex-provider) | Replaces Pi's OpenAI Codex provider with Codex-compatible requests, fast mode, transport, compaction, and durable checkpoint replay.                                      |
| [`@clanker-stuff/footer`](pi/extensions/experimental/footer)                 | Hosts a configurable cooperative footer for built-in, native, and rich extension widgets.                                                                                 |
| [`@clanker-stuff/plannotator`](pi/extensions/experimental/plannotator)       | Adds Plannotator review and annotation commands to pi.                                                                                                                    |
| [`@clanker-stuff/side`](pi/extensions/experimental/side)                     | Adds a concurrent multi-turn /side conversation with an adaptive side panel.                                                                                              |
| [`@clanker-stuff/subagents`](pi/extensions/experimental/subagents)           | Adds durable hierarchical subagents with independent pi sessions, modeled on the Codex collaboration tools; works with any provider but is tuned for OpenAI Codex models. |
| [`@clanker-stuff/tools`](pi/extensions/experimental/tools)                   | Adapts pi's coding tools to model-native interfaces and adds /tools for choosing active tools.                                                                            |
| [`@clanker-stuff/usage`](pi/extensions/experimental/usage)                   | Shows subscription usage for supported providers and contributes quota widgets to cooperative footers.                                                                    |

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
