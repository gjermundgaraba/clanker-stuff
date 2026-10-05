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

`--tools read,grep,find,ls` enables inspection across built-in/extension/custom tool names. `--no-tools` disables all by default; do not then explicitly enable mutation tools. `--no-builtin-tools` leaves extension/custom tools available and is not equivalent.

`--no-extensions` disables discovery, but explicit `-e` paths still load. `--no-skills` disables skill discovery/loading; check installed help if combining it with explicit skill loading. `--no-context-files` disables AGENTS.md/CLAUDE.md discovery when that is intended. These flags do not create an OS sandbox; extensions themselves may run code during loading.

Use `--approve` only when project-local resources are intended and trusted. It is not a per-tool approval setting. `--no-session` avoids saving the conversation.
