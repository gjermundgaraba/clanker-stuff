# Codex compatibility

This provider and `../subagents` exist to minimize model-facing distribution shift from the native Codex CLI harness. For every surface this package owns, prefer the pinned Codex behavior for requests, tools, schemas, descriptions, ordering, results, transport, continuation, and compaction. Do not introduce a Pi-specific difference merely for convenience.

A difference is acceptable only when the backend reserves the native contract, Pi cannot execute it truthfully, matching would reduce safety or correctness, or Pi lacks the required host representation. Keep every difference explicit and tested.

Before changing model-facing tools, requests, model metadata, transport, continuation, compaction, or replay, read `docs/codex-baseline.md` and `docs/design.md` completely and follow their Codex/Pi source links. For collaboration namespaces, schemas, or Code Mode exposure, also read `../subagents/docs/protocols.md` and `../subagents/docs/codex-parity.md`.

Keep the Code Mode host binary current with stable OpenAI Codex releases. During Codex model or harness compatibility updates, check the latest official release and follow [Code Mode host upkeep](docs/codex-baseline.md#code-mode-host-upkeep): update the pinned release and all platform checksums together, review protocol changes, and run the real-host check. If an incompatibility prevents updating, document the blocking behavior and retained version there.
