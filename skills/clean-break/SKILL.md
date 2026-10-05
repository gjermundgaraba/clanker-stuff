---
name: clean-break
description: Apply a clean-break cleanup when the user explicitly permits breaking compatibility or establishes a pre-launch, no-users scope.
---

# Clean Break

Apply this stance only to product code where the user has authorized breaking compatibility or established a pre-launch, no-users scope. Preserve safeguards required by real users, persisted state, live infrastructure, and deploy tooling.

Within that scope, remove compatibility machinery for interfaces being retired. Prefer durable, simple, direct solutions. Delete, don't wrap.

## The stance

- One path for the supported design. Remove legacy fallbacks and dual old/new paths.
- Remove compatibility shims, re-export aliases, and deprecated stubs for interfaces being retired. Rename and move directly; fix the call sites.
- No migrations unless real persisted state actually exists to migrate. No migration scaffolding "for later".
- No defensive ceremony: no belt-and-suspenders guards, retries, or validations protecting the same invariant twice without a concrete current failure mode.
- No speculative configurability or API surface for hypothetical callers.
- Complete authorized API, schema, and file-format breaks across affected callers — half-migrated is worse than either endpoint.

## What to sweep for (cleanup mode)

Fallback branches; `if (legacy)` paths; deprecated functions kept for callers that no longer exist; alias re-exports; version guards; migration leftovers; config flags with one real value; TODO-compat comments; env-var overrides nobody sets; try/catch that swallows to "keep working anyway".

## Removal decisions

Use these categories when they clarify a material decision or the user requests a removal inventory:

- `delete` — dead or compat-only; remove outright.
- `collapse` — two paths doing one job; merge into the better one.
- `keep-intentionally` — looks like a fallback but guards a concrete, current failure mode; identify that failure mode. Test-harness flexibility and real rollback paths for live operations belong here — do not delete safety that is load-bearing today.
- `needs-decision` — product call that available context does not resolve; ask, with a recommendation.

## Guardrails

- Verify removals against references and relevant CI/scripts/docs.
- Run checks appropriate to the changed behavior and required by the repository. Scale targeted tests, build, and lint to the change; repeat when failures or further edits justify it.
- Report material decisions and validation. Include the line-count delta when useful or requested.
