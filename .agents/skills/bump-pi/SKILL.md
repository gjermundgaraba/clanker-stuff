---
name: bump-pi
description: Upgrade this repository's Pi dependencies to the latest stable release and fix extension compatibility issues found in the upstream diff.
disable-model-invocation: true
---

# Bump Pi

Update the repository's Pi baseline and leave affected extensions working on it. Implement necessary compatibility fixes; report optional feature adoption separately. Do not update the user's global Pi installation, change installed extensions, or commit unless requested.

Paths below are repository-relative unless stated otherwise. Follow `AGENTS.md` for source-cache, package, and validation rules. Preserve unrelated working-tree changes.

## Establish the upgrade

- Read the current pin from `pnpm-workspace.yaml`. Resolve the latest stable published `@earendil-works/pi-coding-agent` release from the npm registry; do not infer it from the global executable, a cached checkout, or upstream main. Honor an explicitly requested target instead. Record the old and target versions and source commits.
- Inspect the Pi-family catalog, overrides, package manifests, lockfile, release-age exceptions, and package extensions. Verify which companion packages are published and required at the target; do not assume a fixed package list or blindly bump unrelated dependencies.
- Use the read-only `earendil-works/pi` source cache described in `AGENTS.md`. Fetch missing refs and inspect the old and target tags with `git show`, `git diff`, or temporary extraction; never switch or edit the shared checkout.
- If already at the target, report that rather than manufacture an upgrade. If the release or required packages cannot be verified, state the blocker instead of claiming a latest-version upgrade.

## Review compatibility, not just compilation

Inspect the complete old-to-target diff's changed-file inventory and release notes, then trace relevant implementation changes to local consumers. Include stable and experimental extensions, shared Pi packages, and affected harnesses or scripts. Read the target README and relevant upstream docs/examples according to `AGENTS.md`; release notes alone are not the contract.

Prioritize changes to imported APIs, runtime behavior, and assumptions that types cannot prove. Where affected, examine:

- Session history versus effective context, replay, forks, and compaction.
- Lifecycle ordering, queued input, cancellation, retries, and message persistence.
- Provider requests, structured prompts, tool schemas/results, model metadata, and streaming.
- TUI/editor behavior, host module identity, package exports, and runtime loading.

For each issue, establish the upstream change, the local consumer, and the concrete failure or changed contract. Distinguish required fixes from inherited benefits and optional opportunities. Do not treat every new API as a reason to rewrite an extension.

## Implement and verify

- Align the required Pi-family versions through the workspace catalog/overrides and regenerate `pnpm-lock.yaml` with `vp install`. Preserve host-provided `"*"` peer contracts; exact development pins are not a reason to replace them.
- Reassess version-scoped package workarounds against the new published manifests. Remove resolved workarounds, retain only verified needs, and keep any release-age exceptions narrowly scoped.
- Update active compatibility gates, fixtures, and supported-baseline documentation as needed. Do not blanket-replace historical version references or introduce duplicate version authorities.
- Fix compatibility problems and update affected callers directly. Prefer supported Pi APIs over local workarounds, but preserve real persistence, cancellation, and runtime safety contracts. Ask only where a consequential product choice remains unresolved.
- Add or adapt regression coverage that would detect the actual defect. Start with affected package checks; use real `AgentSession` integration tests for lifecycle behavior and smoke tests for discovery/runtime wiring. Follow repository test-boundary rules rather than testing implementation shape.
- Run repository-wide `vp run ready` before handoff because the dependency baseline is shared. Confirm a frozen-lockfile install and review the final diff. Fix upgrade-caused failures; distinguish unrelated failures and report any blocked checks. Do not run paid live canaries or modify installed environments without authorization.

## Handoff

Report the version/ref transition, compatibility changes, checks actually run, and remaining risks. List worthwhile optional opportunities briefly and route deeper investigation to [leverage-pi](../leverage-pi/SKILL.md), carrying forward the exact diff range. Keep the report in the response unless a durable document was requested.
