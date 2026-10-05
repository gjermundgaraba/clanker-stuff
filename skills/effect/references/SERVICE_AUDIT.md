# Effect Service Audit

## Contents

- [Targeted Review](#targeted-review)
- [Comprehensive Audit](#comprehensive-audit)
- [Bound The Scope](#bound-the-scope)
- [Build The Inventory](#build-the-inventory)
- [Trace Requirements](#trace-requirements)
- [Classify Each Candidate](#classify-each-candidate)
- [Audit Test Implementations](#audit-test-implementations)
- [Report Findings](#report-findings)

Choose depth from the user's request. A diff or focused wiring review uses the targeted path. Reserve the complete inventory and per-service accounting below for explicitly comprehensive audits within the requested boundary.

## Targeted Review

1. Identify the changed services, Layers, operations, and relevant tests. Start from the requested diff or concern.
2. Trace affected requirements from use to the composition boundary only as far as needed to establish the behavior. Inspect unchanged callers, providers, or substitutes when they are material to a finding.
3. Check relevant ownership decisions against `SERVICE_DESIGN.md`, wiring against `SERVICES_LAYERS.md`, and exact APIs against the repository-pinned Effect version. Inspect the affected test strategy when the change alters its contract or behavior.
4. Report grounded findings with evidence, consequence, and the affected contract or ownership obligation. State the reviewed scope and any material coverage limits; if no findings are supported, say so.

Stop when the requested change or concern has been assessed and material leads are resolved. A targeted review does not require a catalog of unaffected services, every dependency path, or every production-service test substitute. If evidence reveals a wider defect, trace and report that defect without silently converting the task into a full audit.

## Comprehensive Audit

Use the following procedure for an explicitly comprehensive service audit. Read `SERVICE_DESIGN.md` with it; all references to “every” candidate or path below are bounded by the requested audit scope.

### Bound The Scope

Name the source, test, and composition-root files in scope. Identify the caller-visible operations and runtime entrypoints that must be traced.

**Complete when:** the audit boundary and its entrypoints are explicit.

### Build The Inventory

Enumerate source and test files, then find:

- every `Context.Service`, tag, `Layer`, `make`, `provide`, and `provideService`;
- service-shaped interfaces/classes with effectful methods;
- parameter, property, constructor, callback, options-bag, and Layer injection;
- direct access to time, randomness, cryptography, IDs, configuration, HTTP, persistence, registries, renderers, filesystem, runtime bindings, and mutable globals;
- test fakes, in-memory implementations, module mocks, and hand-built `Layer.succeed` values.

For each candidate record:

| Field        | Question                                               |
| ------------ | ------------------------------------------------------ |
| Owner        | Which module owns the capability's meaning?            |
| Contract     | Where are the interface and tag?                       |
| Construction | Where are dependencies acquired?                       |
| Production   | Which module selects the concrete implementation?      |
| Tests        | Is there an honest reusable test/local implementation? |
| Consumers    | Are capabilities yielded or drilled?                   |
| Requirements | How far do Effect requirements propagate?              |
| Verdict      | Sound, evidenced problem, or unresolved?               |

Record shared and composed Layers against every candidate they affect rather than forcing a one-to-one service/Layer model.

**Complete when:** every discovered candidate and relevant composition Layer is represented in the inventory.

### Trace Requirements

For every distinct dependency path:

1. Trace caller-visible operations to their effects.
2. Mark where each dependency first appears.
3. Mark where it is yielded, passed as a value, captured from a property, or concretely provided.
4. Verify that the module providing a Layer truthfully owns that implementation choice.
5. Check pinned source for framework/runtime services before alleging a missing application boundary.

Pay special attention to:

- a service yielded once and then passed through several functions;
- a `Layer` accepted as a function argument;
- dependency bags and constructors in Effect-native code;
- plain service values passed into handler builders;
- local `Effect.provide` calls that erase requirements below their truthful composition boundary;
- global Clock, crypto, random, environment, fetch, database, registry, or binding access;
- a service contract, construction, production Layer, and test Layer scattered across unrelated owners.

**Complete when:** every capability's path to its composition or value boundary has been traced, with any broken ownership or propagation contract and material unknowns documented.

### Classify Each Candidate

Apply the service tests from `SERVICE_DESIGN.md`, then classify dependencies:

- **built-in Effect capability** — supplied by the framework; identify how consumers acquire it;
- **application-owned authority** — owns application policy, state, or effects; identify its current contract and owner;
- **technology adapter** — supplies technology-specific behavior; identify the contract it implements;
- **request/domain value** — carries per-call or domain data; identify how it reaches consumers;
- **framework boundary** — exposes a framework-required API; identify the obligations it imposes;
- **pass-through abstraction** — forwards another capability; establish whether it owns any policy, isolation, compatibility, or lifecycle responsibility.

Use the deletion test to establish what complexity or responsibility the current boundary hides. Trace duplicated decisions and their caller burden without choosing a replacement owner or module structure.

**Complete when:** every candidate has one classification and concrete evidence; no finding rests only on stylistic preference.

### Audit Test Implementations

For each production service, inspect how tests replace or control it:

- whether static substitutes supply the complete contract exercised by consumers;
- what reusable state, failure injection, or inspection the tests require;
- whether advertised in-memory implementations preserve the observable contract;
- whether persistence/protocol behavior is exercised by the current substitute;
- whether a narrow fixture is being treated as a general implementation.

Compare the substitute's advertised contract with its implementation. A partial fake can be valid for a focused test without satisfying a general in-memory Layer contract.

Behavior assertions use the production interface. Explicit test-control services may supply setup, failure injection, and inspection.

**Complete when:** every production service's test strategy has been assessed, including supported gaps, material unknowns, or an explicit reason no substitute is needed.

### Report Findings

Prioritize by demonstrated consequence:

- **P0** — correctness, security, data-integrity, or lifecycle risk requiring immediate action;
- **P1** — hidden requirements, wrong implementation ownership, repeated dependency drilling, or scattered service ownership that materially burdens change;
- **P2** — naming, colocation, or surface issues with a demonstrated but limited comprehension or maintenance cost.

For each finding include:

1. evidence with file/line or symbol references;
2. the demonstrated consequence or caller burden;
3. the current ownership or requirement-propagation problem and affected contract;
4. consequences for current composition roots and tests;
5. relevant constraints, counterevidence, and material uncertainty.

Include a final “keep” section covering explicit values, pure functions, framework boundaries, correctly separated ports/adapters, and request-scoped services.

**Complete when:** every inventory candidate and relevant composition Layer has a disposition, findings have supported diagnoses and explicit investigation limits, and no finding depends on an invented replacement design. If no findings are supported, say so.
