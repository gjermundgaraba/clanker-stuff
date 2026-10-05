# Effect Service Design

## Contents

- [Authority Seam](#authority-seam)
- [Service-Or-Value Test](#service-or-value-test)
- [Capability And Ownership Boundaries](#capability-and-ownership-boundaries)
- [Dependency Lifetime](#dependency-lifetime)
- [Layer Ownership](#layer-ownership)
- [Service Module Surface](#service-module-surface)
- [Honest Test Implementations](#honest-test-implementations)
- [Decision Record](#decision-record)

Use this when deciding whether a capability should be an Effect service, where its contract and implementation belong, how far its requirements should propagate, or what kind of reusable test implementation is honest.

## Authority Seam

Treat a service as an **authority seam**: a cohesive capability whose requirements should propagate through Effect context. A service owns meaningful authority, policy, state, behavior, or lifecycle variation. It is not merely a convenient object-shaped collection of functions.

An Effect service module owns the capability contract and the construction surface that belongs to that contract. A concrete technology adapter owns technology-specific construction and Layers. Co-locate them only when the capability module truthfully owns that implementation.

## Service-Or-Value Test

A real service owns at least one meaningful capability:

- authority over persistence, credentials, external I/O, runtime resources, configuration, time, randomness, or lifecycle;
- cohesive effect sequencing or policy reused across entrypoints;
- state or behavior with real production and test/runtime variation;
- enough implementation complexity that deleting the module would spread complexity into callers.

Prefer an existing Effect service such as `Clock`, `Crypto`, `Random`, `Config`, `HttpClient`, `FileSystem`, or `Path` before defining an application service.

Keep these as values or pure modules:

- parsed domain inputs and per-call request data;
- deterministic calculations, projections, parsers, and constructors;
- options that select policy for one call;
- framework values confined to their adapter;
- wrappers that only rename or forward another service.

A test-only desire to inject a value is not enough. The seam must represent real ownership or variability in production.

Base the service-or-value decision on concrete ownership, the complexity deletion would spread into callers, and whether an existing service or adapter already owns the capability. Explain rejected alternatives when they clarify a material tradeoff.

## Capability And Ownership Boundaries

- Domain modules stay pure.
- Application services own operation policy and application-owned ports.
- The application layer that owns a port's meaning owns its tag and interface.
- A concrete adapter owns its technology-specific construction and Layer.
- Composition roots select and provide concrete Layers. They do not become reusable policy modules.
- Runtime bindings are yielded in the composition root or owning adapter, then hidden behind application/domain types.

Dependencies point inward. Raw technology types stop at adapters, and no inner caller chooses a concrete implementation it does not own.

Passing an external library's constructor options remains correct after the owning adapter has yielded the relevant runtime capability. Request values, domain inputs, and framework constructors remain explicit values rather than Effect dependency injection.

## Dependency Lifetime

Yield stable dependencies while building the Layer and close over them in service methods. Yield request-, fiber-, or operation-scoped context inside the method that uses it.

Let requirements propagate until the module that truthfully chooses an implementation provides them. Preserve the requirement when downstream composition still owns that choice.

## Layer Ownership

Export the smallest construction surface callers need.

- Keep requirements visible unless the current module truthfully owns the implementation choice.
- Export a requirement-preserving Layer when downstream composition must choose or provide dependencies.
- Export a fully assembled Layer when the module or package owns the concrete defaults.
- Export either, both, or neither form according to real callers and repository naming conventions.

Layer constructor and combinator mechanics belong in `SERVICES_LAYERS.md`; this reference decides where construction and assembly authority belong.

## Service Module Surface

Keep interfaces narrow and domain-shaped. Use named `Effect.fn` methods, typed expected errors, and yielded dependencies. Add options, methods, services, and combinators only when each hides enough complexity to earn its place.

The capability contract, construction, production assembly, errors, methods, and test strategy each need one clear owner. A single file may own several of these roles when their ownership coincides; separate the technology adapter when it does not.

Export only symbols required by callers. Preserve an established compatible naming convention when renaming would add churn without clarity.

## Honest Test Implementations

- Use `Layer.succeed` for a complete static implementation.
- Add a reusable test Layer plus a test-control service when reusable state, failure injection, or observation is part of a real seam.
- Name a Layer `layerMemory` only when it faithfully implements the service's observable contract in memory.
- Prefer a real local substitute when persistence, transactions, serialization, or protocol behavior matters.
- Keep a tiny one-off fake in its test when promoting it would create production surface solely for that test.

Behavior assertions cross the same service interface as production callers. An explicit test-control service may provide setup and inspection. When reusable control exists, back its production tag and test-control tag with the same object.

Partial objects with unused methods that fail are focused test fixtures, not reusable in-memory adapters. No new authority seam should exist only to support mocking.

## Decision Record

For substantial ownership or composition changes, or a requested design review, record the material decisions and their evidence. Cover the points affected by the change:

- the service-or-value verdict and its evidence;
- the capability and contract owner;
- each dependency's owner and lifetime;
- where each concrete implementation is selected;
- the production and test construction surfaces real callers require.

Routine edits that follow an established design need only explain any changed decision. Dependencies must still remain visible until their ownership boundary, and every proposed export needs a caller.
