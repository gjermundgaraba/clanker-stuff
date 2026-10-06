# Context and trust

Attach files with `@path`, or pass a successfully collected diff through stdin. Resolve the requested PR's actual base/head first; do not assume `main`. Include all requested changes and disclose context limits. Check collection success before starting the reviewer; an empty valid diff means there are no changes to review, while a collection failure needs diagnosis.

```bash
(
  review_diff=$(mktemp) || exit
  trap 'rm -f "$review_diff"' EXIT
  git diff "$base_ref...$head_ref" -- > "$review_diff" || exit
  if [ ! -s "$review_diff" ]; then
    printf '%s\n' 'No changes to review.'
    exit 0
  fi
  pi -p --no-approve --no-extensions --no-skills --no-session --no-tools \
    --model xai/grok-4.5 --thinking high \
    'Review the supplied diff. Return grounded findings with file/line evidence; do not post comments.' \
    < "$review_diff"
)
```

`--tools` selects declarations across built-in/extension/custom tool names. A nonempty list with no entry starting with `mcp__` retains MCP tools for indirect access according to their exposure: `--tools read,codemode` can still call retained tools with `codemode` or `deferred` exposure from scripts. `tool_search`, if listed, can load those non-direct tools; unmatched direct-exposure MCP tools stay undeclared. Once an entry starts with `mcp__`, the list also filters retained MCP tools, for example `--tools read,codemode,'mcp__radius__*'` keeps only that server's tools.

`--no-tools` disables all by default; do not then explicitly enable mutation tools. `--no-builtin-tools` leaves extension/custom tools available and is not equivalent. `--no-mcp` disables built-in MCP startup for one invocation (no built-in server connections, MCP tools, or `/mcp`), but does not suppress replacement MCP extensions. Check installed help: these MCP controls follow Pi 1.0.4 and older installations may differ.

`--no-extensions` disables discovered, configured, and built-in extensions, but explicit `-e` paths still load. `--no-skills` disables skill discovery/loading; check installed help if combining it with explicit skill loading. `--no-context-files` disables AGENTS.md/CLAUDE.md discovery when that is intended. These flags do not create an OS sandbox; extensions themselves may run code during loading.

Use `--approve` only when project-local resources are intended and trusted. It is not a per-tool approval setting. `--no-session` avoids saving the conversation.
