# Context alignment

Pi owns the canonical projection. It persists every completed assistant attempt and appends `context_edit` omissions for selected recovery attempts. Raw history retains those attempts; `buildSessionProjection()` applies omissions and content replacements to the model-visible history.

Checkpoint replay treats the live `context` event as the pending request authority and the persisted branch as proof of the checkpoint boundary. [`frameContiguousBaseline`](../replay.ts) and the lifecycle hooks enforce these rules:

1. Retained branch messages must canonically equal their live counterparts.
2. Both the baseline and checkpoint tail use Pi's canonical projection. Only persisted context edits may omit or replace history; the framing matcher never independently discards assistant errors.
3. Fresh live messages may appear only outside the aligned branch as the preserved prefix or suffix.
4. Raw-tail entry IDs select the projected checkpoint tail; it is a suffix of the baseline. Pi places retained pre-compaction entries after the compaction entry, so slicing after its projected position would include already checkpointed history.
5. Alignment must produce exactly one result; missing or ambiguous alignment fails closed.

Framing locates one complete baseline in the live conversation and takes its checkpoint-tail suffix from those live messages. It has no error-specific omission behavior: historical errors still present in the projection must match normally. Real-user retention also uses projected content, and usage recorded before the latest context edit is not reused for checkpoint sizing.

Temporary frame markers prove which serialized Responses items came from the aligned segment. Before provider execution, the extension removes the markers, substitutes checkpoint v1 history, repairs only Pi-generated fallback IDs whose marker-free identity is proven, and compares the complete result with marker-free serialization. Native IDs and valid tool linkage are never rewritten.

Pi’s persisted recovery edits handle abandoned attempts; replay preserves fresh prefix/suffix content added by earlier hooks. `context` is conversation-only; Pi restores prompt/tool declarations afterwards. A `context_with_system` handler runs after all ordinary context handlers regardless of extension order, so third-party full-transcript transforms still require explicit compatibility validation. Active checkpoint replay aborts if later hooks duplicate or move a marker, split a tool pair, mutate the branch, change request state, or otherwise break structural parity.

Context edits to the live checkpoint tail are respected. Edits to history already absorbed into an opaque remote checkpoint cannot rewrite that checkpoint; retroactive editing needs a separate invalidation/recompaction policy and is not supported by this replay contract.

Failure writes a best-effort SQLite observation containing counts, hashes, message shapes, and the first mismatch location. It contains no prompt text or provider secrets. Coverage is in [request framing tests](../tests/replay.test.ts), [fallback-ID parity tests](../tests/fallback-id-parity.test.ts), and [real-session lifecycle tests](../tests/lifecycle.integration.test.ts).
