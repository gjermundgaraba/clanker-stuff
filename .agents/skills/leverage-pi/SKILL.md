---
name: leverage-pi
description: Find useful Pi APIs and capabilities to adopt in a specified extension or area, or across this repository's Pi extensions. Research and recommend without editing by default.
---

# Leverage Pi

Find concrete ways to improve existing extensions using Pi's capabilities: simpler implementations, fewer workarounds, stronger behavior, or useful product features. Research and recommend only unless implementation is explicitly requested. Do not upgrade dependencies as part of discovery; use [bump-pi](../bump-pi/SKILL.md) for upgrades.

Paths below are repository-relative unless stated otherwise. Follow `AGENTS.md` for upstream source and repository conventions.

## Set the scope and baseline

- Use the requested extension or area. Without one, cover both `pi/extensions/` and `pi/extensions/experimental/`, following shared code in `pi/packages/` where relevant. State any coverage limits rather than implying a sampled audit covered everything.
- Default to all useful capabilities available in the version pinned in `pnpm-workspace.yaml`, including older APIs the code has not adopted. Do not limit discovery to the most recent changelog.
- Honor an explicit version range or an upgrade handoff's old-to-target range. State the inspected versions and refs. If a candidate requires a newer release or unreleased code, label that prerequisite; do not present it as available on the current pin.
- Inspect refs through the read-only source cache described in `AGENTS.md`. Read the selected README and relevant docs/examples, and search public exports and implementations before proposing a replacement. Do not switch or edit the shared checkout.

## Find and verify opportunities

Start from the extension's purpose, registrations, dependencies, and existing behavior. Look for local machinery that Pi can now own, workarounds whose original constraints may have disappeared, and capabilities that unlock a useful extension improvement. For a supplied diff, map relevant upstream changes to actual local consumers.

Explore only relevant surfaces: lifecycle and delivery hooks, context projection and compaction, structured prompts, tools, provider/model metadata, TUI/editor facilities, and SDK/package APIs. This is not a requirement to propose something in every category.

Before recommending an opportunity:

- Verify the API is exported and reachable in the actual extension or SDK runtime, not merely present in upstream internals or another mode.
- Read enough implementation and examples to understand ordering, ownership, persistence, cancellation, and failure behavior. Confirm that the proposed simplification really replaces the local responsibility rather than moving or losing it.
- Check whether the extension already uses it or inherits the benefit automatically. Do not recommend redundant adoption work.
- Identify the user benefit or code that can be removed. API novelty alone is not value; no worthwhile change is a valid finding.
- Separate compatibility defects from optional improvements. Identify behavior changes and product choices rather than silently treating them as refactors.

Use targeted read-only inspection and non-mutating probes where needed to resolve concrete uncertainty. Do not write implementation, upgrade reports, or research artifacts into the repository by default. Do not run paid/live tests without authorization. If a capability cannot be used from an extension today, state that limitation rather than proposing changes to Pi itself.

## Report actionable findings

Rank the worthwhile opportunities by benefit, complexity, and risk. For each, provide:

- The affected local files and current behavior or workaround.
- The upstream API/capability with version/ref and source or documentation evidence.
- The proposed change and concrete benefit, including removable code where applicable.
- Constraints, behavior trade-offs, unresolved questions, and upgrade prerequisites.
- The smallest meaningful verification for an implementation.

Distinguish ready-to-adopt changes, investigations needing more evidence, and benefits requiring no local edits. Summarize coverage and recommend a focused next step; avoid padding the report with speculative features or a generic API inventory.

If implementation was requested, proceed within that authorization, resolve consequential open choices, and follow the repository's scoped-to-broad validation rules. Otherwise stop at the recommendations.
