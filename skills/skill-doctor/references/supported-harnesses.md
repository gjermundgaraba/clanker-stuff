# Supported harnesses

This file is the single source of truth for harness support in `skill-doctor`. Reference it instead of repeating harness lists in `SKILL.md`.

## Startup gate

| Harness | Collector ID | Local conversation source |
| --- | --- | --- |
| Warp | `warp` | Read-only Warp conversation databases |
| Claude Code | `claude` | Project-history JSONL |
| Codex | `codex` | Rollout JSONL |
| Pi | `pi` | Pi agent JSONL (`~/.pi/agent/sessions`) |
| Grok Build | `grok` | Grok Build chat_history JSONL (`~/.grok/sessions`) |
| ZCode | `zcode` | ZCode model-io rollout (`~/.zcode/cli/rollout`) |
| Hermes | `hermes` | Hermes Agent state.db (SQLite: `sessions` + `messages`) |

At startup, identify the harness executing the skill from the runtime context. Do not infer it from conversation files found on disk.

If the executing harness is not listed above, or cannot be identified confidently, stop before creating a report directory or reading conversation history. Tell the user:

> skill-doctor currently supports Warp, Claude Code, Codex, Pi, Grok Build, ZCode, and Hermes. This run appears to be using an unsupported harness, so no conversations were read.

## Collector source selection

- `--harness auto` scans every locally available supported source and is the default.
- `--harness all` also requests every supported source.
- `--harness <collector-id>` restricts collection to one source from the table.
- A report containing one source uses its collector ID in `inventory.json`; a report containing multiple sources uses `mixed`.

Codex messages come from `response_item/message` records; event mirrors do not
add turns. The first session metadata record owns the thread identity. Each
rollout file is a separate source record, including files created by thread
reverts that share a thread ID. The collector does not reconstruct active
context across forks or compaction.

Harness-specific source overrides:

- `--claude-home PATH` — nonstandard Claude Code configuration directory.
- `--codex-home PATH` — nonstandard Codex home.
- `--warp-db PATH` — explicit Warp database; repeatable.
- `--warp-data-dir PATH` — nonstandard Warp channel-data directory.
- `--pi-home PATH` — nonstandard Pi agent home (default `~/.pi/agent`).
- `--grok-home PATH` — nonstandard Grok Build home (default `~/.grok`).
- `--zcode-home PATH` — nonstandard ZCode home (default `~/.zcode`).
- `--hermes-home PATH` — Hermes Agent home containing `state.db` (default discovery checks `HERMES_HOME`, `~/.hermes`, then `~`).

## Skill-use detection

Manual-only skills are included in the installed skill inventory. Loaded
instructions are detected from Codex and Pi's native skill wrappers and Claude
Code's injected metadata messages, even without a separate skill-file read.
Their names survive transcript shortening and are matched against installed
skills after project discovery. A bare command or mention does not establish
that the skill was loaded.

The collector also uses native invocation records and tool-argument references
to skills. Those references can come from inspecting or editing a skill, so
`skills_used` and coverage remain heuristic measures, not proof of adherence.

## Skill locations

Project skills are discovered from:

- `.agents/skills`
- `.claude/skills`
- `.codex/skills`

Global skills are discovered from the corresponding directories under the user's home and configured harness homes when `--include-global-skills` is set: `~/.claude/skills`, `~/.agents/skills`, `~/.codex/skills`, Pi's skill directory under its agent home (default `~/.pi/agent/skills`), Grok Build's `~/.grok/skills`, and ZCode's `~/.zcode/skills`.
