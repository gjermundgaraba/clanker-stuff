# Claude Code

## Operator Summary

Primary source: `$CLAUDE_CONFIG_DIR/projects` or `$HOME/.claude/projects`.

Collect: project-scoped JSONL transcript files and referenced sidecars.

Parse: [../parse/jsonl.md](../parse/jsonl.md).

Ignore first: history, paste cache, file-history snapshots, shell snapshots, and config unless needed for artifacts.

Status: verified.

History scope: default-local.

Last verified: local macOS, storage format verified without transcript bodies.

## Sources

| Priority | Location                                                         | Kind  | Authority      | Contains           | Parser State  | Collection Policy       | Sensitivity |
| -------- | ---------------------------------------------------------------- | ----- | -------------- | ------------------ | ------------- | ----------------------- | ----------- |
| 1        | `$CLAUDE_BASE/projects/<encoded-cwd>/<session-id>.jsonl`         | JSONL | primary        | session transcript | partial       | collect                 | private     |
| 2        | `$CLAUDE_BASE/projects/<encoded-cwd>/<session-id>/tool-results/` | files | artifact store | large tool outputs | partial       | collect_when_referenced | private     |
| 2        | `$CLAUDE_BASE/projects/<encoded-cwd>/<session-id>/subagents/`    | files | secondary      | subagent state     | partial       | collect_when_referenced | private     |
| 3        | `$CLAUDE_BASE/history.jsonl`                                     | JSONL | prompt history | input history      | metadata_only | ignore_by_default       | private     |

## Find

Resolve:

```sh
CLAUDE_BASE="${CLAUDE_CONFIG_DIR:-$HOME/.claude}"
```

Project directory names encode the working directory. Use `$HOME` placeholders in committed docs.

## Fetch

Read the selected transcript JSONL directly. Follow referenced tool-result or subagent sidecars only when the question needs them. Use a temporary snapshot outside the repository when stable input is necessary.

## Parse

Use native `type`, `uuid`, `parentUuid`, `sessionId`, and `message` fields where present. Do not identify this format by a first-line `type: session` sentinel. The transcript-entry `uuid` and an assistant `message.id` are different identifiers.

For user/assistant records, `message.content` may be a string or ordered blocks. Text blocks carry `type: text` and `text`; tool-use blocks carry `id`, `name`, and `input`; tool-result blocks refer to `tool_use_id` and can include `content` and `is_error`.

For content search, retain each record's provenance without combining branches into one conversation. For a selected conversation, follow `parentUuid` from its main-chain leaf. The cited SDK chooses the latest eligible user/assistant leaf by file position, filtering sidechain, team, and meta leaves. It does not follow `logicalParentUuid` across compaction, which would duplicate context already represented by a compact summary. Use the documented reader when exact reconstruction is needed rather than assuming append order alone is the main chain.

SDK session retrieval is a filtered user/assistant view, not the complete raw log. Subagent linkage may use an `agent-<agent-id>.meta.json` sidecar; do not infer the parent tool call from adjacent records or filenames alone.

## Source-specific hazards

Paste caches, file/shell snapshots, and session environment files are not primary transcripts and may contain unrelated sensitive data.

## Gaps

The cited SDK establishes one main-chain reading strategy. Complete decoding of tool-output sidecars and every internal record variant is not covered here. State whether the answer searched raw records or used a reconstructed/filtered conversation view.

## Evidence

Previous local storage inspection established paths and structure without transcript bodies. Native-field and branch guidance is checked against Anthropic SDK commit `b1b838b1c5730a7a0b270915a79b15861a8ca716`: [raw session reader and reconstruction](https://github.com/anthropics/claude-agent-sdk-python/blob/b1b838b1c5730a7a0b270915a79b15861a8ca716/src/claude_agent_sdk/_internal/sessions.py#L825) and [message block parser](https://github.com/anthropics/claude-agent-sdk-python/blob/b1b838b1c5730a7a0b270915a79b15861a8ca716/src/claude_agent_sdk/_internal/message_parser.py#L95). The SDK envelope is not a universal raw-JSONL schema.
