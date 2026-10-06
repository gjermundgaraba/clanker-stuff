# Delegation and thinking

Subagents separates branch-local delegation policy from native thinking. `/proactive` controls whether the model may initiate delegation without an explicit request. `/ultra` is a one-shot action: enable proactive delegation and select the current model's highest supported native thinking level. Neither command is an automatic scheduler, a new provider or a backend reasoning level.

## Commands

- Run `/proactive` to toggle the current branch's effective policy between `explicit` and `proactive`. This can explicitly turn proactive delegation off even when the configured default is `proactive`.
- Run `/ultra` to save a branch-local `proactive` policy and boost native thinking once, even when the configured default is already proactive. Running it again repeats that action; it does not toggle off or restore prior thinking.
- Start Pi with `--ultra` to perform the same action at startup.

Both slash commands take no arguments. Proactive delegation can increase usage substantially. User requests, project constraints and applicable skill instructions still govern delegation. Tools, permissions, role instructions, tree-wide concurrency and mailbox behavior are unchanged. Ultra never enables Fast.

## Branch policy

The configured `delegation` value in `~/.pi/agent/subagents.json` is the fallback: `explicit` by default, or `proactive`. A saved branch policy overrides it. Resume, reload, forks and tree navigation read the selected session branch's policy.

Fresh children snapshot their initial caller's effective policy, regardless of model selection, role or explicit effort. A proactive caller therefore produces a proactive child even when that child's thinking is explicitly set; an explicit caller produces an explicit child even when the child uses highest thinking. Existing children retain their own policy when an ancestor toggles its policy. Cold reload restores the child's saved branch policy rather than resnapshotting the parent.

Policy is stored as `explicit` or `proactive` in `subagents-delegation` session entries. The `proactive` status indicates active delegation policy, not a highest-thinking lock. Historical `ultra` entries are ignored, not migrated or aliased; native thinking is left unchanged during cutover. There is no global Ultra state and no live policy propagation through the tree.

## Native thinking

Ultra asks Pi to clamp thinking to the current model's highest supported native level once. Non-reasoning models are allowed and retain thinking `off`. Changing model or manually selecting another thinking level afterwards uses ordinary native Pi behavior; it neither reapplies a highest-thinking lock nor changes delegation policy. Turning proactive delegation off does not restore an earlier thinking level. Tree navigation restores delegation policy but does not add extension-owned thinking restoration.

For a fresh child, explicit `reasoning_effort` or role-configured thinking takes precedence. Otherwise, a child using the same model as its caller inherits the caller's thinking; a different model uses its native configured default. These rules apply uniformly to explicit model requests and model-only roles. Cold reload uses the child's recorded model and thinking. Policy inheritance never supplies or overrides effort.

## Optional orchestration preset

The vendored `orchestrate` skill is an explicit opt-in preset, not an automatically loaded Subagents skill. From this repository, add it deliberately with:

```bash
pi --skill pi/extensions/experimental/subagents/vendor/orchestrate/SKILL.md
```

Use the equivalent package path when loading an installed copy. The preset recommends coordinating agents for substantial work, bounded scouts and separate ownership. Load it only when those instructions are appropriate; Subagents works without it. Applicable skill instructions can authorize delegation under `explicit` policy, but do not bypass user or project constraints.
