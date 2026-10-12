# Review

A read-only assessment of how far a codebase follows the rules in `SKILL.md`.

## Bound the scope

Name the packages reviewed and the shape of each (see [SHAPES.md](SHAPES.md)). Other packages need a mention only where you read them; say what was read and why. Say whether the conclusions come from reading code only or from also running checks.

Use the full assessment below for an unqualified review of a package or codebase. When the user limits the review to particular questions, concerns, or a change, gather the facts those rest on and report only the house-style practices they touch. State what was not assessed.

## Gather facts first

Collect these before forming findings, and report each with the method used to get it. Keep source files apart from test and fixture files throughout. Summarize: give a full table only for a fact that a finding rests on.

- **The domains.** In a package with folders, the top-level folders and which are domains, adapters, composition, or kernel. In a flat package, the domain each file belongs to, inferred from names and any recorded architecture; say that it is inferred.
- **Service declarations**: every `Context.Service`, tag class, or equivalent, the file each lives in, and whether its interface is named or inferred from the implementation.
- **Where implementations are chosen**: the places a concrete Layer is selected or provided, and the places an Effect is run. Where routes and middleware are themselves Layers, report the selection sites and not a raw count. A framework runtime that runs Effects counts as one run point.
- **Where technology enters**: the files that import a vendor SDK, a database driver, an HTTP client, a generated client, or a Node built-in, or that use browser globals. A transport or vendor client counts whoever wrote it. Do not count Effect itself, the UI framework the package is built on, a design system, or the repository's own contract package. List Effect's platform and driver packages separately.
- **Imports between domains**: for each pair of top-level folders, the number of source files in one that import the other, noting where the imports are type-only. In a flat package, use the file-level import graph. Note any coupling that imports do not show.
- **Tests**: where they live, and for each external dependency whether tests use the real thing or a substitute.

## Structure smells

- A file or folder named for a mechanism that holds code from several domains.
- A domain with schemas but no service, whose logic lives in storage code or in a handler.
- One module that does several jobs, such as a storage file that is also the database adapter and one domain's business logic.
- An implementation that cannot be chosen from outside. The evidence is a caller, such as another entry or a test, that had to rebuild the service graph by hand or could not substitute a dependency. Repeated hand-assembly is a cost even where the repository permits it. A builder shared by every entry that takes configuration is not by itself a finding.
- Domain code tied to a technology: it imports a vendor or generated type, translates a vendor's errors itself, or exposes a transport type in its service methods when that transport is not the service's own job. A pure helper, such as generating an identifier or joining a path, is not this.
- A method that requires a construction dependency from its caller, where the service could have captured it when built.
- A service whose type is inferred from its implementation, so no declaration says what its surface is. Show a member that leaks as a result.
- Two domains that import each other with neither deriving from nor coordinating the other, or a source that imports its derivative (see SHAPES.md on direction).
- Process images that must not mix sharing one folder, kept apart only by comments or build entries.
- A recorded layout or exposure convention that the code does not follow.
- A test file that covers more than one domain, or a domain whose tests can only be found by reading other domains' files. Suites over the composed application are exempt.

## Ownership smells

Report these under their own heading and label.

- One concept encoded in several types, or the same literal set declared in several files.
- One piece of state, or one in-flight operation, tracked in more than one place.
- Two functions that began as copies and have diverged.

## Contract smells

Report these under their own heading. They concern what an operation promises, not where code lives, and fixing them is outside a restructure. Report them where the reviewed package raises or interprets the error, even when it is defined elsewhere.

- A catch-all error that stands in for several distinct failures, told apart only by message text.
- Operations that declare failures they cannot produce, typically from one error list attached to every operation. A failure type shared by every domain is not this.
- An expected failure raised as a plain `Error`. Weigh failures that are fatal at startup lightly.
- An error that drops the context the caller at the next boundary would need, such as which operation or which identifier failed.

## What is not a finding

- A port with one adapter, when it meets the criterion in `SKILL.md`.
- A missing fake for a dependency the repository tests against the real thing.
- Mechanism-named files inside a framework unit, and the framework's root files.
- A flat folder. The findings are the mechanism-named and multi-job files in it.
- How the repository is divided into packages.
- A projection or view domain importing the domain it reads, or a coordinating domain and the domains it coordinates importing each other at no cost.
- A departure the repository's own instructions require. Report it once as required and move on.

## Cost

Each finding shows what the smell costs today, from the code: a caller that had to work around it, a test that could not be written directly, a distinction a client cannot make, copies that must change together and have already diverged, or a rule the code depends on that nothing enforces. A smell with no cost you can show is an observation. List observations briefly at the end; do not rank them as findings.

## House style

After the findings, state where the project stands on each practice in [HOUSE_STYLE.md](HOUSE_STYLE.md): in use, in use in an adapted form, partly in use, absent, or not applicable, with one line of evidence each. Judge from reading; a review does not perform the proofs that page describes. Label the section house style. An absent practice is an observation, not a defect. A practice the repository has recorded as in force and then breaks is a finding. Where a practice overlaps a smell above, as context-carrying errors do with the contract smells, report the finding there and point to it from this section. Judge removable packages for the repository, not for one package.

## Report

Order the report: verdict, scope, facts, what already follows the rules, structure findings, ownership findings, contract findings, house style, observations.

- The verdict names the items with the most practical consequence, whichever heading they fall under.
- Within each heading, order findings by consequence.
- For each finding give the files and lines that show it, the rule number where one applies or else the smell, the label, and the cost. Labels are Effect idiom, layout choice, ownership, contract, and house style. A structure smell with no rule number is Effect idiom when it concerns services, Layers, or ports, and layout choice otherwise.

Keep every claim checkable by reading the cited files. Do not write "every", "all", or "none" unless it was counted. Diagnose; do not prescribe a target layout or a migration unless the user asked for one.
