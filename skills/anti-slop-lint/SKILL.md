---
name: anti-slop-lint
disable-model-invocation: true
description: Enforce the strict anti-slop baseline and fix findings in repositories with the vendored anti-slop Oxlint plugin already installed.
---

# Anti-slop lint

Anti-slop is already installed (see `install-anti-slop`). This skill establishes and enforces the strict baseline: enable missing checks, close coverage and rule-behavior gaps, fix findings at their source, and verify. Invocation authorizes this migration, including configuration and policy-document changes, tested local rule corrections, and owned-API refactors with caller and test updates. Do not ask separately for approval of each baseline setting. Initial installation and wholesale plugin updates are not this skill; if no `anti-slop` entry exists in `jsPlugins`, stop and point to `install-anti-slop`.

Strict rules are the goal. Lint passes because the code is correct, not because the code was rewritten to satisfy a pattern matcher. A passing lint run is not itself evidence of type safety.

## 1. Establish the repository's policy

Read the repository's agent instructions and `git status`. Then locate:

- **Configuration source of truth:** `vite.config.ts`, `oxlint.config.ts`, or `.oxlintrc.json`. Note enabled rules, severities, options such as `allowInTypeGuards`, `overrides`, and `ignorePatterns`.
- **Vendored plugin and provenance:** the `jsPlugins` specifier, usually `tools/oxlint/anti-slop/`, its `UPSTREAM.md`, and any rule regression tests beside it, such as `tools/oxlint/tests/`.
- **Required baseline and local policy:** read [references/policy.md](references/policy.md) and any repository lint policy such as `docs/lint-policy.md`. The baseline is mandatory, not a fallback for repositories without policy. Preserve additional compatible repository checks; migrate weaker settings and stale policy records. If explicit repository instructions or user scope prohibit a required change, ask once to resolve the conflict rather than silently weakening the baseline or overriding those instructions.
- **Commands:** the repository's lint, format, typecheck, and test commands. For Vite+ these are `vp lint`, `vp fmt`, `vp check`, and `vp test`; otherwise use the package scripts or `oxlint` directly.

Preserve unrelated uncommitted work in place. Do not stash, reset, or clean it.

Compare effective configuration, compiler flags, checked source coverage, and registered rule behavior against the baseline. Check inherited settings, overrides, ignores, and actual test-framework imports, not just rule names. Complete when the repository setup and baseline gaps are identified.

## 2. Baseline the findings

Run lint with machine-readable output and rank findings by rule and by file:

```bash
vp lint --format json > /tmp/anti-slop-baseline.json   # or: oxlint --format json
```

Separate the findings into three groups before editing anything:

1. **Whitespace:** `anti-slop/require-readable-spacing`, autofixable.
2. **Semantic:** every other rule. Fix these by hand.
3. **Suspected rule defects:** behavior appears to contradict the rule's intended contract. Handle these in step 5; legitimate cases intentionally caught by a broad rule belong in semantic triage.

Report the baseline counts per rule. Findings inside `ignorePatterns` or the vendored plugin are not application findings.

Measure missing checks and excluded maintained source with a temporary candidate configuration before remediation. Report current findings separately from target-baseline findings; an existing ignore does not justify leaving owned code unchecked. Apply the baseline migration in [references/policy.md](references/policy.md), then use the loop below for all target findings, including compiler and type-aware diagnostics. Persist the required settings and coverage; a temporary lint invocation is not enforcement.

## 3. Apply whitespace fixes alone

Skip this step when there are no spacing findings. Otherwise autofix only the spacing rule, then run the formatter, then lint again:

```bash
vp lint -A all -D anti-slop/require-readable-spacing --fix <paths>
vp fmt <paths>
```

Confirm a second fix/format pass leaves files unchanged. Keep these edits separate from semantic edits, as a separate commit when committing. Preserve documentation attachment and overload groups. Do not enable a competing formatting preset.

Complete when the spacing rule reports nothing and a repeated pass is a no-op.

## 4. Fix semantic findings at their source

Work through the semantic findings in a continuous loop: fix a batch, lint, fix the next. Do obvious fixes first, then dig into the rest. Do not stop to ask after every round. Ask once, with options, only when a real policy decision arises, then apply the decision uniformly to every similar finding.

For semantic triage, read [references/exceptions.md](references/exceptions.md) and apply its decision procedure to each finding. Read only the sections of [references/rules.md](references/rules.md) relevant to the affected rule families or compiler flags.

Guardrails for every finding:

- **Refactor before excepting, even across owned APIs.** Fix at the owning boundary and update affected callers and tests directly; do not add compatibility wrappers solely to preserve the old design.
- **Preserve concrete safety.** Persisted state, third-party contracts, malformed external input, and runtime compatibility survive API breaks. Establish migration or failure behavior before changing those boundaries.
- **Never launder.** Do not silence diagnostics by erasing type evidence, asserting unproven contracts, or disguising the same operation. Concrete examples are in the exception reference.
- **Exceptions are narrow and explained.** Use a line-level disable or a tightly bounded disable/enable pair, not file-, package-, or provider-wide exclusions for maintained code. The exception reference defines the format and required evidence. Existing overrides are migration work, not permission for new violations.
- **Do not weaken enforcement to make lint pass.** Applying the baseline's specified settings, including its three deliberate rule exclusions, is already authorized. Any departure from the baseline needs an explicit user decision, recorded with its reason in the config, policy, and provenance. Report such a departure as a deviation, not full baseline compliance. Never delete rule files.
- **Keep semantics.** When rewriting pipelines, reducers, spreads, or reflection, preserve callback order and arguments, sparse-array behavior, omission versus present-undefined, receiver and getter semantics, and error timing.
- **Fix tests to the same standard.** Tests, harnesses, scripts, and maintained JavaScript follow the same policy. Never move code to an untyped file to escape enforcement.

Complete when every semantic finding is fixed by refactor, covered by a narrow explained exception, or reported as needing a user decision.

## 5. Correct rule defects

Correct code alone does not establish a rule defect. When behavior contradicts the rule's intended contract, prefer a tested correction to the vendored rule over collecting exceptions. For legitimate cases intentionally caught by a broad rule, use a narrow explained exception instead (for example, typed-union discrimination under `no-runtime-typeof`). If the intended contract is unclear, resolve that policy decision before changing the rule.

For a rule correction:

1. Reproduce the false positive or enforcement gap with a minimal fixture through the repository's registered plugin configuration.
2. Patch the rule in the vendored copy with the smallest behavioral change.
3. Add a regression test beside the existing rule tests covering the accepted case, a still-rejected case, and that an exception becomes an unused-directive error once its check is removed.
4. Record the deviation in the plugin's `UPSTREAM.md` so a future update preserves it.

If the rule is right and the code is wrong, fix the code. If the rule is fundamentally unsuited to the repository, report that with evidence; disabling it is the user's decision.

Complete when rule changes have regression tests and recorded provenance.

## 6. Verify and report

Run lint, typecheck, formatter checks, and tests covering the affected contracts and callers. Use affected-package checks for localized changes; run full-repository checks for cross-cutting changes or when repository instructions require them. For Vite+, full checks are `vp check` and `vp test`, or the repository's aggregate such as `vp run ready`. Confirm unused disable directives report as errors. Run the plugin's own rule tests when a rule was touched. Repeat affected checks after fixes or when failures or unresolved concerns justify it.

Baseline adoption changes repository-wide enforcement: run full-repository checks before claiming migration complete. Verify the effective baseline and its behavioral probes from the persisted configuration, including maintained JavaScript and previously excluded owned code. For later invocations with no baseline gaps and only localized edits, affected-package validation is sufficient unless repository instructions require more.

Report:

- Finding counts before and after, per rule.
- Baseline settings, coverage gaps, and rule-behavior gaps corrected; any remaining deviations or blockers.
- Refactors that changed owned APIs and the callers updated.
- Every exception added, with its stated reason.
- Rule corrections and their tests.
- Remaining findings and the decision each one needs.
- Which checks ran, their scope, and their results. Include relevant failure diagnostics and a log location for lengthy output.

Complete when relevant checks have run and authorized in-scope work is finished, including fixes for regressions introduced by the work. Leave failures unresolved only when they are unrelated, blocked, or awaiting a user decision; report the diagnostics, reason, and required next action. Reporting an ordinary fixable in-scope failure is not completion.

Claim full baseline compliance only when every required setting, coverage requirement, and behavioral check is active and verified, and target findings are resolved by refactor or legitimate narrow exceptions. If blocked or explicitly directed to deviate, report the migration as incomplete or deviating; a passing weaker configuration is not success.
