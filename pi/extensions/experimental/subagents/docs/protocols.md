# Subagents design

The extension hosts independent Pi `AgentSession` children behind one tree per root session. Its tools, prompts, and mailbox envelope are adapted from the Codex V2 collaboration contract recorded in [UPSTREAM](../UPSTREAM); Pi owns sessions, providers, permissions, queues, retries, and compaction.

## Tools and addressing

Every agent, including the root, gets six model-only tools: `spawn_agent`, `send_message`, `followup_task`, `wait_agent`, `interrupt_agent`, and `list_agents`. Agents have canonical paths such as `/root/research/tests`; a parent may address a direct child by its task name.

Mail uses the Codex text envelope (`Message Type`, `Task name`, `Sender`, `Payload`):

- `spawn_agent` starts the child with a `NEW_TASK` user turn and returns its path, model, and thinking level.
- `send_message` queues a `MESSAGE` without starting a turn.
- `followup_task` starts a new turn for an idle child or steers a `NEW_TASK` into its current turn, waking the child's pending `wait_agent`. A turn still starting receives the task right after its prompt. A task steered into a turn that settles without reading it, as the transcript shows, starts a turn of its own once the outcome is recorded, unless the agent was interrupted meanwhile; one arriving after the turn ended waits for that outcome the same way. For a child whose last runtime is still closing, it waits until that runtime has released the session file; cancelling the call ends only the wait.
- A finished turn mails `FINAL_ANSWER` (or the Codex error envelope) to its direct parent only. A turn aborted without `interrupt_agent`, such as by a child extension or tool, counts as failed.
- `wait_agent` returns when mail reaches the caller, when new user input reaches it, or at the timeout (10 s to 1 h, default 30 s). Mail that arrived since the previous wait returns at once. It never returns payloads.
- `interrupt_agent` aborts a running turn, marks the agent `interrupted`, and returns its previous status. A late outcome from that turn is ignored.
- `list_agents` lists every agent in the tree with its latest status; a completed status carries the answer cut to 1,000 characters, as does the status `interrupt_agent` returns. The [viewer](#presentation) shows the same tree.

Task and message text is limited to 262,144 characters, the length at which a final answer is cut.

`fork_turns` accepts `none`, `all` (default), or a positive integer of recent user turns. Forked history keeps user messages whole, including images, plus final assistant text and compaction summaries, so a child may use any registered provider. Even `all` omits tool calls/results and intermediate assistant responses; task messages must supply any required findings and decision context.

## Collaboration guidance

Delegate independent work alongside the next local action; keep immediate blockers local. Give workers self-contained tasks with disjoint write scopes and completion criteria, then review their changes. Continue useful independent work or wait for needed results. Keep implementation and verification within the authorized scope, and report changed files, validation and unresolved issues.

Every agent sees the configured tree-wide child-runtime limit, including startup and shutdown occupancy. The root does not consume a slot; a running child does. These limits do not imply free slots. See [delegation and thinking](delegation.md) for branch-local policy, `/proactive`, the one-shot `/ultra` boost, child inheritance and applicable delegation constraints.

## Children

Each child is an independent session stored under `~/.pi/agent/data/subagents/sessions/`. It inherits the root's cwd, trust decision, provider registrations, runtime credentials, context files, skills, custom and appended system prompts, and active tools as its initial activation. It loads the user's extensions through native discovery, so personal permission policies apply; project extensions load only when trusted. Code Mode, tool search, and MCP load as Pi built-ins, so `-builtin:<name>` settings and replacement extensions apply. The root's own subagents extension is replaced by a bridge that registers the tools for the child's path. Children run in print mode. Extensions apply their own mode requirements; TUI-only tools are unavailable. Fast is independently discovered like other extensions, without a child adapter or root-only injection; see [Fast behavior](../../fast/docs/behavior.md).

A role fixes model, reasoning, and instructions; explicit `model` (`provider/model-id`) and `reasoning_effort` apply otherwise. See [child thinking selection](delegation.md#native-thinking) for the effort and inheritance rules. An unknown model lists available models. A child fails to spawn when its model is missing from the child model runtime.

A child's runtime lives only for one turn. After the turn settles, the tree records the outcome and disposes the runtime; a later follow-up reloads the session from its file with the recorded model and thinking level. The concurrency limit is shared across all branches and counts child runtimes starting, running or still shutting down, excluding the root. Before a cancelled turn starts its run, the prompt's preflight callback stops it, and the bridge cancels any compaction that would begin afterwards.

## Mail delivery

Every `MESSAGE` and `FINAL_ANSWER` is written to the tree's outbox before delivery and leaves it once the target transcript holds it, so delivery is at least once:

- A running child receives mail as a passive custom message: Pi appends it at once when the session is idle, or at the end of the current turn, so the next request includes it. The child's `message_end` event acknowledges it.
- Mail for a child that is not running waits in the outbox and is appended before its next task.
- The root receives the same passive mail through `pi.sendMessage(..., { triggerTurn: false })`. The tree acknowledges root mail found in the root transcript after each send, at `turn_start`, at `agent_settled`, and on session start; mail still missing on session start is sent again. Handing a message to Pi is not acknowledgement.

By default, each new child `FINAL_ANSWER` requests an opportunity for the root to handle it. Failed child turns are eligible too. If the root is running and mail arrives after its last request was prepared, `agent_before_settle` requests a native continuation when Pi permits one. Mail already available to a later request needs no extra continuation. An idle root instead receives a batched custom wake; a short internal delay coalesces close completions. The original mail remains the durable payload, and the wake only asks the root to review it. A wake waits for visible mail on the selected branch and defers while an extension dialog or compaction is active. Ordinary `MESSAGE` mail never requests automatic handling.

An automatic-handling opportunity is consumed when Pi prepares a request after the mail is recorded, not merely when a run starts. Compaction and context transforms may omit that mail; the extension respects those projections rather than forcing repeated requests. This tracks a request opportunity, not model understanding or successful provider completion. Durable delivery acknowledgement remains independent. Aborting a root run pauses automatic handling until the next user-started run; an unrelated custom run does not re-enable it. Paused mail still lands and is acknowledged normally. Navigation discards pending opportunities, and session resume/reload re-delivers missing mail passively rather than restarting old work. Shutdown clears the timer.

Wakes and boundary continuations can incur additional model requests. Set `wake_on_final_answer: false` to keep all root mail passive. This setting controls waking, not delegation permission; the resumed model must still follow the selected delegation policy and user instructions.

## Persistence

The tree for a root session is one JSON document, `~/.pi/agent/data/subagents/trees-v4/<sha256 of session id>.json`, written on the first mutation by atomic rename with modes `0600` and `0700`. It holds `version: 4`, the agent nodes, and the outbox, whose final answers record whether their turn failed. Each node records when its latest turn started and ended, and the usage summed over its responses; nodes keep spawn order. An unreadable or invalid document produces a warning and a fresh tree; earlier formats live elsewhere and are never read. Agents recorded as running when the tree is reopened become `interrupted`, with no end time, since when their turn really ended is unknown. Sessions without a file keep their tree in memory, and a forked root session starts with an empty tree. Two Pi processes must not drive the same root session.

The tree lives outside the root transcript because it describes child sessions that exist independently of the root's branch. Stored as session entries, it would revert on `/tree` navigation and be copied into forks, leaving stale trees that point at the same live child session files.

## Presentation

Presentation only reads the tree and never changes what an agent sees. Each child runtime forwards its session events to the tree's monitor, which keeps the current activity of each running child (its latest executing tool call and target, or whether it is thinking, writing, waiting, compacting or retrying after a provider error) and lets a viewer follow one agent's events. Activity lives only as long as the runtime and is not saved.

In TUI mode, a widget above the editor shows the tree while any child runs and disappears as soon as none does. It lists the running agents, those that finished since it appeared, and their ancestors. Each row shows the agent's status, model and thinking level, current activity or outcome, and the time its latest turn took or has taken so far. Running agents spin with a braille dot; while the shape-spinner extension is loaded, they turn its orb instead, in one color per top-level agent that its descendants share, with gray for root. The orbs need shape-spinner's font, which is why they follow its command.

`/agents` and `alt+a` open a read-only overlay. The tree is on the left; on the right, the selected agent's transcript is drawn with Pi's own chat components: its tasks, mail, responses and tool calls, including Pi's recorded tool durations for both live and reopened transcripts. A running agent is read from its live session and then followed through events; any other agent is parsed from its session file without opening it for writing. A transcript that cannot be read or drawn shows the error and is read again at the agent's next turn boundary, the first point where Pi has recorded every message it announced. Each transcript is built once per opening and keeps its scroll position. Transcript lines reach the terminal with only colours and links whose targets hold no controls, so controls in session text cannot act on the terminal; images are described in text, since terminal image protocols cannot draw inside an overlay. A tool keeps the display its live child used for the rest of the process; before a live child has drawn it, Pi's built-in tools and this extension's tools use their own display and other extensions' tools Pi's generic one.

Mail is stored with `display: true`, so the root transcript shows a final answer as a card naming its sender and its recorded outcome, and a message as a short note; the viewer shows a task steered into a running turn the same way. The model receives the same envelope text either way.

## Configuration

Create `~/.pi/agent/subagents.json`:

```json
{
  "version": 2,
  "delegation": "explicit",
  "max_concurrent_threads_per_session": 3,
  "wake_on_final_answer": true,
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

`delegation` supplies the [branch policy fallback](delegation.md#branch-policy). `agent_type` is offered only when roles exist. `wake_on_final_answer` defaults to `true`. Invalid configuration produces a warning and the defaults.

Children run in Pi's process and share its codemode workers. Unless `PI_CODEMODE_MAX_WORKERS` is already set, the first child raises it to `max_concurrent_threads_per_session` + 2, so every child can run a script at once. Each worker may use up to 256 MB.

## Differences from Codex

Pi delivers mail at its own turn boundaries rather than between response items, uses explicit `provider/model-id` references across providers, has no tree-wide token budget, and does not reproduce Codex's app-server items, hooks, or residency cache. Statuses cut a completed answer to 1,000 characters rather than repeating it in full, because every listing and tree save would otherwise carry each answer again.
