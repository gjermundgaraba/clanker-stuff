# The shared Oxlint preset

`config(options)` returns a complete Oxlint config. It extends Ultracite's core and anti-slop presets, then any presets you pass, then Ultracite's Vitest preset and `@effect/tsgo`'s recommended preset. It turns on type-aware linting and type checking, denies warnings and unused disable directives, loads the Vite+ plugin and this package's `clanker` plugin, and applies the shared exceptions below. Every option merges after the shared value, so a repository can override any of it.

## Options

| Option | Merges into |
| --- | --- |
| `extends` | Presets between anti-slop and Vitest, such as `ultracite/oxlint/solid`. |
| `jsPlugins` | Appended after the Vite+ and `clanker` plugins. |
| `testBlocks` | Test functions such as `it.effect`. Both `vitest/expect-expect` and `vitest/no-standalone-expect` treat them as tests. |
| `expectBlocks` | Functions that may hold `expect` without having to assert, such as `it.effect.each`. Only `vitest/no-standalone-expect` reads them. |
| `assertFunctions` | Assertion helpers, added to `expect`, `expectTypeOf`, `assert` and `assert.*`. |
| `env` | Merged over `{ node: true }`. |
| `ignorePatterns` | Appended to Ultracite core's ignore patterns. |
| `rules` | Spread over the shared rules. |
| `overrides` | Appended after the shared test-file override. |

## Examples

A plain repository, in `oxlint.config.ts`:

```ts
import { config } from "@clanker-stuff/oxlint-config";

export default config({
  testBlocks: ["it.effect", "it.live"],
  expectBlocks: ["it.effect.each"],
});
```

With Solid:

```ts
import { config } from "@clanker-stuff/oxlint-config";
import solid from "ultracite/oxlint/solid";

export default config({
  extends: [solid],
  testBlocks: ["it.effect", "it.live"],
  assertFunctions: ["tui.frame"],
});
```

With Foldkit, whose recommended config applies to one app:

```ts
import { config } from "@clanker-stuff/oxlint-config";
import foldkit from "@foldkit/oxlint-plugin";

const { recommended } = foldkit.configs;

const website = "apps/website/src";

const withinWebsite = (patterns: readonly string[] = []) =>
  patterns.map((pattern) => `${website}/${pattern}`);

export default config({
  jsPlugins: recommended.jsPlugins,
  assertFunctions: ["story", "scene"],
  overrides: [
    { files: [`${website}/**/*.ts`], rules: recommended.rules },
    ...recommended.overrides.map((override) => ({
      ...override,
      excludeFiles: withinWebsite(override.excludeFiles),
      files: withinWebsite(override.files),
    })),
  ],
});
```

In `vite.config.ts`, where Vite+ reads the same config from `lint`:

```ts
import { config } from "@clanker-stuff/oxlint-config";
import { defineConfig } from "vite-plus";

export default defineConfig({
  lint: config({ ignorePatterns: ["repos/**"] }),
});
```

## Shared exceptions

Rules the presets enable that the preset turns off or narrows, and why:

- `sort-keys`: key order carries meaning in wire formats, hashes, CLI flags, tool schemas and UI order.
- `max-classes-per-file`: a module holds several tagged errors or services, which are classes.
- `no-await-in-loop`: a loop awaits in order where order, back-pressure or one-at-a-time I/O matters.
- `require-await`: with `promise-function-async` it forces `await Promise.resolve(x)` into thin async wrappers.
- `typescript/consistent-return`: `return yield*` in a generator reads as an inconsistent return.
- `no-use-before-define`, narrowed: a module may call a function or class declared further down, and types are hoisted; a value used before its declaration is still an error.
- `complexity`, `max-nested-callbacks`: metrics, not defects; splitting to satisfy them scatters one decision across helpers.
- `no-bitwise`: hashes, file modes and binary formats are bitwise by nature.
- `unicorn/filename-case`, narrowed: Effect modules are PascalCase (`Schema.ts`); everything else is kebab-case.
- `anti-slop/no-conditional-empty-object-spread`: optional DTO fields belong in their construction expression.
- `func-names`, narrowed: generators passed to `Effect.gen` and `Effect.fn` are named by their span.
- `no-redeclare`: a schema and its type share a name; `tsc` rejects real redeclarations.
- `promise/prefer-await-to-then`: `Effect.catch` is not a promise chain.
- `promise/prefer-await-to-callbacks`: Effect handlers are typed functions, not error-first callbacks.
- `typescript/array-type`, narrowed: `readonly string[]`, but `ReadonlyArray<Html | string>` over `readonly (Html | string)[]`.
- `unicorn/no-array-method-this-argument`: Effect's data-first `map(self, f)` and `filter(self, f)` take no `thisArg`.
- `unicorn/throw-new-error`: `Schema.TaggedError<X>()` builds an error class; it throws nothing.
- `effecttsgo/unstable-api-usage`: notices for every unstable Effect API bury the warnings that matter.
- `anti-slop/require-safety-comment-for-type-assertion`: `typescript/no-unsafe-type-assertion` already confines casts, and a file-scoped override names the files that need one.
- `anti-slop/no-unknown-parameters`, `anti-slop/no-unknown-returns`: decoders, error describers, serializers and adapters take or return `unknown` at real boundaries, and the rules cannot tell those from a consumer that skipped a parse.
- `jsdoc/require-param-description`, `jsdoc/require-property-description`, `jsdoc/require-returns-description`, `jsdoc/require-throws-description`, `jsdoc/require-yields-description`: they demand prose in JSDoc, which the comment rule forbids; JSDoc that types JavaScript is tags only.
- `unicorn/text-encoding-identifier-case`: `"utf-8"` and `"utf8"` are both what Node accepts; the casing is style.
- `default-case`: a `switch` over a union stays exhaustive through `typescript/switch-exhaustiveness-check`, which the preset keeps on; a `default` would hide a missing case.
- `unicorn/no-useless-undefined`, `no-useless-return`: together they reject `return undefined` and a bare `return` in a function that returns a value, which pushed code to `null` for "no value".
- `no-inline-comments`, narrowed: tag-only JSDoc casts and bundler annotations (`@__PURE__`, `#__NO_SIDE_EFFECTS__`, `@vite-ignore`, `webpack…`) sit inline by nature.

The preset also turns on `vite-plus/prefer-vite-plus-imports` and `clanker/no-prose-comments`.

In test files, the same files Ultracite's Vitest preset treats as tests:

- `vitest/prefer-describe-function-title`: an `Effect.fn` export's runtime name is empty, so `describe(fn)` reports `<anonymous>`.
- `typescript/no-non-null-assertion`: a test writes `find(...)!` for what it asserts exists.
- `vitest/max-expects`: each value gets its own `expect`.
- `vitest/valid-expect`, narrowed to two arguments: an `expect` may carry a message.
- `vitest/prefer-to-be-truthy`, `vitest/prefer-to-be-falsy`: `toBe(true)` asserts a boolean; `toBeTruthy()` accepts any truthy value.
- `no-script-url`, `no-template-curly-in-string`: tests feed hostile and literal input on purpose.
- `vitest/no-restricted-vi-methods` rejects `vi.mock` and `vi.doMock`, including `vi` from `vite-plus/test`.

## The comment rule

`clanker/no-prose-comments` runs on every file, tests included. It reports every comment except:

- a license header: the file's first comment, or its leading run of line comments, before any code, containing `Copyright`, `SPDX-License-Identifier` or `License`;
- a tool directive: `oxlint-…`, `eslint-…`, `biome-ignore`, `@ts-expect-error`, `@ts-ignore` and `@ts-nocheck` (with or without `-- reason`), `prettier-ignore`, `oxfmt-ignore`, `/// <reference …>`, `@vitest-environment…`, `@jsxImportSource`, `@__PURE__`, `#__PURE__`, `#__NO_SIDE_EFFECTS__`, `@vite-ignore`, `webpack…`, and `istanbul`, `c8` or `v8` ignore;
- tag-only JSDoc anywhere: `@type`, `@typedef`, `@template`, `@satisfies`, `@import`, `@param {T} name`, `@returns {T}`, `@yields {T}`, `@property {T} name` and `@callback`, with types and names but no prose;
- JSDoc on anything inside an exported declaration, that is, `export const`, `function`, `class`, `type` or `interface`, `export default`, or a name exported through `export { name }`. That covers class and interface members, union arms, nested object properties, and object properties passed to a call, such as `Schema.Struct({ ... })` fields, `Context.Tag` service members and `Schema.TaggedError` fields. It stops at a function body: JSDoc on a local inside an exported function is prose;
- any comment with an `http://` or `https://` URL, which is how a foreign or platform gotcha stays: link the upstream issue, docs or source. A run of line comments on consecutive lines counts as one comment, so the URL may sit on any of its lines.

Everything else belongs in a name, a type, a test title or the commit message.

## Migrating a repository

1. Add the package and its peers as dev dependencies.
2. Replace `testFiles`, `sharedRules`, `sharedTestOverride` and the `defineConfig` shell with `config({ ... })`. Pass the repository's test-block names as `testBlocks`, the extra names its `vitest/no-standalone-expect` list had as `expectBlocks`, and its assertion helpers beyond the defaults as `assertFunctions`.
3. Drop what the preset now sets: the Vite+ plugin entry, `vite-plus/prefer-vite-plus-imports`, `anti-slop/no-unknown-parameters: "off"`, and `env: { node: true }`.
4. A repository that configures lint in `vite.config.ts` with a vendored anti-slop under `tools/oxlint/anti-slop` drops it and its `anti-slop` and `anti-slop-effect` plugin entries, because the vendored `anti-slop` name collides with Ultracite's. One with its own `no-comments` plugin drops that too; the shared rule has no `// Why:` or reasoned-directive allowance.
5. Run `vp check`. A repository that did not load the Vite+ plugin before may now see `vite-plus/prefer-vite-plus-imports` hits. Then delete or relink the comments the rule reports, remove `oxlint-disable` directives for rules the preset turned off (they now fail as unused), and replace `null` stand-ins for "no value" with `undefined` where that is now allowed.
