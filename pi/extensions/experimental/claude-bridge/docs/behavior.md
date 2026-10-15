# claude-bridge behavior

`claude-bridge` registers a `claude-bridge` provider whose models run through Claude Code via the [Claude Agent SDK](https://github.com/anthropics/claude-agent-sdk-typescript). Requests use your Claude Code login and its subscription quota. Pi's tools are served to Claude Code over an in-process MCP server and run in pi, so tool calls appear in pi's TUI as usual.

It started as a port of [pi-claude-bridge](https://github.com/elidickinson/pi-claude-bridge) v0.9.3 and is developed independently; it does not track that project.

## Requirements

- A working Claude Code login (`claude` signed in to a Pro or Max plan). The Agent SDK bundles its own Claude Code binary.
- No exported `ANTHROPIC_BASE_URL`, `ANTHROPIC_API_KEY`, or `ANTHROPIC_AUTH_TOKEN` in pi's environment: Claude Code inherits them and every turn fails with that gateway's auth error.
- The npm `pi-claude-bridge` package must not be installed alongside this one; both register the `claude-bridge` provider.

## Models

The model picker follows pi-ai's Anthropic catalog. Models Claude Code serves at 1M context on every plan (the newer Opus, Sonnet 5.x, Haiku 5.5, and Fable models) are requested and registered at 1M; every other model, including Opus 4.6 and Sonnet 4.6, runs at 200K.

## What reaches Claude Code

Claude Code always runs its own `claude_code` preset prompt. The bridge appends pi's portable parts: project context files, skills (pointing at the bridged `read` tool), a custom prompt, appended instructions, and custom prompt sections from `systemPromptOptions.sections`. It never forwards pi's own harness text: a request carrying it, or both `docs/custom-provider.md` and `docs/packages.md`, is treated by Anthropic as a third-party app (a 400, or Extra Usage billing), so the bridge refuses such a turn with an error naming where it found the text.

| Route                                                 | Reaches Claude Code                                               |
| ----------------------------------------------------- | ----------------------------------------------------------------- |
| `before_agent_start` → `message`                      | Yes, as prompt text in the user turn                              |
| `context` editing the last user message               | Yes, as prompt text                                               |
| `--append-system-prompt`                              | Yes, with the appended instructions                               |
| `context_with_system` editing the system message      | Yes when it wraps pi's prompt; the turn fails when it replaces it |
| `before_agent_start` → `systemPromptOptions.sections` | Yes, one `<name>` block per section                               |
| `before_agent_start` → `systemPrompt`                 | No                                                                |

System-prompt edits must wrap pi's prompt: replacing it leaves nothing to match, and the bridge fails the turn rather than send Claude Code a request without your context files, skills, and instructions.

Claude Code's own `CLAUDE.md`/`AGENTS.md` loading is excluded (pi already sends them), and so are its git-status block, auto-compaction (pi owns compaction), auto-memory, and MCP servers from `~/.claude.json`, `.mcp.json`, and claude.ai (pi serves the tools). `~/.claude/settings.json` hooks still run inside bridge turns; a hook can skip itself with `[ -n "$PI_CODING_AGENT" ] && exit 0`.

## Sessions and caching

Each pi session is mirrored into a Claude Code session file under `~/.claude/projects/` (or `CLAUDE_CONFIG_DIR`). While pi's history only grows, each turn resumes that session and Claude Code's prompt cache stays warm. When the two diverge (an abort, `/compact`, tree navigation, another provider's turn, an API error, or returning to a session), the file is rebuilt from pi's history and the next request usually misses the cache past the system prompt.

Compaction, branch summaries, and other one-off summaries run in a separate Claude Code process without a session. A spent subscription window is reported once and fails the turn as a non-retryable quota error, so pi does not retry a window that resets in hours.

Known limits: files Claude Code edits are not carried across a rebuild (the edit survives as a tool call and result, the post-edit snapshot does not; `@file` expansions are carried), and prompt changes mid-session may not reach the model until a rebuild or a new session.

## Debugging

`CLAUDE_BRIDGE_DEBUG=1` writes a trace to `~/.pi/agent/data/claude-bridge/logs/debug.log` (override with `CLAUDE_BRIDGE_DEBUG_PATH`) and each query's Claude Code CLI log to `logs/cc-cli/` beside it. The trace contains prompts and conversation text and is never rotated; delete it when done. `syncResult:` and `Case N:` lines show each session reuse or rebuild.

## Tests

`vp test --project unit pi/extensions/experimental/claude-bridge` runs the offline suite. The live suite drives real Claude Code with your own login and spends subscription quota, so it only runs on request. pi stays isolated, but Claude Code writes its session files to your real `~/.claude/projects` (or `CLAUDE_CONFIG_DIR`); each test deletes its own afterwards:

```bash
CLAUDE_BRIDGE_LIVE=1 vp test --project integration pi/extensions/experimental/claude-bridge
```
