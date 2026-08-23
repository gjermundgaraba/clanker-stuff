# Codex subagent architecture reference

This document records the upstream application architecture that surrounds the [Codex model-facing contract](codex-model-facing-contract.md). It is descriptive reference material pinned to OpenAI Codex [`12933b69551394328319dcdd1bcee7907326dc85`](https://github.com/openai/codex/tree/12933b69551394328319dcdd1bcee7907326dc85), not the normative Pi contract. Pi behavior is defined by [protocols](protocols.md), and every known match or difference belongs in the [parity ledger](codex-parity.md).

## 1. Control-plane ownership

Codex implements collaboration in core, not in its Responses provider. A tree-scoped `AgentControl` owns:

- the agent registry and parent relationships;
- V1 open-agent accounting;
- V2 execution and runtime-residency limits;
- inter-agent communication;
- durable thread-spawn edges; and
- optional shared rollout-budget accounting.

Each child is still a real independent session with its own model loop, rollout, events, and context. The control plane coordinates those sessions; it does not fold child transcripts into the parent.

Primary sources:

- [`agent/control.rs`](https://github.com/openai/codex/blob/12933b69551394328319dcdd1bcee7907326dc85/codex-rs/core/src/agent/control.rs)
- [`agent/registry.rs`](https://github.com/openai/codex/blob/12933b69551394328319dcdd1bcee7907326dc85/codex-rs/core/src/agent/registry.rs)
- [`thread_manager.rs`](https://github.com/openai/codex/blob/12933b69551394328319dcdd1bcee7907326dc85/codex-rs/core/src/thread_manager.rs)

## 2. Child-session construction

Fresh children clone the parent's effective live configuration, then apply protocol-, role-, model-, effort-, and service-tier-specific changes. Codex preserves the parent's cwd, approval policy, sandbox, permission profile, shell policy, and managed command policy rather than rebuilding those values from disk. The child receives a distinct thread ID and session source carrying its parent identity, path, nickname, role, and depth.

This is application authority, not a portable tool protocol. Pi therefore keeps its own resource loader, project instructions, permissions, credentials, and session representation while matching the observable collaboration behavior it can execute truthfully.

Primary sources:

- [`multi_agents_common.rs`](https://github.com/openai/codex/blob/12933b69551394328319dcdd1bcee7907326dc85/codex-rs/core/src/tools/handlers/multi_agents_common.rs)
- [`agent/role.rs`](https://github.com/openai/codex/blob/12933b69551394328319dcdd1bcee7907326dc85/codex-rs/core/src/agent/role.rs)
- [`protocol.rs`](https://github.com/openai/codex/blob/12933b69551394328319dcdd1bcee7907326dc85/codex-rs/protocol/src/protocol.rs)

The exact fresh, full, and partial history rules are model-visible and are documented in the [model-facing contract](codex-model-facing-contract.md#83-fresh-full-and-partial-history).

## 3. V1 lifecycle architecture

V1 uses UUID-addressed agents and a shared open-agent count. Completion does not release a slot: a completed or errored child remains open until `close_agent`. `send_input` starts an idle child, steers a running child, or interrupts before submitting replacement input. `wait_agent` observes final status, while a separate detached watcher records a completion notification in the immediate parent.

Closing a V1 agent shuts down its currently live descendants and marks the target's durable edge closed. Resuming a missing agent reloads its rollout and then traverses open descendant edges breadth-first. This eager subtree restore is specific to V1.

Primary sources:

- [`agent/control/legacy.rs`](https://github.com/openai/codex/blob/12933b69551394328319dcdd1bcee7907326dc85/codex-rs/core/src/agent/control/legacy.rs)
- [`multi_agents/resume_agent.rs`](https://github.com/openai/codex/blob/12933b69551394328319dcdd1bcee7907326dc85/codex-rs/core/src/tools/handlers/multi_agents/resume_agent.rs)
- [`agent/control/spawn.rs`](https://github.com/openai/codex/blob/12933b69551394328319dcdd1bcee7907326dc85/codex-rs/core/src/agent/control/spawn.rs)

## 4. V2 lifecycle architecture

V2 separates durable identity from loaded runtime state. Canonical task paths, roles, nicknames, and parent edges can remain registered while an inactive runtime is evicted. Triggering work checks execution capacity; loading a runtime also reserves a residency slot. When residency is full, Codex evicts the oldest eligible completed, errored, or interrupted child with no active turn or pending mail.

On resume, Codex restores V2 identity metadata without eagerly loading every rollout. A later message or task can load the target lazily. Consequently, addressability, residency, and `list_agents` visibility are related but not identical concepts.

Primary sources:

- [`agent/control/execution.rs`](https://github.com/openai/codex/blob/12933b69551394328319dcdd1bcee7907326dc85/codex-rs/core/src/agent/control/execution.rs)
- [`agent/control/residency.rs`](https://github.com/openai/codex/blob/12933b69551394328319dcdd1bcee7907326dc85/codex-rs/core/src/agent/control/residency.rs)
- [`multi_agent_resume.rs`](https://github.com/openai/codex/blob/12933b69551394328319dcdd1bcee7907326dc85/codex-rs/core/tests/suite/multi_agent_resume.rs)

## 5. Persistence model

Codex persists collaboration in two complementary forms:

1. rollout/session metadata stores thread identity, source, parent, protocol, path, nickname, role, and history metadata;
2. the `thread_spawn_edges` table stores durable parent-child topology and open or closed edge state.

Runtime and registry entries are caches over that durable information, not the only source of truth. State extraction verifies that embedded session metadata matches the canonical rollout thread ID so a forked parent's metadata cannot be mistaken for the child.

Primary sources:

- [`protocol.rs`](https://github.com/openai/codex/blob/12933b69551394328319dcdd1bcee7907326dc85/codex-rs/protocol/src/protocol.rs)
- [`state/src/extract.rs`](https://github.com/openai/codex/blob/12933b69551394328319dcdd1bcee7907326dc85/codex-rs/state/src/extract.rs)
- [`0021_thread_spawn_edges.sql`](https://github.com/openai/codex/blob/12933b69551394328319dcdd1bcee7907326dc85/codex-rs/state/migrations/0021_thread_spawn_edges.sql)

## 6. Application presentation

Codex exposes child activity and child transcripts through separate paths. Tool activity becomes parent-facing collaboration or subagent activity items, while each child's model events remain attached to that child's app-server thread. The TUI maintains navigation and a bounded status feed rather than copying raw child events into the parent conversation.

V2 children reject direct app-server turn and queue input; their supported input path is the collaboration control plane. V1 children may accept direct app-server input. These are Codex application policies rather than Responses wire requirements.

Primary sources:

- [`event_mapping.rs`](https://github.com/openai/codex/blob/12933b69551394328319dcdd1bcee7907326dc85/codex-rs/app-server-protocol/src/protocol/event_mapping.rs)
- [`turn_processor.rs`](https://github.com/openai/codex/blob/12933b69551394328319dcdd1bcee7907326dc85/codex-rs/app-server/src/request_processors/turn_processor.rs)
- [`agent_navigation.rs`](https://github.com/openai/codex/blob/12933b69551394328319dcdd1bcee7907326dc85/codex-rs/tui/src/app/agent_navigation.rs)

## 7. Hooks, budgets, and security boundary

Thread-spawn sessions can run Codex `SubagentStart` and `SubagentStop` hooks. Internal review, compaction, and memory agents do not use those user-facing hooks. A configured rollout budget is shared across the root and descendants, and reminders are tracked per thread and context-window identity.

Pi does not emulate Codex hooks, rollout-budget state, or backend lineage metadata. The portable invariant is narrower: child configuration must never silently widen cwd, trust, approval, sandbox, network, shell, environment, or managed command-policy boundaries. These unsupported application features stay recorded in the parity ledger so they are not mistaken for accidental matches.

Primary sources:

- [`hook_runtime.rs`](https://github.com/openai/codex/blob/12933b69551394328319dcdd1bcee7907326dc85/codex-rs/core/src/hook_runtime.rs)
- [`rollout_budget.rs`](https://github.com/openai/codex/blob/12933b69551394328319dcdd1bcee7907326dc85/codex-rs/core/src/rollout_budget.rs)
- [`responses_metadata.rs`](https://github.com/openai/codex/blob/12933b69551394328319dcdd1bcee7907326dc85/codex-rs/core/src/responses_metadata.rs)

## 8. What belongs in which document

- Exact model-visible schemas, descriptions, prompts, envelopes, results, and errors: [model-facing contract](codex-model-facing-contract.md).
- Normative Pi behavior and configuration: [protocols](protocols.md).
- Every match, partial match, difference, and unsupported subsystem: [parity ledger](codex-parity.md).
- Provider transport and application boundary: [Codex provider baseline](../../codex-provider/docs/codex-baseline.md).
