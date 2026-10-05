# Subagents design

The extension hosts independent Pi `AgentSession` children behind one tree per root session. Its tools, prompts, and mailbox envelope are adapted from the Codex V2 collaboration contract pinned in `../UPSTREAM`; Pi owns sessions, providers, permissions, queues, retries, and compaction.

## Tools and addressing

Every agent, including the root, gets six model-only tools: `spawn_agent`, `send_message`, `followup_task`, `wait_agent`, `interrupt_agent`, and `list_agents`. Agents have canonical paths such as `/root/research/tests`; a parent may address a direct child by its task name.

Mail uses the Codex text envelope (`Message Type`, `Task name`, `Sender`, `Payload`):

- `spawn_agent` starts the child with a `NEW_TASK` user turn and returns its path, model, and thinking level.
- `send_message` queues a `MESSAGE` without starting a turn.
- `followup_task` starts a new turn for an idle child or steers a `NEW_TASK` into its current turn, waking the child's pending `wait_agent`. A turn still starting receives the task right after its prompt. A task steered into a turn that settles without reading it, as the transcript shows, starts a turn of its own once the outcome is recorded, unless the agent was interrupted meanwhile; one arriving after the turn ended waits for that outcome the same way. For a child whose last runtime is still closing, it waits until that runtime has released the session file; cancelling the call ends only the wait.
- A finished turn mails `FINAL_ANSWER` (or the Codex error envelope) to its direct parent only. A turn aborted without `interrupt_agent`, such as by a child extension or tool, counts as failed.
- `wait_agent` returns when mail reaches the caller, when new user input reaches it, or at the timeout (10 s to 1 h, default 30 s). Mail that arrived since the previous wait returns at once. It never returns payloads.
- `interrupt_agent` aborts a running turn, marks the agent `interrupted`, and returns its previous status. A late outcome from that turn is ignored.
- `list_agents` lists every agent in the tree with its latest status; a completed status carries the answer cut to 1,000 characters, as does the status `interrupt_agent` returns. `/agents` shows the same tree with models.

Task and message text is limited to 262,144 characters, the length at which a final answer is cut.

`fork_turns` accepts `none`, `all` (default), or a positive integer of recent user turns. Forked history keeps user messages whole, including images, plus final assistant text and compaction summaries, so a child may use any registered provider.

## Children

Each child is an independent session stored under `~/.pi/agent/data/subagents/sessions/`. It inherits the root's cwd, trust decision, provider registrations, runtime credentials, context files, skills, custom and appended system prompts, and active tools as its initial activation. It loads the user's extensions through native discovery, so personal permission policies apply; project extensions load only when trusted. Code Mode, tool search, and MCP load as Pi built-ins, so `-builtin:<name>` settings and replacement extensions apply. The root's own subagents extension is replaced by a bridge that registers the tools for the child's path, and the root-only asynchronous user-interaction tools are excluded.

A role fixes model, reasoning, and instructions; explicit `model` (`provider/model-id`) and `reasoning_effort` apply otherwise; the parent fills the rest. An unknown model lists available models. A child fails to spawn when its model is missing from the child model runtime.

A child's runtime lives only for one turn. After the turn settles, the tree records the outcome and disposes the runtime; a later follow-up reloads the session from its file with the recorded model and thinking level. The concurrency limit counts children that are running or still shutting down. Before a cancelled turn starts its run, the prompt's preflight callback stops it, and the bridge cancels any compaction that would begin afterwards.

## Mail delivery

Every `MESSAGE` and `FINAL_ANSWER` is written to the tree's outbox before delivery and leaves it once the target transcript holds it, so delivery is at least once:

- A running child receives mail as a passive custom message: Pi appends it at once when the session is idle, or at the end of the current turn, so the next request includes it. The child's `message_end` event acknowledges it.
- Mail for a child that is not running waits in the outbox and is appended before its next task.
- The root receives mail through `pi.sendMessage(..., { triggerTurn: false })`, which never starts a turn. The tree acknowledges root mail found in the root transcript after each send, at `turn_start`, at `agent_settled`, and on session start; mail still missing on session start is sent again.

## Persistence

The tree for a root session is one JSON document, `~/.pi/agent/data/subagents/trees-v3/<sha256 of session id>.json`, written on the first mutation by atomic rename with modes `0600` and `0700`. It holds `version: 3`, the agent nodes, and the outbox. An unreadable or invalid document produces a warning and a fresh tree; earlier formats live elsewhere and are never read. Agents recorded as running when the tree is reopened become `interrupted`. Sessions without a file keep their tree in memory, and a forked root session starts with an empty tree. Two Pi processes must not drive the same root session.

The tree lives outside the root transcript because it describes child sessions that exist independently of the root's branch. Stored as session entries, it would revert on `/tree` navigation and be copied into forks, leaving stale trees that point at the same live child session files.

## Configuration

Create `~/.pi/agent/subagents.json`:

```json
{
  "version": 2,
  "delegation": "explicit",
  "max_concurrent_threads_per_session": 3,
  "roles": {
    "researcher": {
      "description": "Investigates a bounded question and reports evidence.",
      "model": "openai/gpt-5.6-luna",
      "thinking": "high",
      "instructions": "Investigate and report evidence."
    }
  }
}
```

`delegation` is `explicit` (spawn only on request; the default) or `proactive`. `agent_type` is offered only when roles exist. Invalid configuration produces a warning and the defaults.

## Differences from Codex

Pi delivers mail at its own turn boundaries rather than between response items, uses explicit `provider/model-id` references across providers, has no tree-wide token budget, and does not reproduce Codex's app-server items, hooks, or residency cache. Statuses cut a completed answer to 1,000 characters rather than repeating it in full, because every listing and tree save would otherwise carry each answer again.
