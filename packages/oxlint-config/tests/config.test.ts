import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";

import type { OxlintConfig } from "oxlint";
import { describe, expect, it } from "vite-plus/test";

import { config } from "../src/index.ts";

const extra: OxlintConfig = { rules: { "no-console": "error" } };

const merged = config({
  extends: [extra],
  testBlocks: ["it.effect"],
  expectBlocks: ["it.effect.each"],
  assertFunctions: ["story"],
  env: { browser: false },
  ignorePatterns: ["repos/**"],
  rules: { "default-case": "error" },
  overrides: [{ files: ["scripts/**"], rules: { "no-console": "off" } }],
});

const testRules = merged.overrides?.[0]?.rules ?? {};

describe("config", () => {
  it("loads the comment plugin from a file next to the preset", () => {
    const plugin = fileURLToPath(new URL("../src/plugin.ts", import.meta.url));

    expect(merged.jsPlugins).toContainEqual({
      name: "clanker",
      specifier: plugin,
    });
    expect(existsSync(plugin)).toBe(true);
  });

  it("lets repository values follow the shared ones", () => {
    expect(merged.rules?.["default-case"]).toBe("error");
    expect(merged.rules?.["clanker/no-prose-comments"]).toBe("error");
    expect(merged.env).toStrictEqual({ node: true, browser: false });
    expect(merged.ignorePatterns?.at(-1)).toBe("repos/**");
    expect(merged.overrides?.[1]?.files).toStrictEqual(["scripts/**"]);
    expect(merged.extends?.indexOf(extra)).toBe(2);
    expect(merged.extends).toHaveLength(5);
  });

  it("feeds test blocks and assertion helpers to the Vitest rules", () => {
    expect(testRules["vitest/expect-expect"]).toStrictEqual([
      "error",
      {
        additionalTestBlockFunctions: ["it.effect"],
        assertFunctionNames: [
          "expect",
          "expectTypeOf",
          "assert",
          "assert.*",
          "story",
        ],
      },
    ]);
    expect(testRules["vitest/no-standalone-expect"]).toStrictEqual([
      "error",
      { additionalTestBlockFunctions: ["it.effect", "it.effect.each"] },
    ]);
  });
});
