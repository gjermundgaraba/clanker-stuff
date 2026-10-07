# State machine

States, events, and lifecycle transitions.

Nodes are stable states, not activities. Directed edges use `event [guard] / action` when those details matter. Distinguish initial markers from final states; the initial arrow points into the first state. Self-transitions are valid and must show the triggering event. Alternative guarded transitions, unreachable states, and terminal behavior should match the actual model. Use nested/composite states only when they carry defined semantics.

For one subject's progress with separate interruption/recovery and terminal bands, use the [lifecycle phase map](semantic-patterns.md#lifecycle-phase-map). Use [sequence](type-sequence.md) for actor messages; keep ordinary state machines for dense transition/guard logic.

Geometry examples: [state](../assets/example-state.html) · [lifecycle phases](../assets/example-state-lifecycle.html). These retain an upstream illustration palette; use [design defaults](design.md) for new work.
