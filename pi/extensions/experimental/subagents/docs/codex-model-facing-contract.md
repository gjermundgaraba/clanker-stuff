# Codex multi-agent model-facing contract

This document records the collaboration-specific contract presented to models by Codex at commit [`12933b69551394328319dcdd1bcee7907326dc85`](https://github.com/openai/codex/tree/12933b69551394328319dcdd1bcee7907326dc85). It covers the V1 and V2 multi-agent protocols, including tool definitions, developer instructions, child prompt construction, inter-agent messages, tool results, lifecycle markers, and model-visible errors.

This is a descriptive upstream reference, not the normative Pi contract or a license to copy behavior Pi cannot execute. It is the primary evidence for the extension's compatibility objective: portable model-facing behavior should converge on this contract by default. Pi's truthful projection is defined in [protocols](protocols.md), broader upstream architecture is described in the [implementation reference](codex-reference.md), and every known projection difference is tracked in the [parity ledger](codex-parity.md).

The scope is deliberately limited to content selected, generated, or changed by Codex's multi-agent implementation. Ordinary Codex model instructions, project instructions, permission context, and unrelated tool definitions are out of scope except where the multi-agent implementation determines how a child inherits or replaces them.

Quoted prose is verbatim except that Rust source indentation and leading blank lines are normalized. Dynamic substitutions are written as `{name}`.

## 1. Contract overview

Codex has two distinct model-facing protocols ([version selection](https://github.com/openai/codex/blob/12933b69551394328319dcdd1bcee7907326dc85/codex-rs/core/src/session/mod.rs#L435-L450), [tool registration](https://github.com/openai/codex/blob/12933b69551394328319dcdd1bcee7907326dc85/codex-rs/core/src/tools/spec_plan.rs#L1131-L1217)):

| Surface                        | V1                                                                       | V2                                                                                             |
| ------------------------------ | ------------------------------------------------------------------------ | ---------------------------------------------------------------------------------------------- |
| Default namespace              | `multi_agent_v1`                                                         | `collaboration`                                                                                |
| Address exposed by spawn       | Thread UUID                                                              | Canonical task path                                                                            |
| Tools                          | `spawn_agent`, `send_input`, `resume_agent`, `wait_agent`, `close_agent` | `spawn_agent`, `send_message`, `followup_task`, `wait_agent`, `interrupt_agent`, `list_agents` |
| Delegation guidance            | Primarily in `spawn_agent`'s description                                 | Standalone developer messages plus a shorter `spawn_agent` description                         |
| Initial child task             | Normal user input                                                        | `NEW_TASK` inter-agent message                                                                 |
| Completion delivered to parent | User-role `<subagent_notification>`                                      | Structured `FINAL_ANSWER` agent message                                                        |
| Wait semantics                 | Wait for named agents to become final                                    | Wait for mailbox activity or steered user input                                                |
| Targeting                      | UUID only                                                                | Relative path, canonical path, or in-tree UUID fallback                                        |

Codex does **not** define a separate collaboration-specific system prompt. Instead:

- both versions inherit the parent's effective base/model instructions by default;
- V1 relies on its tool description and ordinary child context;
- V2 adds collaboration-specific **developer** messages;
- child developer instructions can be replaced by configuration or a selected role.

The checkout also contains [`core/templates/collab/experimental_prompt.md`](https://github.com/openai/codex/blob/12933b69551394328319dcdd1bcee7907326dc85/codex-rs/core/templates/collab/experimental_prompt.md), but no runtime code references that template at the pinned commit. It is not part of the live model-facing contract.

The inheritance and replacement rules are described in [§8](#8-child-instruction-and-history-construction).

### 1.1 Protocol selection and session inheritance

For a new session without inherited protocol metadata, Codex selects the protocol in this order:

1. enabled `features.multi_agent_v2` forces V2;
2. otherwise `agents_enabled = false` forces `Disabled`;
3. otherwise a model-catalog `multi_agent_version` declaration wins, including `V1`, `V2`, or `Disabled`;
4. otherwise enabled legacy `features.collab` selects V1;
5. otherwise the protocol is `Disabled`.

The V2 feature therefore overrides `agents_enabled = false`. The model declaration is consulted only when neither hard configuration override applies ([selection](https://github.com/openai/codex/blob/12933b69551394328319dcdd1bcee7907326dc85/codex-rs/core/src/config/mod.rs#L1468-L1495)).

The selected catalog or legacy value is stored once for the session. Later model changes reuse that latched value, although the two hard configuration overrides above are reapplied when Codex resolves the effective version ([latch](https://github.com/openai/codex/blob/12933b69551394328319dcdd1bcee7907326dc85/codex-rs/core/src/session/mod.rs#L3372-L3395)).

Spawned children and forks inherit the parent session's selected version, and session metadata persists it for resume. A resumed or forked legacy history with no version metadata defaults to V1. An explicitly inherited `Disabled` version remains disabled ([history resolution](https://github.com/openai/codex/blob/12933b69551394328319dcdd1bcee7907326dc85/codex-rs/core/src/session/mod.rs#L435-L450)).

## 2. Tool exposure and wire placement

### 2.1 Namespaces and member ordering

V1 declares the fixed namespace:

> `multi_agent_v1`

V1's namespace description is:

> Tools for spawning and managing sub-agents.

V2's configured default namespace is:

> `collaboration`

V2 uses the same namespace description:

> Tools for spawning and managing sub-agents.

Sources: [V1 constants](https://github.com/openai/codex/blob/12933b69551394328319dcdd1bcee7907326dc85/codex-rs/core/src/tools/handlers/multi_agents_spec.rs#L14-L22), [V2 default](https://github.com/openai/codex/blob/12933b69551394328319dcdd1bcee7907326dc85/codex-rs/core/src/config/mod.rs#L211-L220), [V2 wrapper](https://github.com/openai/codex/blob/12933b69551394328319dcdd1bcee7907326dc85/codex-rs/core/src/tools/spec_plan.rs#L1301-L1333).

When namespace tools are supported, Codex merges same-named namespaces and sorts their members alphabetically ([source](https://github.com/openai/codex/blob/12933b69551394328319dcdd1bcee7907326dc85/codex-rs/core/src/tools/spec_plan.rs#L817-L861)). The resulting member order is:

- V1: `close_agent`, `resume_agent`, `send_input`, `spawn_agent`, `wait_agent`
- V2: `followup_task`, `interrupt_agent`, `list_agents`, `send_message`, `spawn_agent`, `wait_agent`

When namespace tools are supported, V2 uses its configured namespace string. A custom runtime namespace changes the exposed recipient accordingly. If namespace tools are unavailable, or if the runtime `MultiAgentV2Config.tool_namespace` is `None`, V2 exposes ordinary function tools instead ([registration](https://github.com/openai/codex/blob/12933b69551394328319dcdd1bcee7907326dc85/codex-rs/core/src/tools/spec_plan.rs#L1131-L1165)). The shipped TOML schema accepts only a non-empty namespace string; omitting the field restores `collaboration`, so a namespace-supporting provider does not reach `None` through ordinary TOML configuration ([resolution](https://github.com/openai/codex/blob/12933b69551394328319dcdd1bcee7907326dc85/codex-rs/core/src/config/mod.rs#L2672-L2675), [schema](https://github.com/openai/codex/blob/12933b69551394328319dcdd1bcee7907326dc85/codex-rs/core/config.schema.json#L2026-L2031)).

V1 has no corresponding plain-function fallback: because its direct specs remain namespace specs, Codex filters them from the model-visible tool list when namespace tools are unavailable ([source](https://github.com/openai/codex/blob/12933b69551394328319dcdd1bcee7907326dc85/codex-rs/core/src/tools/spec_plan.rs#L489-L523)).

### 2.2 Standard Responses and Responses Lite

For standard Responses requests, tool definitions are sent in the request's top-level `tools` field. For Responses Lite, collaboration member definitions and their parameter schemas are inserted at the start of model input inside a developer-role `additional_tools` item. Lite can regroup ordinary function and freeform tools into a `functions` namespace, so the serialization and container are not universally identical to Standard Responses ([request placement](https://github.com/openai/codex/blob/12933b69551394328319dcdd1bcee7907326dc85/codex-rs/core/src/client.rs#L844-L896), [Lite conversion](https://github.com/openai/codex/blob/12933b69551394328319dcdd1bcee7907326dc85/codex-rs/tools/src/tool_spec.rs#L82-L149)).

All collaboration function definitions set:

```json
{
  "strict": false
}
```

Their object parameter schemas set `additionalProperties: false`. V2 argument structs also reject unknown fields at runtime. V1's argument structs generally do not, so the advertised V1 schema is stricter than V1's deserializer ([tool specs](https://github.com/openai/codex/blob/12933b69551394328319dcdd1bcee7907326dc85/codex-rs/core/src/tools/handlers/multi_agents_spec.rs#L67-L358), [V1 arguments](https://github.com/openai/codex/blob/12933b69551394328319dcdd1bcee7907326dc85/codex-rs/core/src/tools/handlers/multi_agents/spawn.rs#L236-L246), [V2 arguments](https://github.com/openai/codex/blob/12933b69551394328319dcdd1bcee7907326dc85/codex-rs/core/src/tools/handlers/multi_agents_v2/spawn.rs#L218-L229)).

Codex defines internal output schemas for most collaboration tools, but `ResponsesApiTool.output_schema` is marked `serde(skip)`. Those schemas are therefore absent from ordinary Responses and Responses Lite tool JSON ([source](https://github.com/openai/codex/blob/12933b69551394328319dcdd1bcee7907326dc85/codex-rs/tools/src/responses_api.rs#L31-L44)). The model instead learns output shapes from tool descriptions, returned values, and—when Code Mode applies—generated TypeScript declarations.

### 2.3 Tool search

When tool search is enabled, V1 tools are registered as deferred rather than direct tools. Their search source is:

- name: `Multi-agent tools`
- description: `Spawn and manage sub-agents.`

Each V1 tool supplies one internal search-text string:

| Tool           | Exact search text                                                                                                           |
| -------------- | --------------------------------------------------------------------------------------------------------------------------- |
| `spawn_agent`  | `spawn_agent spawn agent subagent sub-agent delegate delegation parallel work worker explorer no-apps fork model reasoning` |
| `send_input`   | `send_input send message existing agent subagent follow up interrupt redirect queue target`                                 |
| `resume_agent` | `resume_agent resume reopen closed agent subagent thread id target`                                                         |
| `wait_agent`   | `wait_agent wait agent subagent status final result complete timeout targets`                                               |
| `close_agent`  | `close_agent close shutdown stop agent subagent thread status target`                                                       |

These strings are retrieval metadata rather than prose returned in the loaded tool definition, but they affect whether a model query discovers each deferred tool. The loaded result carries the same namespace, tool description, and parameter schema documented below ([shared source](https://github.com/openai/codex/blob/12933b69551394328319dcdd1bcee7907326dc85/codex-rs/core/src/tools/handlers/multi_agents.rs#L30-L71), [per-tool strings](https://github.com/openai/codex/tree/12933b69551394328319dcdd1bcee7907326dc85/codex-rs/core/src/tools/handlers/multi_agents), [exposure selection](https://github.com/openai/codex/blob/12933b69551394328319dcdd1bcee7907326dc85/codex-rs/core/src/tools/spec_plan.rs#L1191-L1215)).

The deferred namespace can also appear in the developer-role `<tools>` world state as:

```text
Deferred tool namespaces:
- multi_agent_v1: Tools for spawning and managing sub-agents.
```

The `<tools>` rendering contract is defined [here](https://github.com/openai/codex/blob/12933b69551394328319dcdd1bcee7907326dc85/codex-rs/core/src/context/world_state/tools.rs#L15-L115).

V2 tools are not deferred by the stock registration path.

### 2.4 Code Mode

V1 uses ordinary `Direct` exposure when it is not deferred. In Code Mode this makes the tools both direct model tools and nested Code Mode tools; in Code-Mode-only sessions they remain only on the nested surface. Namespaced nested names use two underscores, for example:

```text
multi_agent_v1__spawn_agent
```

V2 defaults `non_code_mode_only` to `true`, which registers its tools as `DirectModelOnly`. They remain directly callable but are intentionally absent from the nested `functions.exec`/`tools.*` surface ([V2 defaults](https://github.com/openai/codex/blob/12933b69551394328319dcdd1bcee7907326dc85/codex-rs/core/src/config/mod.rs#L1211-L1255), [exposure](https://github.com/openai/codex/blob/12933b69551394328319dcdd1bcee7907326dc85/codex-rs/core/src/tools/spec_plan.rs#L1131-L1143), [exposure semantics](https://github.com/openai/codex/blob/12933b69551394328319dcdd1bcee7907326dc85/codex-rs/tools/src/tool_executor.rs#L49-L99)).

When a collaboration tool participates in Code Mode, Codex appends this generic suffix to its description:

````text
<original description>

exec tool declaration:
```ts
declare const tools: { <generated typed declaration> };
```
````

Parameter descriptions become TypeScript comments, and an internal output schema becomes the promise return type ([source](https://github.com/openai/codex/blob/12933b69551394328319dcdd1bcee7907326dc85/codex-rs/code-mode-protocol/src/description.rs#L370-L440)).

The generated input object uses the exact property types, requiredness, and descriptions documented in [§4](#4-v1-tool-definitions) and [§5](#5-v2-tool-definitions), sorted alphabetically by property name. Namespace names become a double-underscore prefix in the nested identifier. The exact generated return types are below.

#### V1 Code Mode return types

`multi_agent_v1__spawn_agent`:

```text
{
  // Thread identifier for the spawned agent.
  agent_id: string;
  // User-facing nickname for the spawned agent when available.
  nickname: string | null;
}
```

`multi_agent_v1__send_input`:

```text
{
  // Identifier for the queued input submission.
  submission_id: string;
}
```

`multi_agent_v1__resume_agent`:

```text
{ status: "pending_init" | "running" | "interrupted" | "shutdown" | "not_found" | { completed: string | null; } | { errored: string; }; }
```

`multi_agent_v1__wait_agent`:

```text
{
  // Final statuses keyed by agent id.
  status: { [key: string]: "pending_init" | "running" | "interrupted" | "shutdown" | "not_found" | { completed: string | null; } | { errored: string; }; };
  // Whether the wait call returned due to timeout before any agent reached a final status.
  timed_out: boolean;
}
```

`multi_agent_v1__close_agent`:

```text
{
  // The agent status observed before shutdown was requested.
  previous_status: ("pending_init" | "running" | "interrupted" | "shutdown" | "not_found" | { completed: string | null; } | { errored: string; });
}
```

#### V2 Code Mode return types

V2 has these return types only when configuration exposes it to Code Mode. Namespaced identifiers use the configured namespace, such as `collaboration__spawn_agent`; ordinary-function exposure uses the plain tool name.

`spawn_agent` with hidden metadata:

```text
{
  // Canonical task name for the spawned agent.
  task_name: string;
}
```

`spawn_agent` with visible metadata:

```text
{
  // User-facing nickname for the spawned agent when available.
  nickname: string | null;
  // Canonical task name for the spawned agent.
  task_name: string;
}
```

`send_message` and `followup_task` have no output schema and therefore use:

```text
unknown
```

`wait_agent`:

```text
{
  // Brief wait summary without the agent's final content, including any timeout adjustment.
  message: string;
  // Whether the wait call returned because no mailbox update arrived before the timeout.
  timed_out: boolean;
}
```

`interrupt_agent`:

```text
{
  // The agent status observed before the interrupt request was handled.
  previous_status: ("pending_init" | "running" | "interrupted" | "shutdown" | "not_found" | { completed: string | null; } | { errored: string; });
}
```

`list_agents`:

```text
{
  // Live agents visible in the current root thread tree.
  agents: Array<{
  // Canonical task name for the agent when available, otherwise the agent id.
  agent_name: string;
  // Last known status of the agent.
  agent_status: ("pending_init" | "running" | "interrupted" | "shutdown" | "not_found" | { completed: string | null; } | { errored: string; });
}>;
}
```

The `timeout_ms` input property is rendered as TypeScript `number` because its JSON schema type is `number`. Both V1 and V2 runtime argument structs deserialize it as `i64`, so a fractional JSON number fails argument parsing before timeout clamping or validation ([schemas](https://github.com/openai/codex/blob/12933b69551394328319dcdd1bcee7907326dc85/codex-rs/core/src/tools/handlers/multi_agents_spec.rs#L848-L889), [V1 runtime type](https://github.com/openai/codex/blob/12933b69551394328319dcdd1bcee7907326dc85/codex-rs/core/src/tools/handlers/multi_agents/wait.rs#L274-L278), [V2 runtime type](https://github.com/openai/codex/blob/12933b69551394328319dcdd1bcee7907326dc85/codex-rs/core/src/tools/handlers/multi_agents_v2/wait.rs#L123-L127)).

### 2.5 Protocol, depth, model, and configuration gates

The collaboration surface is registered only when the selected protocol and the current turn pass the following gate ([gate](https://github.com/openai/codex/blob/12933b69551394328319dcdd1bcee7907326dc85/codex-rs/core/src/tools/spec_plan.rs#L596-L612)):

- `Disabled`: no collaboration tools are registered.
- V1: all five V1 tools are registered only when the **next** thread-spawn depth is at most `agent_max_depth`. The stock maximum depth is `1`, so a root can delegate once and a depth-one V1 child receives none of the V1 collaboration tools.
- V2: a session whose `SessionSource` has no `agent_path` receives the V2 tools regardless of its actual model declaration. A session with an `agent_path` receives them only when its actual model declares V2. Current thread-spawned V2 children normally have an `agent_path`; root-like and other pathless sources normally do not.

Within an otherwise enabled V2 surface, `wait_agent_enabled = false` removes only `wait_agent`. `non_code_mode_only` and namespace capability then determine the direct/Code Mode placement described above ([registration](https://github.com/openai/codex/blob/12933b69551394328319dcdd1bcee7907326dc85/codex-rs/core/src/tools/spec_plan.rs#L1131-L1217)).

This gate is independent of the permissive spawn-model picker described in [§3.1](#31-available-model-inventory). A V2 parent can therefore spawn a path-bearing child on an advertised V1 or undeclared model, after which that child receives no collaboration tools. The bundled claim that all agents have the same tools is fixed prose and is not rewritten for this case.

### 2.6 Concurrency, depth, and V2 runtime residency

Stock V1 limits are:

- maximum open spawned agents per session: `6`;
- maximum thread-spawn depth: `1`.

The root is not one of the six spawned-agent slots. A completed V1 agent remains registered, stays open, and consumes its slot until `close_agent` releases it ([defaults](https://github.com/openai/codex/blob/12933b69551394328319dcdd1bcee7907326dc85/codex-rs/core/src/config/mod.rs#L211-L221), [registry accounting](https://github.com/openai/codex/blob/12933b69551394328319dcdd1bcee7907326dc85/codex-rs/core/src/agent/registry.rs#L80-L115)).

Stock V2 maximum concurrency is `4` agents **including the root**. Codex derives a child execution and residency capacity of `max_concurrent_threads_per_session - 1`, so the stock root tree has three resident child slots ([derivation](https://github.com/openai/codex/blob/12933b69551394328319dcdd1bcee7907326dc85/codex-rs/core/src/config/mod.rs#L1497-L1510)). The usage hint in [§6.3](#63-shared-appended-text) exposes the configured total, not the number of currently free slots.

When V2 needs a child slot, it can unload the least-recently-used resident child whose status is `Completed`, `Errored`, or `Interrupted`, provided the child has no active turn and no pending mailbox input. Codex first materializes its rollout, shuts down the runtime, and removes the runtime from the thread manager while leaving the agent identity registered ([residency](https://github.com/openai/codex/blob/12933b69551394328319dcdd1bcee7907326dc85/codex-rs/core/src/agent/control/residency.rs#L48-L150), [eligibility](https://github.com/openai/codex/blob/12933b69551394328319dcdd1bcee7907326dc85/codex-rs/core/src/agent/control/residency.rs#L217-L232)). If no resident can be unloaded, spawn or reload returns the ordinary agent-thread-limit error.

Registered unloaded identities remain path-addressable, but successful lazy reload requires stored history that identifies the session as V2. If that history is absent or unsuitable, reload returns thread-not-found. While unloaded, the identity is omitted from `list_agents` ([reload](https://github.com/openai/codex/blob/12933b69551394328319dcdd1bcee7907326dc85/codex-rs/core/src/agent/control/spawn.rs#L257-L292)).

## 3. Shared dynamic prose in `spawn_agent`

Both versions can add model and role inventories to `spawn_agent`.

### 3.1 Available-model inventory

Codex selects at most five picker-visible models using a permissive protocol filter. V1 accepts every available model. V2 excludes only models explicitly declared `Disabled`; it still accepts models declared V1 or having no declaration ([filter](https://github.com/openai/codex/blob/12933b69551394328319dcdd1bcee7907326dc85/codex-rs/core/src/tools/handlers/multi_agents_common.rs#L36-L42)). If none qualify, the exact text is:

> No picker-visible model overrides are currently loaded.

Otherwise the exact format is:

```text
Available model overrides (optional; inherited parent model is preferred):
- `{model}`: {description} Reasoning efforts: {effort_a}, {effort_b} (default). Service tiers: {tier_a}, {tier_b}.
```

The reasoning-effort and service-tier sentences are independently omitted when their corresponding lists are empty. Each reasoning-effort label is truncated to 64 characters before display. The model list is included:

- in V1 unless spawn metadata options are hidden;
- in V2 only when spawn model overrides are exposed.

Source: [`spawn_agent_models_description`](https://github.com/openai/codex/blob/12933b69551394328319dcdd1bcee7907326dc85/codex-rs/core/src/tools/handlers/multi_agents_spec.rs#L781-L846).

The same filter validates an explicit `model` argument. Picker visibility limits only the displayed inventory: an exact available model can be accepted even when it is hidden from the picker. Because the V2 filter does not require a V2 declaration, successful spawn-model validation does not imply that the child will receive V2 collaboration tools; the separate child gate is documented in [§2.5](#25-protocol-depth-model-and-configuration-gates) ([runtime lookup](https://github.com/openai/codex/blob/12933b69551394328319dcdd1bcee7907326dc85/codex-rs/core/src/tools/handlers/multi_agents_common.rs#L431-L455)).

The optional inherited-model sentence is:

> Spawned agents inherit your current model by default. Omit `model` to use that preferred default; set `model` only when an explicit override is needed.

V1 includes it whenever spawn model/role metadata is not hidden. V2 includes it only when model overrides are exposed **and** spawn metadata is not hidden. The stock V2 configuration hides spawn metadata, so its default `spawn_agent` description includes the model inventory but not this sentence ([assembly](https://github.com/openai/codex/blob/12933b69551394328319dcdd1bcee7907326dc85/codex-rs/core/src/tools/handlers/multi_agents_spec.rs#L67-L145)).

The inherited-model sentence describes the preferred policy, not the full runtime precedence. Configured default-subagent overrides or a selected role can replace the parent model and reasoning effort even when the call omits those fields. The complete order is in [§8.4](#84-role-model-effort-provider-and-service-tier-precedence).

### 3.2 Available-role inventory

The `agent_type` parameter is advertised only when at least one user-defined agent role is configured. When it is advertised, its description includes all configured roles followed by built-in roles not shadowed by the configured names ([exposure](https://github.com/openai/codex/blob/12933b69551394328319dcdd1bcee7907326dc85/codex-rs/core/src/tools/spec_plan.rs#L1144-L1161), [formatting](https://github.com/openai/codex/blob/12933b69551394328319dcdd1bcee7907326dc85/codex-rs/core/src/agent/role.rs#L295-L377)).

The exact outer format is:

```text
Available roles:
{name}: {
{description}
{optional locked-setting notes}
}
{name_without_description}: no description
```

Configured roles are sorted by name because they are stored in a `BTreeMap`. Built-ins are then emitted in sorted order.

Possible locked-setting notes are:

```text
- This role's model is set to `{model}` and its reasoning effort is set to `{reasoning_effort}`. These settings cannot be changed.
- This role's model is set to `{model}` and cannot be changed.
- This role's reasoning effort is set to `{reasoning_effort}` and cannot be changed.
- This role's service tier is set to `{service_tier}`. If it is supported by the resolved model, it takes precedence over a valid spawn request service tier.
```

The built-in descriptions are:

#### `default`

```text
Default agent.
```

#### `explorer`

```text
Use `explorer` for specific codebase questions.
Explorers are fast and authoritative.
They must be used to ask specific, well-scoped questions on the codebase.
Rules:
- In order to avoid redundant work, you should avoid exploring the same problem that explorers have already covered. Typically, you should trust the explorer results without additional verification. You are still allowed to inspect the code yourself to gain the needed context!
- You are encouraged to spawn up multiple explorers in parallel when you have multiple distinct questions to ask about the codebase that can be answered independently. This allows you to get more information faster without waiting for one question to finish before asking the next. While waiting for the explorer results, you can continue working on other local tasks that do not depend on those results. This parallelism is a key advantage of delegation, so use it whenever you have multiple questions to ask.
- Reuse existing explorers for related questions.
```

#### `worker`

```text
Use for execution and production work.
Typical tasks:
- Implement part of a feature
- Fix tests or bugs
- Split large refactors into independent chunks
Rules:
- Explicitly assign **ownership** of the task (files / responsibility). When the subtask involves code changes, you should clearly specify which files or modules the worker is responsible for. This helps avoid merge conflicts and ensures accountability. For example, you can say "Worker 1 is responsible for updating the authentication module, while Worker 2 will handle the database layer." By defining clear ownership, you can delegate more effectively and reduce coordination overhead.
- Always tell workers they are **not alone in the codebase**, and they should not revert the edits made by others, and they should adjust their implementation to accommodate the changes made by others. This is important because there may be multiple workers making changes in parallel, and they need to be aware of each other's work to avoid conflicts and ensure a cohesive final product.
```

Source: [built-in declarations](https://github.com/openai/codex/blob/12933b69551394328319dcdd1bcee7907326dc85/codex-rs/core/src/agent/role.rs#L380-L423).

These role descriptions instruct the **calling model** how to choose a role. They are not automatically repeated to the child. The selected role instead applies a configuration layer, which may independently set base instructions or developer instructions. At the pinned commit, `default` and `worker` have no role config file, while the built-in `explorer.toml` is empty, so the three active built-in roles add no fixed child-facing prose of their own ([role declarations](https://github.com/openai/codex/blob/12933b69551394328319dcdd1bcee7907326dc85/codex-rs/core/src/agent/role.rs#L380-L423), [`explorer.toml`](https://github.com/openai/codex/blob/12933b69551394328319dcdd1bcee7907326dc85/codex-rs/core/src/agent/builtins/explorer.toml)).

### 3.3 Nickname generation

Every normal V1 or V2 thread-spawn reserves a user-facing nickname before the child is committed to the shared agent registry. The default pool contains 101 names loaded from [`agent_names.txt`](https://github.com/openai/codex/blob/12933b69551394328319dcdd1bcee7907326dc85/codex-rs/core/src/agent/agent_names.txt). A selected role can replace that pool with its configured `nickname_candidates` ([candidate selection](https://github.com/openai/codex/blob/12933b69551394328319dcdd1bcee7907326dc85/codex-rs/core/src/agent/control/spawn.rs#L11-L49)).

For an ordinary new spawn, Codex:

1. formats every candidate for the current pool generation;
2. removes names that have already been reserved by the shared registry;
3. randomly chooses one remaining candidate;
4. records it in the child's `AgentMetadata`.

When a non-empty pool has no unused candidate, Codex clears the used-name set, increments the pool generation, and randomly chooses a candidate with an ordinal suffix. The first reset produces names such as:

> Plato the 2nd

Later resets produce `the 3rd`, `the 4th`, and so on, with `11th` through `13th` handled specially ([reservation and reset](https://github.com/openai/codex/blob/12933b69551394328319dcdd1bcee7907326dc85/codex-rs/core/src/agent/registry.rs#L45-L61), [selection](https://github.com/openai/codex/blob/12933b69551394328319dcdd1bcee7907326dc85/codex-rs/core/src/agent/registry.rs#L205-L241)).

Validated role configuration rejects an empty candidate list, blank names, duplicate names, and characters outside ASCII letters, digits, spaces, hyphens, and underscores. With the bundled or any valid configured pool, nickname reservation therefore returns a string. The internal result schemas remain nullable, but a normal successful production thread-spawn does not return `null` for `nickname` ([configuration validation](https://github.com/openai/codex/blob/12933b69551394328319dcdd1bcee7907326dc85/codex-rs/core/src/config/agent_roles.rs#L418-L460), [spawn metadata](https://github.com/openai/codex/blob/12933b69551394328319dcdd1bcee7907326dc85/codex-rs/core/src/agent/control.rs#L604-L628)).

The fixed error:

> no available agent nicknames

is returned when reservation receives no usable candidate. Through ordinary validated configuration this would require a nonstandard or programmatically constructed empty runtime pool ([error](https://github.com/openai/codex/blob/12933b69551394328319dcdd1bcee7907326dc85/codex-rs/core/src/agent/registry.rs#L304-L317)).

## 4. V1 tool definitions

All V1 tools live in the `multi_agent_v1` namespace. The complete specs are constructed in [`multi_agents_spec.rs`](https://github.com/openai/codex/blob/12933b69551394328319dcdd1bcee7907326dc85/codex-rs/core/src/tools/handlers/multi_agents_spec.rs#L67-L100).

The sections below call these specs “complete” in the advertised-schema sense. For rich `items`, every per-item field is optional and `type` is a free string in that schema; runtime `UserInput` deserialization supplies the actual variant combinations and constraints. Schema completeness therefore does not imply that every schema-admitted item executes successfully.

### 4.1 `spawn_agent`

The description begins with the optional model inventory from [§3.1](#31-available-model-inventory), then:

```text
Spawn a sub-agent for a well-scoped task. Returns the spawned agent id plus the user-facing nickname when available. Spawned agents inherit your current model by default. Omit `model` to use that preferred default; set `model` only when an explicit override is needed.
```

If `usage_hint_text` is configured, Codex appends that text verbatim and omits the bundled policy below.

Otherwise Codex appends this exact policy:

```text
This spawn_agent tool provides you access to sub-agents that inherit your current model by default. Do not set the `model` field unless the user explicitly asks for a different model or there is a clear task-specific reason. You should follow the rules and guidelines below to use this tool.

Do not spawn sub-agents unless the user or applicable AGENTS.md/skill instructions explicitly ask for sub-agents, delegation, or parallel agent work.
Requests for depth, thoroughness, research, investigation, or detailed codebase analysis do not count as permission to spawn.
{agent_role_authorization_sentence}

### When to delegate vs. do the subtask yourself
- First, quickly analyze the overall user task and form a succinct high-level plan. Identify which tasks are immediate blockers on the critical path, and which tasks are sidecar tasks that are needed but can run in parallel without blocking the next local step. As part of that plan, explicitly decide what immediate task you should do locally right now. Do this planning step before delegating to agents so you do not hand off the immediate blocking task to a submodel and then waste time waiting on it.
- Use a subagent when a subtask is easy enough for it to handle and can run in parallel with your local work. Prefer delegating concrete, bounded sidecar tasks that materially advance the main task without blocking your immediate next local step.
- Do not delegate urgent blocking work when your immediate next step depends on that result. If the very next action is blocked on that task, the main rollout should usually do it locally to keep the critical path moving.
- Keep work local when the subtask is too difficult to delegate well and when it is tightly coupled, urgent, or likely to block your immediate next step.

### Designing delegated subtasks
- Subtasks must be concrete, well-defined, and self-contained.
- Delegated subtasks must materially advance the main task.
- Do not duplicate work between the main rollout and delegated subtasks.
- Avoid issuing multiple delegate calls on the same unresolved thread unless the new delegated task is genuinely different and necessary.
- Narrow the delegated ask to the concrete output you need next.
- For coding tasks, prefer delegating concrete code-change worker subtasks over read-only explorer analysis when the subagent can make a bounded patch in a clear write scope.
- When delegating coding work, instruct the submodel to edit files directly in its forked workspace and list the file paths it changed in the final answer.
- For code-edit subtasks, decompose work so each delegated task has a disjoint write set.

### After you delegate
- Call wait_agent very sparingly. Only call wait_agent when you need the result immediately for the next critical-path step and you are blocked until it returns.
- Do not redo delegated subagent tasks yourself; focus on integrating results or tackling non-overlapping work.
- While the subagent is running in the background, do meaningful non-overlapping work immediately.
- Do not repeatedly wait by reflex.
- When a delegated coding task returns, quickly review the uploaded changes, then integrate or refine them.

### Parallel delegation patterns
- Run multiple independent information-seeking subtasks in parallel when you have distinct questions that can be answered independently.
- Split implementation into disjoint codebase slices and spawn multiple agents for them in parallel when the write scopes do not overlap.
- Delegate verification only when it can run in parallel with ongoing implementation and is likely to catch a concrete risk before final integration.
- The key is to find opportunities to spawn multiple independent subtasks in parallel within the same round, while ensuring each subtask is well-defined, self-contained, and materially advances the main task.
```

`{agent_role_authorization_sentence}` is either empty or:

> Agent-role guidance below only helps choose which agent to use after spawning is already authorized; it never authorizes spawning by itself.

Codex includes that sentence whenever the model-inventory section is present, including when the inventory says no picker-visible overrides are loaded.

Source: [`spawn_agent_tool_description`](https://github.com/openai/codex/blob/12933b69551394328319dcdd1bcee7907326dc85/codex-rs/core/src/tools/handlers/multi_agents_spec.rs#L682-L747).

Parameters:

| Property           | Required by schema                              | Model-facing description                                                                                                                                                |
| ------------------ | ----------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `message`          | No                                              | `Initial plain-text task for the new agent. Use either message or items.`                                                                                               |
| `items`            | No                                              | `Structured input items. Use this to pass explicit mentions (for example app:// connector paths).`                                                                      |
| `agent_type`       | No; field omitted unless configured roles exist | `Agent type override for the new agent. Omit to inherit the parent agent type with a full-history fork; otherwise, \`default\` is used.` followed by the role inventory |
| `fork_context`     | No                                              | `True forks the current thread history into the new agent; false or omitted starts with only the initial prompt.`                                                       |
| `model`            | No                                              | `Model override for the new agent. Omit unless an explicit override is needed.`                                                                                         |
| `reasoning_effort` | No                                              | `Reasoning effort override for the new agent. Omit to inherit the parent effort.`                                                                                       |
| `service_tier`     | No                                              | `Service tier override for the new agent. Omit unless explicitly requested.`                                                                                            |

The schema marks no property as required, but runtime requires exactly one of `message` or `items`.

Each `items` entry is an object with `additionalProperties: false` and these optional schema properties:

| Property    | Description                                                                                                                                                                     |
| ----------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `type`      | `Input item type: text, image, local_image, audio, local_audio, skill, or mention.`                                                                                             |
| `text`      | `Text content when type is text.`                                                                                                                                               |
| `image_url` | `Image URL when type is image.`                                                                                                                                                 |
| `audio_url` | `Audio data URL when type is audio.`                                                                                                                                            |
| `path`      | `Path when type is local_image/local_audio/skill, or structured mention target such as app://<connector-id> or plugin://<plugin-name>@<marketplace-name> when type is mention.` |
| `name`      | `Display name when type is skill or mention.`                                                                                                                                   |

Source: [V1 parameters](https://github.com/openai/codex/blob/12933b69551394328319dcdd1bcee7907326dc85/codex-rs/core/src/tools/handlers/multi_agents_spec.rs#L546-L629).

### 4.2 `send_input`

Description:

> Send a message to an existing agent. Use interrupt=true to redirect work immediately. You should reuse the agent by send_input if you believe your assigned task is highly dependent on the context of a previous task.

Parameters:

| Property    | Required | Description                                                                                          |
| ----------- | -------- | ---------------------------------------------------------------------------------------------------- |
| `target`    | Yes      | `Agent id to message (from spawn_agent).`                                                            |
| `message`   | No       | `Legacy plain-text message to send to the agent. Use either message or items.`                       |
| `items`     | No       | Same structured-item schema as `spawn_agent`                                                         |
| `interrupt` | No       | `True interrupts the current task and handles this message immediately; false or omitted queues it.` |

Runtime requires exactly one of `message` or `items`.

Source: [`create_send_input_tool_v1`](https://github.com/openai/codex/blob/12933b69551394328319dcdd1bcee7907326dc85/codex-rs/core/src/tools/handlers/multi_agents_spec.rs#L148-L184).

### 4.3 `resume_agent`

Description:

> Resume a previously closed agent by id so it can receive send_input and wait_agent calls.

Required parameter:

| Property | Description           |
| -------- | --------------------- |
| `id`     | `Agent id to resume.` |

Source: [`create_resume_agent_tool`](https://github.com/openai/codex/blob/12933b69551394328319dcdd1bcee7907326dc85/codex-rs/core/src/tools/handlers/multi_agents_spec.rs#L247-L267).

### 4.4 `wait_agent`

Description:

> Wait for agents to reach a final status. Completed statuses may include the agent's final message. Returns empty status when timed out. Once the agent reaches a final status, a notification message will be received containing the same completed status.

Parameters:

| Property     | Required | Description                                                                                                                  |
| ------------ | -------- | ---------------------------------------------------------------------------------------------------------------------------- |
| `targets`    | Yes      | `Agent ids to wait on. Pass multiple ids to wait for whichever finishes first.`                                              |
| `timeout_ms` | No       | `Timeout in milliseconds. Defaults to {default}, min {min}, max {max}. Prefer longer waits (minutes) to avoid busy polling.` |

The stock values are:

- default: `30000`
- minimum: `10000`
- maximum: `3600000`

At runtime, an omitted value uses the default. Zero and negative values return `timeout_ms must be greater than zero`. Every positive value is silently clamped into the stock minimum/maximum range: values below `10000` become `10000`, and values above `3600000` become `3600000`. Unlike V2, V1 does not reject an above-maximum request and does not report that clamping occurred ([runtime](https://github.com/openai/codex/blob/12933b69551394328319dcdd1bcee7907326dc85/codex-rs/core/src/tools/handlers/multi_agents/wait.rs#L89-L97)).

The advertised JSON type is `number`, but runtime deserializes `timeout_ms` as `i64`. Fractional values fail generic argument parsing before the positive-value check or clamping.

Source: [`create_wait_agent_tool_v1`](https://github.com/openai/codex/blob/12933b69551394328319dcdd1bcee7907326dc85/codex-rs/core/src/tools/handlers/multi_agents_spec.rs#L269-L283), [parameters](https://github.com/openai/codex/blob/12933b69551394328319dcdd1bcee7907326dc85/codex-rs/core/src/tools/handlers/multi_agents_spec.rs#L848-L874).

### 4.5 `close_agent`

Description:

> Close an agent and any open descendants when they are no longer needed, and return the target agent's previous status before shutdown was requested. Completed agents remain open and count toward the concurrency limit until closed. Don't keep agents open for too long if they are not needed anymore.

Required parameter:

| Property | Description                             |
| -------- | --------------------------------------- |
| `target` | `Agent id to close (from spawn_agent).` |

Source: [`create_close_agent_tool_v1`](https://github.com/openai/codex/blob/12933b69551394328319dcdd1bcee7907326dc85/codex-rs/core/src/tools/handlers/multi_agents_spec.rs#L318-L338).

### 4.6 V1 UUID target scope

V1 tool handlers parse UUID targets directly and do not verify that the target belongs to the caller's root tree ([parser](https://github.com/openai/codex/blob/12933b69551394328319dcdd1bcee7907326dc85/codex-rs/core/src/tools/handlers/multi_agents.rs#L39-L58)). They then address the process-local thread manager by that UUID. Consequently, a known live UUID is effectively a process-local capability for `send_input`, `wait_agent`, and `close_agent`; the resume path can similarly attempt to reopen a known stored UUID. The normal source of these UUIDs is the caller's own `spawn_agent` result, but ancestry is not a runtime validation rule.

## 5. V2 tool definitions

The stock V2 tool profile has these notable defaults:

- namespace: `collaboration`
- `hide_spawn_agent_metadata = true`
- `expose_spawn_agent_model_overrides = true`
- `wait_agent_enabled = true`
- `non_code_mode_only = true`

Consequently, stock `spawn_agent` exposes `task_name`, `message`, `fork_turns`, `model`, and `reasoning_effort`; it omits `agent_type` unless user roles exist and omits `service_tier` while spawn metadata is hidden ([defaults](https://github.com/openai/codex/blob/12933b69551394328319dcdd1bcee7907326dc85/codex-rs/core/src/config/mod.rs#L1211-L1255), [registration](https://github.com/openai/codex/blob/12933b69551394328319dcdd1bcee7907326dc85/codex-rs/core/src/tools/spec_plan.rs#L1131-L1190)).

### 5.1 `spawn_agent`

The description begins with the optional model inventory from [§3.1](#31-available-model-inventory), then:

```text
Spawns an agent to work on the specified task. If your current task is `/root/task1` and you spawn_agent with task_name "task_3" the agent will have canonical task name `/root/task1/task_3`.
You are then able to refer to this agent as `task_3` or `/root/task1/task_3` interchangeably. However an agent `/root/task2/task_3` would only be able to communicate with this agent via its canonical name `/root/task1/task_3`.
The spawned agent will have the same tools as you and the ability to spawn its own subagents.
{inherited_model_guidance}
Only call this tool for a concrete, bounded subtask that can run independently alongside useful local work; otherwise continue locally.
It will be able to send you and other running agents messages, and its final answer will be provided to you when it finishes.
The new agent's canonical task name will be provided to it along with the message.

Note that passing `fork_turns="none"` will not pass any surrounding context to the spawned subagent, which may cause the agent to lack the context it needs to complete its task, whereas `fork_turns="all"` will provide the subagent with all surrounding context.
```

`{inherited_model_guidance}` is either empty or:

> Spawned agents inherit your current model by default. Omit `model` to use that preferred default; set `model` only when an explicit override is needed.

If `usage_hint_text` is configured, Codex appends it verbatim after the quoted description. Unlike V1, there is no longer bundled policy that it replaces.

Source: [`spawn_agent_tool_description_v2`](https://github.com/openai/codex/blob/12933b69551394328319dcdd1bcee7907326dc85/codex-rs/core/src/tools/handlers/multi_agents_spec.rs#L749-L779).

Parameters:

| Property           | Required by schema                              | Model-facing description                                                                                                                                                            |
| ------------------ | ----------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `task_name`        | Yes                                             | `Task name for the new agent. Use lowercase letters, digits, and underscores.`                                                                                                      |
| `message`          | Yes                                             | `Initial plain-text task for the new agent.`                                                                                                                                        |
| `agent_type`       | No; field omitted unless configured roles exist | `Agent type override for the new agent. Omit unless explicitly asked. The selected role applies regardless of how much parent history is inherited.` followed by the role inventory |
| `fork_turns`       | No                                              | `Optional number of turns to fork. Defaults to \`all\`. Use \`none\`, \`all\`, or a positive integer string such as \`3\` to fork only the most recent turns.`                      |
| `model`            | No; field can be hidden by configuration        | `Model override for the new agent. Omit unless an explicit override is needed.`                                                                                                     |
| `reasoning_effort` | No; field can be hidden by configuration        | `Reasoning effort override for the new agent. Omit to inherit the parent effort.`                                                                                                   |
| `service_tier`     | No; omitted in the stock profile                | `Service tier override for the new agent. Omit unless explicitly requested.`                                                                                                        |

`message` carries the public JSON-schema marker `"encrypted": true`. The runtime accepts case-insensitive `none` and `all`, or a positive integer string, for `fork_turns`. Empty or omitted `fork_turns` becomes `all` ([schema](https://github.com/openai/codex/blob/12933b69551394328319dcdd1bcee7907326dc85/codex-rs/core/src/tools/handlers/multi_agents_spec.rs#L102-L146), [parser](https://github.com/openai/codex/blob/12933b69551394328319dcdd1bcee7907326dc85/codex-rs/core/src/tools/handlers/multi_agents_v2/spawn.rs#L231-L265)).

`task_name` is a single new path segment. Runtime rejects empty names, `root`, `.` and `..`, slashes, and characters other than lowercase ASCII letters, digits, and underscores ([validation](https://github.com/openai/codex/blob/12933b69551394328319dcdd1bcee7907326dc85/codex-rs/protocol/src/agent_path.rs#L121-L176)).

The full-history model/effort restriction in the V2 usage hint is guidance, not runtime validation. The handler currently accepts and applies supplied `model`/`reasoning_effort` values before full-history role handling ([handler order](https://github.com/openai/codex/blob/12933b69551394328319dcdd1bcee7907326dc85/codex-rs/core/src/tools/handlers/multi_agents_v2/spawn.rs#L55-L89)).

### 5.2 `send_message`

Description:

> Send a message to an existing agent. The message will be delivered promptly. Does not trigger a new turn.

Required parameters:

| Property  | Description                                                      |
| --------- | ---------------------------------------------------------------- |
| `target`  | `Relative or canonical task name to message (from spawn_agent).` |
| `message` | `Message text to queue on the target agent.`                     |

`message` carries the public JSON-schema marker `"encrypted": true`.

Source: [`create_send_message_tool`](https://github.com/openai/codex/blob/12933b69551394328319dcdd1bcee7907326dc85/codex-rs/core/src/tools/handlers/multi_agents_spec.rs#L186-L216).

### 5.3 `followup_task`

Description:

> Send a follow-up task to an existing non-root target agent and trigger a turn if it is idle. If the target is already running, deliver the task promptly at message boundaries while sampling, or after the pending tool call completes.

Required parameters:

| Property  | Description                                                                       |
| --------- | --------------------------------------------------------------------------------- |
| `target`  | `Agent id or canonical task name to send a follow-up task to (from spawn_agent).` |
| `message` | `Message text to send to the target agent.`                                       |

`message` carries the public JSON-schema marker `"encrypted": true`.

Source: [`create_followup_task_tool`](https://github.com/openai/codex/blob/12933b69551394328319dcdd1bcee7907326dc85/codex-rs/core/src/tools/handlers/multi_agents_spec.rs#L218-L245).

### 5.4 Target resolution

Despite slightly different parameter prose, `send_message`, `followup_task`, and `interrupt_agent` share the same resolver:

1. A valid thread UUID is accepted directly.
2. `/root` resolves to the root.
3. Any other absolute reference must be a valid `/root/...` path or the exact special path `/morpheus`.
4. A relative reference is appended to the **current agent's** path.

Thus `worker` from `/root/task1` means `/root/task1/worker`, while a sibling or agent in another branch requires a canonical path.

Path lookup uses the tree-shared agent registry rather than the loaded-thread table. A syntactically valid but unregistered path returns:

> live agent path `{path}` not found

Invalid references use the `AgentPath` validation strings listed in [§11.3](#113-v2-path-and-target-errors). A registered but runtime-unloaded V2 identity still resolves:

- `send_message` and `followup_task` call `ensure_v2_agent_loaded` before delivery. They lazily reload from stored V2 history when possible and otherwise return the wrapped reload error.
- `interrupt_agent` does not reload the target. It obtains the current status, treats a missing runtime as an accepted no-op, and can therefore return `{"previous_status":"not_found"}`.
- `list_agents` omits the identity until its runtime is loaded.

UUID input bypasses path parsing, but the V2 handlers subsequently require that the UUID be known to the shared agent registry.

Sources: [resolver](https://github.com/openai/codex/blob/12933b69551394328319dcdd1bcee7907326dc85/codex-rs/core/src/agent/agent_resolver.rs#L8-L30), [path lookup](https://github.com/openai/codex/blob/12933b69551394328319dcdd1bcee7907326dc85/codex-rs/core/src/agent/control.rs#L384-L403), [message reload](https://github.com/openai/codex/blob/12933b69551394328319dcdd1bcee7907326dc85/codex-rs/core/src/tools/handlers/multi_agents_v2/message_tool.rs#L67-L123), [interrupt handling](https://github.com/openai/codex/blob/12933b69551394328319dcdd1bcee7907326dc85/codex-rs/core/src/tools/handlers/multi_agents_v2/interrupt_agent.rs#L38-L95).

### 5.5 `wait_agent`

Description:

> Wait for a mailbox update from any live agent, including queued messages and final-status notifications. The wait also ends early when new user input is steered into the active turn. Does not return the content; returns either a summary of which agents have updates (if any), an interruption summary for steered input, or a timeout summary if no activity arrives before the deadline.

The mailbox-success promise in that description does not match the returned summary. On mailbox activity the result message is exactly:

> Wait completed.

It contains no agent name or update source. The communication that woke the wait is delivered separately as an agent-message input item, so the model can still receive its author and content outside the tool result ([runtime result](https://github.com/openai/codex/blob/12933b69551394328319dcdd1bcee7907326dc85/codex-rs/core/src/tools/handlers/multi_agents_v2/wait.rs#L135-L156)).

Optional parameter:

| Property     | Description                                                             |
| ------------ | ----------------------------------------------------------------------- |
| `timeout_ms` | `Timeout in milliseconds. Defaults to {default}, min {min}, max {max}.` |

The stock values are:

- default: `30000`
- minimum: `10000`
- maximum: `3600000`

A requested value above the maximum is rejected. Any value below the minimum, including zero or a negative value, is clamped upward. The tool result tells the model when clamping occurred.

The advertised JSON type is `number`, but runtime deserializes `timeout_ms` as `i64`. Fractional values therefore fail generic argument parsing rather than reaching the clamping behavior.

Source: [`create_wait_agent_tool_v2`](https://github.com/openai/codex/blob/12933b69551394328319dcdd1bcee7907326dc85/codex-rs/core/src/tools/handlers/multi_agents_spec.rs#L285-L295), [runtime](https://github.com/openai/codex/blob/12933b69551394328319dcdd1bcee7907326dc85/codex-rs/core/src/tools/handlers/multi_agents_v2/wait.rs#L36-L62).

### 5.6 `interrupt_agent`

Description:

> Interrupt an agent's current turn, if any, and return its previous status. The agent remains available for messages and follow-up tasks.

Required parameter:

| Property | Description                                                        |
| -------- | ------------------------------------------------------------------ |
| `target` | `Agent id or canonical task name to interrupt (from spawn_agent).` |

Source: [`create_interrupt_agent_tool_v2`](https://github.com/openai/codex/blob/12933b69551394328319dcdd1bcee7907326dc85/codex-rs/core/src/tools/handlers/multi_agents_spec.rs#L340-L358).

### 5.7 `list_agents`

Description:

> List live agents in the current root thread tree. Optionally filter by task-path prefix.

Optional parameter:

| Property      | Description                                                                       |
| ------------- | --------------------------------------------------------------------------------- |
| `path_prefix` | `Task-path prefix filter without a trailing slash. Omit to list all live agents.` |

The prefix is resolved relative to the current agent unless it is canonical. Matching includes the exact path and all descendants. `/root` matches the whole tree. Results are ordered by path. The root is included only when its runtime is loaded and matches. Codex then enumerates registered agents but skips reserved entries without an id and every registered identity whose runtime is currently unloaded ([implementation](https://github.com/openai/codex/blob/12933b69551394328319dcdd1bcee7907326dc85/codex-rs/core/src/agent/control.rs#L437-L507), [prefix matching](https://github.com/openai/codex/blob/12933b69551394328319dcdd1bcee7907326dc85/codex-rs/core/src/agent/control.rs#L814-L825)).

Source: [`create_list_agents_tool`](https://github.com/openai/codex/blob/12933b69551394328319dcdd1bcee7907326dc85/codex-rs/core/src/tools/handlers/multi_agents_spec.rs#L297-L316).

## 6. V2 role usage hints

V2 resolves one usage hint for the root and one for thread-spawned children. Each is emitted as a standalone developer message ([resolver](https://github.com/openai/codex/blob/12933b69551394328319dcdd1bcee7907326dc85/codex-rs/core/src/session/multi_agents.rs#L62-L142), [message role and separation](https://github.com/openai/codex/blob/12933b69551394328319dcdd1bcee7907326dc85/codex-rs/core/src/context/multi_agent_role_instructions.rs#L25-L48)).

### 6.1 Bundled root text

````text
You are `/root`, the primary agent in a team of agents collaborating to fulfill the user's goals.

At the start of your turn, you are the active agent.
You can spawn sub-agents to handle subtasks, and those sub-agents can spawn their own sub-agents.
All agents in the team, including the agents that you can assign tasks to, are equally intelligent and capable, and have access to the same set of tools.

You can use `spawn_agent` to create a new agent, `followup_task` to give an existing agent a new task and trigger a turn, and `send_message` to pass a message to a running agent without triggering a turn.
Child agents can also spawn their own sub-agents.
You can decide how much context you want to propagate to your sub-agents with the `fork_turns` parameter.

You will receive messages in the analysis channel in the form:
```
Message Type: MESSAGE | FINAL_ANSWER
Task name: <recipient>
Sender: <author>
Payload:
<payload text>
```
They may be addressed as to=/root
````

### 6.2 Bundled subagent text

````text
You are an agent in a team of agents collaborating to complete a task.

You can spawn sub-agents to handle subtasks, and those sub-agents can spawn their own sub-agents. All agents in the team, including the agents that you can assign tasks to, are equally intelligent and capable, and have access to the same set of tools.

You can use `spawn_agent` to create a new agent, `followup_task` to give an existing agent a new task and trigger a turn, and `send_message` to pass a message to a running agent.
Child agents can also spawn their own sub-agents.

When you provide a response in the final channel, that content is immediately delivered back to your parent agent.

You will receive messages in the analysis channel in the form:
```
Message Type: NEW_TASK | MESSAGE | FINAL_ANSWER
Task name: <recipient>
Sender: <author>
Payload:
<payload text>
```
You may also see them addressed as to=/root/..., which indicates your identity is /root/...
````

Source for both: [bundled role text](https://github.com/openai/codex/blob/12933b69551394328319dcdd1bcee7907326dc85/codex-rs/core/src/session/multi_agents.rs#L11-L59).

### 6.3 Shared appended text

Catalog or bundled role text receives this exact suffix:

```text
Note that collaboration tools cannot be called from inside `functions.exec`. Call `spawn_agent`, `send_message`, `followup_task`, `wait_agent`, `interrupt_agent`, and `list_agents` only as direct tool calls using the recipient shown in their tool definitions, such as `to=functions.collaboration.spawn_agent`, since they are intentionally absent from the `functions.exec` `tools.*` namespace. Available tools in `functions.exec` are explicitly described with a `tools` namespace in the developer message.

All agents share the same directory. In detail:
- All agents have access to the same container and filesystem as you.
- All agents use the same current working directory.
- As a result, edits made by one agent are immediately visible to all other agents.
```

If `wait_agent` is enabled, Codex then adds:

> When calling `wait_agent`, prefer longer waits (minutes) to avoid busy polling.

It always adds:

> There are `{max_concurrency}` available concurrency slots, meaning that up to `{max_concurrency}` agents can be active at once, including you.

If spawn model overrides are exposed, it finally adds:

> Full-history forks (`fork_turns` omitted or `"all"`) inherit the parent model and reasoning effort and do not accept overrides. Only set `model` or `reasoning_effort` when explicitly requested by the user, applicable `AGENTS.md` instructions, or skill instructions; when doing so, set `fork_turns` to `"none"` or a positive integer string.

Source: [shared and optional text](https://github.com/openai/codex/blob/12933b69551394328319dcdd1bcee7907326dc85/codex-rs/core/src/session/multi_agents.rs#L50-L59), [assembly](https://github.com/openai/codex/blob/12933b69551394328319dcdd1bcee7907326dc85/codex-rs/core/src/session/multi_agents.rs#L94-L142).

The shared literal is not rewritten to match non-stock tool exposure. In particular, it:

- hard-codes the example recipient `functions.collaboration.spawn_agent` even when V2 uses a custom namespace or ordinary unnamespaced functions;
- lists `wait_agent` even when `wait_agent_enabled = false`;
- says the tools cannot be called through `functions.exec` even when `non_code_mode_only = false` gives them Code Mode exposure.

The actual tool definitions and recipients remain authoritative in those configurations.

### 6.4 Resolution, suppression, and markers

For each of root and subagent:

1. Configured `root_agent_usage_hint_text` or `subagent_usage_hint_text` wins.
2. A configured empty string suppresses the message.
3. Otherwise model-catalog role text wins over bundled text.
4. An empty catalog string also suppresses the message.

A non-empty **configured** role is used alone. It does not receive the shared filesystem text, wait guidance, concurrency count, or model-override guidance, and it is unmarked.

A non-empty **catalog** role receives all applicable additions and is wrapped:

```text
<multi_agent_role>{resolved text}</multi_agent_role>
```

A **bundled** role receives the same additions but is unmarked.

Usage hints apply only in V2 and only to root-like sources and thread-spawned subagents. Internal and non-thread-spawn subagents do not receive them ([source](https://github.com/openai/codex/blob/12933b69551394328319dcdd1bcee7907326dc85/codex-rs/core/src/session/multi_agents.rs#L67-L92)).

They are stored as diffed world state. When an unmarked hint changes, the new text is emitted as a separate developer message. Catalog hints retain the `<multi_agent_role>` markers ([source](https://github.com/openai/codex/blob/12933b69551394328319dcdd1bcee7907326dc85/codex-rs/core/src/context/world_state/multi_agent_usage_hint.rs#L8-L49)).

## 7. V2 multi-agent mode instructions

V2 emits a separate developer-role mode message after the role usage hint so the mode can override general role guidance ([initial ordering](https://github.com/openai/codex/blob/12933b69551394328319dcdd1bcee7907326dc85/codex-rs/core/src/session/mod.rs#L3596-L3640)).

### 7.1 Built-in explicit-request mode

```text
<multi_agent_mode>Any earlier instruction enabling proactive multi-agent delegation no longer applies. Do not spawn sub-agents unless the user or applicable AGENTS.md/skill instructions explicitly ask for sub-agents, delegation, or parallel agent work.</multi_agent_mode>
```

### 7.2 Built-in proactive mode

```text
<multi_agent_mode>Proactive multi-agent delegation is active. Any earlier instruction requiring an explicit user request before spawning sub-agents no longer applies. Use sub-agents when parallel work would materially improve speed or quality. This mode remains active until a later multi-agent mode developer message changes it.</multi_agent_mode>
```

Source: [`MultiAgentModeInstructions`](https://github.com/openai/codex/blob/12933b69551394328319dcdd1bcee7907326dc85/codex-rs/core/src/context/multi_agent_mode_instructions.rs#L6-L48).

### 7.3 Resolution

Codex resolves the effective mode in this order:

1. configured `multi_agent_mode_hint_text`;
2. model-catalog `multi_agent.mode.hint_text`;
3. proactive mode when effective reasoning effort is `ultra`;
4. model-catalog `multi_agent.mode.explicit`;
5. bundled explicit-request mode.

Configured or catalog hint text is a custom policy. Catalog `explicit` text is also a custom policy. Custom text appears inside the same `<multi_agent_mode>...</multi_agent_mode>` markers.

An explicitly empty custom value suppresses the mode message. Custom mode text is truncated to 400 tokens before it is stored and rendered. The mode is diffed: unchanged state emits nothing; removing a previously proactive or unknown mode can emit the bundled explicit-request text as a safety reset ([resolver](https://github.com/openai/codex/blob/12933b69551394328319dcdd1bcee7907326dc85/codex-rs/core/src/session/multi_agents.rs#L145-L185), [bounded diff state](https://github.com/openai/codex/blob/12933b69551394328319dcdd1bcee7907326dc85/codex-rs/core/src/context/world_state/multi_agent_mode.rs#L13-L86)).

As with usage hints, mode instructions apply only to root-like sources and thread-spawned V2 subagents.

## 8. Child instruction and history construction

### 8.1 Base/model instructions

For both versions, spawn begins with the parent's effective base instructions:

```rust
config.base_instructions = Some(base_instructions.text.clone());
```

Source: [`build_agent_spawn_config`](https://github.com/openai/codex/blob/12933b69551394328319dcdd1bcee7907326dc85/codex-rs/core/src/tools/handlers/multi_agents_common.rs#L171-L187).

A selected role replaces base instructions when its configuration declares `instructions` or `model_instructions_file`. When both fields are absent, Codex normally preserves the current base instructions and their provenance.

There is one additional regeneration path. If the role changes either the selected `personality` or whether `Feature::Personality` is enabled, and the current base instructions have model-owned provenance, Codex clears both the inherited instructions and their provenance. Child-session startup then regenerates base instructions from the resulting model and personality. Instructions with custom provenance remain preserved across the same personality change ([role reload](https://github.com/openai/codex/blob/12933b69551394328319dcdd1bcee7907326dc85/codex-rs/core/src/agent/role.rs#L167-L231), [session resolution](https://github.com/openai/codex/blob/12933b69551394328319dcdd1bcee7907326dc85/codex-rs/core/src/session/mod.rs#L638-L656)).

Therefore there is no fixed child-only system text to quote. The default child base prompt is the same effective base prompt as the parent.

### 8.2 Developer instructions

The initial child config normally clones the parent's effective developer instructions. In V2, configured `subagent_developer_instructions` replaces that value, including when the configured value is explicitly empty ([source](https://github.com/openai/codex/blob/12933b69551394328319dcdd1bcee7907326dc85/codex-rs/core/src/tools/handlers/multi_agents_common.rs#L200-L225)). Configuration loading trims this value before use ([source](https://github.com/openai/codex/blob/12933b69551394328319dcdd1bcee7907326dc85/codex-rs/core/src/config/mod.rs#L2662-L2689)).

A selected role can then provide its own top-level `developer_instructions`, which takes precedence. For V2 roles that do not declare developer instructions, Codex preserves the caller-selected developer instructions rather than restoring an older config-layer value ([source](https://github.com/openai/codex/blob/12933b69551394328319dcdd1bcee7907326dc85/codex-rs/core/src/agent/role.rs#L51-L65), [preservation](https://github.com/openai/codex/blob/12933b69551394328319dcdd1bcee7907326dc85/codex-rs/core/src/agent/role.rs#L177-L207)).

### 8.3 Fresh, full, and partial history

Model-facing history behavior is:

- V1 `fork_context = false` and V2 `fork_turns = none`: no parent conversation history is copied; the child receives its ordinary instructions plus the new task.
- V1 `fork_context = true` and V2 `fork_turns = all`: eligible parent history is copied.
- V2 positive `fork_turns = N`: Codex retains a suffix beginning at the earliest of the most recent `N` **fork-turn boundaries**, then applies the normal fork filters below.

A fork-turn boundary is any of:

- a real user message;
- an inter-agent communication with `trigger_turn = true`;
- an inter-agent delivery-metadata record with `trigger_turn = true`;
- a legacy assistant inter-agent envelope whose delivery flag triggers a turn.

Queue-only agent messages do not count. Thread-rollback markers remove rolled-back boundaries before the suffix is selected. If fewer than `N` boundaries exist, Codex still starts at the first boundary and drops all pre-turn startup context. If there is no boundary, the copied history is empty ([boundary detection](https://github.com/openai/codex/blob/12933b69551394328319dcdd1bcee7907326dc85/codex-rs/core/src/thread_rollout_truncation.rs#L63-L127), [suffix selection](https://github.com/openai/codex/blob/12933b69551394328319dcdd1bcee7907326dc85/codex-rs/core/src/thread_rollout_truncation.rs#L257-L279)).

For both V1 and V2 forks, the top-level rollout filter keeps:

- system, developer, and user messages;
- assistant messages only when their phase is `final_answer`;
- compacted-rollout records, session metadata, and most event records;
- cached turn-context and world-state records only when reference context is preserved.

It drops:

- `additional_tools` and `agent_message` response items;
- reasoning;
- local-shell, function, custom-tool, tool-search, web-search, and image-generation calls and outputs;
- response-level compaction items and unknown response items;
- raw inter-agent communications, their delivery metadata, and security-risk scores.

Partial forks do not preserve cached turn-context or world-state reference context. Full-history forks normally do, but Codex also discards that reference context when the latest compacted checkpoint is a legacy checkpoint without replacement history. Paginated destination histories additionally drop completed-item, token-count, thread-goal, and applied-settings events ([top-level filter](https://github.com/openai/codex/blob/12933b69551394328319dcdd1bcee7907326dc85/codex-rs/core/src/agent/control/spawn.rs#L52-L85), [application](https://github.com/openai/codex/blob/12933b69551394328319dcdd1bcee7907326dc85/codex-rs/core/src/agent/control/spawn.rs#L700-L805)).

Compacted replacement histories use a deliberately narrower response-item filter than the top-level rollout. Inside a replacement history, Codex removes agent messages and excluded developer fragments and performs developer-instruction replacement, but it does not reapply the complete top-level response-item kind whitelist. Other response items already embedded in that replacement history can therefore remain.

Codex also removes inherited multi-agent role messages, current-time reminders, and matching root/subagent usage-hint messages. When child-specific developer instructions are selected, it replaces or removes the matching parent developer-instruction fragment. When the resolved V2 subagent usage hint is non-empty, Codex ensures that it reaches the resulting child context once, either through preserved reference context or the child's rebuilt initial context ([sanitization](https://github.com/openai/codex/blob/12933b69551394328319dcdd1bcee7907326dc85/codex-rs/core/src/agent/control/spawn.rs#L687-L839)).

After history construction, the new V2 task is supplied as a triggering inter-agent `NEW_TASK` message. The V1 task remains ordinary user input.

### 8.4 Role, model, effort, provider, and service-tier precedence

When `agent_type` is omitted:

- a fresh V1 spawn applies the `default` role;
- a full-history V1 spawn inherits the parent's role and rejects an explicit role override;
- a fresh or partial V2 spawn applies the `default` role;
- a full-history V2 spawn with no explicit role preserves the inherited configuration, while an explicit role is applied even to that full-history fork.

The V1 rejection text is documented in [§11.2](#112-v1-specific-errors).

Before role application, the child starts from the live turn's effective model, provider, reasoning effort, base instructions, developer instructions, approval policy, permission profile, cwd, and other shared configuration. Spawn arguments and configured defaults then resolve as follows ([base snapshot](https://github.com/openai/codex/blob/12933b69551394328319dcdd1bcee7907326dc85/codex-rs/core/src/tools/handlers/multi_agents_common.rs#L171-L225), [model/effort overrides](https://github.com/openai/codex/blob/12933b69551394328319dcdd1bcee7907326dc85/codex-rs/core/src/tools/handlers/multi_agents_common.rs#L272-L328)):

1. An explicit `model` wins over `[agents].default_subagent_model`.
2. An explicit `reasoning_effort` wins over `[agents].default_subagent_reasoning_effort`.
3. If neither an argument nor its configured default exists, the parent setting remains unchanged. If a model is selected through either the argument or the configured default and no effort is selected, Codex uses that model's default reasoning effort rather than preserving the parent's effort.
4. If only reasoning effort changes, Codex validates it against the current parent model.

Codex applies the selected role **after** those model and effort choices. A role file is parsed as a general high-precedence Codex configuration layer, not as a whitelist of agent-only settings. It can directly replace model, reasoning effort, model provider, base/model instructions, developer instructions, and service tier, and it can also change other configuration that affects the child's ordinary context, feature set, or tool exposure. Omitted role fields preserve the values already chosen where the role reload code explicitly makes them sticky, subject to the V1/V2 developer-instruction behavior described in [§8.2](#82-developer-instructions) and the personality regeneration rule in [§8.1](#81-basemodel-instructions) ([role application](https://github.com/openai/codex/blob/12933b69551394328319dcdd1bcee7907326dc85/codex-rs/core/src/agent/role.rs#L33-L120), [layer construction](https://github.com/openai/codex/blob/12933b69551394328319dcdd1bcee7907326dc85/codex-rs/core/src/agent/role.rs#L167-L260)).

Service tier is resolved after the role and final model. The ordered candidates are:

1. the effective role/config tier;
2. the explicit spawn request;
3. a parent tier supported by the final child model.

Codex chooses the first supported candidate. An explicit requested tier is validated against the final model and errors when unsupported even if another candidate could otherwise be selected ([service-tier selection](https://github.com/openai/codex/blob/12933b69551394328319dcdd1bcee7907326dc85/codex-rs/core/src/tools/handlers/multi_agents_common.rs#L330-L382)).

These settings can change the child's ordinary system/developer context, but their resulting prose is dynamic model or configuration content rather than a fixed collaboration literal.

### 8.5 Agent messages across long-context compaction

The fork filtering in [§8.3](#83-fresh-full-and-partial-history) is separate from later long-context compaction inside an already running agent.

Remote Compaction V2 can retain `ResponseItem::AgentMessage` items in the installed replacement history. An agent message is retained only when:

- its first content item is not input text beginning with the exact prefix `Message Type: FINAL_ANSWER\n`; and
- its estimated size is at most 10,000 tokens.

The retained messages then participate in the shared 64,000-token retained-message budget. Truncation favors newer retained groups and can truncate an older message to fit. `FINAL_ANSWER` completion mail can be present in the request sent to the compaction model, but it is excluded from the replacement history installed for later turns ([retention filter](https://github.com/openai/codex/blob/12933b69551394328319dcdd1bcee7907326dc85/codex-rs/core/src/compact_remote_v2.rs#L465-L523), [budget truncation](https://github.com/openai/codex/blob/12933b69551394328319dcdd1bcee7907326dc85/codex-rs/core/src/compact_remote_v2.rs#L541-L610)).

When Codex reinserts canonical initial context into a compacted replacement history, it treats a retained non-`FINAL_ANSWER` agent message as a real user/agent boundary and places the initial context before it. The same helper is shared by local and remote compaction implementations, but local compaction normally rebuilds replacement history from real user messages plus a summary and therefore does not itself preserve agent messages ([insertion rule](https://github.com/openai/codex/blob/12933b69551394328319dcdd1bcee7907326dc85/codex-rs/core/src/compact.rs#L575-L635), [local replacement construction](https://github.com/openai/codex/blob/12933b69551394328319dcdd1bcee7907326dc85/codex-rs/core/src/compact.rs#L340-L377)).

## 9. Inter-agent and lifecycle messages

### 9.1 V2 plaintext task and message envelope

Codex classifies a call as a plaintext direct message only when all three conditions hold:

1. the canonical tool namespace is exactly `collaboration`;
2. the tool name is `spawn_agent`, `send_message`, or `followup_task`;
3. the response item contains `encrypted_function_args: []`.

The classification matrix is:

| Call source                    | Namespace/metadata                                               | Communication branch |
| ------------------------------ | ---------------------------------------------------------------- | -------------------- |
| Direct function call           | `collaboration` plus `encrypted_function_args: []`               | Plaintext            |
| Direct function call           | `collaboration` with missing or non-empty encryption metadata    | Encrypted-content    |
| Direct function call           | Any custom V2 namespace, even with `encrypted_function_args: []` | Encrypted-content    |
| Ordinary unnamespaced function | Canonicalized to the `functions` namespace                       | Encrypted-content    |
| Code Mode nested call          | Explicit `CodeMode` source                                       | Encrypted-content    |

Source: [`ToolCall::direct_source`](https://github.com/openai/codex/blob/12933b69551394328319dcdd1bcee7907326dc85/codex-rs/core/src/tools/router.rs#L39-L55), [Code Mode dispatch](https://github.com/openai/codex/blob/12933b69551394328319dcdd1bcee7907326dc85/codex-rs/core/src/tools/code_mode/mod.rs#L351-L374).

For calls classified as plaintext, `spawn_agent` and `followup_task` use `NEW_TASK`; `send_message` uses `MESSAGE`. The model-facing item is a structured agent message and has no surrounding marker:

```text
Message Type: {NEW_TASK|MESSAGE}
Task name: {recipient_path}
Sender: {author_path}
Payload:
{message}
```

Sources: [renderer](https://github.com/openai/codex/blob/12933b69551394328319dcdd1bcee7907326dc85/codex-rs/core/src/context/inter_agent_message.rs#L5-L65), [tool conversion](https://github.com/openai/codex/blob/12933b69551394328319dcdd1bcee7907326dc85/codex-rs/core/src/tools/handlers/multi_agents_v2.rs#L57-L84).

`Task name` is the recipient, not the sender. On initial spawn that tells the new child its canonical identity. Authors without an agent path fall back to `/root`.

The active model-input conversion uses the special `ResponseItem::AgentMessage` variant, not an ordinary role-tagged assistant message. The item carries structured `author`, `recipient`, and content fields; the plaintext envelope above is the text content inside that item ([conversion](https://github.com/openai/codex/blob/12933b69551394328319dcdd1bcee7907326dc85/codex-rs/protocol/src/protocol.rs#L813-L845)). This representation is used for V2 initial tasks, ordinary messages, follow-up tasks, and completion mail.

### 9.2 V2 encrypted task and message envelope

V2's `message` fields carry the public JSON-schema marker `"encrypted": true`. That marker is separate from response-item `encrypted_function_args` metadata, which participates in the plaintext classification in [§9.1](#91-v2-plaintext-task-and-message-envelope). Both are separate from replay representation: for every call not classified as plaintext, Codex stores the supplied `message` value in the communication's `encrypted_content` field and sends the model an agent message containing:

```text
Message Type: {NEW_TASK|MESSAGE}
Task name: {recipient_path}
Sender: {author_path}
Payload:
```

followed by a distinct encrypted-content item. The payload is not duplicated in the plaintext header ([schema marker](https://github.com/openai/codex/blob/12933b69551394328319dcdd1bcee7907326dc85/codex-rs/tools/src/json_schema.rs#L48-L50), [response metadata](https://github.com/openai/codex/blob/12933b69551394328319dcdd1bcee7907326dc85/codex-rs/protocol/src/models.rs#L909-L927), [construction](https://github.com/openai/codex/blob/12933b69551394328319dcdd1bcee7907326dc85/codex-rs/core/src/tools/handlers/multi_agents_v2.rs#L57-L75), [model conversion](https://github.com/openai/codex/blob/12933b69551394328319dcdd1bcee7907326dc85/codex-rs/protocol/src/protocol.rs#L813-L845)).

This branch does not itself transform or cryptographically encrypt the supplied string. A custom-namespace, unnamespaced, Code Mode, or metadata-missing call can therefore place literal plaintext inside the `encrypted_content` item. The distinction here is the model-input content type and envelope shape.

### 9.3 V2 completion envelope

When a thread-spawned V2 child with a canonical path reaches a deliverable final turn status, its direct parent receives this queue-only `ResponseItem::AgentMessage`:

```text
Message Type: FINAL_ANSWER
Task name: {parent_path}
Sender: {child_path}
Payload:
{completion_payload}
```

Source: [`InterAgentCompletionMessage`](https://github.com/openai/codex/blob/12933b69551394328319dcdd1bcee7907326dc85/codex-rs/core/src/context/inter_agent_completion_message.rs#L5-L40).

The normal child-session delivery path produces:

| Final status                  | Source event                                                                | Payload                             |
| ----------------------------- | --------------------------------------------------------------------------- | ----------------------------------- |
| `completed` with a message    | `TurnComplete`                                                              | The child's final assistant message |
| `completed` without a message | `TurnComplete`                                                              | Empty string                        |
| `errored`                     | A stored terminal error, or a non-interrupt/non-budget `TurnAborted` reason | See exact error envelope below      |

The error envelope is:

```text
Agent errored: {truncated_error}

This agent's turn failed. If you still need this agent, use the available collaboration tools to give it another task.
```

The raw error is truncated to a 900-token budget, reserving 100 tokens from a 1,000-token completion-message budget for the envelope. Pending, running, and interrupted states do not produce a completion message. In particular, `TurnAborted` with reason `Interrupted` or `BudgetLimited` records `Interrupted` and sends no completion ([status mapping](https://github.com/openai/codex/blob/12933b69551394328319dcdd1bcee7907326dc85/codex-rs/core/src/agent/status.rs#L4-L27), [formatter](https://github.com/openai/codex/blob/12933b69551394328319dcdd1bcee7907326dc85/codex-rs/core/src/session_prefix.rs#L7-L44)).

The shared formatter also defines payloads for `shutdown` and `not_found`:

```text
Agent shut down.
Agent was not found.
```

Those statuses are supported by the formatter but are not produced by the normal V2 child-session delivery path, which reacts only to `TurnComplete` and `TurnAborted`.

Normal V2 delivery is performed by the child session itself, not the detached completion watcher ([session delivery](https://github.com/openai/codex/blob/12933b69551394328319dcdd1bcee7907326dc85/codex-rs/core/src/session/mod.rs#L1934-L2035)). V2 spawn explicitly does not install that watcher ([watcher exclusion](https://github.com/openai/codex/blob/12933b69551394328319dcdd1bcee7907326dc85/codex-rs/core/src/agent/control/spawn.rs#L552-L586)).

The completion communication has `trigger_turn = false` and is sent only to the direct parent. It is best-effort: Codex does not lazily reload or retry an unavailable parent and can drop the result. The normal child-session path logs a delivery failure at debug level; the detached completion watcher, when present, silently discards that failure ([session delivery](https://github.com/openai/codex/blob/12933b69551394328319dcdd1bcee7907326dc85/codex-rs/core/src/session/mod.rs#L2016-L2035), [detached watcher](https://github.com/openai/codex/blob/12933b69551394328319dcdd1bcee7907326dc85/codex-rs/core/src/agent/control.rs#L512-L589)). Queue-only delivery normally waits for the parent's next active turn instead of starting one. The exception is an idle parent with an outstanding durable sleep: any mailbox message, including queue-only completion mail, can wake that sleeping session ([queue scheduling](https://github.com/openai/codex/blob/12933b69551394328319dcdd1bcee7907326dc85/codex-rs/core/src/session/handlers.rs#L80-L101), [durable-sleep wake](https://github.com/openai/codex/blob/12933b69551394328319dcdd1bcee7907326dc85/codex-rs/core/src/tasks/mod.rs#L434-L490)).

Within an active turn, mailbox mail is also subject to an answer boundary. Completed reasoning and commentary items can stop the current response so pending mailbox mail enters a follow-up request. Completed non-commentary assistant text switches mailbox delivery to the next turn only when existing turn-local pending input is empty or entirely queue-only. Other pending input prevents that switch. Once delivery switches, later mailbox mail—including trigger-turn mail—is also withheld for the rest of the turn unless an accepted tool call or another required follow-up reopens current-turn delivery. Thus queue-only mail arriving after a final answer normally does not restart sampling. At each mailbox poll Codex drains every currently pending item in FIFO order while retaining separate structured agent-message items ([reasoning and commentary preemption](https://github.com/openai/codex/blob/12933b69551394328319dcdd1bcee7907326dc85/codex-rs/core/src/session/turn.rs#L2327-L2370), [final-answer boundary](https://github.com/openai/codex/blob/12933b69551394328319dcdd1bcee7907326dc85/codex-rs/core/src/stream_events_utils.rs#L91-L111), [mailbox phases](https://github.com/openai/codex/blob/12933b69551394328319dcdd1bcee7907326dc85/codex-rs/core/src/session/input_queue.rs#L206-L227), [FIFO drain](https://github.com/openai/codex/blob/12933b69551394328319dcdd1bcee7907326dc85/codex-rs/core/src/session/input_queue.rs#L151-L181)).

### 9.4 V1 completion notification

When a V1 child reaches a final state, its direct parent receives a **user-role** context fragment:

```text
<subagent_notification>
{"agent_path":"{thread_uuid}","status":{serialized_agent_status}}
</subagent_notification>
```

The body contains a leading and trailing newline inside the markers. Despite the JSON key name, V1's `agent_path` value is the child's UUID reference.

Sources: [renderer](https://github.com/openai/codex/blob/12933b69551394328319dcdd1bcee7907326dc85/codex-rs/core/src/context/subagent_notification.rs#L5-L41), [delivery](https://github.com/openai/codex/blob/12933b69551394328319dcdd1bcee7907326dc85/codex-rs/core/src/agent/control.rs#L594-L600).

This notification is independent of V1 `wait_agent`; a completed status can therefore appear in both the wait result and the notification.

V1 uses ordinary injected response input rather than the V2 queue-only mailbox phase. When the parent task is active, the notification joins its pending input and reopens current-turn delivery, so it can cause a follow-up request even after visible final text. When the parent is idle, Codex records the notification in conversation history without starting a turn ([injection dispatch](https://github.com/openai/codex/blob/12933b69551394328319dcdd1bcee7907326dc85/codex-rs/core/src/session/inject.rs#L117-L135), [active injection](https://github.com/openai/codex/blob/12933b69551394328319dcdd1bcee7907326dc85/codex-rs/core/src/session/inject.rs#L15-L35), [mailbox reopening](https://github.com/openai/codex/blob/12933b69551394328319dcdd1bcee7907326dc85/codex-rs/core/src/session/input_queue.rs#L252-L263)).

### 9.5 Interrupt marker

By default, Codex records a model-visible marker when an agent turn is interrupted. V1 and disabled multi-agent sessions use a user-role marker:

```text
<turn_aborted>
The user interrupted the previous turn on purpose. Any running unified exec processes may still be running in the background. If any tools/commands were aborted, they may have partially executed.
</turn_aborted>
```

V2 uses a developer-role marker:

```text
<turn_aborted>
The previous turn was interrupted on purpose. Any running unified exec processes may still be running in the background. If any tools/commands were aborted, they may have partially executed.
</turn_aborted>
```

The marker can be disabled by configuration ([selection](https://github.com/openai/codex/blob/12933b69551394328319dcdd1bcee7907326dc85/codex-rs/core/src/tasks/mod.rs#L77-L124), [literal text](https://github.com/openai/codex/blob/12933b69551394328319dcdd1bcee7907326dc85/codex-rs/core/src/context/turn_aborted.rs#L3-L34), [default enabled](https://github.com/openai/codex/blob/12933b69551394328319dcdd1bcee7907326dc85/codex-rs/core/src/config/mod.rs#L3691-L3700)).

## 10. Other collaboration-specific model context

### 10.1 Direct-child list in environment context

When environment context is enabled, Codex lists each **currently loaded**, direct thread-spawn child inside the user-role `<environment_context>` block:

```text
<environment_context>
  ...
  <subagents>
    - {reference}: {nickname}
    - {reference_without_nickname}
  </subagents>
</environment_context>
```

For a V2 child, `{reference}` is its final path segment. For a V1 child it falls back to the UUID. Empty nicknames are omitted. This list contains no status and does not recursively list deeper descendants. It is built from live thread-spawn edges in the loaded thread manager; a residency-unloaded V2 child is omitted even though its identity remains registered and path-addressable ([formatting](https://github.com/openai/codex/blob/12933b69551394328319dcdd1bcee7907326dc85/codex-rs/core/src/agent/control.rs#L415-L435), [live-edge enumeration](https://github.com/openai/codex/blob/12933b69551394328319dcdd1bcee7907326dc85/codex-rs/core/src/agent/control.rs#L711-L739), [thread-manager source](https://github.com/openai/codex/blob/12933b69551394328319dcdd1bcee7907326dc85/codex-rs/core/src/thread_manager.rs#L1337-L1355), [environment rendering](https://github.com/openai/codex/blob/12933b69551394328319dcdd1bcee7907326dc85/codex-rs/core/src/context/world_state/environment.rs#L249-L256)).

### 10.2 Token-budget context-window identity

When `Feature::TokenBudget` is enabled and the effective model has a known context window, Codex emits a separate developer message:

```text
<context_window>
Agent name: {agent_path}
First context window id: {first_window_uuid}
Current context window id: {current_window_uuid}
Previous context window id: {previous_window_uuid}
{optional_notes_thread_hint_text}
</context_window>
```

The `Previous context window id` line is omitted when there is no previous window. Successful text content from the latest `notes.thread_hint` MCP call is appended verbatim as one or more following lines; an unavailable, failed, or empty result adds nothing.

For a thread-spawned V2 child, `{agent_path}` is its canonical path, such as `/root/worker`. Sources without a canonical agent path use `/root`. The world-state snapshot for this section is the agent path, so a full-history child can retain an inherited parent identity block and also receive a new block for its own path ([literal and rendering](https://github.com/openai/codex/blob/12933b69551394328319dcdd1bcee7907326dc85/codex-rs/core/src/context/token_budget_context.rs#L12-L82), [initial-context assembly](https://github.com/openai/codex/blob/12933b69551394328319dcdd1bcee7907326dc85/codex-rs/core/src/session/mod.rs#L3554-L3593)).

The window identifiers and notes integration are generic TokenBudget behavior. The collaboration-specific observable is that a V2 thread-spawn's canonical task path becomes the `Agent name`.

### 10.3 Shared rollout-budget reminder

When a shared session rollout budget is configured and reaches a reminder threshold, any agent can receive this developer-role block:

```text
<rollout_budget>
You have {remaining_tokens} weighted tokens left in the shared session token budget.
</rollout_budget>
```

The budget is owned by the tree-shared `AgentControl`, so usage is shared between the root and descendants ([literal](https://github.com/openai/codex/blob/12933b69551394328319dcdd1bcee7907326dc85/codex-rs/core/src/context/rollout_budget.rs#L3-L26), [recording](https://github.com/openai/codex/blob/12933b69551394328319dcdd1bcee7907326dc85/codex-rs/core/src/session/rollout_budget.rs#L8-L35)).

Exhaustion surfaces as:

> shared rollout token budget exhausted

### 10.4 Hook-provided dynamic context

Thread-spawned children use the `SubagentStart` and `SubagentStop` hook lifecycle. These hooks do not add fixed Codex prose, but they are collaboration-specific dynamic model-facing extension points:

- `SubagentStart` can inject arbitrary additional context as separate developer messages.
- A controlling `SubagentStop` hook can block completion and return a continuation prompt, causing another child turn.

Sources: [start dispatch](https://github.com/openai/codex/blob/12933b69551394328319dcdd1bcee7907326dc85/codex-rs/core/src/hook_runtime.rs#L103-L154), [developer-message construction](https://github.com/openai/codex/blob/12933b69551394328319dcdd1bcee7907326dc85/codex-rs/core/src/hook_runtime.rs#L678-L699), [developer role](https://github.com/openai/codex/blob/12933b69551394328319dcdd1bcee7907326dc85/codex-rs/core/src/context/hook_additional_context.rs#L4-L27), [stop continuation](https://github.com/openai/codex/blob/12933b69551394328319dcdd1bcee7907326dc85/codex-rs/hooks/src/events/stop.rs#L198-L317).

## 11. Tool results and model-visible errors

### 11.1 Status encoding

Where a tool result or V1 notification serializes `AgentStatus`, the JSON value is one of:

```json
"pending_init"
"running"
"interrupted"
"shutdown"
"not_found"
{"completed":"final message"}
{"completed":null}
{"errored":"error text"}
```

Source: [`AgentStatus`](https://github.com/openai/codex/blob/12933b69551394328319dcdd1bcee7907326dc85/codex-rs/protocol/src/protocol.rs#L1733-L1753), [declared result schema](https://github.com/openai/codex/blob/12933b69551394328319dcdd1bcee7907326dc85/codex-rs/core/src/tools/handlers/multi_agents_spec.rs#L360-L389).

Successful structured results are serialized as compact JSON ([source](https://github.com/openai/codex/blob/12933b69551394328319dcdd1bcee7907326dc85/codex-rs/core/src/tools/handlers/multi_agents_common.rs#L53-L83)).

#### V1 results

| Tool           | Model-visible success output                                                                                 |
| -------------- | ------------------------------------------------------------------------------------------------------------ |
| `spawn_agent`  | `{"agent_id":"{uuid}","nickname":"{nickname}"}`                                                              |
| `send_input`   | `{"submission_id":"{id}"}`                                                                                   |
| `resume_agent` | `{"status":{AgentStatus}}`                                                                                   |
| `wait_agent`   | `{"status":{"{target}":{AgentStatus}},"timed_out":false}`; timeout returns an empty status object and `true` |
| `close_agent`  | `{"previous_status":{AgentStatus}}`                                                                          |

Sources: [V1 spawn](https://github.com/openai/codex/blob/12933b69551394328319dcdd1bcee7907326dc85/codex-rs/core/src/tools/handlers/multi_agents/spawn.rs#L224-L269), [send](https://github.com/openai/codex/blob/12933b69551394328319dcdd1bcee7907326dc85/codex-rs/core/src/tools/handlers/multi_agents/send_input.rs#L123-L164), [resume](https://github.com/openai/codex/blob/12933b69551394328319dcdd1bcee7907326dc85/codex-rs/core/src/tools/handlers/multi_agents/resume_agent.rs#L148-L188), [wait](https://github.com/openai/codex/blob/12933b69551394328319dcdd1bcee7907326dc85/codex-rs/core/src/tools/handlers/multi_agents/wait.rs#L188-L221), [close](https://github.com/openai/codex/blob/12933b69551394328319dcdd1bcee7907326dc85/codex-rs/core/src/tools/handlers/multi_agents/close_agent.rs#L125-L158).

#### V2 results

| Tool                                | Model-visible success output                                                          |
| ----------------------------------- | ------------------------------------------------------------------------------------- |
| `spawn_agent` with hidden metadata  | `{"task_name":"{canonical_path}"}`                                                    |
| `spawn_agent` with visible metadata | `{"task_name":"{canonical_path}","nickname":"{nickname}"}`                            |
| `send_message`                      | Empty text                                                                            |
| `followup_task`                     | Empty text                                                                            |
| `wait_agent`                        | `{"message":"{summary}","timed_out":{boolean}}`                                       |
| `interrupt_agent`                   | `{"previous_status":{AgentStatus}}`                                                   |
| `list_agents`                       | `{"agents":[{"agent_name":"{canonical_path_or_uuid}","agent_status":{AgentStatus}}]}` |

Sources: [V2 spawn](https://github.com/openai/codex/blob/12933b69551394328319dcdd1bcee7907326dc85/codex-rs/core/src/tools/handlers/multi_agents_v2/spawn.rs#L199-L209), [empty message result](https://github.com/openai/codex/blob/12933b69551394328319dcdd1bcee7907326dc85/codex-rs/core/src/tools/handlers/multi_agents_v2/message_tool.rs#L112-L137), [wait](https://github.com/openai/codex/blob/12933b69551394328319dcdd1bcee7907326dc85/codex-rs/core/src/tools/handlers/multi_agents_v2/wait.rs#L129-L175), [interrupt](https://github.com/openai/codex/blob/12933b69551394328319dcdd1bcee7907326dc85/codex-rs/core/src/tools/handlers/multi_agents_v2/interrupt_agent.rs#L93-L130), [list](https://github.com/openai/codex/blob/12933b69551394328319dcdd1bcee7907326dc85/codex-rs/core/src/tools/handlers/multi_agents_v2/list_agents.rs#L56-L82).

For a root caller, a V2 canonical path has the form `/root/{name}`; a descendant caller produces a nested path such as `/root/parent/child`. The declared result schemas and internal metadata types permit `nickname: null`, but the normal production thread-spawn path reserves a nickname before spawn and returns a string on success. See [§3.3](#33-nickname-generation).

V2 wait summaries are exactly:

```text
Wait completed.
Wait interrupted by new input.
Wait timed out.
```

When a requested timeout is clamped upward, Codex appends:

```text

Requested timeout of {requested_timeout_ms}ms was clamped to the minimum of {effective_timeout_ms}ms.
```

Source: [`WaitAgentResult::from_outcome`](https://github.com/openai/codex/blob/12933b69551394328319dcdd1bcee7907326dc85/codex-rs/core/src/tools/handlers/multi_agents_v2/wait.rs#L135-L156).

### 11.2 V1-specific errors

Codex-authored V1 validation messages include:

```text
invalid agent id {target}: {parse_error_debug}
agent ids must be non-empty
Provide either message or items, but not both
Provide one of: message or items
Empty message can't be sent to an agent
Items can't be empty
Agent depth limit reached. Solve the task yourself.
Full-history forked agents inherit the parent agent type; omit agent_type, or spawn without a full-history fork.
timeout_ms must be greater than zero
```

Sources: [UUID parsing](https://github.com/openai/codex/blob/12933b69551394328319dcdd1bcee7907326dc85/codex-rs/core/src/tools/handlers/multi_agents.rs#L39-L58), [input validation](https://github.com/openai/codex/blob/12933b69551394328319dcdd1bcee7907326dc85/codex-rs/core/src/tools/handlers/multi_agents_common.rs#L138-L169), [role/fork rejection](https://github.com/openai/codex/blob/12933b69551394328319dcdd1bcee7907326dc85/codex-rs/core/src/tools/handlers/multi_agents_common.rs#L228-L237), [depth](https://github.com/openai/codex/blob/12933b69551394328319dcdd1bcee7907326dc85/codex-rs/core/src/tools/handlers/multi_agents/spawn.rs#L63-L71), [wait timeout](https://github.com/openai/codex/blob/12933b69551394328319dcdd1bcee7907326dc85/codex-rs/core/src/tools/handlers/multi_agents/wait.rs#L89-L97).

### 11.3 V2 path and target errors

Path validation can return:

```text
agent path must not be empty
agent_name must not be empty
agent_name `root` is reserved
agent_name `.` is reserved
agent_name `..` is reserved
agent_name must not contain `/`
agent_name must use only lowercase letters, digits, and underscores
absolute agent paths must start with `/root` or be `/morpheus`
absolute agent path must not end with `/`
relative agent path must not end with `/`
live agent path `{path}` not found
```

Source: [`AgentPath` validation](https://github.com/openai/codex/blob/12933b69551394328319dcdd1bcee7907326dc85/codex-rs/protocol/src/agent_path.rs#L38-L72), [name and path validators](https://github.com/openai/codex/blob/12933b69551394328319dcdd1bcee7907326dc85/codex-rs/protocol/src/agent_path.rs#L121-L176), [lookup](https://github.com/openai/codex/blob/12933b69551394328319dcdd1bcee7907326dc85/codex-rs/core/src/agent/control.rs#L384-L403).

The validator source also contains:

> absolute agent path must not be empty

That branch is not practically reachable at the pinned commit: after a leading slash is removed, Rust's `str::split('/')` always yields a first segment, including an empty segment for `/`. The input `/` therefore reaches the general “must start with `/root` or be `/morpheus`” error instead. The literal is source-resident but not a currently returnable model-facing validation result.

Other fixed V2 messages include:

```text
spawned agent is missing a canonical task name
fork_context is not supported in MultiAgentV2; use fork_turns instead
fork_turns must be `none`, `all`, or a positive integer string
Empty message can't be sent to an agent
Follow-up tasks can't target the root agent
target agent is missing an agent_path
timeout_ms must be at most {max_timeout_ms}
root is not a spawned agent
an agent cannot interrupt itself; return your result and let the parent interrupt you if needed
```

Sources: [spawn](https://github.com/openai/codex/blob/12933b69551394328319dcdd1bcee7907326dc85/codex-rs/core/src/tools/handlers/multi_agents_v2/spawn.rs#L103-L114), [fork parser](https://github.com/openai/codex/blob/12933b69551394328319dcdd1bcee7907326dc85/codex-rs/core/src/tools/handlers/multi_agents_v2/spawn.rs#L231-L265), [messaging](https://github.com/openai/codex/blob/12933b69551394328319dcdd1bcee7907326dc85/codex-rs/core/src/tools/handlers/multi_agents_v2/message_tool.rs#L42-L85), [wait](https://github.com/openai/codex/blob/12933b69551394328319dcdd1bcee7907326dc85/codex-rs/core/src/tools/handlers/multi_agents_v2/wait.rs#L48-L62), [interrupt](https://github.com/openai/codex/blob/12933b69551394328319dcdd1bcee7907326dc85/codex-rs/core/src/tools/handlers/multi_agents_v2/interrupt_agent.rs#L38-L61).

### 11.4 Shared spawn and control errors

Shared fixed or formatted messages include:

```text
collab handler received unsupported payload
collab manager unavailable
collab spawn failed: {error}
agent with id {id} not found
agent with id {id} is closed
collab tool failed: {error}
approval_policy is invalid: {error}
permission_profile is invalid: {error}
spawn_agent could not resolve the child model for service tier validation
Service tier `{requested}` is not supported for model `{model}`. Supported service tiers: {tiers_or_none}
spawn_agent could not resolve the child model for reasoning effort validation
Unknown model `{requested}` for spawn_agent. Available models: {available}
Reasoning effort `{requested}` is not supported for model `{model}`. Supported reasoning efforts: {supported}
unknown agent_type '{role}'
agent type is currently not available
agent path `{path}` already exists
no available agent nicknames
```

An `UnsupportedOperation` encountered during spawn can also be passed through verbatim. Capacity failures normally appear through a wrapper such as:

```text
collab spawn failed: agent thread limit reached
collab tool failed: agent thread limit reached
```

Sources: [shared error mapping](https://github.com/openai/codex/blob/12933b69551394328319dcdd1bcee7907326dc85/codex-rs/core/src/tools/handlers/multi_agents_common.rs#L44-L110), [permission validation](https://github.com/openai/codex/blob/12933b69551394328319dcdd1bcee7907326dc85/codex-rs/core/src/tools/handlers/multi_agents_common.rs#L239-L269), [model/tier validation](https://github.com/openai/codex/blob/12933b69551394328319dcdd1bcee7907326dc85/codex-rs/core/src/tools/handlers/multi_agents_common.rs#L272-L383), [role/model validation](https://github.com/openai/codex/blob/12933b69551394328319dcdd1bcee7907326dc85/codex-rs/core/src/tools/handlers/multi_agents_common.rs#L385-L477), [role errors](https://github.com/openai/codex/blob/12933b69551394328319dcdd1bcee7907326dc85/codex-rs/core/src/agent/role.rs#L73-L90), [registry errors](https://github.com/openai/codex/blob/12933b69551394328319dcdd1bcee7907326dc85/codex-rs/core/src/agent/registry.rs#L245-L253), [nickname error](https://github.com/openai/codex/blob/12933b69551394328319dcdd1bcee7907326dc85/codex-rs/core/src/agent/registry.rs#L304-L317), [limit text](https://github.com/openai/codex/blob/12933b69551394328319dcdd1bcee7907326dc85/codex-rs/protocol/src/error.rs#L94-L102).

`no available agent nicknames` is a source-resident registry error. With the bundled non-empty default pool or a configuration accepted by the normal validator, pool exhaustion advances to a new suffixed generation rather than returning that error. It requires a nonstandard or programmatically constructed empty nickname pool; see [§3.3](#33-nickname-generation).

Generic JSON/Serde argument parsing failures and lower-level dynamic error strings are also returned to the model, but they are not fixed collaboration-authored prose.

## 12. Source map

The primary contract sources are:

- protocol selection and stock limits: [`config/mod.rs`](https://github.com/openai/codex/blob/12933b69551394328319dcdd1bcee7907326dc85/codex-rs/core/src/config/mod.rs)
- session protocol inheritance and V2 completion delivery: [`session/mod.rs`](https://github.com/openai/codex/blob/12933b69551394328319dcdd1bcee7907326dc85/codex-rs/core/src/session/mod.rs)
- tool visibility and namespace placement: [`spec_plan.rs`](https://github.com/openai/codex/blob/12933b69551394328319dcdd1bcee7907326dc85/codex-rs/core/src/tools/spec_plan.rs)
- tool names, descriptions, schemas, and declared output shapes: [`multi_agents_spec.rs`](https://github.com/openai/codex/blob/12933b69551394328319dcdd1bcee7907326dc85/codex-rs/core/src/tools/handlers/multi_agents_spec.rs)
- V1 execution and tool-search metadata: [`multi_agents.rs`](https://github.com/openai/codex/blob/12933b69551394328319dcdd1bcee7907326dc85/codex-rs/core/src/tools/handlers/multi_agents.rs)
- V2 execution and communication construction: [`multi_agents_v2.rs`](https://github.com/openai/codex/blob/12933b69551394328319dcdd1bcee7907326dc85/codex-rs/core/src/tools/handlers/multi_agents_v2.rs)
- direct-call source classification: [`tools/router.rs`](https://github.com/openai/codex/blob/12933b69551394328319dcdd1bcee7907326dc85/codex-rs/core/src/tools/router.rs)
- Code Mode declaration rendering: [`description.rs`](https://github.com/openai/codex/blob/12933b69551394328319dcdd1bcee7907326dc85/codex-rs/code-mode-protocol/src/description.rs), [`json_schema_types.rs`](https://github.com/openai/codex/blob/12933b69551394328319dcdd1bcee7907326dc85/codex-rs/code-mode-protocol/src/json_schema_types.rs)
- shared spawn precedence and validation: [`multi_agents_common.rs`](https://github.com/openai/codex/blob/12933b69551394328319dcdd1bcee7907326dc85/codex-rs/core/src/tools/handlers/multi_agents_common.rs)
- root/subagent usage hints and mode resolution: [`session/multi_agents.rs`](https://github.com/openai/codex/blob/12933b69551394328319dcdd1bcee7907326dc85/codex-rs/core/src/session/multi_agents.rs)
- role inventory and role application: [`agent/role.rs`](https://github.com/openai/codex/blob/12933b69551394328319dcdd1bcee7907326dc85/codex-rs/core/src/agent/role.rs)
- nickname reservation and registry state: [`agent/control/spawn.rs`](https://github.com/openai/codex/blob/12933b69551394328319dcdd1bcee7907326dc85/codex-rs/core/src/agent/control/spawn.rs), [`agent/registry.rs`](https://github.com/openai/codex/blob/12933b69551394328319dcdd1bcee7907326dc85/codex-rs/core/src/agent/registry.rs)
- V2 task and message rendering: [`inter_agent_message.rs`](https://github.com/openai/codex/blob/12933b69551394328319dcdd1bcee7907326dc85/codex-rs/core/src/context/inter_agent_message.rs)
- completion rendering: [`session_prefix.rs`](https://github.com/openai/codex/blob/12933b69551394328319dcdd1bcee7907326dc85/codex-rs/core/src/session_prefix.rs)
- child history sanitization: [`agent/control/spawn.rs`](https://github.com/openai/codex/blob/12933b69551394328319dcdd1bcee7907326dc85/codex-rs/core/src/agent/control/spawn.rs)
- partial-fork boundary selection: [`thread_rollout_truncation.rs`](https://github.com/openai/codex/blob/12933b69551394328319dcdd1bcee7907326dc85/codex-rs/core/src/thread_rollout_truncation.rs)
- long-context agent-message handling: [`compact_remote_v2.rs`](https://github.com/openai/codex/blob/12933b69551394328319dcdd1bcee7907326dc85/codex-rs/core/src/compact_remote_v2.rs), [`compact.rs`](https://github.com/openai/codex/blob/12933b69551394328319dcdd1bcee7907326dc85/codex-rs/core/src/compact.rs)
- token-budget identity context: [`token_budget_context.rs`](https://github.com/openai/codex/blob/12933b69551394328319dcdd1bcee7907326dc85/codex-rs/core/src/context/token_budget_context.rs)
- V2 residency and eviction: [`agent/control/residency.rs`](https://github.com/openai/codex/blob/12933b69551394328319dcdd1bcee7907326dc85/codex-rs/core/src/agent/control/residency.rs)
- structured agent-message transport: [`protocol.rs`](https://github.com/openai/codex/blob/12933b69551394328319dcdd1bcee7907326dc85/codex-rs/protocol/src/protocol.rs)
- transport placement: [`client.rs`](https://github.com/openai/codex/blob/12933b69551394328319dcdd1bcee7907326dc85/codex-rs/core/src/client.rs)
