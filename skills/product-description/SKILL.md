---
name: product-description
description: Create or extend an exhaustive behavior-spec repository from code, tests, and observations of the running product.
disable-model-invocation: true
---

# Product description repo

Describe the product's observable behavior feature by feature, from the user's point of view. Use a common document skeleton, shared vocabulary, source provenance, observed verification, and deduplicated bug triage.

## Choose the work

Read the procedure relevant to the request; follow another route when the work reaches that stage.

| Request                                                           | Procedure                                              |
| ----------------------------------------------------------------- | ------------------------------------------------------ |
| Create a product-description repository                           | [Create a repository](references/create-repo.md)       |
| Resume, extend, or revise an existing repository                  | [Extend or revise](references/extend-repo.md)          |
| Build checklists, observe the running product, or triage findings | [Verification and triage](references/verify-triage.md) |

## Link-checker setup

The link checker uses Node.js 26+ and maintained Markdown/GitHub-slug libraries.
Run `npm install --prefix <skill-directory>` once for a standalone installation;
workspace development uses `vp install`. See [helper usage](README.md).

## Shared contract

- The source repository is read-only reference material. Describe supported behavior; record unknowns and suspected defects plainly without guessing or blocking unrelated work.
- Preserve the common feature-document skeleton, variant and interrupt tables, cross-cutting order, and user-visible state diagrams. Use [the document template](references/document-template.md) when establishing or extending that structure. Preserve the shared section order and terminology. Mark genuinely inapplicable sections or phases briefly with the reason, or omit them where repository conventions allow. Do not invent an extended phase for an atomic operation. Cover all applicable behavior, variants, interrupts, and interactions.
- Foundations own shared facts; `glossary.md` owns vocabulary. Link to those definitions rather than duplicating them. When work is parallel, one designated owner integrates glossary and shared-plan changes; drafting workers propose additions and edit only their assigned documents.
- Keep `README.md` structure and coverage aligned with planned and existing documents. Preserve checklist and triage IDs once used. Check affected documents and their dependencies for inconsistent facts, terminology, and links. Repeat work when missing evidence, unresolved questions, or inconsistencies justify it.
- Each feature document ends with open questions, the inspected source commit, and a separate observed-verification status. Reading source or tests does not establish an observed pass; record the actual tested build, method, coverage, and results.
- Use existing scope decisions and authorization. Ask only when a material choice remains unresolved. Follow repository conventions; commit coherent completed work when committing is within the task, without a prescribed per-file sequence or message recipe.

## Completion

A drafting assignment is complete when its assigned documents and applicable tracking updates are consistent and its unresolved questions are reported. It does not complete the lead's wider task.

For a full repository build, or a request that includes observation and triage, continue through the verification route. Run the observations available within the authorized scope, record results and blockers, reconcile findings, and finish remaining independent work. Report coverage gaps explicitly. Human acceptance, when required by the user or repository, is separate from whether claims have been observed.
