# Handoff: portable Codex compaction and controlled fallback

Purpose: give an independent implementer or reviewer the complete scope, evidence, and verification criteria for adding portable summaries, failure choice, and custom `/compact` instructions to `codex-provider`.

## Context

The requested work is:

> Compare the current `codex-provider` behavior with the current `pi-openai-server-compaction`, ignoring old releases. Add the useful parts: store a readable portable summary alongside the opaque OpenAI checkpoint; if remote compaction fails, let the user choose whether to use text compaction, with configuration that can force either outcome; and make custom `/compact <instructions>` affect the portable summary without affecting native OpenAI compaction.

This matters because an opaque OpenAI checkpoint provides the best continuation on a compatible Codex model, but it is unusable by another provider and unreadable in exports. A portable Pi summary solves that without changing compatible Codex input.

Assumptions about the reader:

- The reader has filesystem access to `/Users/gg/code/priv/clanker-extensions` and the two read-only checkouts named below.
- The reader understands TypeScript and Pi extension hooks, but has no access to the conversation that produced this report.
- No credentials or live OpenAI calls are required for the unit and integration work. Live validation requires the repository's existing authenticated canary setup.

Source state used for this report:

- `gjermundgaraba/clanker-extensions`, branch `main`, HEAD `375ad8c9e961d314b6bad14aae359034a0fd1036`.
- The relevant package exists only in the working tree at `/Users/gg/code/priv/clanker-extensions/codex-provider`; the worktree currently deletes `/Users/gg/code/priv/clanker-extensions/codex-compaction`, adds `codex-provider`, and modifies the workspace and lock files. HEAD alone does not contain the reviewed package state.
- `earendil-works/pi`, tag `v0.83.0`, commit `845d6ff1f6643aba440341cce877ce1c43ebbc39`, read-only checkout at `/Users/gg/.cache/checkouts/github.com/earendil-works/pi`.
- `algal/pi-openai-server-compaction`, branch `main`, commit [`8a3de2f3b0c178fdd6f73f2f94172dfc3943e466`](https://github.com/algal/pi-openai-server-compaction/tree/8a3de2f3b0c178fdd6f73f2f94172dfc3943e466), read-only checkout at `/Users/gg/.cache/checkouts/github.com/algal/pi-openai-server-compaction`.

## Implementation status

Implemented on 2026-08-03. The package now produces the portable and native artifacts concurrently, validates lifecycle fallback boundaries, applies the configured failure policy only to genuine remote failures, cleans up portable-summary provider sessions, and includes deterministic plus live-backend coverage. The implementation deliberately retains Pi 0.83.0's split-turn custom-instruction limitation documented below.

## Baseline before implementation

`codex-provider` currently creates a native OpenAI Responses V2 checkpoint and stores the literal text `[OpenAI encrypted compaction checkpoint]` as the Pi compaction summary. It rejects remote failures without changing context, warns once that custom `/compact` instructions are ignored, and blocks incompatible lifecycle-checkpoint replay. Compatible Codex requests frame the Pi context and replace that frame with the opaque checkpoint before sending the provider request.

Inline checkpoints are different: they are custom entries and do not remove Pi's plaintext history. The existing inline fallback can therefore ignore an incompatible inline checkpoint when no earlier native lifecycle compaction has made the Pi summary unusable.

The remaining sections preserve the implementation contract and its pre-change evidence for review.

## Findings and evidence

1. **Pi already provides the required portable summarizer.** Pi's exported `compact()` handles the normal structured format, previous summaries, split turns, file-operation annotations, custom instructions, and usage. Custom text is appended only to the history summarizer prompt as `Additional focus:`. Pi's separate split-turn-prefix prompt does not receive custom instructions, so the implementation and acceptance criteria must not claim otherwise. Evidence: `/Users/gg/.cache/checkouts/github.com/earendil-works/pi/packages/coding-agent/src/core/compaction/compaction.ts:622` and `/Users/gg/.cache/checkouts/github.com/earendil-works/pi/packages/coding-agent/src/core/compaction/compaction.ts:817`; pinned source: [`compaction.ts`](https://github.com/earendil-works/pi/blob/845d6ff1f6643aba440341cce877ce1c43ebbc39/packages/coding-agent/src/core/compaction/compaction.ts#L622-L918).

2. **The existing Pi summary field is sufficient persistence.** The lifecycle hook already returns a `CompactionResult` with `summary`, `details`, `firstKeptEntryId`, `tokensBefore`, and `usage`. The marker is assigned at `/Users/gg/code/priv/clanker-extensions/codex-provider/lifecycle.ts:858`. The opaque checkpoint remains independently stored under `details.checkpoint`. A second copy inside the checkpoint schema would add validation and migration work without enabling any behavior.

3. **Compatible native replay can remain provider-identical.** Finalized replay takes only `checkpoint.replacement` and substitutes it for the framed Pi context at `/Users/gg/code/priv/clanker-extensions/codex-provider/lifecycle.ts:1515`. Replacing the stored marker with readable text does not require that text to enter the final Codex request. Existing integration assertions already verify that the marker is absent from serialized provider input at `/Users/gg/code/priv/clanker-extensions/codex-provider/tests/lifecycle.integration.test.ts:1336` and `/Users/gg/code/priv/clanker-extensions/codex-provider/tests/lifecycle.integration.test.ts:2925`.

4. **Portability is currently blocked at the replay decision, not by Pi.** Incompatible lifecycle checkpoints return `blocked` at `/Users/gg/code/priv/clanker-extensions/codex-provider/lifecycle.ts:902`, while fallback returns control to Pi's ordinary context at `/Users/gg/code/priv/clanker-extensions/codex-provider/lifecycle.ts:1268`. The inline predicate at `/Users/gg/code/priv/clanker-extensions/codex-provider/checkpoint.ts:820` rejects fallback whenever the nearest earlier compaction is native, because that compaction currently has only the marker. Once that earlier entry has a real summary, Pi context is authoritative again.

5. **The reference implementation proves the two-artifact design but should not be copied wholesale.** `pi-openai-server-compaction` runs text and native compaction concurrently, routes custom instructions only to text generation, stores both results, and uses text when native compaction fails. Evidence: [`src/index.ts`](https://github.com/algal/pi-openai-server-compaction/blob/8a3de2f3b0c178fdd6f73f2f94172dfc3943e466/src/index.ts#L202-L290) and [`src/remote-compaction.ts`](https://github.com/algal/pi-openai-server-compaction/blob/8a3de2f3b0c178fdd6f73f2f94172dfc3943e466/src/remote-compaction.ts#L351-L355). Its custom prompt and placeholder fallback are unnecessary here because Pi's `compact()` is already available.

6. **Custom instructions are not deletion or native-checkpoint controls.** The reference repository's live test redacts a codeword from the readable summary and then proves the compatible OpenAI checkpoint can still recall it. Evidence: [`tests/live/openai-compaction-rpc-live.ts`](https://github.com/algal/pi-openai-server-compaction/blob/8a3de2f3b0c178fdd6f73f2f94172dfc3943e466/tests/live/openai-compaction-rpc-live.ts#L378-L427). Original Pi JSONL history also remains on disk. Any UI or documentation must avoid presenting custom summary instructions as secure deletion.

7. **Pi has the required failure-choice UI.** `ctx.ui.select(title, options, { signal })` returns a selected string or `undefined`; `ctx.hasUI` identifies interactive TUI and RPC contexts. Evidence: `/Users/gg/.cache/checkouts/github.com/earendil-works/pi/packages/coding-agent/src/core/extensions/types.ts:131` and `/Users/gg/.cache/checkouts/github.com/earendil-works/pi/packages/coding-agent/src/core/extensions/types.ts:307`. Returning `{ compaction }` installs an extension result, `{ cancel: true }` preserves context, and `undefined` lets Pi run its default compactor.

## Recommendations

1. **Generate two independent results in `/Users/gg/code/priv/clanker-extensions/codex-provider/lifecycle.ts`.** Import Pi's public `compact()` and run it concurrently with `runEffectiveProviderCompaction()` after resolving auth. Pass `event.preparation`, the selected model, auth, `event.customInstructions`, the combined abort signal, current thinking level, `providerRuntime.provider.streamSimple`, and provider environment. Do not pass custom instructions to the native request. Capture both outcomes without short-circuiting when native failure still permits text fallback. If the summary fails, abort a still-running native request because its result can no longer be installed, and await both operations before returning.

   Pi assigns every standalone summary request a fresh session ID. Ensure that ephemeral provider session and any cached WebSocket are closed after the summary stream settles; repeated lifecycle compactions must not grow the provider runtime's session map. Native standalone compaction already performs equivalent cleanup.

2. **Persist without changing the checkpoint schema.** On dual success, use the Pi result's `summary` and boundary fields, retain the existing native checkpoint in `details`, and combine local-summary and remote-compaction usage for the `CompactionEntry.usage`. Keep `checkpoint.response.usage` native-only. Remove `customInstructionsWarned` and the warning at `/Users/gg/code/priv/clanker-extensions/codex-provider/lifecycle.ts:706`.

3. **Use one failure policy with three values.** Reuse the package's existing environment-based configuration style and add `CLANKER_CODEX_COMPACTION_FAILURE=ask|fallback|cancel`, defaulting to `ask`. Parse it once when the extension is created, after trimming and lowercasing. An invalid value warns once and behaves as `ask`; without dialog-capable UI, `ask` behaves as `cancel`. `ask` should call `ctx.ui.select()` with explicit choices `Use portable text summary` and `Keep context unchanged`, passing the operation signal. Dismissal, abort, timeout, or no UI must resolve to `cancel`. `fallback` installs an already completed Pi summary without a second model call. `cancel` preserves the current fail-closed behavior.

4. **Centralize the portable-context safety predicate.** A lifecycle checkpoint is portable only when its `CompactionEntry.summary` trims to a non-empty string and is not the exact legacy marker after trimming. An inline checkpoint is portable when the underlying Pi history is authoritative, including when its nearest earlier native lifecycle compaction has a real summary. Use the predicate for incompatible-model replay, replay-only compaction, and remote-failure fallback. Invalid checkpoints, unresolved kept boundaries, stale source hashes, session/model changes, aborts, concurrent operations, and persistence verification failures must remain fail-closed rather than showing a fallback choice.

   Preserve native failure classification instead of reducing every exception to `ok: false`. Only an exhausted, genuine remote/model failure may enter the failure policy. Abort and stale/session-state failures cancel directly. Revalidate generation, session, branch, leaf, model identity, request-state hash, source hash, and signal after both requests settle and again after an awaited `ctx.ui.select()` before installing fallback.

5. **Make the persisted dual result atomic.** Use this result matrix:

| Native result | Pi summary result | Outcome |
| --- | --- | --- |
| Success | Success | Install readable summary plus native checkpoint |
| Failure | Success | Apply `ask`, `fallback`, or `cancel` policy |
| Success | Failure | Cancel; do not install a marker-only checkpoint |
| Failure | Failure | Cancel and report that no usable compaction was produced |

Atomicity here means no partial checkpoint is persisted. The two network requests can have independent side effects, so cancellation, settlement, and ephemeral-session cleanup are still required.

Tradeoffs: each Pi lifecycle compaction adds one ordinary summarization request, increasing cost and potentially latency. Running both requests concurrently minimizes added wall time but creates two simultaneous model requests. Inline checkpoints need no extra summary request because they retain Pi's authoritative plaintext context. Pi 0.83.0 applies custom instructions to the history portion of a split summary, not its separately generated turn-prefix portion; preserve and document that Pi behavior instead of cloning its private summarizer.

## Implementation boundaries

Expected production changes:

- `/Users/gg/code/priv/clanker-extensions/codex-provider/lifecycle.ts`: summary call, usage combination, failure policy/parser, UI choice, atomic result handling, custom-instruction routing, and lifecycle replay fallback.
- `/Users/gg/code/priv/clanker-extensions/codex-provider/checkpoint.ts`: update inline local-fallback eligibility when an earlier native lifecycle entry has a readable summary.
- `/Users/gg/code/priv/clanker-extensions/codex-provider/provider.ts`: release the fresh provider session created for each portable-summary stream after it settles.
- `/Users/gg/code/priv/clanker-extensions/codex-provider/README.md` and `/Users/gg/code/priv/clanker-extensions/codex-provider/docs/design.md`: configuration, portability, cost, plaintext-storage, and redaction limitations.

Expected test changes:

- `/Users/gg/code/priv/clanker-extensions/codex-provider/tests/lifecycle.test.ts`: policy parsing, portable-context eligibility, and usage combination.
- `/Users/gg/code/priv/clanker-extensions/codex-provider/tests/lifecycle.integration.test.ts`: dual persistence, custom-instruction isolation, compatible/incompatible replay, all policy outcomes, abort/stale behavior before and after a delayed choice, repeated compaction, and reload.
- `/Users/gg/code/priv/clanker-extensions/codex-provider/tests/checkpoint.test.ts`: inline fallback with no earlier compaction, a readable earlier native compaction, and a legacy marker-only native compaction.
- `/Users/gg/code/priv/clanker-extensions/codex-provider/tests/provider.test.ts`: repeated portable summaries release their ephemeral provider sessions and sockets.
- `/Users/gg/code/priv/clanker-extensions/codex-provider/scripts/live-multi-compaction.ts`: a lifecycle `/compact` mode covering readable persistence, custom-instruction isolation, compatible opaque replay, and opaque recall of information omitted from the readable summary.

Do not add a new checkpoint version, portable-summary field inside the checkpoint, custom summary prompt, JSON configuration subsystem, or summary request for inline checkpoints unless a failing acceptance test proves one is necessary.

## How to verify

Run from `/Users/gg/code/priv/clanker-extensions` after implementation:

```bash
pnpm --filter @clanker-extensions/codex-provider exec vitest run --project unit
```

Expected: exit code `0`; output ends with all discovered unit test files and tests passing, including policy parsing and checkpoint fallback eligibility.

```bash
pnpm --filter @clanker-extensions/codex-provider exec vitest run --project integration
```

Expected: exit code `0`; output reports no failed integration tests. Captured compatible Codex payloads contain exactly the opaque replacement and neither the portable-summary sentinel nor custom-instruction sentinel. Captured incompatible-provider context contains the portable-summary sentinel and no opaque compaction item.

```bash
pnpm --filter @clanker-extensions/codex-provider exec vitest run --project smoke
pnpm exec ultracite check codex-provider
pnpm typecheck
pnpm check:readmes
```

Expected: every command exits `0`; Vitest reports no failed smoke tests, Ultracite prints no diagnostics, TypeScript reports no errors, and README policy validation passes.

```bash
pnpm --filter @clanker-extensions/codex-provider test:live
pnpm --filter @clanker-extensions/codex-provider test:live:portable
```

Expected with valid existing OpenAI authentication: both commands exit `0`. The existing live canary completes its multi-compaction continuity assertions. The portable canary performs a real lifecycle `/compact`, persists a readable summary, proves compatible replay sends only the opaque replacement, and demonstrates that custom summary instructions do not alter the native checkpoint's recall. No credential value should appear in captured output or committed fixtures. A live second-provider credential is not required; incompatible-provider context shape remains deterministic integration coverage.

## Open questions

1. **Configuration surface:** Use `CLANKER_CODEX_COMPACTION_FAILURE` now because `codex-provider` already configures provider ownership through an environment variable. Do not add a persistent JSON file until more than one durable user preference exists.

2. **Automatic-compaction prompts:** Should `ask` display for manual, threshold, and overflow compaction failures? Recommendation: yes; the user requested a choice on failure. In headless operation or when the dialog is dismissed, cancel safely.

3. **Legacy marker-only sessions:** Must sessions created before portable summaries become cross-provider portable? Recommendation: no migration. Detect the marker and keep those boundaries fail-closed because their hidden history cannot be reconstructed faithfully from text.

4. **Native success with summary failure:** Should users be allowed to accept a native-only checkpoint? Recommendation: no. Atomic cancellation guarantees that every newly installed lifecycle checkpoint remains portable and avoids reintroducing the marker behavior this work is meant to remove.

## Appendix: acceptance cases

- A non-split `/compact Focus on database migration decisions` stores a summary reflecting that focus, while the native compaction request is byte-for-byte unaffected by the custom phrase.
- A split-turn `/compact` preserves Pi 0.83.0 semantics: custom instructions affect the history summary but not the separately generated turn-prefix section. A prefix-only split does not claim custom-instruction support.
- A compatible Codex turn after compaction uses the opaque replacement; the readable summary is absent from its provider request.
- A non-Codex turn after compaction receives the readable summary and retained Pi messages; it does not receive encrypted checkpoint data.
- If remote compaction fails after a local summary succeeds, `ask` presents two choices, `fallback` installs text automatically, and `cancel` leaves the branch unchanged.
- Escape, UI dismissal, abort, stale source, corrupt state, headless `ask`, and a delayed choice after session/model/branch/reload change never install a compaction implicitly.
- Ten repeated lifecycle compactions return the portable-summary provider session/socket count to its baseline after every round.
