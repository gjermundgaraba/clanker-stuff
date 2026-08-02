# Extension structure

Every pi extension uses the same entrypoint contract and grows directories only when the code earns them. Source stays at the package root; these packages load TypeScript directly, so a `src/` directory adds no useful boundary.

```text
<name>/
  README.md  LICENSE  package.json
  index.ts              # Pi registrations and wiring
  <capability>.ts       # package-wide behavior
  <subsystem>/          # only for 3+ closely related modules
    <member>.ts
  docs/                 # package documentation beyond README.md
  tests/                # mirrors the source layout
    index.test.ts
    <capability>.test.ts
    <subsystem>/
      <member>.test.ts
    fixtures/           # setup shared by 2+ tests
    *.integration.test.ts
    *.smoke.test.ts
```

## Entrypoint

`index.ts` is a readable manifest of what the extension adds to pi. Opening it should reveal the extension's commands, tools, shortcuts, flags, event hooks, and runtime components without revealing their implementations.

`index.ts` may contain only:

- imports;
- the default extension function;
- construction of shared runtime or controller objects;
- direct `pi.register*()` and `pi.on()` calls;
- registration metadata such as names, labels, descriptions, and prompt guidance; and
- single-expression callbacks that delegate to imported functions or runtime methods.

```ts
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

import { createTimer } from "./timer.js";

export default function timer(pi: ExtensionAPI): void {
  const timer = createTimer();

  pi.on("agent_start", (_event, ctx) => timer.start(ctx));
  pi.on("agent_settled", (_event, ctx) => timer.stop(ctx));
  pi.on("session_shutdown", (_event, ctx) => timer.dispose(ctx));
}
```

`index.ts` must not contain:

- branches, loops, `try`/`catch`, or algorithms;
- parsing, validation, formatting, or rendering implementations;
- file, network, database, process, or terminal operations;
- schema declarations, classes, or helper functions; or
- mutable state other than constructed runtime or controller objects.

Keep `index.ts` below 120 nonblank lines. If registration alone exceeds that, group registrations by a real feature area such as `code-mode/register.ts`, then call those registrars from `index.ts`. Do not group solely by API type into generic `commands.ts` or `events.ts` files.

## Modules and directories

Each source module owns one primary concept. Supporting types, constants, and private helpers stay with that concept. Shared state stays in the module that owns it; create a controller only when multiple registered capabilities need to coordinate the same mutable state.

Names are relative to their package and containing directory. Use the shortest name that is unambiguous there:

- `ask-question/dialog/input.ts` is clear;
- `ask-question/input.ts` is ambiguous; and
- `ask-question/question-dialog-input.ts` repeats context already expressed by its directories.

Create a subdirectory only for at least three closely related modules, such as `adapters/`, `dialog/`, `media/`, or `profiles/`. Do not create one-file directories or empty standard skeletons. Keep runtime source no more than two directories deep unless an asset's native layout requires more.

Types live with the concept that owns them. Use a specifically named protocol module only for a contract shared by multiple modules or extensions; do not create generic `types.ts`, `helpers.ts`, `common.ts`, or barrel modules.

For example:

```text
ask-question/
  index.ts
  tool.ts
  questions.ts
  dialog/
    controller.ts
    input.ts
    render.ts
  tests/
    index.test.ts
    tool.test.ts
    questions.test.ts
    dialog/
      controller.test.ts
      input.test.ts
      render.test.ts
```

## Tests

Tests mirror the source path and responsibility. `tests/index.test.ts` covers registration metadata, delegation, and lifecycle wiring. Unit tests cover the matching source module. Use `*.integration.test.ts` only for real `AgentSession` behavior and `*.smoke.test.ts` only for discovery, packaging, or runtime loading.

Do not create package-wide catch-all tests such as `mcp.test.ts`. Put shared setup in `tests/helpers.ts` or `tests/fixtures/` only after at least two tests need it.

## Package and repository boundaries

Every root-level extension directory must be a workspace package with `package.json`, `README.md`, and `LICENSE`. Its package export and `pi.extensions` entry both point to `./index.ts`. Expose another package path only for an intentional shared protocol; internal test seams are not public API.

`package.json` `files` must include every runtime source file and asset plus `README.md` and `LICENSE`. Do not publish tests, research, audits, or development scripts unless they are required at runtime.

Standalone skills belong under `skills/`. Prototypes and executable research belong under `lab/`, not beside workspace extensions. A directory that looks like an extension must not be invisible to workspace validation.
