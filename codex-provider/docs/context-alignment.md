# Context alignment

Pi persists every completed assistant attempt, but automatic retry removes the retryable error from live `agent.state.messages` while retaining it in the session branch. A successful retry therefore leaves a deliberate persisted-versus-live divergence: the failed assistant remains in JSONL history but is absent from later provider requests.

Codex checkpoint replay treats the live `context` event as the authoritative pending request and the persisted branch as proof of the checkpoint boundary. It aligns them under these rules:

1. Retained branch messages must canonically equal their live counterparts.
2. The only permitted omission is a persisted assistant with `stopReason === "error"`.
3. Fresh live messages are allowed only outside the aligned branch as the preserved context prefix or suffix.
4. The checkpoint tail must be a canonical suffix of the branch projection.
5. Alignment must produce exactly one result; otherwise replay fails closed.

The framed checkpoint tail is built from matched live messages. Omitted retry errors are therefore not reintroduced from persisted history. Historical errors that remain in live context match normally and are retained.

This request-local proof handles trailing, interior, and repeated retry failures without persisting retry state or changing checkpoint schema v4/v5. Marker-free structural parity still validates the complete finalized Responses input before provider execution.

If alignment fails with an active checkpoint, the request is aborted and a redacted `codex-compaction.diagnostic` entry records counts, hashes, message shapes, and the first mismatch location.
