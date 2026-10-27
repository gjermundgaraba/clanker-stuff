import { recommended as effect } from "@effect/tsgo/oxlint-presets";
import { defineConfig } from "oxlint";
import type { DummyRuleMap, OxlintOverride } from "oxlint";
import antiSlop from "ultracite/oxlint/anti-slop";
import core from "ultracite/oxlint/core";
import vitest from "ultracite/oxlint/vitest";

// The shared Ultracite exceptions. Every Effect/Vite+ repository carries this block verbatim, so
// a grep finds every copy; only the test-block and assertion-function name lists vary. Each rule
// here conflicts with an Effect idiom or with a contract the code must keep. Changing the block
// needs maintainer approval, and changes every copy.
// The files Ultracite's vitest preset treats as tests, so its rules and these relaxations agree.
const testFiles = [
  "**/*.{test,spec,test-d,spec-d}.{ts,tsx,js,jsx,mts,cts,mjs,cjs}",
  "**/__tests__/**/*.{ts,tsx,js,jsx,mts,cts,mjs,cjs}",
];

export const sharedRules: DummyRuleMap = {
  // Key order carries meaning: wire formats, hashes, CLI flags, tool schemas, UI order.
  "sort-keys": "off",
  // A module holds several tagged errors or services, which are classes.
  "max-classes-per-file": "off",
  // A loop awaits in order where order, back-pressure or one-at-a-time I/O matters.
  "no-await-in-loop": "off",
  // With `promise-function-async`, it forces `await Promise.resolve(x)` into thin async wrappers.
  "require-await": "off",
  // `return yield*` in a generator reads as an inconsistent return.
  "typescript/consistent-return": "off",
  // A module may call a function or class declared further down, and types are hoisted; a
  // value used before its declaration is still an error.
  "no-use-before-define": [
    "error",
    { classes: false, functions: false, ignoreTypeReferences: true },
  ],
  // Metrics, not defects: splitting to satisfy them scatters one decision across helpers.
  complexity: "off",
  "max-nested-callbacks": "off",
  // Hashes, file modes and binary formats are bitwise by nature.
  "no-bitwise": "off",
  // Effect modules are PascalCase (`Schema.ts`); everything else is kebab-case.
  "unicorn/filename-case": [
    "error",
    { cases: { kebabCase: true, pascalCase: true } },
  ],
  // Optional DTO fields belong in their construction expression.
  "anti-slop/no-conditional-empty-object-spread": "off",
  // Generators passed to Effect.gen and Effect.fn are named by their span, not the function.
  "func-names": ["error", "as-needed", { generators: "never" }],
  // A schema and its type share a name; tsc rejects real redeclarations.
  "no-redeclare": "off",
  // `Effect.catch` is not a promise chain.
  "promise/prefer-await-to-then": "off",
  // Effect handlers are typed functions, not error-first callbacks: the rule flags every
  // `Effect.catch((error) => ...)`, the name `unicorn/catch-error-name` demands.
  "promise/prefer-await-to-callbacks": "off",
  // `readonly string[]`, but `ReadonlyArray<Html | string>` over `readonly (Html | string)[]`.
  "typescript/array-type": [
    "error",
    { default: "array-simple", readonly: "array-simple" },
  ],
  // Effect's data-first `map(self, f)` and `filter(self, f)` take no thisArg.
  "unicorn/no-array-method-this-argument": "off",
  // Effect APIs take `undefined` as a value, as in `Deferred.succeed(done, undefined)`.
  "unicorn/no-useless-undefined": ["error", { checkArguments: false }],
  // `Schema.TaggedError<X>()` builds an error class; it throws nothing.
  "unicorn/throw-new-error": "off",
  // Notices for every unstable Effect API bury the warnings that matter.
  "effecttsgo/unstable-api-usage": "off",
};

export const sharedTestOverride: OxlintOverride = {
  files: testFiles,
  // Naming the plugin lets the override reach its rules.
  plugins: ["vitest"],
  rules: {
    // `@effect/vitest`'s test functions are test blocks, and the repository's assertion helpers
    // (Foldkit's `scene`/`story` among them, where used) assert. List the names the repository uses.
    "vitest/no-standalone-expect": [
      "error",
      { additionalTestBlockFunctions: [] },
    ],
    "vitest/expect-expect": [
      "error",
      {
        additionalTestBlockFunctions: [],
        assertFunctionNames: [
          "expect",
          "expectTypeOf",
          "assert",
          "assert.*",
          "expectPrefix",
          "inspect",
          "open",
        ],
      },
    ],
    // An `Effect.fn` export's runtime name is empty, so `describe(fn)` reports `<anonymous>`; the
    // rule also takes namespace imports for functions. Titles are strings.
    "vitest/prefer-describe-function-title": "off",
    // A test writes `find(...)!` for what it asserts exists.
    "typescript/no-non-null-assertion": "off",
    // Each value gets its own `expect`, with a message where the value alone would not explain a failure.
    "vitest/max-expects": "off",
    "vitest/valid-expect": ["error", { maxArgs: 2 }],
    // `toBe(true)` asserts a boolean; `toBeTruthy()` accepts any truthy value.
    "vitest/prefer-to-be-truthy": "off",
    "vitest/prefer-to-be-falsy": "off",
    // Tests feed hostile and literal input on purpose.
    "no-script-url": "off",
    "no-template-curly-in-string": "off",
    // Replaces Ultracite's `no-module-mocking`, which misses `vi` from `vite-plus/test`.
    "vitest/no-restricted-vi-methods": [
      "error",
      {
        doMock:
          "Replace dependencies through Layers or real interfaces, not module mocks.",
        mock: "Replace dependencies through Layers or real interfaces, not module mocks.",
      },
    ],
  },
};

export const ignorePatterns = [
  // Evaluation caches and raw runs contain third-party source.
  "**/.harbor/**",
  // Adapted third-party skill with a minified diff bundle; keep upstream source for syncs.
  "skills/skill-doctor/**",
  // An eval task's starting workspace is what the agent under test is asked to fix; its defects
  // and its bytes (graders pin their hashes) are the task.
  "pi/evals/suites/*/tasks/**/environment/**",
];

export default defineConfig({
  env: { node: true },
  extends: [core, antiSlop, vitest, effect],
  ignorePatterns: [...(core.ignorePatterns ?? []), ...ignorePatterns],
  jsPlugins: [{ name: "vite-plus", specifier: "vite-plus/oxlint-plugin" }],
  options: {
    typeAware: true,
    typeCheck: true,
    denyWarnings: true,
    reportUnusedDisableDirectives: "deny",
  },
  overrides: [
    sharedTestOverride,
    // Published surface: these package entry points export interfaces that implementers satisfy.
    // Property signatures would check their parameters contravariantly and reject existing ones.
    {
      files: [
        "pi/packages/editor/index.ts",
        "pi/packages/skill-providers/index.ts",
      ],
      rules: { "typescript/method-signature-style": "off" },
    },
    // The eval container mounts these modules at /opt/pi-evals, /tests, /solution and /app;
    // tsconfig paths map the same addresses for type checking.
    {
      files: [
        "pi/evals/runtime/service-codex.mjs",
        "pi/evals/suites/scaling/*.mjs",
        "pi/evals/suites/smoke/tasks/coding/inventory-ledger/tests/hidden.test.js",
      ],
      rules: { "import/no-absolute-path": "off" },
    },
    // Eval tests and graders run on node:test inside the eval container, not on Vitest.
    {
      files: ["pi/evals/**/*.test.{js,mjs}"],
      plugins: ["vitest"],
      rules: {
        "vitest/no-import-node-test": "off",
        "vitest/prefer-each": "off",
        "vitest/prefer-importing-vitest-globals": "off",
      },
    },
    // The eval runtime is plain JavaScript checked through JSDoc, whose type annotations and
    // casts are comments by syntax: `/** @type {T} */ (value)`. Other inline comments stay errors.
    {
      files: ["pi/evals/**/*.{js,mjs}"],
      rules: {
        "no-inline-comments": [
          "error",
          { ignorePattern: String.raw`^\*\s*@(?:type|returns|param)\b` },
        ],
      },
    },
    // Persisted output: an FNV-1a hash over UTF-16 code units seeds the committed glyph
    // fixtures; code points would change it for astral input.
    {
      files: ["pi/extensions/experimental/shape-spinner/scripts/geometry.ts"],
      rules: { "unicorn/prefer-code-point": "off" },
    },
    // A JSON `\uXXXX` escape encodes one UTF-16 code unit, so `charCodeAt` is the right call.
    {
      files: ["pi/packages/tool-rendering/text.ts"],
      rules: { "unicorn/prefer-code-point": "off" },
    },
    // pi-tui's `Container.removeChild` is not a DOM node method.
    {
      files: ["pi/extensions/experimental/subagents/ui/transcript.ts"],
      rules: { "unicorn/prefer-dom-node-remove": "off" },
    },
    // These classes implement Pi's `Component` or the runtime interface their fakes stand in
    // for; the interface's methods cannot be static even when they ignore `this`.
    {
      files: [
        "pi/extensions/experimental/shape-spinner/settings.ts",
        "pi/extensions/experimental/subagents/tests/controller.test.ts",
        "pi/extensions/experimental/subagents/ui/widget.ts",
      ],
      rules: {
        "class-methods-use-this": [
          "error",
          { ignoreClassesWithImplements: "all" },
        ],
      },
    },
    // `next` here is a domain function (the vim document's next cell, Pi's renderer chain),
    // not a Node callback; `return next(...)` would be wrong.
    {
      files: [
        "pi/extensions/experimental/codemode-diffs/renderer.ts",
        "pi/extensions/experimental/vim/core/commands.ts",
        "pi/extensions/experimental/vim/tests/core/document.test.ts",
      ],
      rules: { "node/callback-return": "off" },
    },
    // The loop condition reads `done` and `failure`, which `end()` and `fail()` set while
    // the loop awaits.
    {
      files: [
        "pi/extensions/experimental/claude-bridge/query/prompt-stream.ts",
        "pi/extensions/experimental/claude-bridge/tests/helpers.ts",
      ],
      rules: { "no-unmodified-loop-condition": "off" },
    },
    // Counting by code points: `Array.from(text)` trips `prefer-spread`, and `[...text]` trips
    // `typescript/no-misused-spread`.
    {
      files: [
        "pi/extensions/experimental/turn-recap/conversation.ts",
        "pi/extensions/experimental/turn-recap/tests/runtime.test.ts",
      ],
      rules: { "unicorn/prefer-spread": "off" },
    },
    // Fakes whose `push` takes one message by contract (the SDK query, the watch decoder);
    // the rule reads them as `Array#push`.
    {
      files: [
        "pi/extensions/experimental/background-tasks/tests/protocol.test.ts",
        "pi/extensions/experimental/claude-bridge/tests/agent-session.integration.test.ts",
        "pi/extensions/experimental/claude-bridge/tests/provider.test.ts",
      ],
      rules: { "unicorn/prefer-single-call": "off" },
    },
    // A JSON round trip on purpose: the expectation is what the tool's JSON text or a
    // reloaded session holds, which drops `undefined` fields that `structuredClone` keeps.
    {
      files: [
        "pi/extensions/experimental/background-tasks/tests/renderers.test.ts",
      ],
      rules: { "unicorn/prefer-structured-clone": "off" },
    },
    // A rejection assertion attached before the action that rejects and awaited after it, which
    // the rule cannot express: awaiting it at once hangs, and a bare promise rejects unhandled.
    {
      files: [
        "pi/extensions/experimental/claude-bridge/tests/query/prompt-stream.test.ts",
      ],
      plugins: ["vitest"],
      rules: { "vitest/valid-expect": "off" },
    },
    // Assertion helpers outside a test body: a `beforeEach` precondition that should fail
    // every test, and a fake runtime's `settle()`/`finish()` that poll with `vi.waitFor`.
    {
      files: [
        "pi/extensions/experimental/mcp-skills/tests/index.test.ts",
        "pi/extensions/experimental/subagents/tests/controller.test.ts",
      ],
      plugins: ["vitest"],
      rules: { "vitest/no-standalone-expect": "off" },
    },
    // Callbacks registered before the runtime exists read `steer`, which is destructured
    // from it afterwards.
    {
      files: [
        "pi/extensions/experimental/subagents/tests/runtime.integration.test.ts",
      ],
      rules: { "prefer-const": ["error", { ignoreReadBeforeAssign: true }] },
    },
    // Shape Spinner draws geometric shapes, and "shape" names that domain and the product: its
    // glyph package, its persisted settings and the published `SHAPE_SPINNER_COMMAND`. The rule
    // reads every "shape" as a structural name for something that has an owner.
    {
      files: [
        "pi/extensions/experimental/shape-spinner/**",
        "pi/extensions/experimental/subagents/index.ts",
        "pi/packages/shape-glyphs/**",
      ],
      rules: { "anti-slop/no-shape-in-symbol-names": "off" },
    },
    // `typeof` here either tells apart the members of a declared union (Pi's `string | Content[]`,
    // `JsonValue`, `string | Settings`, `OverlayOptions | (() => OverlayOptions)`), where nothing
    // is left to parse, or is the hand-written decoder at the boundary (configs, JSON, logs, CDP
    // results, and the eval scripts, whose type predicates are JSDoc the rule cannot see). The rule
    // asks for a parse at the boundary and reads these as the branch that skipped one.
    {
      files: [
        "pi/evals/**/*.{js,mjs}",
        "pi/extensions/ask-question/tests/lifecycle.integration.test.ts",
        "pi/extensions/experimental/claude-bridge/json.ts",
        "pi/extensions/experimental/claude-bridge/log.ts",
        "pi/extensions/experimental/claude-bridge/machine/conversation.ts",
        "pi/extensions/experimental/claude-bridge/mcp-server.ts",
        "pi/extensions/experimental/claude-bridge/session/convert.ts",
        "pi/extensions/experimental/claude-bridge/session/rebuild.ts",
        "pi/extensions/experimental/claude-bridge/tests/machine/conversation.test.ts",
        "pi/extensions/experimental/claude-bridge/tests/provider.test.ts",
        "pi/extensions/experimental/claude-bridge/tests/query/prompt-stream.test.ts",
        "pi/extensions/experimental/claude-bridge/tests/session/convert.test.ts",
        "pi/extensions/experimental/claude-bridge/tests/session/messages.ts",
        "pi/extensions/experimental/codemode-diffs/diffs.ts",
        "pi/extensions/experimental/context/observation.ts",
        "pi/extensions/experimental/fast/tests/transport.integration.test.ts",
        "pi/extensions/experimental/footer/tests/layout.test.ts",
        "pi/extensions/experimental/mcp-skills/config.ts",
        "pi/extensions/experimental/mcp-skills/entry.ts",
        "pi/extensions/experimental/mcp-skills/resource-reads.ts",
        "pi/extensions/experimental/mcp-skills/runtime.ts",
        "pi/extensions/experimental/mcp-skills/skill-reads.ts",
        "pi/extensions/experimental/mcp-skills/tests/config.test.ts",
        "pi/extensions/experimental/plannotator/tests/commands/last.test.ts",
        "pi/extensions/experimental/shape-spinner/scripts/render.ts",
        "pi/extensions/experimental/subagents/monitor.ts",
        "pi/extensions/experimental/subagents/renderers.ts",
        "pi/extensions/experimental/subagents/tests/manager.integration.test.ts",
        "pi/extensions/experimental/subagents/tests/ui/presenter.test.ts",
        "pi/extensions/experimental/subagents/tools.ts",
        "pi/extensions/experimental/turn-recap/tests/index.test.ts",
        "pi/extensions/experimental/turn-recap/tests/runtime.integration.test.ts",
        "pi/extensions/experimental/turn-recap/tests/runtime.test.ts",
        "pi/extensions/experimental/usage/adapters/xai.ts",
        "pi/extensions/history/storage.ts",
        "pi/extensions/history/tests/runtime.test.ts",
        "pi/lab/mcp-test-server/http.ts",
        "pi/packages/skill-providers/index.ts",
        "pi/packages/tool-schema/index.ts",
        "pi/tests/harness/tui.ts",
        "scripts/check-package-readiness.ts",
      ],
      rules: { "anti-slop/no-runtime-typeof": "off" },
    },
    // Stricter than the presets: stdout is Pi's JSON and RPC transport, so extension code must
    // not write to it. Scripts, evals and tests own their stdout.
    {
      excludeFiles: ["**/scripts/**", "**/tests/**", "pi/evals/**"],
      files: ["**/*.{ts,mts,cts,js,mjs,cjs}"],
      rules: { "no-console": ["error", { allow: ["error", "warn"] }] },
    },
  ],
  rules: {
    ...sharedRules,
    // A type predicate that checks what it claims is the decoder the rule asks for.
    "anti-slop/no-runtime-typeof": ["error", { allowInTypeGuards: true }],
    // The parameter is the undecoded value: decoders and validators (`parseConfig`,
    // `validateQuestionnaire`), error describers, serializers and JSON replacers, `.catch`
    // handlers, and Pi's untyped event payloads. The rule exempts only the name `cause`, so it
    // cannot tell the decoder at the boundary from a consumer that skipped one.
    "anti-slop/no-unknown-parameters": "off",
    // Tests and tooling import Vite+'s entry points, not vite or vitest.
    "vite-plus/prefer-vite-plus-imports": "error",
  },
});
