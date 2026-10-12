# Project shapes

Decide the shape of each package before applying rule 1. A monorepo can hold several shapes, so decide per package. A package with no services of its own, such as a schema-only contract package or a UI that only decodes data, is out of scope for layout: say so and move on.

## Contents

- [What a domain is](#what-a-domain-is)
- [Service app](#service-app)
- [Framework client](#framework-client)
- [Library](#library)
- [Monorepo](#monorepo)
- [Questions the rules leave open](#questions-the-rules-leave-open)

## What a domain is

A domain is an area of application work that a user or caller would name: `billing`, `invoices`, `session`. A mechanism is how the work is done: `tools`, `handlers`, `actions`, `store`, `services`, `utils`, `components`, `internal`. For an application, a useful test is whether the name would survive replacing the technology underneath it.

In a flat package, each file is the unit: `invoices.ts` is a domain file and `handlers.ts` is a mechanism file. Flat is fine while files are named for domains. A file that exposes several domains through one transport, such as the HTTP or MCP surface, belongs to composition.

Some folders are not domains and are still correct:

- **`platform/`** holds adapters. It is the one mechanism folder the layout expects.
- **A composition folder** assembles domains into the running application when the entry file alone is too small for the job. It imports domains; domains do not import it.
- **A shared kernel** holds vocabulary every domain uses, such as a common failure type or a wire contract. It imports nothing from the domains and stays small.
- **A small named folder for a shared mechanism that no domain can own**, such as `stdio/` for a console writer two domains use. The test is under [Where shared code goes](#questions-the-rules-leave-open).

Name each of these for what it holds. Do not create `shared/` or `common/` as a place for whatever did not fit.

## Service app

A server, worker, or CLI.

- **Domains** are the application's areas of work. Each owns its service, its schemas and errors, and the handlers that expose it. A file that gathers the handlers for every domain is a mechanism file; so is a storage file that also carries one domain's business logic.
- **A domain that has schemas but no service** usually has its logic living somewhere else, often in the storage layer or in a handler.
- **`platform/`** holds the database, HTTP, filesystem, and vendor adapters.
- **The composition root** is wherever implementations are chosen for an entry: the production entry, the development entry, and test setup. It may be a module beside the entry file. What matters is that each entry can choose differently, so a function that builds the application takes Layers as input and does not select them.
- **Several process images in one package**, such as a server and the worker it spawns, each get their own subtree. Module sets that must not mix should not be kept apart by comments and build entries alone.

## Framework client

A browser or desktop UI built on a framework that has its own file conventions, such as an Elm-architecture runtime or a component framework.

- **Inside a unit, the framework decides.** Files named `model`, `message`, `update`, `view`, or a component file beside its styles, are mechanism names that are correct here. Follow the framework's own guidance and exemplars for that split, and for where cross-feature tests live.
- **At the top level, folders are domains.** The framework's root files, such as the entry, the root model and update, and the router, stay at the root.
- **Where the framework's guidance names top-level folders**, such as `pages/`, `components/`, or a single `domain/` folder for all schemas, it and this layout disagree. If the repository's instructions or the user's request already say which governs the top level, follow that. Otherwise ask the user, and move nothing before it is settled. Record the choice in the repository if it is not already recorded, as an override where it departs from the framework's guidance. In a review, report which one the code follows and whether a departure from the framework's guidance is recorded as an override.
- **Test each behavior in the layer that owns it**, using the layers the framework defines: for example, update contracts in the framework's update tests, view structure in its view tests, and focus, transport, and the real DOM in browser tests.
- **Expect few services.** A client can have a dozen domain folders and a handful of ports, typically one per backend resource plus local storage. Most of each domain is state, updates, and views.
- **The composition root** is the entry file where the framework's runtime receives its Layers. The framework runs the Effects; do not count that as running Effect manually.
- **Technology here includes browser globals.** `document`, `location`, and `fetch` are not imports, but direct use in domain code is the same question as a vendor import. Use inside the framework's own effect boundary, such as a command or subscription, is normal.
- **Ownership problems are the common failure.** Look for the client-specific forms: the same user action encoded once per input surface, and a change of shared context relayed through several functions where one would do.

## Library

A published package consumed by other projects.

- **Domains are the public modules.** Each folder holds one public module and its private files. The module names win even when they are technology names; the replace-the-technology test is for applications.
- **A visibility folder such as `internal/` is the mechanism folder.** Before dissolving it, check whether it encodes a rule, usually that no public module depends on another's private code. Dissolving it turns "shared" files into imports between modules. List the edges that would appear and record the ones you keep as the allowed edges. A file goes to a named folder only when it passes the shared-code test below.
- **The root contract module is often both a domain and the kernel.** Other modules import it; it imports none of them.
- **Where the public file sits is a build decision.** It can be the folder's `index.ts`, a named file inside the folder, or a file left beside the folder of its privates. Under a module-preserving build the choice determines the published subpath, whether path mappings can stay a wildcard, and how many imports in tests, examples, and documentation tooling change. Compare the options by those consequences, and confirm the published subpaths with a build. An `index.ts` that is the module itself is not a barrel. Watch for a private file and a public module whose names differ only by case; they collide on a case-insensitive filesystem.
- **One-file folders are optional.** A module with no private files can stay a single file. Apply the shared-code test to every file that leaves `internal/`, so the placements are consistent. A set of named folders that is `internal/` in pieces means the test was skipped.
- **Keep subpaths stable even when permitted to break them**, unless the rename buys consumers something. A moved public module is a breaking change that needs explicit permission either way. Stable subpaths still change every source-relative import in tests, examples, and snippet tooling.
- **An explicit list of published entries is a privacy boundary.** Keep it explicit; a glob would publish any new folder.
- **There is no `platform/` and no `main`.** A library does not choose implementations; its consumers do. Rule 3 and the composition phase are usually empty.
- **Rule 6 often does not hold.** A Layer beside a public interface can pull server-only code into a browser bundle, or widen the published types. Apply the service rules only where they fit, and say where they did not.
- **Suites that prove a guarantee across every module are cross-domain on purpose.** Keep them in a folder named for that, apart from the per-module tests. Helpers and suites that check repository policy, such as documentation tests, stay at the root of the test tree.
- **The examples are the composition roots**, and they are what consumers and their agents copy. An example that shows an application uses the application layout from this skill; a single-feature snippet can stay flat. Restructuring examples is a separate step from moving `src/`, so propose it separately.

## Monorepo

How code is divided into packages is a separate decision from the service graph. Do not split or merge packages as part of a restructure. Apply the shapes above inside each package, and leave a contract package that already groups schemas by domain as it is.

When schemas and errors live in a contract package, rule 5 is met by that package's own grouping. A review of a package that raises or interprets those errors still reports contract smells it finds there, citing the contract package as evidence.

## Questions the rules leave open

**Where shared code goes.** Code used by two domains belongs to the one that owns the concept, and the other imports it; record the edge. Vocabulary that every domain uses goes in the shared kernel. A small named folder is the last resort: use it only for a mechanism that no domain can own, or when every candidate owner would create an import cycle or an edge the repository's rules forbid.

**Whether domains may import each other.** They may. Direction is what matters.

- _Derivation._ A domain that derives from another, such as a projection reading its source data, imports in the normal direction. To find the source, ask which side would still make sense if the other were deleted. The source importing its derivative is the direction to question, and usually means one definition sits in the wrong folder.
- _Coordination._ A domain that coordinates others, such as a single writer or a sync engine, defines the vocabulary they speak and calls their ports, so it and they import each other. That is one owner doing its job. Report it as a fact. It becomes a finding only when it has a cost, such as imports that must bypass a folder's public surface to avoid a load cycle.
- _Neither._ Two domains that import each other with no derivation or coordination between them usually have a definition in the wrong folder, or are one domain.

Domains can also be coupled without importing each other, through a shared storage service where each reads the other's records. Import counts do not show this; note it when seen.

**How a domain exposes itself.** Follow the repository. If it uses an `index.ts` per folder, give each domain one and import across domains through it, unless that would create a load cycle, load unrelated code, or expose private symbols. If it imports files directly, keep doing that. Do not introduce barrels as part of a move. Where the repository states a convention, the code should match it.

**When to add subfolders.** A domain folder stays flat until one unit inside it has several files of its own.

**Where tests and fixtures go.** Beside the code, or in a separate tree that mirrors the domain folders; keep whichever the repository uses. Give each domain its own test file, so file names show where a behavior is proven. Suites over the composed application, such as transport or end-to-end tests, legitimately span domains.
