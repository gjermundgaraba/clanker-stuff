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

Each pi session runs on a Claude Code session file under `~/.claude/projects/` (or `CLAUDE_CONFIG_DIR`). The bridge records which of pi's messages Claude Code holds and compares each request against them by content. When the request is that history plus a new user turn, the turn resumes the session and Claude Code's prompt cache stays warm. Anything else (an abort, a failed turn, `/compact`, tree navigation, an edited message, another provider's turn, a steer that never reached Claude Code, a model, prompt or tool change while a tool runs, a tool call cut off at the output limit, or a pi restart) writes a new session from pi's history and deletes the old one, and the next request usually misses the cache past the system prompt.

One-off requests (compaction and branch summaries, an extension's call without a session, or a call made while a turn runs that does not continue it) run in a temporary Claude Code session of their own under the caller's system prompt, without pi's tools, and leave the running turn alone. A one-off that returns no text fails rather than handing pi an empty summary. A spent subscription window is reported once and fails the turn as a non-retryable quota error, so pi does not retry a window that resets in hours.

Claude Code receives pi's messages as written: an `@file` mention is not expanded and a message starting with `/` is not a Claude Code command, as with any other pi provider.

## Debugging

`CLAUDE_BRIDGE_DEBUG=1` writes a trace to `~/.pi/agent/data/claude-bridge/logs/debug.log` (override with `CLAUDE_BRIDGE_DEBUG_PATH`) and each query's Claude Code CLI log to `logs/cc-cli/` beside it. The trace contains prompts and conversation text and is never rotated; delete it when done. `sync:` lines show what each request did: `deliver` (tool results to the waiting turn), `resume`, `side`, `finish` (a tool result after an abort), or `rebuild reason=none|diverged|tail|changed`. `CLAUDE_BRIDGE_RECORD_STREAM=<path>` appends every SDK message to that file as a JSON line, for capturing replay fixtures of what Claude Code emits.

## Tests

`vp test --project unit pi/extensions/experimental/claude-bridge` runs the offline suite. The live suite drives real Claude Code with your own login and spends subscription quota, so it only runs on request. pi stays isolated, but Claude Code writes its session files to your real `~/.claude/projects` (or `CLAUDE_CONFIG_DIR`); each test deletes its own afterwards:

```bash
CLAUDE_BRIDGE_LIVE=1 vp test --project integration pi/extensions/experimental/claude-bridge
```

## Upstream behavior the bridge relies on

Facts about Claude Code, Agent SDK 0.3.310, pi and XState that the code depends on. Most of the Claude Code ones are observed rather than documented, so an upgrade can break them silently.

- The prompt is a streaming input that stays open for the whole query. Claude Code takes a steer at the next tool boundary only if it reached stdin before the tool result, so the bridge waits until the SDK has written the steer before it releases the result.
- Pi's TypeBox schemas are served verbatim from a raw MCP protocol server. The SDK's `createSdkMcpServer` accepts only Zod, and its round trip drops nested objects, `anyOf` and `const`. Argument validation is left to pi.
- Claude Code drops an MCP tool whose input schema has a top-level `anyOf`, `oneOf` or `allOf`, so the bridge flattens such a schema into one object the way Claude Code's own normalizer does.
- Claude Code stamps each `tools/call` with `_meta["claudecode/toolUseId"]`. It is the only reliable link from a call to its `tool_use` block, since calls need not arrive in block order.
- Claude Code answers a call to a tool it does not serve with "No such tool available" and retries under a fresh id, so such a call must never reach pi.
- `--strict-mcp-config` does not keep claude.ai connectors out; `ENABLE_CLAUDEAI_MCP_SERVERS=0` does.
- 1M context is requested only through the `[1m]` model id suffix. A model not entitled to it fails every turn with a 400 or 429, so only measured models get the suffix.
- `--resume` does not follow records appended as a branch and re-reads the session file on every resume, so a rebuild rewrites the file whole.
- Anthropic rejects thinking signatures it cannot verify, so only thinking blocks Claude Code signed are replayed.
- An image with an unsupported media type or no data fails its request, and every later one once it is in the session, so images are checked on both the prompt and the tool-result path.
- Claude Code streams each API response and then repeats it as one complete `assistant` message; either can carry the content first. A complete message under a new id is the non-streaming fallback after a stalled stream.
- Claude Code reports API failures and quota or context notices as an `assistant` message whose model is `<synthetic>`. It is a report, not model output.
- Claude Code writes a stop reason only on a message's last block.
- `thinking_tokens` in usage is part of `output_tokens`, never an addend to the total or the cost.
- A rate-limit `resetsAt` is in Unix seconds.
- Claude Code finishes writing its session file after its stdin closes; stopping it sooner can cut the file short.
- Some models default to an omitted thinking display. The bridge passes the raw `thinking-display` flag because the typed option would force a thinking mode on every model.
- Pi passes a session id on every agent turn, so a call without one is an extension's one-off. Compaction, branch and bug-report summaries carry `cacheRetention: "none"`.
- XState freezes machine context while pi goes on writing to its own messages, so the conversation keeps copies.
