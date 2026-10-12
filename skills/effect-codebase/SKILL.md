---
name: effect-codebase
description: "Review or shape an Effect-based TypeScript codebase: by-domain layout, services and Layers, ports and adapters, composition roots, and the testing, error, comment, and lint practices that go with them. Use only when explicitly invoked."
disable-model-invocation: true
metadata:
  upstream-source: "https://ratstack.sh/lore/structure-effect-by-domain"
  upstream-relationship: "reference"
  upstream-reviewed: "2026-10-11"
  upstream-content-url: "https://ratstack.sh/lore/structure-effect-by-domain.md"
  upstream-content-sha256: "22ae3cae8b9950fa1ba9972f5d16c34bd4c54dc87bb60cc2609180c2b8f4710d"
  upstream-services-source: "https://ratstack.sh/lore/services-capture-dependencies"
  upstream-services-relationship: "reference"
  upstream-layers-source: "https://ratstack.sh/lore/layers-make-dependencies-explicit"
  upstream-layers-relationship: "reference"
  upstream-hexagonal-source: "https://ratstack.sh/lore/hexagonal-architecture"
  upstream-hexagonal-relationship: "reference"
  upstream-tests-source: "https://ratstack.sh/lore/tests-that-earn-their-place"
  upstream-tests-relationship: "reference"
  upstream-fence-source: "https://ratstack.sh/lore/the-fence"
  upstream-fence-relationship: "reference"
  upstream-comments-source: "https://ratstack.sh/lore/no-comments"
  upstream-comments-relationship: "reference"
  upstream-machines-source: "https://ratstack.sh/lore/lifecycles-are-machines"
  upstream-machines-relationship: "reference"
  upstream-capabilities-source: "https://ratstack.sh/lore/one-capability-every-surface"
  upstream-capabilities-relationship: "reference"
  upstream-cartridges-source: "https://ratstack.sh/lore/cartridges"
  upstream-cartridges-relationship: "reference"
---

# Effect codebase

Shape an Effect codebase, or assess how far one already is. This skill owns two things: the by-domain layout (folders, where services, Layers, ports, and adapters live, and the order of a restructure) and the house style that goes with it (how operations, errors, tests, comments, and enforcement are handled). It does not teach Effect APIs: take mechanics from the project's pinned Effect version and its existing conventions.

## Rules

| #   | Rule                                                                                                      | Standing                                                                                                                                                                                            |
| --- | --------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | Group files by domain, not mechanism: `src/coding/edit.ts`, not `src/tools/edit.ts`.                      | Layout choice. Effect leaves folder layout to the application.                                                                                                                                      |
| 2   | A service captures its dependencies when it is built, so its methods require nothing extra from callers.  | Effect idiom. Request-scoped context, such as the current user, stays explicit at the call, as a parameter or as a requirement of the method.                                                       |
| 3   | Each entrypoint has a composition root that chooses and provides the Layers.                              | Effect idiom.                                                                                                                                                                                       |
| 4   | Ports, the service interfaces named for an application job, live in the domain. Adapters live outside it. | Effect idiom.                                                                                                                                                                                       |
| 5   | Schemas, expected failures, and tests live with the domain they describe.                                 | Effect idiom. Tests may sit beside the code or in a tree that mirrors it; keep the repository's choice.                                                                                             |
| 6   | One service per file, with its Layer beside it.                                                           | Default, not a rule. Split them when the Layer is an adapter (rule 4), or when keeping the Layer beside the interface would pull server-only code into a client bundle or a published type surface. |

## House style

The source pairs the layout with nine practices: the service constructor and Layer in the service file, operations defined as contracts, context-carrying errors, Effect-aware tests with no manual runtime, property and model tests, lifecycle state machines, removable packages, no prose comments, and a lint fence. They are part of adopting the approach in full, and each fits only under stated conditions. [HOUSE_STYLE.md](references/HOUSE_STYLE.md) gives the conditions, the order, and what has gone wrong when each was applied literally.

The first restates rule 6. The rest stay distinct from the rules: a project can follow the rules without any of them, and none is Effect idiom.

## Modes

**Review** is read-only. Read [REVIEW.md](references/REVIEW.md), plus "What a domain is" and the section for the project's shape in [SHAPES.md](references/SHAPES.md). Gather the facts REVIEW.md lists and report findings. Read HOUSE_STYLE.md to report where the project stands on each practice. When the user limits the review to particular questions, gather and report only what those need, as REVIEW.md describes. Offer a target layout only when asked.

**Adopt** applies when planning or carrying out a restructure. Read SHAPES.md to decide what a domain and a composition root are for this project, then [ADOPTION.md](references/ADOPTION.md) for the order of work, then HOUSE_STYLE.md for the steps that follow the structural ones. The plan's format and any permission to break import paths or public API come from the user, not from this skill.

**Delegating.** When handing review or adoption work to another agent, give it this skill itself, by invocation or by path. Do not paraphrase the rules in the brief: a summary loses the standing of each rule and the conditions on each practice.

## Precedence

The repository's own conventions outrank this skill: its lint and test policy, naming, mandated files, and framework guidance. The layout under review or being replaced is the exception.

- In review, the existing layout does not excuse itself. A departure that the repository's instructions require, in `AGENTS.md` or a document it binds contributors to, is reported once, marked as required, and not ranked as a finding. A provisional design direction is context, not a requirement.
- In adopt, the user's request overrides the recorded description of the old layout. It does not override behavior the old layout protected. When a folder encodes a rule, such as "nothing here is imported by another public module", name the rule and either keep it enforced or have the user waive it.

## Judgement the rules do not supply

**Folders are not the architecture.** Moving files by domain does not settle who owns what. Check across domains for one owner per piece of state and one vocabulary per concept. Several types that encode the same set of actions, or several places that each track the same in-flight operation, are ownership problems that the new layout exposes but does not fix. Report them in a review under their own label, and look for them after a move.

**A port has to earn its place.** A port is justified when it names an application job and its adapter does at least one of these: translates failures into the domain's own errors, keeps a vendor or generated type out of domain code, or has a second honest implementation. An interface that only renames another service's methods should not exist; depend on that service directly. Judge substitutes per dependency: a missing fake is not a defect for a dependency the repository tests against the real thing.

**Move definitions; do not redesign them.** A restructure puts schemas and errors beside their domain. Changing what an error carries, splitting a catch-all error, or narrowing an operation's declared failures is a contract change with its own consequences, and belongs in a separate step.

**Write the decision down.** When a project adopts this layout, record it where the repository keeps such decisions, usually the README or `AGENTS.md`: the domains, where ports and adapters live, where Layers are provided, and which house-style practices are in force. A structural choice that exists only in a conversation gets reopened by the next reviewer.

## Source

The rules are distilled from [Structure an Effect codebase by domain](https://ratstack.sh/lore/structure-effect-by-domain) and the pages it links. This skill is enough to work from. When a page's wording matters, read it as raw Markdown, which the site serves to plain HTTP clients such as `curl`. A fetch tool that summarizes will drop the distinction between idiom and house style.

## Completion

A review is complete when each finding cites the files that support it and the report states what was and was not inspected.

An adoption is complete when the agreed steps are done, the repository's checks pass, and the recorded description of the layout matches the code. When a failure that predates the work blocks a check, report the work as done and its validation as incomplete. Do not chase repeated review rounds to zero findings; stop when the remaining ones are preferences.
