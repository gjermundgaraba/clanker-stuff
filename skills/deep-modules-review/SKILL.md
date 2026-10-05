---
name: deep-modules-review
disable-model-invocation: true
description: Review module depth and information hiding, diagnosing evidenced caller burden without designing or implementing changes.
---

# Deep Modules Review

Assess how much useful, cohesive capability a boundary provides relative to what its callers must understand. The unit may be a function, class, package, service, or subsystem. Review the effective interface, including behavior and obligations absent from its signature.

Keep the project read-only. Deliver diagnosis and prioritization, without replacement APIs, proposed decompositions, patches, or migration plans. Write a report file only when requested. Findings can inform a later design task, but do not start that task automatically.

## Establish coverage

Honor a requested subsystem or question. Otherwise map the whole project at a useful level: its main capabilities, entry points, public boundaries, consumers, and important process or trust boundaries. Then investigate the strongest candidates rather than inventorying every module in equal detail.

Use actual caller friction to choose candidates: repeated orchestration or policy, exposed internal choices, difficult lifecycle protocols, callers importing internals, or changes scattered across a concept. History and existing dependency tooling can help locate these when available; file size, export counts, dependency counts, and co-change are leads, not findings or depth measurements.

Trace representative caller jobs through implementations, relevant types, tests, and configuration. Follow the necessary callers and dependencies beyond a named directory to assess its boundary, while keeping findings within the requested scope. Distinguish the project map from areas inspected in detail; do not imply exhaustive coverage.

## Show the current structure

Create a compact current-structure overview. Add focused views only where the overview cannot expose a finding clearly.

Show callers, the public interfaces they use, and the implementation hidden behind each relevant boundary. Group internals inside their owning module; label the policies and obligations that remain in callers or are repeated across them. Keep necessary process or trust boundaries visible. Label arrows with what the relationship means, such as calls, imports, or a particular caller obligation; do not imply execution order with an unlabeled dependency edge.

Use actual module and symbol names, with nearby code references for the relationships that support a finding. Mark an inferred or uninspected relationship as such. Keep a broad overview selective and zoom into the evidence instead of drawing every file and edge. For a small scope, one diagram can serve as both map and finding evidence.

Prefer inline Mermaid when supported, or a legible plain-text box diagram in a terminal. Use a sequence or state view in addition when the burden is a protocol that a structural map would miss. Annotate interface burden and hidden capability in words; box dimensions and edge counts are not numerical measures of depth. No extra renderer, artifact, or separate skill is required.

The [repeated-import case](references/diagnostic-cases.md#repeated-import-policy-across-consumers) illustrates how to expose scattered ownership visually. Review diagrams describe the current design and its problems; proposed structures belong to the subsequent design task.

## Assess the boundary from both sides

For each serious candidate, establish:

- **Capability and ownership:** Which caller job does it complete? What policy, invariant, representation, or mechanism does it own? What knowledge can the caller avoid learning?
- **Actual caller cost:** What concepts, setup, configuration, ordering, state, cleanup, errors, retries, or coordination must the caller manage? Include important performance, concurrency, and diagnostic obligations where they occur.
- **Leakage and locality:** Where else is the same decision encoded? Can a representative change stay behind the boundary, or must callers understand and update its machinery? Ground this in a current behavior, test, or relevant change history.
- **Audience and constraints:** Who pays the cost: ordinary callers, operators, extension authors, or maintainers? What real isolation, compatibility, performance, or independent-variation requirement explains it?

Names and signatures are insufficient evidence. Verify claims against reachable implementations and at least a relevant caller or consumer when available. If external callers are unavailable, state that limitation and avoid inventing their burden. Tests describe expectations; check whether the running code supports them.

Check what the boundary actually promises to hide. A public data representation may be its intentional contract; direct access alone does not establish a bypass or misplaced decision. If a concern's only consequence requires an imagined replacement implementation or unestablished future requirement, keep it as an uncertainty rather than a prioritized finding.

Apply the same lens to humans and coding agents. Navigation and context gathering matter when they reveal knowledge a caller must acquire to use or change the interface correctly. Reading internals during debugging or an architecture review does not itself show a defective abstraction.

## Distinguish problems from legitimate tradeoffs

A small interface is not necessarily cheap: a single call can expose a complex options bag or undocumented protocol. A large implementation is not evidence of depth, and a short helper is not automatically a problem. Internal decomposition can support a deep public boundary.

Look for a demonstrated cost, not conformity to a preferred folder structure. A transport adapter, compatibility bridge, privilege boundary, or independently varying component may earn its interface cost even if it forwards most work. A low-level API may intentionally expose control to its actual audience. Do not count removing a necessary isolation boundary as a simplification.

An application entry point may legitimately own a workflow. Its use of several private helpers is not leakage by itself; establish where consumers must reconstruct that workflow or where a shared decision escapes its owner. Likewise, separate a missing behavioral contract from a structural boundary problem instead of treating every documentation gap as a redesign finding.

Use [diagnostic cases](references/diagnostic-cases.md) when a candidate turns on subtle caller obligations, a thin boundary, or the distinction between poor documentation and poor decomposition. The cases calibrate judgment; they are not a checklist every project must satisfy.

Rank findings by demonstrated impact and reach, using confidence to distinguish established problems from unresolved concerns. Do not assign a numerical depth score or estimate agent productivity from token counts. A sound project may have no actionable findings.

## Report

Lead with the overall assessment and the current-structure diagram, followed by the brief explanation needed to read it. Include sound boundaries worth preserving when they clarify the verdict.

Present the strongest findings first. For each, provide:

- A diagnostic title naming the burden or leaked decision.
- A focused current-state diagram, or a reference to the overview when it already exposes the issue. Place the visual beside the finding it explains.
- Exact code paths and symbols, with line references where available, connecting the boundary to its consumers.
- What useful capability the boundary supplies and what callers must still know or coordinate.
- A concrete consequence for correct use, change locality, diagnosis, or verification. Separate observed failures from inferred risks; do not invent an incident to make a design problem seem consequential.
- Relevant counterevidence or constraints, and any uncertainty that affects the conclusion.

Keep findings self-contained, naming the problem and affected contract so they can inform a separate design task.

Close with coverage and material unknowns, including relevant checks or history examined. If no finding clears the evidence bar, say so and explain what was inspected rather than manufacturing work.

The conceptual foundation is Ousterhout's [Modular Design lecture](https://web.stanford.edu/~ouster/cgi-bin/cs190-winter18/lecture.php?topic=modularDesign): capability, interface cost, and information hiding. The review procedure and diagnostic cases here are practical applications, not a quantitative measure of depth.
