# Codex compatibility

This extension and `../codex-provider` exist to minimize model-facing distribution shift from the native Codex CLI harness. Match the pinned Codex collaboration contract as closely as Pi can truthfully execute it, including tool families, schemas, descriptions, ordering, results, prompts, messages, history, errors, persistence, and lifecycle behavior. Do not introduce a Pi-specific difference merely for convenience.

A difference is acceptable only when the backend reserves the native contract, Pi cannot execute it truthfully, matching would reduce safety or correctness, or Pi lacks the required host representation. Record every difference in `docs/codex-parity.md` and cover it at the smallest practical test layer.

Before changing a collaboration surface, read its normative section in `docs/protocols.md`, the applicable rows in `docs/codex-parity.md`, and the matching pinned Codex sources. Use this topic map for the longer references:

- tool placement, schemas, results, or errors: `docs/codex-model-facing-contract.md` §§2, 4, 5, and 11;
- prompts, roles, or delegation policy: §§3, 6, and 7;
- child instructions, history, or messages: §§8–10;
- lifecycle, persistence, or application ownership: the relevant sections of `docs/codex-reference.md`.

For provider placement, namespaces, or Code Mode, also read the relevant sections of `../codex-provider/docs/codex-baseline.md` and `../codex-provider/docs/design.md`. After changing the pinned commit, extractor, catalog declarations, namespace ordering, tool families, or stock V2 spawn contract, run `pnpm --filter @clanker-stuff/subagents exec node scripts/extract-codex-contracts.ts --check`.
