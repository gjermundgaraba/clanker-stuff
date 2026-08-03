# Historical Pi terminal hook design

> Archived Phase 4 design evidence. This is not a current recommendation or repository task; the extension remains private under the audited load-last contract in [local-deployment.md](local-deployment.md).

## Historical conclusion

The Phase 4 analysis concluded that one explicit terminal-registration primitive would have satisfied the extension's general-release safety contract. Numeric normal-handler priority was unnecessary.

The smallest safe public surface is:

```ts
interface ExtensionAPI {
  onTerminal<TEvent extends TerminalExtensionEventName>(
    event: TEvent,
    handler: ExtensionHandler<TEvent>
  ): void;
}

type TerminalExtensionEventName =
  | "context"
  | "before_provider_request"
  | "before_provider_headers"
  | "session_before_compact";
```

`onTerminal` must be a new method, not `{ terminal: true }` passed to `on`. An older Pi silently ignores an extra JavaScript argument to `on`; an absent `onTerminal` method instead makes an incompatible extension fail during loading.

## Required semantics

### Terminal registration

- At most one terminal handler may exist for each supported event across the complete loaded extension set.
- A terminal handler always runs after all normal handlers in the current extension-load and registration order.
- The runner snapshots normal handlers at the start of each dispatch. A normal handler registered during dispatch is eligible only for the next dispatch, where it runs before the terminal owner.
- `onTerminal` is legal only while an extension factory is executing. Calling it from `session_start`, `resources_discover`, another event handler, a timer, or a command must throw and must not register anything.
- Loading fails if two extensions claim the same terminal event.
- Claiming multiple events is all-or-nothing at extension-set activation time. A conflict on one event prevents the new extension set from becoming active.
- A normal handler can never run after the terminal handler in the same dispatch.

The Codex extension would call `onTerminal` four times. Successful extension-set activation is then the runtime proof that it owns the finalized context, payload, headers, and non-cancelled compaction result.

## Per-event result behavior

### `context`

Normal handlers transform `messages` in their existing order. The terminal handler receives the accumulated messages and may return the final messages.

### `before_provider_request`

Normal handlers transform `payload` in their existing order. The terminal handler receives the accumulated payload and its return value is the transport payload.

### `before_provider_headers`

Normal handlers mutate the shared headers object in their existing order. The terminal handler receives that final object and is the last code allowed to mutate it before provider execution.

### `session_before_compact`

Normal handlers retain current result semantics:

1. A normal `{ cancel: true }` stops dispatch immediately. The terminal handler is not called because no built-in or extension compaction may proceed.
2. A non-cancelling normal result becomes the accumulated result.
3. If no normal handler cancels, the terminal handler runs last.
4. A terminal result replaces the accumulated result; terminal `undefined` preserves it.
5. Terminal `{ cancel: true }` cancels compaction.

Skipping the terminal handler after an earlier cancellation does not violate terminal ownership: there is no downstream compaction request or result to protect.

## Error behavior

- Normal-handler errors keep current behavior: emit an `ExtensionError` and continue.
- A terminal-handler error emits an `ExtensionError` and is rethrown.
- A terminal error in `context`, payload, or headers therefore aborts the pending provider request.
- A terminal error in `session_before_compact` rejects the compaction operation.
- Pi must never catch a terminal error and continue into provider execution or built-in compaction.

This distinction is required for fail-closed extensions. The current runner catches every handler error and continues.

## Discovery and reload

Pi should build and validate a candidate extension set before replacing the active runner:

1. Load package, project, user, local, CLI, and inline extension factories.
2. Complete synchronous factory registration.
3. Validate terminal uniqueness for all supported events.
4. Snapshot existing-order normal plans and terminal owner records.
5. Atomically activate the candidate set.

Reload and resource rediscovery must repeat all five steps. If loading or validation fails, reload fails without partially activating the candidate set. Deferred `onTerminal` registration is forbidden, so `session_start` and `resources_discover` cannot change ownership after validation.

Normal deferred `on` registration remains supported. It enters the next dispatch plan in existing order and necessarily runs before any terminal owner.

## Backward compatibility

- Existing extensions require no changes.
- Normal handlers retain current extension-load and registration order.
- Existing normal error and cancellation behavior remains unchanged.
- Extensions requiring terminal ownership declare a Pi peer version containing `onTerminal`.
- Running such an extension on older Pi fails visibly during extension loading because `pi.onTerminal` is absent.
- No manifest ordering field or package-manager convention becomes part of the security contract.

## Minimum Pi tests

1. **Terminal adversary:** a terminal handler remains last when another extension loads later or registers a normal handler from `session_start`, `resources_discover`, or another dispatch.
2. **All four events:** accumulated context, payload, headers, and compaction results reach the terminal owner exactly once.
3. **Failure:** duplicate ownership rejects activation; terminal errors abort; normal errors retain current continue behavior; normal compaction cancellation prevents terminal and built-in work.
4. **Reload:** ownership is revalidated atomically after package reordering, local/CLI changes, resource rediscovery, and extension reload; deferred terminal registration is rejected.

## Why current public strategies do not qualify

At Pi `845d6ff1f6643aba440341cce877ce1c43ebbc39`, the runner iterates extensions and then handlers in stored order:

- [generic and lifecycle dispatch](https://github.com/earendil-works/pi/blob/845d6ff1f6643aba440341cce877ce1c43ebbc39/packages/coding-agent/src/core/extensions/runner.ts#L796-L827)
- [`context`](https://github.com/earendil-works/pi/blob/845d6ff1f6643aba440341cce877ce1c43ebbc39/packages/coding-agent/src/core/extensions/runner.ts#L979-L1009)
- [`before_provider_request`](https://github.com/earendil-works/pi/blob/845d6ff1f6643aba440341cce877ce1c43ebbc39/packages/coding-agent/src/core/extensions/runner.ts#L1011-L1043)
- [`before_provider_headers`](https://github.com/earendil-works/pi/blob/845d6ff1f6643aba440341cce877ce1c43ebbc39/packages/coding-agent/src/core/extensions/runner.ts#L1045-L1074)

Phase 4 executable tests confirm:

- Normal and deferred registration preserve extension order, so a later extension still runs later.
- Reversing package-list entries reverses those package extensions.
- CLI and top-level local paths precede configured packages in the tested loader setup, but none is reserved as terminal.
- Factory registrations keep the same non-terminal order after reload.
- `session_start`- and `resources_discover`-deferred request hooks are not restored by the tested reload path.

Load-last documentation is therefore an operational convention, not a package-level guarantee.
