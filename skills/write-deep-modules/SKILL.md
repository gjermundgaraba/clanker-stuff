---
name: write-deep-modules
disable-model-invocation: true
description: Design and implement deep modules, making caller obligations explicit and agreeing substantive interface changes before implementation.
---

# Write Deep Modules

Design the boundary before committing to its implementation. A deep module owns meaningful decisions and completes useful caller jobs while keeping the full caller burden manageable. That burden includes signatures and types as well as behavior, ordering, errors, configuration, resource use, concurrency, security, compatibility, diagnostics, and escape hatches that callers must understand.

Depth is a design judgment, not a score. Do not use line counts, export counts, or other structural proxies as proof. Evaluate the boundary for each real audience, including people and coding agents: what can an ordinary caller accomplish, and what must that caller learn or coordinate?

## Establish the design

Inspect the existing code, tests, call sites, repository conventions, and any supplied findings. Treat review findings as evidence about friction or leakage, not as a prescribed design. Identify:

- the caller jobs and audiences;
- the policy, invariant, representation, mechanism, or workflow the module can own;
- observed behavior and compatibility constraints;
- real variation and necessary deployment, privilege, process, performance, or failure boundaries;
- the common-case defaults, failures that can be absorbed, failures that must cross the boundary, and diagnostics each audience needs.

For existing code, read [references/refactoring.md](references/refactoring.md) to establish the behavioral baseline and plan its preservation through migration.

If a concrete interface and behavioral contract are already agreed, use them as the design baseline. Do not reopen settled alternatives unless new evidence reveals a material problem.

Compare credible designs that differ in where decisions live. Consider the complete contract and operational cost, not only the shape of declarations. Do not invent alternatives to meet a quota. Recommend the interface that best concentrates cohesive policy and change while respecting real constraints and variation. If no proposed boundary owns a meaningful decision or reduces caller coordination, keep the existing structure or choose a legitimate explicit boundary.

For contrasting interface shapes and the conditions that favor each, read [references/design-contrasts.md](references/design-contrasts.md).

## Show the design change

Make the current structure and the proposed structure visible before asking for interface agreement. Use paired diagrams, side by side when practical, with consistent names, scope, and level of detail so the reader can compare them directly. For a new capability, show its existing callers and surrounding dependencies, and label the new boundary as proposed; do not invent a legacy module.

Show public entry points, callers, and internal responsibilities grouped inside their owners. Label the relationships and the caller obligations that move behind a boundary, disappear, or remain explicit. Include retained adapters and necessary process or trust boundaries when they matter to the choice. A before-and-after file tree or a box with fewer arrows is insufficient: make the change in ownership and interface burden visible.

Ground the current view in inspected code and cite the important paths or symbols nearby. Clearly label proposed modules and relationships as proposals. Draw alternatives when their different ownership or topology is material to the decision; use a compact contract comparison when their structure is the same. Avoid a diagram per minor implementation choice.

Prefer inline Mermaid when supported, or legible plain-text box diagrams in a terminal. Add a sequence or state view when lifecycle or ordering is central. Keep views focused and annotate capability and interface cost in words, without using box dimensions as a depth score. The skill needs no external renderer or other skill. See the [visual comparison example](references/design-contrasts.md#example-move-import-policy-behind-one-boundary) for a refactor expressed as a change in ownership.

Present the recommended interface in concrete, language-appropriate form. Explain:

- what capability it provides and what decisions it owns;
- the formal and behavioral contract, including defaults, state, errors, side effects, resource or concurrency semantics, and compatibility where relevant;
- the alternatives considered and why the recommendation fits current evidence;
- costs, risks, and any deliberately exposed expert or operational surface.

## Agreement checkpoint

If the interface and its substantive behavioral contract are not already explicitly agreed, present the visual comparison together with the concrete contract, then stop before implementation and ask the user to agree to the recommendation. An explicit agreement earlier in the conversation or task counts; do not request it again. For an already agreed design, use or update its diagrams as needed without reopening the decision.

Ask again only when new evidence requires a substantive contract change, such as different observable behavior, error semantics, lifecycle, consistency, authority, compatibility, or caller responsibilities. Private representation, algorithms, helper structure, and other implementation choices within the agreed contract do not require another checkpoint.

For implementation requests, once the interface is agreed, implement and verify it autonomously within the authorized task. Do not add another permission step for ordinary implementation decisions. A design-only request ends with the design deliverable.

## Implement the boundary

Put cohesive decisions and common-case orchestration behind the public entry point. Choose safe, useful defaults instead of exporting every internal choice. Keep rare expert control or operational inspection explicit and separate when it is genuinely needed. Preserve clean internal decomposition; a deep public boundary does not require a monolithic implementation.

Record the behavioral promises beside the public interface using the repository's documentation conventions. A caller should not need the design conversation or implementation to discover required ordering, failure behavior, or resource obligations.

Avoid forwarding layers that merely rename the underlying operations, speculative ports for imagined variants, and option bags that make callers reconstruct policy. Keep genuine variants and hard isolation boundaries visible. Security, independent deployment, failure containment, end-to-end knowledge, and a product whose purpose is low-level control can justify a wider or shallower interface.

Make the intended boundary real with the language or repository's native visibility and packaging facilities when practical. Add a focused guardrail only when it prevents a demonstrated bypass or contract regression; conformance tooling does not establish depth.

## Verify and report

Verify observable behavior through the public boundary, including important failures and side effects. Use focused internal tests where they improve diagnosis. Check representative call sites to confirm they no longer coordinate the hidden policy, and run the repository's relevant checks.

Report the implemented interface and contract, the decisions moved behind it, the principal tradeoffs, compatibility or migration status, and verification results. Include the resulting module diagram, checked against the code, so the final report shows what was actually built. Mark remaining adapters or unfinished migrations; do not present the intended end state as completed. Call out evidence that changed the agreed design rather than silently widening the contract.
