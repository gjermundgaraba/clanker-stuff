# clanker stuff

A personal collection of extensions, plugins, and skills for Pi, Claude Code, and Codex. This is an independent project that is not affiliated with or endorsed by OpenAI, Anthropic, or the Pi maintainers.

## Pi extensions

| Extension                                                                   | Description                                                                                |
| --------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------ |
| [`@clanker-stuff/ask-question`](pi/extensions/ask-question)                 | Lets pi ask blocking or asynchronous questionnaires with reviewed, revisable answers.      |
| [`@clanker-stuff/dollah-skills`](pi/extensions/dollah-skills)               | Adds Codex-style skill mentions that complete, highlight, and load skills into the prompt. |
| [`@clanker-stuff/history`](pi/extensions/history)                           | Adds persistent prompt history with native ↑/↓ recall and Ctrl+R search to pi's editor.    |
| [`@clanker-stuff/shell-resume-history`](pi/extensions/shell-resume-history) | Adds pi's resume command to the invoking fish or zsh shell's history when pi exits.        |
| [`@clanker-stuff/stash`](pi/extensions/stash)                               | Adds a Ctrl+S shortcut and /pop-stash command for stashing and restoring editor text.      |

## Experimental pi extensions

| Extension                                                                        | Description                                                                                                                                                               |
| -------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| [`@clanker-stuff/background-tasks`](pi/extensions/experimental/background-tasks) | Runs session-owned background jobs and agent-authored watchers with automatic notifications.                                                                              |
| [`@clanker-stuff/context`](pi/extensions/experimental/context)                   | Inspects Pi's current context as a read-only TUI tree with searchable, scrollable details.                                                                                |
| [`@clanker-stuff/footer`](pi/extensions/experimental/footer)                     | Lays out built-in widgets and native extension statuses in the footer and editor border.                                                                                  |
| [`@clanker-stuff/plannotator`](pi/extensions/experimental/plannotator)           | Adds Plannotator review and annotation commands to pi.                                                                                                                    |
| [`@clanker-stuff/shape-spinner`](pi/extensions/experimental/shape-spinner)       | Replaces Pi's working spinner with selectable Rubik's cube or wireframe shape animations.                                                                                 |
| [`@clanker-stuff/subagents`](pi/extensions/experimental/subagents)               | Adds durable hierarchical subagents with independent pi sessions, modeled on the Codex collaboration tools; works with any provider but is tuned for OpenAI Codex models. |
| [`@clanker-stuff/turn-recap`](pi/extensions/experimental/turn-recap)             | Adds a turn card with timing, usage, tool activity, and optional LLM recaps to the chat after each run.                                                                   |
| [`@clanker-stuff/usage`](pi/extensions/experimental/usage)                       | Shows account usage for supported providers in a status line and on demand.                                                                                               |
| [`@clanker-stuff/user-attention`](pi/extensions/experimental/user-attention)     | Sends attention notifications while pi continues working.                                                                                                                 |
| [`@clanker-stuff/vim`](pi/extensions/experimental/vim)                           | Adds composable Vim editing with transactional undo and visual selections to pi.                                                                                          |

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

## Skills

[Reusable skills](skills/README.md) cover coding, review, writing, visualization, and agent-tool workflows. Repository-local workflows live in `.agents/skills/`; package-owned skills stay with their extension or plugin. Personal skills live in the dotfiles repository.

## Development

Requires Vite+, Node.js 26 or newer, and Python 3.10 or newer. Run `vp install --frozen-lockfile`, then `vp run ready`. See the [native Pi baseline](docs/native-pi.md) for retirement and local-adoption notes.

## License

[MIT](LICENSE). Vendored and derived third-party code is listed in [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md).
