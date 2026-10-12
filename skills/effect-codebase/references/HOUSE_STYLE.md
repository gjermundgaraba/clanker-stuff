# House style

Practices the source pairs with the by-domain layout. None is Effect idiom, and each fits only some projects. For each one below: what it is, when it fits, and what to watch for.

In a review, report where the project stands on each. In an adoption, propose the ones that fit as separate steps after the structural phases, in the order of this page, and state for each why it fits or does not. The repository's own lint, test, and comment policies take precedence. Where one conflicts with a practice, the policy stands: name the conflict, and change the policy only when the user's request covers it.

## Contents

- [Service constructor and Layer in the service file](#service-constructor-and-layer-in-the-service-file)
- [Operations as contracts](#operations-as-contracts)
- [Errors that carry context](#errors-that-carry-context)
- [Effect-aware tests and no manual runtime](#effect-aware-tests-and-no-manual-runtime)
- [Property and model tests](#property-and-model-tests)
- [Lifecycles as machines](#lifecycles-as-machines)
- [Removable packages](#removable-packages)
- [No prose comments](#no-prose-comments)
- [A lint fence](#a-lint-fence)

## Service constructor and Layer in the service file

The service's constructor and its Layer live in the service's file, as static members of the class or as exports beside it, so one file answers "what is this service and how is it built". This is rule 6 in `SKILL.md`, with the same exceptions: an adapter Layer lives outside the domain, and a Layer that would drag server code into a client bundle is split off.

## Operations as contracts

Each operation is one contract: a name, an input schema, an output schema, and its declared failures. Every surface that exposes it, such as an HTTP route, a CLI command, an MCP tool, or an RPC method, is derived from that contract instead of written by hand. The contract is importable without the handler, so a client does not pull in server code. Each operation's handler lives in its domain, one operation per file or one small file per domain.

- **Fits** an application that exposes the same operations on more than one surface, or that already uses a contract library.
- **Does not fit** a library's own API, including a library whose product is this practice, or an application with one surface and a few routes.
- **Watch for** building a projection framework to satisfy this. Use the contract library the project has, or leave the practice out.

## Errors that carry context

An expected failure is a tagged error whose fields say what failed: which entity, which identifier, which operation. One catch-all error with a message is split into the failures it stands for, and each operation declares only the failures it can produce.

- **Fits** any project whose callers branch on failures or show them to people.
- **Watch for** the sentence. A message computed by a getter exists only in the process that holds the class. A client that decodes the error from JSON, or an agent that reads the raw payload, receives the declared fields and nothing else. If any consumer reads the encoded error, make the sentence a declared field and build it in one place from the other fields.
- **Watch for** scope. This is a contract change. Do it in one step that updates every caller, client, and test that matches on the old shape.
- **In a review**, the gaps are contract findings; report them there.

## Effect-aware tests and no manual runtime

Tests return Effects and receive their services through Layers. The test runner's Effect integration, or the framework's own test harness for code the framework runs, owns execution, scopes, and controlled time, so tests do not call `Effect.runPromise` or build runtimes themselves. In production code, Effect is run only where a process starts and where a foreign framework calls in; those boundaries own the runtime and its disposal.

- **Fits** most applications.
- **Exempt** entry files, bridges into a host framework, suites that drive a real browser or process from outside, and library examples whose purpose is to show how to run a program.
- **Watch for** tooling. Confirm the runner integration works with the repository's test toolchain before any test depends on it. Make that the first step.
- **Watch for** shared Layers in a test block: mutable state does not reset between tests unless construction is fresh or the test resets it.

## Property and model tests

Choose the smallest proof that fits the rule being tested.

| Behavior                              | Test shape                                    |
| ------------------------------------- | --------------------------------------------- |
| One interface between components      | An integration example with supplied services |
| A rule over many inputs               | A property over generated inputs              |
| State that depends on earlier actions | A model checked after generated commands      |

- **Fits** rules with a large input space, and state where order matters: ordering, moves in a tree, undo and redo, identity over time.
- **Watch for** the assertion. Generated inputs do not create it. The test needs a statement of correct behavior that does not call the code under test to decide the expected result.
- **Prove each new property** by planting a violation in the behavior it protects, watching it fail, and restoring the code.
- **Start small.** Adopt the practice as a rule for new tests plus a few seed properties on the rules that matter most. Do not convert existing example tests wholesale. Derive generators from the schemas where the schema library supports it.

## Lifecycles as machines

Named states, retries, cancellation, and lifecycles that must be resumed or inspected are modeled as an explicit state machine with declared states and events, kept beside the behavior it controls. Side effects are declared actors the machine invokes. A domain failure is a machine state; a failure of the machine itself is a defect. The source uses XState through its Effect integration.

- **Fits** a service that has accumulated booleans whose combinations have no meaning, or a workflow with several legal event orders.
- **Does not fit** where storage constraints already enforce the states, where a UI framework's model is already the state machine, or for a two-state flag.
- **Watch for** adding the dependency before there is a lifecycle that needs it.

## Removable packages

A package owns one job and the resources it needs. It is added with one package and one provision line, and removed by deleting both, with the repository's checks still passing and nothing left behind. The source calls these cartridges.

- **Fits** a monorepo with optional capabilities or interchangeable providers. Judge it for the repository, not for one package.
- **Does not fit** a single-package project. It is also not a reason to split packages during a restructure; propose it separately.
- **Prove it** by performing the removal in a scratch copy.

## No prose comments

Code carries no prose comments. A reason goes where the code can enforce or reveal it: a type, a test, a commit message. What remains: tool directives with their reason inline, a one-line safety statement above a type assertion, and type-only documentation blocks.

- **Fits** application code, where agents copy comments and a comment explaining a workaround spreads the workaround.
- **Does not fit as written** a published library. Documentation comments on the public API ship to consumers and are part of the product.
- **Before deleting a comment, move its reason.** An automatic fix deletes the comment and leaves the workaround unexplained.
- **A name says what a thing is, not why.** Do not push rationale into identifiers.
- **Do not create a parallel set of design notes** to hold the removed reasons. They drift from the code and duplicate it. Where the repository already keeps design notes by policy, use them.
- **Agree what survives before starting.** Reasons that no type or test can express need a home. A short marked why-comment is a common allowance, and settling this first avoids reversing the rule later.
- **In a review**, judge a repository against its own recorded comment rule. One that limits comments to a stated set of marked forms has this practice in an adapted form; only comments outside that set count against it.

## A lint fence

The rules above are enforced by the compiler, the linter, and hooks instead of by prose. Put each correction at the most enforceable place it can go: a type before a lint rule, a lint rule before a written instruction. Do not bypass a failing check. When a check and a paragraph disagree, reconcile them against the intended rule and correct whichever misstates it.

Typical rules: domain folders do not import adapters, vendors, or platform modules; Effect is run manually only in entry files; the comment rule; machines invoke only declared actors.

- **Fits** once the layout and the chosen practices have settled. It is the last step, since it encodes the others.
- **Ask first** in a repository that keeps its lint policy small.
- **Prefer the repository's linter** to a custom test. A test that scans import strings misses spellings such as package self-imports and type-only `import()` expressions.
- **Prefer an allow-list** of what each folder may import to a deny-list of forbidden spellings.
- **Prove each guard** by planting a violation and watching it fail, and keep a test of the rule itself.
- **Know the limits.** Syntax-based rules do not resolve every dynamic import, package condition, or re-export. A rule that only approximates the property it is named for will be wrong in both directions.
