---
name: bump-effect
description: Upgrade a repository's Effect dependencies, fix compatibility issues, and identify useful upstream changes to adopt in its code.
disable-model-invocation: true
metadata:
  upstream-source: "https://github.com/Effect-TS/effect"
  upstream-relationship: "reference"
---

# Bump Effect

Update the target repository's Effect baseline and leave its consumers working. Review opportunities to use the upstream changes as part of every run, alongside compatibility work. Implement required fixes; recommend optional adoption unless the user also requested implementation.

Use the requested repository, or the current repository when none is specified. Follow its `AGENTS.md`, Effect conventions, package manager, and validation rules. Preserve unrelated work. Do not commit, publish, or change global installations unless requested. Keep the report in the response unless a durable document was requested.

## Establish the upgrade

- Inspect manifests, workspace catalogs, overrides, patches, and lockfiles. Inventory `effect`, relevant `@effect/*` packages, and integrations with Effect peer requirements across the workspace. Record declared ranges and resolved versions separately, including multiple installed baselines where present.
- Resolve the latest stable published `effect` release from the npm registry; honor an explicit target or supported release line instead. Verify dist-tags, published versions, deprecations, peer requirements, and runtime/toolchain requirements. Do not infer the target from memory, upstream main, or a cached checkout. Do not silently downgrade a prerelease baseline to an older stable release.
- Choose a coherent published package set using the selected release's package policy and manifests. Check whether companion versions are synchronized or independently versioned; neither copying the core version onto every package nor taking every package's latest tag proves compatibility. Account for packages consolidated, renamed, or removed in the target release.
- Distinguish a library's supported peer range from its development pin. Preserve the repository's support policy, and change a peer range only when the resulting compatibility claim is justified. Flag a conflict between the requested upgrade and an established support policy before choosing a different policy.
- Record each affected package's old and target versions and recoverable source refs/commits. If already current, avoid artificial dependency edits and still perform the adoption review against the installed baseline, clearly labeling that there is no new upgrade range. If publication or compatibility cannot be verified, report the unresolved constraint rather than claiming a latest-version upgrade.

## Review the upstream changes

Use the published packages and matching source as API authority. Resolve the source repository from package metadata; the canonical Effect source is [Effect-TS/effect](https://github.com/Effect-TS/effect). Reuse a read-only checkout under `${LIBRARIAN_CACHE_ROOT:-$HOME/.cache/checkouts}/github.com/Effect-TS/effect`, or the repository's prescribed cache. Clone if absent and fetch missing refs as needed. Inspect with `git show`, `git diff`, or temporary extraction; do not switch or edit a shared checkout. Verify historical repository and tag mappings instead of assuming every release lives on the same branch or uses the same tag pattern.

Inspect the full old-to-target changed-file inventory and release notes/package changelogs for the selected package set, including intermediate releases. A core-package comparison alone may not cover every companion's range. Read the matching README, `LLMS.md`, and relevant docs, examples, and tests; consult `MIGRATION.md` and linked migration guides when crossing API or package reorganizations. Verify migration advice against target exports, types, and implementation.

Map relevant changes to actual local consumers, including shared helpers, examples, tests, public declarations, and package-consumer fixtures. Review changed semantics even when compilation succeeds. Follow the surfaces the repository uses, especially:

- Resource scopes, Layer lifetime/memoization, service requirements, interruption, finalization, and concurrency.
- Typed errors versus defects, retries, schedules, streams, queues, and backpressure.
- Schema decoding/encoding, defaults, transformations, generated schemas, and persisted or wire representations.
- HTTP clients/servers, middleware, RPC, CLI, AI/tool integrations, and platform-specific behavior.
- Public exports, browser/server boundaries, runtime requirements, and Effect type/module identity across dependencies.

Check stability annotations and the selected release's guarantees; a minor or patch bump is not proof that every used API is compatible. For each issue, establish the upstream change, local consumer, and concrete failure or changed contract. Separate required fixes, inherited upstream benefits, and optional adoption.

## Find useful adoption opportunities

Start from the repository's purpose and existing implementation. Map the reviewed upstream changes to local workarounds, custom machinery, missing capabilities, and consumer friction. Look for code Effect can now replace, stronger behavior it can provide, or useful features it makes practical. Focus on the upgrade range; label any older capability discovered along the way separately. This review is required even when no compatibility fix is needed.

Before recommending an opportunity:

- Verify that the API is public, exported, and available in the chosen package version and runtime. An internal helper or unreleased change is not an available replacement.
- Read enough source and examples to establish equivalent ownership, lifetime, error, cancellation, and serialization behavior. Explain any semantic differences or trade-offs.
- Check whether the repository already uses it or inherits the benefit automatically. Identify a concrete improvement: removable code, a resolved limitation, safer behavior, or a useful consumer capability. Novelty alone is not value.
- Name affected local files and the current behavior, link the upstream evidence and version/ref, and describe the proposed change. For public API or workflow changes, show concise consumer code before and after.
- State the smallest meaningful verification, expected complexity, and remaining uncertainty. Rank worthwhile candidates by benefit and risk; no worthwhile opportunities is a valid result.

Keep optional adoption distinct from the upgrade's required fixes. If implementation was requested, implement the supported opportunities within that scope and validate them; resolve consequential product choices where the existing instructions do not settle them. Otherwise provide actionable recommendations without turning the upgrade into a broad redesign.

## Implement and verify

- Update the existing dependency authorities and regenerate the lockfile with the repository's package manager. Preserve its pin/range conventions and avoid unrelated dependency churn. Where the repository has none of its own, follow the `effect-codebase` skill's dependency conventions (`references/DEPENDENCIES.md`) for peer ranges, CLI pins and release-age exclusions. Check the resolved graph for incompatible peers and unintended duplicate Effect baselines.
- Fix affected imports, callers, types, and runtime behavior directly. Reassess version-specific patches, overrides, and workarounds; remove only those the target makes unnecessary. Do not mask incompatibility with casts, suppressed checks, or unverified peer overrides.
- Update active baseline documentation, fixtures, and examples where affected. Preserve historical release references and use established generators for derived documentation or skills.
- Add or adapt regression coverage for demonstrated compatibility defects and implemented behavior changes. Use the smallest test layer that proves the contract, including runtime tests where types cannot establish resource, interruption, or protocol behavior.
- Run focused checks while iterating, then the repository's required full validation. For libraries, include existing declaration/type tests, builds, and package-consumer checks where applicable; compilation against a development pin alone does not establish the entire peer support range.
- Confirm a reproducible frozen/immutable-lockfile install with the package manager's supported command and review the final diff. Fix upgrade-caused failures; distinguish unrelated failures and blocked checks. Do not claim unrun live integrations were verified.

## Handoff

Report the package version/ref transitions, compatibility changes made, validation actually run, and remaining constraints. Present ranked adoption opportunities separately from implemented changes and benefits inherited automatically. State the review's coverage and any gaps.

End with **What changed in Effect** for the full reviewed release range: meaningful new capabilities, behavior/compatibility changes, and reliability fixes, omitting empty categories. Explain practical effects and relevance to this repository, including any remaining user action. Link the release notes/changelogs and exact source comparisons. Do not advertise changes outside the selected range or imply that a recommendation was implemented. For an already-current run, report that explicitly and summarize only the baseline capabilities actually reviewed.
