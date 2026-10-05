---
name: architecture-review
description: Explain and assess architecture at system, subsystem, flow, change, or proposal scope. Use only when explicitly invoked.
license: MIT
disable-model-invocation: true
---

# Architecture review

Explain the design before judging it. Ground the assessment in evidence and remain read-only.

Report the problem, supporting evidence, demonstrated consequence, and relevant constraints or uncertainty. Do not prescribe replacements, implementation steps, or a target design unless requested. A supported finding does not require a known solution.

## Choose the scope

Use the user's requested scope and architectural question. Scopes can overlap:

| Scope                                           | Review focus                                                                                                                                                                            |
| ----------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| System or repository                            | Major components, dependency direction, ownership, and representative end-to-end flows. State which areas were inspected; avoid implying exhaustive coverage.                           |
| Subsystem, module, or files                     | Responsibilities, public contracts, internal cohesion, and relationships with callers and dependencies.                                                                                 |
| Flow or cross-cutting concern                   | Trace a behavior or concern across components, such as state ownership, error propagation, authentication, or persistence.                                                              |
| Implemented change: diff, commit, branch, or PR | Establish the baseline and assess affected contracts beyond the diff. Distinguish introduced, worsened, and pre-existing issues.                                                        |
| Unimplemented proposal or design                | Assess the proposed boundaries and affected contracts against the current system and stated requirements. Keep assumptions and proposed behavior distinct from observed implementation. |

If scope is unspecified, use conversation context, recent changes, or recurring maintenance pain to select a useful bounded question and state it. Ask only when ambiguity would materially change the assessment. History guides attention, not the verdict.

Follow relevant callers and dependencies beyond the named files when needed to answer the question. Keep findings tied to that question; a narrow review does not require a repository-wide audit.

## Investigate and explain

Read relevant design documentation, domain terminology, and architecture decision records (ADRs) when present. Compare their intent with the implementation. A documented decision is context, not immunity from review: explain the current evidence that warrants reopening it.

Trace representative behavior from trigger to effect, including data transformations, side effects, and ownership boundaries. Follow relevant failure paths and inspect contract tests where they help establish guarantees. Distinguish inspected tests from tests actually run.

Build a coherent explanation of purpose, key concepts, component relationships, and how behavior flows through them. Cite concrete paths and symbols. Include a diagram only when it clarifies a relationship or sequence. Scale the explanation to the scope and distinguish verified facts, inferences, and unresolved gaps.

## Assess and present

Apply the relevant lenses in [the critique rubric](references/critique-rubric.md), then use [the assessment guidance](references/assessment.md) to substantiate and prioritize findings.

Present the scope and architectural explanation first, followed by supported findings and investigation limits. Include sound boundaries worth preserving when they explain the assessment. An empty findings list is valid; it does not establish that unexamined areas are sound.

The review is complete when the scoped question has an evidence-backed assessment, supported diagnoses where warranted, and explicit investigation limits. Solution design, implementation, and documentation updates require their own requested scope. Create a separate report artifact only when requested.
