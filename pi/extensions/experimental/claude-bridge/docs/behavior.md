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

Claude Code always runs its own `claude_code` preset prompt. The bridge appends the sections of pi's system prompt that are yours: a custom prompt, appended instructions, project context files, skills, and extension sections from `systemPromptOptions.sections`, in pi's order. A prompt a `before_agent_start` handler replaced outright is forwarded whole. Pi's own sections (its preamble, tool list, rules, documentation routing and cwd) never are; each tool's prompt guidelines reach Claude in that tool's description instead.

Anthropic treats a request carrying pi's preamble, or both `docs/custom-provider.md` and `docs/packages.md`, as a third-party app (a 400, or Extra Usage billing), so the bridge refuses such a turn with an error naming where it found the text, including the context files.

Claude Code runs without its filesystem settings: no `CLAUDE.md`/`AGENTS.md` or rules (pi already sends them), skills, hooks, permissions or `env` from `settings.json`. Its git-status block, auto-compaction (pi owns compaction), auto-memory, and MCP servers from `~/.claude.json`, `.mcp.json`, and claude.ai (pi serves the tools) are off too. Your Claude Code login still applies.

## Sessions and caching

Each pi session runs on a Claude Code session file under `~/.claude/projects/` (or `CLAUDE_CONFIG_DIR`). The bridge records which of pi's messages Claude Code holds and compares each request against them by content. When the request is that history plus a new user turn, the turn resumes the session and Claude Code's prompt cache stays warm. Anything else (an abort, a failed turn, `/compact`, tree navigation, an edited message, another provider's turn, a steer that never reached Claude Code, a model, prompt or tool change while a tool runs, or a pi restart) writes a new session from pi's history and deletes the old one, and the next request usually misses the cache past the system prompt.

One-off requests (compaction and branch summaries, an extension's call without a session, or a call made while a turn runs that does not continue it) run in a temporary Claude Code session of their own under the caller's system prompt, without pi's tools, and leave the running turn alone. A spent subscription window is reported once and fails the turn as a non-retryable quota error, so pi does not retry a window that resets in hours.

Claude Code receives pi's messages as written: an `@file` mention is not expanded and a message starting with `/` is not a Claude Code command, as with any other pi provider.

## Debugging

`CLAUDE_BRIDGE_DEBUG=1` writes a trace to `~/.pi/agent/data/claude-bridge/logs/debug.log` (override with `CLAUDE_BRIDGE_DEBUG_PATH`) and each query's Claude Code CLI log to `logs/cc-cli/` beside it. The trace contains prompts and conversation text and is never rotated; delete it when done. `sync:` lines show what each request did: `deliver` (tool results to the waiting turn), `resume`, `side`, `finish` (a tool result after an abort), or `rebuild reason=none|diverged|tail|changed`.

## Tests

`vp test --project unit pi/extensions/experimental/claude-bridge` runs the offline suite. The live suite drives real Claude Code with your own login and spends subscription quota, so it only runs on request. pi stays isolated, but Claude Code writes its session files to your real `~/.claude/projects` (or `CLAUDE_CONFIG_DIR`); each test deletes its own afterwards:

```bash
CLAUDE_BRIDGE_LIVE=1 vp test --project integration pi/extensions/experimental/claude-bridge
```
