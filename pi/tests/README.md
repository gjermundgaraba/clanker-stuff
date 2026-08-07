# Tests

Choose the smallest layer that proves the behavior.

## Layers

### Unit / contract / TUI

Use `*.test.ts` for:

- pure functions
- extension-local state and event handling
- command and tool registration behavior
- widgets, notifications, and session-tree behavior
- TUI components and key flows

Default harnesses:

- `pi/tests/harness/extension-host.ts`
- `pi/tests/harness/tui.ts`

This is the default layer for extension tests.

### Integration

Use `*.integration.test.ts` only when the assertion depends on a real `AgentSession`, including:

- runtime hook ordering
- provider payload interception
- real prompt lifecycle behavior at the model boundary
- resource loading that does not depend on filesystem discovery

Default harness:

- `pi/tests/harness/agent-session.ts`

Any test that imports `pi/tests/harness/agent-session.ts`, including tests of the harness itself, must be named `*.integration.test.ts`.

`agent-session` wraps a process-global faux provider. Active integration-style harnesses must not overlap, so this layer runs serially.

### Smoke

Use `*.smoke.test.ts` for minimal happy-path checks that must prove real filesystem discovery and runtime wiring together.

Default harness:

- `pi/tests/harness/extension-smoke.ts`

Any test that imports `pi/tests/harness/extension-smoke.ts`, including tests of the harness itself, must be named `*.smoke.test.ts`.

`extension-smoke` stages real extension directories under `<project>/.pi/extensions`, isolates `HOME`, and runs them through a real `AgentSession`. Use it to verify discovered extensions, not to build a generic interactive end-to-end suite. Its options are intentionally limited to discovery/runtime smoke concerns.

## Harness selection

- Start with `extension-host`.
- For unit-layer tool tests, prefer `host.runTool(...)` over manually capturing a registered tool. Pass `{ ctx, signal, onUpdate, toolCallId }` when the tool behavior depends on those execution details.
- Move to `agent-session` when you need the real runtime or provider boundary.
- Use `extension-smoke` when discovery from `.pi/extensions` is part of what you are proving.

Package-local setup is still appropriate for env-heavy tests, subprocess seams, and tightly package-specific logic.

## Resource ownership

Tests and harnesses must clean up the env patches and temp dirs they create.

- keep restore functions local to the file or harness that called `patchEnv(...)`
- delete temp dirs from the same test or harness that created them
- do not add repo-wide cleanup stacks or temp-dir registries back into shared helpers

## TUI guidance

TUI-heavy interactive flows usually belong in unit/TUI tests with `extension-host` and `pi/tests/harness/tui.ts`.

For generic `ui.custom(...)` mechanics, prefer the shared driver in `pi/tests/harness/tui.ts` over package-local wiring. Keep package-local helpers only when they add package semantics such as fixture builders, domain-specific queued results, or package-language assertions.

Use a package-local subprocess seam only when that boundary is already justified by the package behavior.

## Naming

- `*.test.ts` — unit / contract / TUI
- `*.integration.test.ts` — integration
- `*.smoke.test.ts` — smoke

Enforced package-level higher-layer coverage requirements live in `scripts/check-tests.mjs`.

## Repo rules

- Non-test workspace package source files may use relative imports only when the resolved path stays within that package root.
- Tests importing `pi/tests/harness/agent-session.ts` must be `*.integration.test.ts`.
- Tests importing `pi/tests/harness/extension-smoke.ts` must be `*.smoke.test.ts`.
- Shared helpers used across packages must come from real workspace package dependencies.
