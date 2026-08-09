# Context alignment

Pi persists every completed assistant attempt, but automatic retry removes a retryable error from live `agent.state.messages` while leaving it on the active session branch. A successful retry therefore creates an intentional persisted-versus-live difference.

Checkpoint replay treats the live `context` event as the pending request authority and the persisted branch as proof of the checkpoint boundary. [`frameContiguousBaseline`](../replay.ts) and the lifecycle hooks enforce these rules:

1. Retained branch messages must canonically equal their live counterparts.
2. The only permitted omission is a persisted assistant with `stopReason === "error"`.
3. Fresh live messages may appear only outside the aligned branch as the preserved prefix or suffix.
4. The checkpoint tail must be a canonical suffix of the branch projection.
5. Alignment must produce exactly one result; missing or ambiguous alignment fails closed.

The framed segment is built from matched live messages, so omitted retry errors are never reintroduced from JSONL history. Historical errors that still exist in live context match normally.

Temporary frame markers prove which serialized Responses items came from the aligned segment. Before provider execution, the extension removes the markers, substitutes checkpoint v1 history, repairs only Pi-generated fallback IDs whose marker-free identity is proven, and compares the complete result with marker-free serialization. Native IDs and valid tool linkage are never rewritten.

This handles trailing, interior, and repeated retry failures without persisting retry state. It also preserves prefix/suffix content added by earlier hooks. Active checkpoint replay aborts if later hooks duplicate or move a marker, split a tool pair, mutate the branch, change request state, or otherwise break structural parity.

Failure writes a best-effort SQLite observation containing counts, hashes, message shapes, and the first mismatch location. It contains no prompt text or provider secrets. Coverage is in [request framing tests](../tests/replay.test.ts), [fallback-ID parity tests](../tests/fallback-id-parity.test.ts), and [real-session lifecycle tests](../tests/lifecycle.integration.test.ts).
