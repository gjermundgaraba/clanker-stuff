# Phase 4 results

> Historical phase-gate snapshot. Its validation counts and Pi API proposal are archived evidence, not current repository work. See [design.md](design.md) for the current supported boundary.

## Decision

**Implementation and parity gate: PASS.**

**General package discovery and release: NO-GO on Pi 0.83.0.**

Phase 4 closes both extension-local gaps:

- A request whose public context usage is below 90% can now compact safely when an earlier `before_provider_request` handler pushes the finalized payload over 90%.
- Temporary replay markers are accepted only when removing them yields the entire marker-free logical Responses input, including tool structure and corrected fallback assistant IDs.

Release remains blocked because no public Pi API guarantees this extension is terminal for `context`, `before_provider_request`, `before_provider_headers`, and `session_before_compact`. No package metadata, export surface, discovery wiring, license, packed-install work, or release changes were added.

Phase 5 later permits one controlled local package deployment by externally auditing the complete resolved order. It does not change this phase's general-release decision.

## Pinned baselines

- Pi: `845d6ff1f6643aba440341cce877ce1c43ebbc39` (`0.83.0`)
- Codex: `6219b7c40fc9c702c0aef9964e72b492558f60e4`
- Comparison adapter: `7f72997715bfdbcaa1ced0d38d1c7b3bad7f8988`

Only public Pi exports are used. Phase 4 adds no dependency, private import, direct HTTP client, provider override, duplicate serializer, timeout, or JSONL mutation.

## 1. Finalized payload-only threshold crossing

### Implemented path

For a supported Codex model with no active checkpoint and public context usage below 90%, the `context` hook now records an unframed candidate without changing messages.

At `before_provider_request`, the candidate path:

1. Revalidates generation, request settings, model identity, leaf, branch hash, and active-source state.
2. Strictly parses the full finalized Responses envelope.
3. JSON-normalizes the complete finalized `input`, including changes from earlier payload handlers.
4. Applies the existing decision policy to `max(valid fresh usage, finalized local estimate)`.
5. Returns the original payload object unchanged if the exact decision remains below 90%.
6. If the threshold is crossed, uses the full finalized envelope and input as the registered-provider side-request source.
7. Rechecks immutable input, request settings, model, branch, source, generation, and candidate ownership after the side request.
8. Appends and verifies the inline checkpoint before returning the pending request with the checkpoint replacement.

The pending request preserves non-`input` envelope fields. Because the entire finalized input was compacted, there is no unframed prefix or suffix outside the replacement. Payload-only additions are inside the opaque state for the current continuation; normal extension execution may add fresh state again on later turns.

Remote, stale, and persistence failures retain the existing distinct fail-closed outcomes. No normal provider fetch occurs after an unsafe result.

### Executable proof

The real `AgentSession` fixture starts below 90%, has an earlier payload handler append 16,000 characters, and proves:

- The side compaction request occurs before the pending model request.
- The side input contains the payload-only item and exactly one `compaction_trigger`.
- The pending request contains one opaque item and no marker.
- Non-input `client_metadata` survives.
- The checkpoint is durable and classified as inline pre-sampling.
- The next turn replays one opaque item.
- The payload-only text is not leaked outside opaque state after installation.
- A payload-stage branch mutation invalidates the candidate before any network request.

The existing byte-level ordinary-request fixture continues to prove that a finalized request remaining below threshold is byte-identical to the request without this extension.

### Remaining boundary

This path can include only mutations that occur before this extension's payload handler. A later handler can still mutate the validated result. That is the same terminal-order release blocker, not a remaining threshold bug.

## 2. Fallback `msg_pi_*` ID audit and correction

### Measured effect

Pinned Pi generates fallback assistant text IDs from transformed message position:

- [`msg_pi_${msgIndex}` and block suffixes](https://github.com/earendil-works/pi/blob/845d6ff1f6643aba440341cce877ce1c43ebbc39/packages/ai/src/api/openai-responses-shared.ts#L219-L244)

The Phase 4 fixtures quantify the marker effect:

| Position | Marker-bearing serialization | Marker-free logical serialization | Shift |
| --- | --- | --- | --- |
| Assistant inside start/end frame | `msg_pi_2` | `msg_pi_1` | `+1` |
| Assistant after the end marker | `msg_pi_4` | `msg_pi_2` | `+2` |

The end marker is after framed content, so framed items move by one. Suffix items move by both temporary user markers.

Pinned Codex installs retained user/developer/system messages followed by the new compaction item and does not add local framing messages:

- [remote v2 replacement construction](https://github.com/openai/codex/blob/6219b7c40fc9c702c0aef9964e72b492558f60e4/codex-rs/core/src/compact_remote_v2.rs#L439-L465)

Marker-bearing fallback IDs therefore were a Pi framing artifact, not part of the marker-free logical replacement.

### Safe correction and structural parity

The extension now invokes Pi's exported `convertResponsesMessages` twice during framing:

1. Serialize the marker-bearing context.
2. Serialize the equivalent marker-free logical context.

Assistant message items are paired in order. A mapping is accepted only when every changed old and new ID matches Pi's `msg_pi_*` fallback form. The context hook then extracts the current nonce frame from the marker-bearing serialization, removes both markers with no checkpoint replacement, applies the fallback-ID correction, and requires the complete canonical Responses input to equal the marker-free serialization.

This whole-input check covers messages, reasoning, calls, outputs, IDs, metadata, and ordering. It catches Pi `transformMessages` synthesis such as `"No result provided"` when a temporary marker splits an assistant call from its real tool result.

On structural mismatch:

- Active checkpoint replay aborts fail-closed before provider transport.
- A possible-threshold request with no active checkpoint discards the marker-bearing context and records an unframed candidate. The finalized candidate path then compacts the exact payload or returns it unchanged.

Finalized replay:

- Rewrites only exact mapped assistant message IDs.
- Requires each mapped old ID to occur exactly once.
- Fails closed if an ID is missing or duplicated.
- Leaves native text IDs unchanged.
- Leaves reasoning IDs/signatures unchanged.
- Leaves function-call IDs, call IDs, and tool-result linkage unchanged.
- Uses Pi's serializer rather than copying or approximating serializer logic.

The same correction is applied after marker removal and checkpoint replacement construction, before token estimation or transport. Existing exact-current-nonce handling still treats unrelated marker-like user text as ordinary user input.

### Fixture matrix

Pinned marker-free comparisons cover:

- Active replay with fallback assistant text.
- Native assistant text IDs.
- Tool call/result pairs.
- Reasoning signatures plus fallback text.
- Repeated opaque replacement shape.
- Overflow retry with no live assistant.
- Duplicate/native-ID collision failure.
- Prefix, framed, and suffix position offsets.
- A start marker splitting a prefix call from a framed real result.
- An end marker splitting a framed call from a suffix real result.
- Real no-checkpoint fallback to an unframed threshold candidate with the real output preserved and no synthetic output.
- Real active-checkpoint fail-closed rejection of the same unsafe split.

Every safe fixture is structurally equal to a direct marker-free Pi serialization with the opaque replacement prepended.

## 3. Public handler-ordering audit

### Source finding

Pinned Pi stores handlers per extension and dispatches extensions, then handlers, in stored order. It exposes no priority, terminal stage, exclusive ownership, or order introspection:

- [generic and lifecycle dispatch](https://github.com/earendil-works/pi/blob/845d6ff1f6643aba440341cce877ce1c43ebbc39/packages/coding-agent/src/core/extensions/runner.ts#L796-L827)
- [`context`](https://github.com/earendil-works/pi/blob/845d6ff1f6643aba440341cce877ce1c43ebbc39/packages/coding-agent/src/core/extensions/runner.ts#L979-L1009)
- [`before_provider_request`](https://github.com/earendil-works/pi/blob/845d6ff1f6643aba440341cce877ce1c43ebbc39/packages/coding-agent/src/core/extensions/runner.ts#L1011-L1043)
- [`before_provider_headers`](https://github.com/earendil-works/pi/blob/845d6ff1f6643aba440341cce877ce1c43ebbc39/packages/coding-agent/src/core/extensions/runner.ts#L1045-L1074)

### Executable strategy results

Real `AgentSession` and public resource-loader tests cover all candidate strategies:

| Strategy | Result |
| --- | --- |
| Normal factory registration | Later extension runs later for all four hooks. |
| `session_start` deferred registration | Preserves extension order; later extension still runs later. |
| `resources_discover` deferred registration | Preserves extension order; later extension still runs later. |
| Package-list order | Reversing the list reverses package extension order. |
| Local and CLI paths | CLI and top-level local paths precede configured packages in the tested loader setup, but none is terminal. |
| Factory registration after reload | Same non-terminal order remains. |
| `session_start` or `resources_discover` deferral after reload | Tested deferred request hooks are not restored. |

No strategy remains terminal when an adversarial extension is loaded or registered later. Dynamic deferral cannot move an extension to the end of the runner's extension list, and it is not reload-safe.

### Minimal Pi proposal

`pi-hook-priority-proposal.md` specifies the smallest safe change:

- A distinct `pi.onTerminal(...)` method for the four required events.
- One terminal owner per event, validated before activation.
- Existing normal-handler order unchanged.
- Dispatch snapshots that place dynamically registered normal handlers before terminal ownership on the next dispatch.
- Fail-closed terminal errors.
- Existing normal cancellation behavior.
- Factory-only terminal registration.
- Atomic validation across startup, reload, and rediscovery.
- Adversarial core tests.

A distinct method is necessary because an old Pi would silently ignore an extra options argument to `pi.on`, while a missing `onTerminal` method fails extension loading visibly.

## Files changed

- `lifecycle.ts`
- `tests/lifecycle.integration.test.ts`
- `tests/fallback-id-parity.test.ts`
- `tests/hook-order.integration.test.ts`
- `remaining-work.md`
- `pi-hook-priority-proposal.md`
- `phase-four-results.md`

## Validation

Final validation:

- Unit: 38 tests across 6 files.
- Integration: 35 tests across 3 files.
- Repository TypeScript check: passed.
- Test-boundary check: passed.
- Package-directory Ultracite: passed.
- Package-directory Oxfmt, including Markdown: passed.
- Private-import and trailing-whitespace checks: passed.

No package/discovery wiring, dependency file, root package file, direct client, provider override, timeout, or unrelated dirty file was changed.

## Historical release gate

**GO at Phase 4:** retain the implementation for controlled manual testing. The former Pi terminal-hook recommendation is archived and is not current repository work.

**NO-GO:** general discovery, npm publication, or portable release on Pi 0.83.0.

Phase 5's private local package is an explicitly audited operational exception; general publication still requires terminal ownership.
