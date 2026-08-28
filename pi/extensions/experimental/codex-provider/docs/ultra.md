# How Codex Ultra works

## Result

`ultra` is a Codex client mode, not a distinct inference-backend reasoning level. It combines two behaviors:

1. Inference requests carrying the selected Ultra effort use the backend's `max` reasoning effort.
2. Eligible multi-agent V2 turns receive a developer instruction allowing proactive sub-agent delegation.

The model still decides whether to call `spawn_agent`; there is no deterministic scheduler that automatically splits every task. Codex implements the “automatic task delegation” advertised in the model catalog by changing model-visible policy and exposing the existing collaboration tools.

This distinction is essential for provider parity. Sending `"ultra"` directly in a Responses request does not reproduce Codex Ultra. Sending `"max"` without the multi-agent tools and policy produces Max, not Ultra.

## Research baseline

This document was verified on 2026-08-16 against a clean local checkout of [`openai/codex`](https://github.com/openai/codex) at [`12933b69551394328319dcdd1bcee7907326dc85`](https://github.com/openai/codex/tree/12933b69551394328319dcdd1bcee7907326dc85), authored 2026-08-15 14:25:48 UTC and committed 2026-08-15 14:31:04 UTC. The checkout's `main` matched its local `origin/main` tracking ref. All Codex source links below are pinned to that revision.

The model-facing contract was rechecked on 2026-08-25 against [`origin/main` at `339751715c64496cb86246bfb3935f40e309dd3d`](https://github.com/openai/codex/tree/339751715c64496cb86246bfb3935f40e309dd3d). V2 eligibility logic, policy text, the six collaboration tools, default capacity, and child inheritance were unchanged. That newer bundled catalog also contains two hidden `gpt-daybreak-*` Ultra variants outside this provider's `gpt-5.6-*` model scope; the line-specific evidence below remains pinned to the original audit revision.

The behavior was introduced by [`df1199fddb0c41441b7cd5a1f48bc48514a617dd`](https://github.com/openai/codex/commit/df1199fddb0c41441b7cd5a1f48bc48514a617dd), whose rationale explicitly describes Ultra as maximum reasoning plus proactive multi-agent delegation while retaining `max` at the inference boundary.

## End-to-end flow

| Stage                                 | `max`                                                        | `ultra`                                          |
| ------------------------------------- | ------------------------------------------------------------ | ------------------------------------------------ |
| Selected and persisted effort         | `max`                                                        | `ultra`                                          |
| Outbound Responses `reasoning.effort` | `max`                                                        | `max`                                            |
| Eligible multi-agent V2 mode          | Explicit-request-only, unless customized                     | Proactive, unless customized                     |
| Collaboration tools                   | Available when the thread/model runtime enables them         | Same tools                                       |
| Delegation                            | User, `AGENTS.md`, skill, or custom policy must authorize it | Model may initiate it proactively                |
| Model-call fan-out                    | Normally one active agent                                    | May create multiple concurrent Max-effort agents |

The core decision is equivalent to:

```text
wire_effort = selected_effort == ultra ? max : selected_effort

if multi_agent_version == v2 and session_source_is_eligible:
    mode = configured_or_catalog_hint
        ?? (selected_effort == ultra ? proactive : catalog_explicit_policy)
        ?? explicit_request_only
else:
    mode = none
```

The actual implementation is split between the request-boundary conversion in [`core/src/client.rs`](https://github.com/openai/codex/blob/12933b69551394328319dcdd1bcee7907326dc85/codex-rs/core/src/client.rs#L177-L182) and per-turn mode derivation in [`core/src/session/multi_agents.rs`](https://github.com/openai/codex/blob/12933b69551394328319dcdd1bcee7907326dc85/codex-rs/core/src/session/multi_agents.rs#L145-L185).

## Representation and model support

`ReasoningEffort` has distinct `Max` and `Ultra` variants. Both serialize to lowercase strings, and parsing is forward-compatible: unknown non-empty effort strings become `Custom` values. This type is shared across core, the TUI, app-server, and SDK boundaries. See [`protocol/src/openai_models.rs`](https://github.com/openai/codex/blob/12933b69551394328319dcdd1bcee7907326dc85/codex-rs/protocol/src/openai_models.rs#L41-L140).

Ultra is catalog-advertised, not assumed for every reasoning model. At the researched revision, the bundled catalog advertises it for exactly two models:

| Model           | Default  | Advertised progression                           | Multi-agent runtime |
| --------------- | -------- | ------------------------------------------------ | ------------------- |
| `gpt-5.6-sol`   | `low`    | `low`, `medium`, `high`, `xhigh`, `max`, `ultra` | V2                  |
| `gpt-5.6-terra` | `medium` | `low`, `medium`, `high`, `xhigh`, `max`, `ultra` | V2                  |

For both models, the catalog description is “Maximum reasoning with automatic task delegation.” The Sol metadata is in [`models-manager/models.json`](https://github.com/openai/codex/blob/12933b69551394328319dcdd1bcee7907326dc85/codex-rs/models-manager/models.json#L34-L60); Terra is in the [same file](https://github.com/openai/codex/blob/12933b69551394328319dcdd1bcee7907326dc85/codex-rs/models-manager/models.json#L148-L174).

Clients must use the live `model/list` result when available and preserve the catalog's effort order. `ModelInfo` converts to `ModelPreset` without inventing an ordering, and app-server exposes both the ordered effort options and the model's multi-agent version. See [`protocol/src/openai_models.rs`](https://github.com/openai/codex/blob/12933b69551394328319dcdd1bcee7907326dc85/codex-rs/protocol/src/openai_models.rs#L781-L810) and [`app-server-protocol/src/protocol/v2/model.rs`](https://github.com/openai/codex/blob/12933b69551394328319dcdd1bcee7907326dc85/codex-rs/app-server-protocol/src/protocol/v2/model.rs#L89-L142).

## How Ultra is selected

### Configuration and per-turn state

The durable configuration value is:

```toml
model_reasoning_effort = "ultra"
```

A command-line override can set the same config key with `-c model_reasoning_effort=ultra`. Plan mode has a separate `plan_mode_reasoning_effort` setting, but the effective effort stored in each `TurnContext` is the active collaboration-mode effort for that turn.

The effective effort is the explicit turn value, falling back to the model's catalog default. Ultra mode derivation uses this effective value, not only the global config field. See [`core/src/session/turn_context.rs`](https://github.com/openai/codex/blob/12933b69551394328319dcdd1bcee7907326dc85/codex-rs/core/src/session/turn_context.rs#L284-L294).

### TUI selection

The TUI treats both Max and Ultra as advanced efforts:

- `/model` shows ordinary efforts first and puts Max/Ultra behind `More reasoning…`.
- Keyboard effort-increase shortcuts never cross into Max or Ultra.
- Ultra is described as “For demanding work using multiple agents · highest usage.”
- Selecting Ultra at a configured concurrency of eight or more threads warns that proactive agents can increase usage quickly.

The two-step picker is implemented in [`tui/src/chatwidget/model_popups.rs`](https://github.com/openai/codex/blob/12933b69551394328319dcdd1bcee7907326dc85/codex-rs/tui/src/chatwidget/model_popups.rs#L396-L436) and its [advanced picker](https://github.com/openai/codex/blob/12933b69551394328319dcdd1bcee7907326dc85/codex-rs/tui/src/chatwidget/model_popups.rs#L569-L649). Shortcut behavior is documented in [`reasoning_shortcuts.rs`](https://github.com/openai/codex/blob/12933b69551394328319dcdd1bcee7907326dc85/codex-rs/tui/src/chatwidget/reasoning_shortcuts.rs#L8-L14), and the concurrency warning is in [`model_popups.rs`](https://github.com/openai/codex/blob/12933b69551394328319dcdd1bcee7907326dc85/codex-rs/tui/src/chatwidget/model_popups.rs#L660-L706).

TUI-picked Ultra is deliberately conversation-scoped. The active conversation and Plan-mode effort are both set to Ultra, while a supported non-Ultra effort remains the persisted default for new threads. Leaving Ultra restores the configured conversation/Plan defaults. Resuming an Ultra thread restores Ultra and carries it into Plan mode. See [`tui/src/app/config_persistence.rs`](https://github.com/openai/codex/blob/12933b69551394328319dcdd1bcee7907326dc85/codex-rs/tui/src/app/config_persistence.rs#L763-L843) and [`tui/src/chatwidget/session_flow.rs`](https://github.com/openai/codex/blob/12933b69551394328319dcdd1bcee7907326dc85/codex-rs/tui/src/chatwidget/session_flow.rs#L85-L114).

This conversation-scoped TUI behavior does not prevent an operator from setting `model_reasoning_effort = "ultra"` directly as the default configuration.

### App-server selection

For app-server clients, Ultra is selected through reasoning effort:

- `turn/start.effort: "ultra"` applies to that turn and subsequent turns.
- `thread/settings/update.effort: "ultra"` updates future turns.
- `thread/start.config.model_reasoning_effort` can seed a new thread.
- Resume retains the persisted reasoning effort unless an explicit model/config override disables that fallback.

The deprecated `multiAgentMode` request fields are accepted for compatibility but ignored. Compatibility response fields always report `explicitRequestOnly`; they do not report the effective Ultra-derived mode. The relevant protocol declarations are [`v2/turn.rs`](https://github.com/openai/codex/blob/12933b69551394328319dcdd1bcee7907326dc85/codex-rs/app-server-protocol/src/protocol/v2/turn.rs#L122-L160) and [`v2/thread.rs`](https://github.com/openai/codex/blob/12933b69551394328319dcdd1bcee7907326dc85/codex-rs/app-server-protocol/src/protocol/v2/thread.rs#L218-L267).

## The inference side: Ultra becomes Max

Codex retains `Ultra` in application/session state but converts it to `Max` while building an outbound API request:

```rust
match effort {
    ReasoningEffortConfig::Ultra => ReasoningEffortConfig::Max,
    effort => effort,
}
```

The conversion is centralized in `reasoning_effort_for_request`. Normal HTTP and WebSocket Responses requests both use the shared `build_responses_request`, whose reasoning builder applies the conversion after resolving the explicit effort or model default. See [`core/src/client.rs`](https://github.com/openai/codex/blob/12933b69551394328319dcdd1bcee7907326dc85/codex-rs/core/src/client.rs#L824-L841) and its [request builder](https://github.com/openai/codex/blob/12933b69551394328319dcdd1bcee7907326dc85/codex-rs/core/src/client.rs#L844-L940).

The same conversion is used for:

- standard streamed Responses requests over HTTP;
- streamed and prewarmed Responses requests over WebSocket;
- remote conversation compaction;
- memory summarization.

Compaction reuses the shared request builder at [`core/src/client.rs`](https://github.com/openai/codex/blob/12933b69551394328319dcdd1bcee7907326dc85/codex-rs/core/src/client.rs#L552-L607), while memory summarization applies the converter directly in the [same file](https://github.com/openai/codex/blob/12933b69551394328319dcdd1bcee7907326dc85/codex-rs/core/src/client.rs#L688-L733). A focused test asserts `Ultra -> Max` and leaves other efforts unchanged in [`core/src/client_tests.rs`](https://github.com/openai/codex/blob/12933b69551394328319dcdd1bcee7907326dc85/codex-rs/core/src/client_tests.rs#L290-L299).

Consequences:

- The `reasoning.effort` parameter does not distinguish Ultra from Max. The model can still see the client-injected proactive developer item in the request input.
- Any quality difference in a single agent's model call comes from Max reasoning, not an Ultra-only backend budget.
- Ultra's additional behavior must be implemented by the client-side agent runtime.
- Reasoning summaries, service tier, transport, and context-window rules do not get Ultra-specific values.

## The agent side: Ultra becomes proactive policy

### Eligibility

Ultra derives proactive mode only when the turn's resolved multi-agent version is V2. Version resolution prefers an explicit V2 feature override, then the thread/model runtime, then older feature-derived behavior. New Sol/Terra threads resolve V2 from model metadata. Resumed legacy threads can remain on V1, so choosing Ultra there still maps inference to Max but does not inject the V2 proactive policy. See [`core/src/config/mod.rs`](https://github.com/openai/codex/blob/12933b69551394328319dcdd1bcee7907326dc85/codex-rs/core/src/config/mod.rs#L1468-L1495) and [`core/src/session/mod.rs`](https://github.com/openai/codex/blob/12933b69551394328319dcdd1bcee7907326dc85/codex-rs/core/src/session/mod.rs#L435-L450).

The mode instruction is emitted for root sessions from CLI, VS Code, Exec, MCP, custom, or unknown sources, plus sub-agents created through `ThreadSpawn`. Other internal and sub-agent sources receive no mode instruction. These gates are in [`core/src/session/multi_agents.rs`](https://github.com/openai/codex/blob/12933b69551394328319dcdd1bcee7907326dc85/codex-rs/core/src/session/multi_agents.rs#L145-L185).

### Precedence and overrides

For an eligible V2 turn, mode precedence is:

1. `features.multi_agent_v2.multi_agent_mode_hint_text`, when present.
2. The model catalog's multi-agent mode `hint_text`, when present.
3. `Proactive` when the effective reasoning effort is Ultra.
4. The catalog's explicit-mode text, otherwise `ExplicitRequestOnly`.

A configured or catalog hint is a complete custom policy and overrides Ultra-derived proactive mode. An empty hint is significant: it selects a custom empty policy and suppresses the mode developer message. This is intentional, not a missing-value fallback.

### What the model sees

The built-in proactive message says that proactive multi-agent delegation is active, removes any earlier explicit-user-request restriction, and asks the model to use sub-agents when parallel work would materially improve speed or quality. The non-Ultra built-in message revokes earlier proactive instructions and permits spawning only when the user, `AGENTS.md`, or a skill explicitly requests delegation. See [`core/src/context/multi_agent_mode_instructions.rs`](https://github.com/openai/codex/blob/12933b69551394328319dcdd1bcee7907326dc85/codex-rs/core/src/context/multi_agent_mode_instructions.rs#L6-L47).

This is why delegation is model-driven. Core injects policy; it does not analyze the task and invoke `spawn_agent` itself.

### World-state lifecycle

The effective mode is a world-state section. On the first turn, Codex renders the collaboration usage hint and then the mode as a separate developer item so the mode can override more general hint text. On later turns, it emits a new mode item only when the effective mode or associated usage hint changes. If a previously proactive thread becomes ineligible, Codex emits `ExplicitRequestOnly` to revoke the stale instruction.

The state and transition rules are in [`core/src/context/world_state/multi_agent_mode.rs`](https://github.com/openai/codex/blob/12933b69551394328319dcdd1bcee7907326dc85/codex-rs/core/src/context/world_state/multi_agent_mode.rs#L13-L86). World-state assembly is in [`core/src/session/world_state.rs`](https://github.com/openai/codex/blob/12933b69551394328319dcdd1bcee7907326dc85/codex-rs/core/src/session/world_state.rs#L286-L297), and initial message ordering is in [`core/src/session/mod.rs`](https://github.com/openai/codex/blob/12933b69551394328319dcdd1bcee7907326dc85/codex-rs/core/src/session/mod.rs#L3596-L3639).

## Collaboration tools and spawned agents

Ultra does not register a separate tool set. Multi-agent V2 eligibility registers the normal collaboration surface: `spawn_agent`, `send_message`, `followup_task`, optional `wait_agent`, `interrupt_agent`, and `list_agents`. See [`core/src/tools/spec_plan.rs`](https://github.com/openai/codex/blob/12933b69551394328319dcdd1bcee7907326dc85/codex-rs/core/src/tools/spec_plan.rs#L1132-L1190).

Codex separately supplies root/sub-agent usage instructions describing the team, shared workspace, communication protocol, concurrency slots, and model/effort override rules. These hints are catalog-overridable and are independent of the proactive-versus-explicit mode policy. See [`core/src/session/multi_agents.rs`](https://github.com/openai/codex/blob/12933b69551394328319dcdd1bcee7907326dc85/codex-rs/core/src/session/multi_agents.rs#L11-L58) and its [hint resolver](https://github.com/openai/codex/blob/12933b69551394328319dcdd1bcee7907326dc85/codex-rs/core/src/session/multi_agents.rs#L67-L142).

Spawned agents begin from the parent's effective model and reasoning effort. Therefore an Ultra parent normally creates Ultra children, and eligible V2 `ThreadSpawn` children derive proactive mode for themselves. A requested child model/effort or configured role can override this, and explicit child efforts are validated against the selected child's catalog. See [`multi_agents_common.rs`](https://github.com/openai/codex/blob/12933b69551394328319dcdd1bcee7907326dc85/codex-rs/core/src/tools/handlers/multi_agents_common.rs#L171-L225) and its [override validation](https://github.com/openai/codex/blob/12933b69551394328319dcdd1bcee7907326dc85/codex-rs/core/src/tools/handlers/multi_agents_common.rs#L272-L327).

Ultra does not raise safety or capacity limits. At this revision, V2 defaults to four concurrent threads per session, including the root. The V2 tool path does not use the legacy V1 spawn-depth gate, so nested V2 agents remain able to spawn while shared concurrency permits it. The TUI warning begins at eight total threads; it is a warning threshold, not a runtime limit. Defaults are defined in [`core/src/config/mod.rs`](https://github.com/openai/codex/blob/12933b69551394328319dcdd1bcee7907326dc85/codex-rs/core/src/config/mod.rs#L207-L221) and [`MultiAgentV2Config`](https://github.com/openai/codex/blob/12933b69551394328319dcdd1bcee7907326dc85/codex-rs/core/src/config/mod.rs#L1211-L1255); the V1/V2 tool gate is in [`core/src/tools/spec_plan.rs`](https://github.com/openai/codex/blob/12933b69551394328319dcdd1bcee7907326dc85/codex-rs/core/src/tools/spec_plan.rs#L596-L612).

## Persistence, observability, and usage

Codex persists the selected effort as Ultra in thread/session state so resume, feedback, status, and per-turn mode derivation retain the application-level meaning. The `Ultra -> Max` conversion happens only at inference request construction.

This produces two valid views of the same turn:

| Surface                                                          | Expected value                                |
| ---------------------------------------------------------------- | --------------------------------------------- |
| Thread setting, TUI status, feedback context                     | `ultra`                                       |
| Outbound inference request and request-level inference telemetry | `max`                                         |
| Effective client multi-agent mode                                | `proactive`, when eligible and not overridden |

Request-level telemetry reads the already-converted request effort in [`core/src/client.rs`](https://github.com/openai/codex/blob/12933b69551394328319dcdd1bcee7907326dc85/codex-rs/core/src/client.rs#L184-L195).

Ultra does not define a fixed token multiplier or guaranteed number of sub-agents. Its incremental usage comes from possible fan-out: the root and each child make separate Max-effort model calls. Actual usage depends on whether the model delegates, how many agents it starts, how much context each receives, and configured concurrency/runtime limits. The source supports “highest usage” warnings, but not a universal numeric multiplier.

## Current Pi implementation

Pi 0.84.2 has a closed `ThinkingLevel` union ending at `max`; it has no distinct `ultra` value. See [`packages/ai/src/types.ts`](https://github.com/earendil-works/pi/blob/914cf1472e715297caa30db4b9535d534a9eb718/packages/ai/src/types.ts#L82-L84). The extension therefore keeps Ultra as branch-scoped custom state and uses Pi's `max` only for inference. Native Max remains a separate user choice and continues to send `reasoning.effort: "max"` without enabling proactive delegation.

`/ultra` and `--ultra` are always registered, but activation requires both a live V2 contract from the companion [`subagents`](../../subagents) extension and an eligible selected model. The command toggles branch state; the flag attempts to enable Ultra for the initial CLI session and warns without changing state when activation is unavailable. If current metadata does not already advertise Ultra, a fresh enable attempt performs a targeted `openai-codex` refresh, then rechecks for `multi_agent_version: "v2"` plus both `max` and `ultra` reasoning options. Enabling immediately selects Pi `max`; resume restores branch state, while switching to an ineligible model or selecting a non-Max thinking level disables it. The catalog gate is implemented in [`model-catalog.ts`](../model-catalog.ts), and the branch adapter is in [`ultra/index.ts`](../ultra/index.ts).

### Collaboration ownership and wire contract

The `subagents` extension is the sole owner of the six V2 collaboration tools and child lifecycle:

- `spawn_agent` starts a named child with all, none, or a positive number of inherited user turns.
- `send_message` delivers or queues a message without starting an idle agent.
- `followup_task` queues work for a running child or starts an idle child.
- `wait_agent` waits for mailbox or completion updates.
- `interrupt_agent` aborts a running child but leaves it reusable.
- `list_agents` reports the live nested team tree.

Those tools use closed parameter schemas. The provider groups the active family under the extension-owned `pi_subagents` namespace with `strict: false` on the wire. It does not claim Codex's reserved `collaboration` namespace or encrypted-argument contract, which Pi cannot execute end to end. Ultra neither registers a second family nor removes the V2 tools when disabled.

The packages remain import-independent. On each synchronous session-contract request, the provider publishes whether the current branch is actively Ultra. The V2 controller uses that signal for the root and marks a child for Ultra inheritance when its parent is Ultra, `reasoning_effort` was omitted, and the selected role does not configure reasoning. A fresh child's contract returns that inheritance signal to its provider, which persists the branch state before the first request. An explicit child effort or role-configured reasoning selects native reasoning without inheriting the proactive policy.

### Model-facing policy

The `subagents` extension continues to supply collaboration usage, identity, capability, and configured delegation guidance. Immediately before each Ultra turn, the load-last provider appends one marked proactive-policy block after that guidance. The block removes an earlier explicit-request restriction and allows delegation when parallel work would materially improve speed or quality. Re-applying the hook replaces the marked block instead of duplicating it. Pi has no public developer-message hook, so this uses its effective system prompt; the provider sends that as Responses `instructions`, or as a developer message for Responses Lite.

### Agent runtime

The companion V2 controller hosts the in-process Pi `AgentSession` children, durable hierarchy, mailbox, residency, and concurrency limits documented in its [protocol specification](../../subagents/docs/protocols.md). The default remains three concurrent children in addition to the root, and Ultra does not change capacity or lifecycle rules. Disabling Ultra leaves the latched V2 collaboration surface and existing team intact; it only removes the provider's branch state and proactive policy.

This implementation intentionally has no separate Pi model-picker value, persistent global Ultra default, second collaboration runtime, or catalog-supplied multi-agent prompt override.

## Non-effects and caveats

- Ultra does not select a faster service tier; fast/priority routing remains independent.
- Ultra does not alter approval, sandbox, permission, network, or tool safety policy.
- Ultra does not guarantee delegation or a particular sub-agent count.
- `/ultra` and `--ultra` remain visible for every model, but activation requires current V2 metadata and the companion V2 contract.
- In upstream Codex, Ultra on a V1/disabled multi-agent thread still receives Max inference but no proactive V2 instruction. This extension rejects Ultra unless live metadata advertises V2 support.

## Change history that explains the current design

| Date                     | Change                                                                                                                                                                                                                                                                                | Significance                                                                                                               |
| ------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------- |
| 2026-06-24               | [`#29899`](https://github.com/openai/codex/commit/df1199fddb0c41441b7cd5a1f48bc48514a617dd) added Ultra                                                                                                                                                                               | Made reasoning effort the source of truth, mapped Ultra to backend Max, and deprecated explicit app-server mode selection. |
| 2026-06-29 to 2026-07-13 | [`#30467`](https://github.com/openai/codex/commit/80f54d1266b4571ef649e7e5ecc382dd4e670937), [`#30493`](https://github.com/openai/codex/commit/da4c8ca57d40b074bdc1b5b1218851100150c56b), [`#32822`](https://github.com/openai/codex/commit/4ebc61c0f8df9852e709ff4b477b750fc816a69b) | Made Max first-class, added custom mode hints, and made explicit mode updates override earlier proactive guidance.         |
| 2026-07-08               | [`#31621`](https://github.com/openai/codex/commit/927004c06dc55565af17f0bc8eeb5e35fb990351)                                                                                                                                                                                           | Added the high-concurrency Ultra warning.                                                                                  |
| 2026-07-22 to 2026-08-14 | [`#34845`](https://github.com/openai/codex/commit/0da13c6c993cbb6de3ce88591b316a40cbd411b1), [`#37189`](https://github.com/openai/codex/commit/92b83e226df59dc5ec43a49259d7716821e20c85), [`#38619`](https://github.com/openai/codex/commit/395723b2385cf1314dcf27db4b01a221785109b0) | Moved mode and usage hints into world state and allowed the model catalog to supply multi-agent instructions.              |
