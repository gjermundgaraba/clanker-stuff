# Pi v0.87.0 upgrade review

Historical record of the initial upgrade, not a current validation guarantee or committed backlog. The [workspace catalog](../pnpm-workspace.yaml) owns the current dependency baseline; the provider’s [deployment contract](../pi/extensions/experimental/codex-provider/docs/local-deployment.md) and [context alignment](../pi/extensions/experimental/codex-provider/docs/context-alignment.md) describe the maintained behavior, including subsequent cleanup.

Compared [`v0.86.1...v0.87.0`](https://github.com/earendil-works/pi/compare/v0.86.1...v0.87.0): 18 commits, 136 changed files. The new tag resolves to `16787ad5b2dc748047f314ca1bfe7708f30f54f3`. npm's `latest` tag resolved to `0.87.0` for all nine Pi/Chord packages in our catalog.

## Applied changes

- Pinned all nine catalog packages, dependency overrides, release-age exceptions, and lockfile resolutions to `0.87.0`. Kept the `pi-coding-agent` → `pi-server` package extension: the published SDK still imports that undeclared dependency.
- Updated the Codex provider's exact-version deployment audit and current compatibility references. Historical source-review and copied-code references remain historical, not new compatibility claims.
- Updated the test host's required `turn_end` boundary fields and added canonical projection support.
- Changed both subagent protocols to fork `buildSessionProjection().messages`, not raw retained entries. Omitted attempts stay omitted, replacements are respected, and retain-none compaction forks only its summary.
- Changed Codex compaction input, retained user content, checkpoint tails, and turn-role decisions to use Pi's canonical projection. Removed the replay matcher's independent permission to drop arbitrary assistant errors: omission now requires a persisted context edit. Usage predating an edit is no longer reused for checkpoint sizing.
- Adapted Codex's ordinary `context` hook to the conversation-only contract; Pi restores the system prompt and tool declarations. Documented the separate `context_with_system` phase in the deployment contract.

Regression coverage includes context replacements/omissions, branch navigation, retain-none compaction, exact replay matching, and real-session retry/checkpoint replay. Integration fixtures also needed valid image bytes and updated expectations for request-setting capture and failed persistence.

## Compatibility findings

### Canonical history is the important migration

The [canonical-boundary change](https://github.com/earendil-works/pi/commit/466db0fe) makes `SessionManager` authoritative for future requests. `context_edit` entries omit or replace model-visible content without changing raw history, UI history, or usage. Flattening `buildContextEntries()` with `sessionEntryToContextMessages()` does **not** apply those edits.

This was a real Codex replay issue, not merely a new optional API: Pi now persists recovery omissions itself. The previous matcher could accommodate a missing error in the baseline while still rebuilding the checkpoint tail from the unedited branch. Both baseline and tail now use the same projection.

`context` and `side` already use `buildSessionContext()` and inherit the new projection. History/search should continue reading raw history. Recap's choice of raw versus effective conversation deserves a separate behavior decision, described below.

Direct assignment to `session.agent.state.messages` no longer restores provider context. No local restoration path depends on that behavior. Failed session appends likewise no longer leave an unpersisted message in canonical context; two subagent failure tests now assert that behavior while retaining their failure/receipt checks.

### Request and extension boundaries changed

- `turn_end` has persisted message IDs, `outcome`, proposed `entries`/`continue`, and a context snapshot including pending messages. `agent_before_settle` is a new actionable final boundary. Our production handlers do not construct or redispatch these events; the shared test host did need new required fields.
- `agent_settled` remains idle, but requested runs wait until all settled handlers finish instead of reentering immediately. Existing notification/settlement integrations remain covered by the real-session tests.
- `prepareRequest` runs before every provider call, including the first. A reasoning-effort change in `turn_start` now affects that first request; a change inside `context` remains too late for that request's captured settings. The provider integration test now checks those distinct boundaries.
- [`context` is conversation-only](https://github.com/earendil-works/pi/commit/aef5fc42). `context_with_system` runs afterwards and its full-transcript output is sent verbatim. Moving existing filtering hooks to the new event would unnecessarily take ownership of prompt/tool invariants; do not migrate them blindly.

### Other breaking surfaces checked

| Upstream change                                                                 | Local impact                                                                                                                              |
| ------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------- |
| `shouldStopAfterTurn` removed; use `finishTurn`                                 | No local callers. Error/aborted responses remain hard exits; the new callback also observes them.                                         |
| `ExtensionRunner.emit()` excludes actionable boundaries; use `emitBoundary()`   | No production caller needing migration.                                                                                                   |
| `ContextEditEntry` / `AgentBeforeSettleEvent` expand public unions              | Shared fixture updated; type-check and tests cover our consumers. Raw-history consumers intentionally retain raw entries.                 |
| `loadPromptTemplates()` returns `{ templates, diagnostics }`                    | No local callers.                                                                                                                         |
| Chord replicated `.state` / `.publish()` replaced by `.change()` / `.replace()` | No direct local consumers. Keep the transitive package pinned with Pi.                                                                    |
| Unknown Chat Completions endpoints default to non-strict tool schemas           | Intentional upstream compatibility fix. Our Codex Responses provider is separate; retain structural schemas and runtime value validation. |

## Opportunities, in priority order

### 1. Subagent mailbox scheduling and continuation

[`subagents/runtime.ts`](../pi/extensions/experimental/subagents/runtime.ts) currently infers a safe mailbox admission point from stop reasons, tool results, and `ctx.hasPendingMessages()`. The new boundary snapshot provides `outcome`, stable entry IDs, and the next queue-selected batch. Use those to strengthen admission and receipt tests, then consider `agent_before_settle` for the final admission decision.

The low-level `finishTurn` continuation decision also creates a possible path toward the documented Codex `end_turn:false` parity gap in SDK-owned child sessions. This is not automatic in v0.87.0, and an extension boundary's `continue: true` is not an unconditional scheduler: it must leave legal projected input, and normal tool/queue scheduling can satisfy the one requested continuation. Preserve terminating-tool, cancellation, durable-receipt, and final-answer deferral semantics; compose with the session's existing hooks rather than replacing them.

### 2. Background tasks and questionnaire delivery at final boundaries

[`background-tasks`](../pi/extensions/experimental/background-tasks/) and [`ask-question`](../pi/extensions/ask-question/) could admit already-available notifications at `agent_before_settle`, persisting a custom-message draft and requesting one continuation instead of starting another run after settlement. This may simplify late-completion races, but is not a reason to remove idle watchers, durable queues, or acknowledgments.

Boundary proposals are validated before persistence, not an atomic durable transaction. A later handler can replace an earlier proposal's fields; append to `event.entries` when composing. Human questionnaire answers must retain their user-input/approval semantics, not be silently recast as custom notification messages.

### 3. Context inspector and recap

The [`context` inspector](../pi/extensions/experimental/context/snapshot.ts) already counts effective context. `buildSessionProjection().entries` can additionally show raw-versus-projected provenance, edited content, and omitted attempts. That would make recovery and replay failures easier to explain without modifying history.

[`recap/runtime.ts`](../pi/extensions/experimental/recap/runtime.ts) still summarizes raw retained user/assistant entries. Consider projected message content for the generated recap so it does not summarize a superseded length-limited attempt or an explicitly replaced message. Keep raw-branch cadence accounting separate, and preserve the existing policy of excluding compaction summaries. This is a user-visible policy choice, not a mechanical version migration.

### 4. Model-specific image handling

The [new resize profiles](https://github.com/earendil-works/pi/commit/f5c94648) already apply to attachments, reads, and tool-result images. Codex's `view_image` delegates to Pi's read implementation and benefits automatically. Resizing happens before persistence; switching models does not rewrite old images and invalidate cached history.

[`codex-provider/model-catalog.ts`](../pi/extensions/experimental/codex-provider/model-catalog.ts) reconstructs remote models and currently does not preserve an existing model's `inputLimits`. A useful follow-up is to preserve that metadata, with tests, and support deliberate model-specific resize overrides rather than inventing provider limits. `maxPerMessage`, `maxPerRequest`, and `maxRequestBytes` are metadata only in this release, not enforced admission limits.

### 5. Lower-priority infrastructure

Chord's synchronous copy-on-write transactions and immutable replicated snapshots could support a future subagent/task dashboard. There is no present consumer to migrate, and this is not a replacement for our durable control stores.

Retain-none compaction is now directly expressible with `SessionManager.appendCompaction(summary, null, tokensBefore)` or a compaction boundary draft. This could simplify an explicit summary-only reset. The older `session_before_compact` result still requires a string kept-entry ID; do not pass `null` to that API.

## Benefits requiring no extension rewrite

- Filtering/slicing ordinary context no longer loses the current prompt and tools.
- Image limits are applied consistently, and text beginning with `GIF` is no longer mistaken for an image.
- Late cache-warming callbacks cannot rebuild an expired cache.
- Extension crash stack hints and prompt-frontmatter diagnostics improve debugging.
- Fullscreen jump-to-end centering is fixed; no private editor-layout change was found in this diff.
- Offline `/bug` blocks uploads while retaining local exports. This does not change the separate `/share` privacy warning.

## Validation and remaining limits

`vp run ready` passed: formatting, lint, types, package/README/test-boundary checks, and 2,581 tests across 228 unit/integration/smoke files. The real-session tests use controlled providers; they do not prove live OpenAI transport compatibility.

Before daily-driving the Codex provider, rerun its [local deployment audit and live canaries](../pi/extensions/experimental/codex-provider/docs/local-deployment.md) against the installed Pi and actual extension order. Those installation-specific and paid live checks were not run as part of this repository upgrade.

Projected edits to the live checkpoint tail are covered. Arbitrary retroactive edits to history already absorbed into an opaque remote checkpoint cannot rewrite that checkpoint. Supporting those edits needs an explicit invalidation/recompaction policy; the migration does not claim that capability. Likewise, full-transcript third-party transforms need explicit Codex replay compatibility testing even when this provider is loaded last.
