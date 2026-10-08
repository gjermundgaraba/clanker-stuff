---
name: bump-alchemy
description: Upgrade a repository's Alchemy infrastructure dependencies, fix compatibility issues, and identify useful upstream capabilities to adopt in its stacks and providers.
disable-model-invocation: true
metadata:
  upstream-source: "https://github.com/alchemy-run/alchemy"
  upstream-relationship: "reference"
---

# Bump Alchemy

Update the target repository's Alchemy baseline and leave its stacks and providers compatible. Review opportunities to use the upstream changes as part of every run. Implement required compatibility fixes; recommend optional adoption unless the user also requested implementation.

Use the requested repository, or the current repository when none is specified. Follow its `AGENTS.md`, infrastructure conventions, package manager, runtime, and validation rules. Preserve unrelated work. An upgrade request covers repository changes and read-only validation; deploying infrastructure, changing live state, or running tests that provision resources needs authorization covering those actions. Honor authorization already given. Do not commit, publish, or change global installations unless requested. Keep the report in the response unless a durable document was requested.

## Establish the upgrade

- Inspect manifests, lockfiles, catalogs, overrides, and patches. Inventory `alchemy`, used `@alchemy.run/*` packages, and coupled dependencies such as `effect`, `@effect/*`, and `@distilled.cloud/*`. Record declared ranges and resolved versions separately. Identify stack entrypoints, custom providers, state backends, stages, credential wrappers, and commands used by CI and operators.
- Resolve published versions and dist-tags from the npm registry. Honor an explicit target or supported release line. For a stable baseline, default to the latest stable release. For a prerelease baseline, follow the existing major and channel, or its stable successor within that major. Do not assume `latest` points to the intended generation, downgrade a beta to an older stable line, or choose an unrelated canary/PR build. State the selected channel and target.
- Verify the selected package's repository/ref, dependencies, required and optional peers, and runtime/toolchain requirements. Use its actual manifests and release policy to select companion versions; do not apply one version number across unrelated package families. Install optional integrations only where used. Change Effect or cloud SDK pins when needed for Alchemy compatibility or explicitly requested, rather than treating this as an independent upgrade of every dependency.
- Check direct SDK imports against the versions Alchemy uses and inspect material transitive SDK changes where they affect local providers. Preserve the repository's runtime and package-manager choices even when upstream examples use another toolchain.
- Record affected packages' old and target versions and source refs/commits. If already current, avoid artificial dependency edits and still review adoption against the installed baseline, labeling that there is no new upgrade range. If the release or compatible package set cannot be verified, report the unresolved constraint rather than claiming a completed upgrade.

## Review the upstream changes

Use published packages and matching source as API authority. Resolve the repository from package metadata; the canonical Alchemy source is [alchemy-run/alchemy](https://github.com/alchemy-run/alchemy). Reuse a read-only checkout under `${LIBRARIAN_CACHE_ROOT:-$HOME/.cache/checkouts}/github.com/alchemy-run/alchemy`, or the repository's prescribed cache. Clone if absent and fetch missing refs as needed. Inspect with `git show`, `git diff`, or temporary extraction; do not switch or edit a shared checkout. Verify historical repository, branch, and tag mappings instead of mixing APIs from different Alchemy generations.

Inspect the complete old-to-target changed-file inventory, release notes, and package changelogs, including intermediate releases. Read the matching README and relevant documentation, migration guides, examples, and tests. Trace behavior through the planner, engine, and providers where release notes leave the contract unclear. A core-package comparison may not cover every changed companion's range.

Map relevant changes to the repository's actual stacks, providers, helpers, tests, scripts, and deployment configuration. Review semantics even when compilation succeeds, especially:

- Stack/stage namespaces, logical IDs, physical names, resource types, references, and ownership of existing resources.
- Provider lifecycle methods such as `read`, `diff`, `reconcile`, and `delete`: missing resources, unresolved inputs, replacement decisions, retry/idempotency, and recovery after interrupted operations.
- Outputs and dependency ordering, observation versus saved attributes, drift detection, and verification that a write took effect.
- Retention/deletion policies, adoption and renames, state serialization and migrations, secrets, locking, and interrupted replacements.
- Provider defaults, credentials, permission grants, network exposure, build artifacts, runtime bindings, and CLI flag/command behavior.

For each issue, establish the upstream change, local consumer, and concrete failure or changed contract. Separate required fixes, inherited benefits, and optional adoption. A prerelease version increment is not evidence that persistence or provider contracts stayed compatible.

## Find useful adoption opportunities

Start from the repository's purpose and existing machinery. Look for native resources, provider helpers, Output operations, state/rename support, drift handling, or build/runtime integrations that can remove custom code or resolve a real limitation. Focus on changes in the upgrade range; label older capabilities discovered along the way separately. Perform this review even when no compatibility fixes are needed.

Before recommending an opportunity:

- Verify the API is public, exported, and usable in the selected version and runtime. Check whether the repository already uses it or inherits the benefit automatically.
- Identify affected local files, current behavior, the proposed change, and a concrete benefit. Link upstream source or documentation at the relevant version/ref. Show concise before/after stack or provider code when the change affects how the repository expresses infrastructure.
- For a native provider replacing a custom provider, verify resource identity, ownership, observation, reconciliation, drift, retention, and error behavior. Less code is not an improvement if it drops an existing guarantee or recreates an existing resource. Describe any supported state/adoption migration needed; API similarity alone is insufficient.
- Call out changes to permissions, reachability, costs, replacement behavior, or stored state. Explain remaining uncertainty and the smallest meaningful verification. Rank worthwhile candidates by benefit, complexity, and risk; no worthwhile opportunities is a valid result.

Keep optional adoption separate from required compatibility fixes. If implementation was requested, implement supported opportunities within that scope, resolving consequential infrastructure choices that existing instructions do not settle. Authorization to edit an adoption candidate does not itself authorize applying it to live infrastructure.

## Implement and validate

- Update the existing dependency authorities and regenerate the lockfile with the repository's package manager. Preserve pin/range conventions and review unrelated churn, peer conflicts, and duplicate coupled runtimes. Reassess version-scoped patches and workarounds against the target; remove only verified obsolete ones.
- Fix affected callers, providers, and scripts directly. Preserve resource identity, state-backend selection, stage defaults, retention, and access policy unless a change is required and within the requested scope. Identify a required migration explicitly; do not hide it in a rename, state reset, forced adoption, or relaxed deletion policy.
- Update active baseline documentation and fixtures where affected, preserving historical references. Add or adapt regression coverage for demonstrated defects: meaningful cases include missing or drifted resources, unresolved inputs, retained deletion, replacement, and interrupted reconciliation when those contracts changed. Use local mocks or isolated state fixtures for engine/provider behavior where appropriate.
- Run focused checks, then the repository's required full local validation. Inspect test/build scripts before running them: infrastructure test and development commands may provision resources. Do not invoke a deploy wrapper as a shortcut to its embedded lint/test commands. Confirm a reproducible frozen/immutable-lockfile install and review the final diff.
- Use the repository's prescribed plan and drift commands for live read-only validation where available. First inspect their wrappers and stack evaluation for side effects; if they bootstrap resources, migrate state, or otherwise write remotely, treat that part as a live mutation. Use existing credential handling without exposing secret values or raw state in logs or reports. If credentials or a safe preview are unavailable, finish local checks and state the validation gap.
- Review the entire plan for unexpected creates, replacements, deletions, renames, access changes, and state migrations. Account for known pre-existing changes where evidence is available. Do not hide an unexplained action with filters, snapshot updates, forced adoption, or state edits. A partial plan validates only the selected resources.
- Fix upgrade-caused failures and distinguish unrelated failures or blocked checks. If deployment is authorized, follow the repository's deployment gates and verify the result with its service checks, plan, and drift checks. Otherwise hand off the validated repository changes and any deployment prerequisites without applying them.

## Handoff

Report package/channel/ref transitions, compatibility changes made, checks actually run, and remaining constraints. Distinguish local checks, live plan/drift results, and any authorized deployment verification. Describe expected resource or state changes and unresolved plan actions. Present ranked adoption recommendations separately from implemented changes and inherited benefits, with review coverage and gaps.

End with **What changed in Alchemy** for the full reviewed release range: meaningful capabilities, behavior/compatibility changes, and reliability fixes, omitting empty categories. Explain practical effects on this repository and any migration or operator action still needed. Link release notes/changelogs and exact upstream comparisons. Do not advertise changes outside the selected range or imply recommendations were implemented or deployed. For an already-current run, state that explicitly and summarize only the baseline capabilities actually reviewed.
