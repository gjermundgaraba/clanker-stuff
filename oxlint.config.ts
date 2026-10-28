import { config } from "@clanker-stuff/oxlint-config";

export const thirdPartyEvalRuns = "**/.harbor/**";

const evalTaskStartingWorkspaces = "pi/evals/suites/*/tasks/**/environment/**";

export const ignorePatterns = [
  thirdPartyEvalRuns,
  "skills/skill-doctor/**",
  evalTaskStartingWorkspaces,
];

export default config({
  assertFunctions: ["expectPrefix", "inspect", "open"],
  ignorePatterns,
  overrides: [
    {
      files: [
        "pi/packages/editor/index.ts",
        "pi/packages/skill-providers/index.ts",
      ],
      rules: { "typescript/method-signature-style": "off" },
    },
    {
      files: [
        "pi/evals/runtime/service-codex.mjs",
        "pi/evals/suites/scaling/*.mjs",
        "pi/evals/suites/smoke/tasks/coding/inventory-ledger/tests/hidden.test.js",
      ],
      rules: { "import/no-absolute-path": "off" },
    },
    {
      files: ["pi/evals/**/*.test.{js,mjs}"],
      plugins: ["vitest"],
      rules: {
        "vitest/no-import-node-test": "off",
        "vitest/prefer-each": "off",
        "vitest/prefer-importing-vitest-globals": "off",
      },
    },
    {
      files: ["pi/extensions/experimental/shape-spinner/scripts/geometry.ts"],
      rules: { "unicorn/prefer-code-point": "off" },
    },
    {
      files: ["pi/packages/tool-rendering/text.ts"],
      rules: { "unicorn/prefer-code-point": "off" },
    },
    {
      files: ["pi/extensions/experimental/subagents/ui/transcript.ts"],
      rules: { "unicorn/prefer-dom-node-remove": "off" },
    },
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
    {
      files: [
        "pi/extensions/experimental/codemode-diffs/renderer.ts",
        "pi/extensions/experimental/vim/core/commands.ts",
        "pi/extensions/experimental/vim/tests/core/document.test.ts",
      ],
      rules: { "node/callback-return": "off" },
    },
    {
      files: [
        "pi/extensions/experimental/claude-bridge/query/prompt-stream.ts",
        "pi/extensions/experimental/claude-bridge/tests/helpers.ts",
      ],
      rules: { "no-unmodified-loop-condition": "off" },
    },
    {
      files: [
        "pi/extensions/experimental/turn-recap/conversation.ts",
        "pi/extensions/experimental/turn-recap/tests/runtime.test.ts",
      ],
      rules: { "unicorn/prefer-spread": "off" },
    },
    {
      files: [
        "pi/extensions/experimental/background-tasks/tests/protocol.test.ts",
        "pi/extensions/experimental/claude-bridge/tests/agent-session.integration.test.ts",
        "pi/extensions/experimental/claude-bridge/tests/provider.test.ts",
      ],
      rules: { "unicorn/prefer-single-call": "off" },
    },
    {
      files: [
        "pi/extensions/experimental/background-tasks/tests/renderers.test.ts",
      ],
      rules: { "unicorn/prefer-structured-clone": "off" },
    },
    {
      files: [
        "pi/extensions/experimental/claude-bridge/tests/query/prompt-stream.test.ts",
      ],
      plugins: ["vitest"],
      rules: { "vitest/valid-expect": "off" },
    },
    {
      files: [
        "pi/extensions/experimental/mcp-skills/tests/index.test.ts",
        "pi/extensions/experimental/subagents/tests/controller.test.ts",
      ],
      plugins: ["vitest"],
      rules: { "vitest/no-standalone-expect": "off" },
    },
    {
      files: [
        "pi/extensions/experimental/subagents/tests/runtime.integration.test.ts",
      ],
      rules: { "prefer-const": ["error", { ignoreReadBeforeAssign: true }] },
    },
    {
      files: [
        "pi/extensions/experimental/shape-spinner/**",
        "pi/extensions/experimental/subagents/index.ts",
        "pi/packages/shape-glyphs/**",
      ],
      rules: { "anti-slop/no-shape-in-symbol-names": "off" },
    },
    {
      files: ["pi/tests/harness/tui.ts"],
      rules: { "typescript/no-unsafe-type-assertion": "off" },
    },
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
    {
      excludeFiles: ["**/scripts/**", "**/tests/**", "pi/evals/**"],
      files: ["**/*.{ts,mts,cts,js,mjs,cjs}"],
      rules: { "no-console": ["error", { allow: ["error", "warn"] }] },
    },
  ],
});
