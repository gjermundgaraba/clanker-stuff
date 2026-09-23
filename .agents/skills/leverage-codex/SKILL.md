---
name: leverage-codex
description: Research Codex source changes and capabilities worth adopting in this repository's Pi extensions, targeting the latest stable release tag unless specified otherwise. Report recommendations without editing by default.
---

# Leverage Codex

Find useful Codex behavior, features, and implementation ideas for existing Pi extensions. Research and report only unless the user authorizes changes. Discovery does not authorize refreshing repository docs, regenerating contract fixtures, advancing upstream markers, or updating dependencies and binaries.

Paths below are repository-relative unless stated otherwise. Follow `AGENTS.md` and applicable package instructions. Do not commit or change installed environments unless requested.

## Establish scope and source versions

- Use the requested extension or area. Without one, identify Codex-derived extensions across `pi/extensions/` and `pi/extensions/experimental/` using upstream markers, research documents, and code references. Follow shared packages where relevant; do not assume only `codex-provider` and `subagents` matter.
- Resolve the latest official stable Codex release tag from `openai/codex` release metadata, excluding drafts and prereleases, and verify the tag's commit. Record the tag and full commit. Do not substitute upstream main, the installed CLI, a cached HEAD, or the lexicographically largest tag. Honor an explicitly requested version, ref, branch, or comparison range instead; resolve moving refs once for a consistent investigation.
- Use `~/.cache/checkouts/github.com/openai/codex` as a reusable read-only source cache. Partial-clone it if absent and fetch missing refs as needed. Read refs with `git show`, `git diff`, or temporary extraction; never edit, reset, or switch the shared checkout. If the current release cannot be verified, state the limitation rather than claiming the cache is latest.
- Identify each component's actual comparison baseline from its `UPSTREAM` files, source citations, parity ledgers, and binary/protocol pins. These may differ, including feature-specific commits. Keep the research target, adopted source baseline, and Code Mode host version distinct.
- Check ancestry before describing a delta as an upgrade. If a recorded baseline is newer than or diverges from the stable target, explain that relationship and compare the relevant behavior without recommending an automatic rollback. Missing or stale provenance is uncertainty, not permission to invent a baseline.

## Connect upstream findings to local behavior

Review release notes and changed-file inventories between the applicable refs, then trace relevant source and tests. Also consider useful capabilities already in the target that local code has never adopted. Changelog entries alone do not establish behavior.

Start with local responsibilities and pain points. Follow relevant surfaces such as provider requests and transport, tool contracts and placement, Code Mode protocols, collaboration and delegation, context/compaction, model metadata, user interaction, and usage reporting. Do not manufacture findings for every category.

Use package instructions to select the necessary references: provider baseline/design docs for provider contracts, subagent protocols/parity docs for collaboration, and an extension's research docs for borrowed features. Verify claims against source at the recorded target, not documentation from another revision.

For each candidate:

- Identify the precise upstream change or capability and the local code that would benefit. Check whether it is already implemented or inherited automatically.
- Distinguish a correctness defect, a model-facing parity gap, an optional product feature, and a simplification. A parity gap is not itself proof of a local failure.
- Verify feature gates and stable defaults. Code present in a stable tag may still be experimental, disabled, backend-reserved, or confined to a different runtime such as the app server rather than the CLI.
- Establish how Pi can execute the behavior with the repository's pinned host APIs. Codex's internal Rust implementation is a reference, not an API that a Pi extension can automatically call. Identify host, protocol, binary, or backend prerequisites explicitly.
- Preserve the provider/subagents goal of minimizing model-facing differences. Propose deliberate deviations only under their documented criteria; do not trade away ordering, persistence, cancellation, or correctness merely to reduce code.
- Explain the concrete user benefit or removable machinery. Avoid copying native architecture when the same behavior can be achieved more simply within Pi's actual ownership boundaries. If Pi cannot support it today, state the limit rather than proposing changes to Pi itself.

Use targeted read-only inspection and non-mutating probes to resolve material uncertainty. Do not run paid/live inference without authorization. Broad test suites are not a substitute for verifying the claimed upstream behavior.

## Report and hand off

State the inspected target, per-component baselines, scope, and verification limits. Rank worthwhile findings by benefit, effort, and risk. For each, provide:

- Upstream evidence tied to a tag/commit and source path.
- The affected local files and current behavior.
- The proposed change, its value, and any behavior trade-offs.
- Prerequisites, unresolved product choices, and the smallest meaningful validation.

Separate actionable fixes, optional adoption, unresolved investigations, and benefits requiring no local changes. Identify stale research or generated contracts that merit refreshing, without presenting a research target as already adopted. No worthwhile change is a valid conclusion.

Stop at recommendations by default. If the user authorizes documentation refreshes or implementation, complete that scope without redundant approval gates and follow package-specific checks. In particular, a Code Mode host update requires its release pin, all platform checksums, protocol review, and real-host validation together; it is not implied by inspecting a newer Codex tag.
