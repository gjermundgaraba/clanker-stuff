# Codex

## Operator Summary

Primary source: `$CODEX_HOME/sessions` and `$CODEX_HOME/archived_sessions`.

Collect: rollout JSONL files, plus attachment/generated-image sidecars when referenced.

Parse: [../parse/jsonl.md](../parse/jsonl.md).

Ignore first: SQLite indexes, logs, auth/config, and caches unless filling metadata gaps.

Status: verified.

History scope: default-local.

Last verified: local macOS, storage format verified without transcript bodies.

## Sources

| Priority | Location                                                               | Kind   | Authority | Contains                | Parser State  | Collection Policy | Sensitivity |
| -------- | ---------------------------------------------------------------------- | ------ | --------- | ----------------------- | ------------- | ----------------- | ----------- |
| 1        | `$CODEX_HOME/sessions/<date>/rollout-<timestamp>-<session-id>.jsonl`   | JSONL  | primary   | full session stream     | partial       | collect           | private     |
| 1        | `$CODEX_HOME/archived_sessions/rollout-<timestamp>-<session-id>.jsonl` | JSONL  | primary   | archived session stream | partial       | collect           | private     |
| 2        | `$CODEX_HOME/state_*.sqlite`                                           | SQLite | index     | thread metadata         | schema_known  | collect           | private     |
| 3        | `$CODEX_HOME/logs_*.sqlite`                                            | SQLite | log       | app/runtime logs        | metadata_only | ignore_by_default | private     |

## Find

Use `${CODEX_HOME:-$HOME/.codex}`. Active sessions are date-sharded. Archived sessions are flat under `archived_sessions`.

## Fetch

Read selected rollout JSONL directly. Include referenced attachments or generated images only when needed for the question. Use a temporary snapshot outside the repository when stable input is necessary.

## Parse

Check the record's `type` before interpreting its `payload`; retain JSONL order and any available `ordinal`. Known response-item fields from the cited source revision:

| Record                                   | Useful native fields                                                                                                                                                                     |
| ---------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `session_meta`                           | Session identity and provenance in `payload.id`, `timestamp`, `cwd`, `cli_version`; newer formats add lineage/history fields. The first session metadata record identifies this rollout. |
| `response_item` / `message`              | `payload.role`, ordered `payload.content` blocks; `input_text` and `output_text` blocks carry `text`. Message IDs may be absent.                                                         |
| `response_item` / `function_call`        | `name`, `arguments` (JSON string), `call_id`                                                                                                                                             |
| `response_item` / `function_call_output` | `call_id` where present and `output`, which may be structured                                                                                                                            |
| `response_item` / `custom_tool_call`     | `name`, `call_id`, and string `input`; matching output records carry `call_id` and `output`                                                                                              |

Use explicit call IDs for associations. Do not count event mirrors, compaction summaries, or retained context as additional user/assistant messages. Searching historical text is different from reconstructing the active model context. Keep missing IDs/times and opaque media or encrypted blocks unresolved rather than inventing text.

## Source-specific hazards

Auth/config, feedback, and runtime logs are not primary rollout history.

## Gaps

Rollout fields vary by version. The cited revision supports additional lineage and history modes; do not require those fields in older files. Complete active-context reconstruction across compaction/forks and interpretation of every response variant are outside this reading guide.

## Evidence

Previous local storage inspection established paths and structure without transcript bodies. Native-field guidance is checked against OpenAI Codex commit `64b482500d00b331189beefd173a5e08b4060ff2`:

- [Rollout wire format](https://github.com/openai/codex/blob/64b482500d00b331189beefd173a5e08b4060ff2/codex-rs/history/src/rollout_payload.rs#L21) and [line envelope](https://github.com/openai/codex/blob/64b482500d00b331189beefd173a5e08b4060ff2/codex-rs/history/src/lib.rs#L253).
- [Content and response-item types](https://github.com/openai/codex/blob/64b482500d00b331189beefd173a5e08b4060ff2/codex-rs/protocol/src/models.rs#L856).
- [Session metadata](https://github.com/openai/codex/blob/64b482500d00b331189beefd173a5e08b4060ff2/codex-rs/protocol/src/protocol.rs#L3040) and [first-metadata selection](https://github.com/openai/codex/blob/64b482500d00b331189beefd173a5e08b4060ff2/codex-rs/rollout/src/recorder.rs#L1052).
