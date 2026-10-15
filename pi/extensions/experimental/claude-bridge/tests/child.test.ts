import { afterEach, describe, expect, it } from "vite-plus/test";

import { childEnv } from "../child.js";

import { patchEnv } from "../../../../tests/helpers/env.js";

let restoreEnv: (() => void) | undefined;

afterEach(() => {
  restoreEnv?.();
  restoreEnv = undefined;
});

// Silent when missing: Claude Code compacts its own copy or loads claude.ai MCP servers,
// nothing throws, and the damage shows up away from any test.
describe("childEnv", () => {
  it("keeps Claude Code's hands off state pi owns, overriding the parent's settings", () => {
    restoreEnv = patchEnv({ DISABLE_AUTO_COMPACT: "0", CLAUDE_BRIDGE_CHILD_PROBE: "kept" });

    expect(childEnv()).toMatchObject({
      ENABLE_CLAUDEAI_MCP_SERVERS: "0",
      DISABLE_AUTO_COMPACT: "1",
      CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: "1",
      CLAUDE_BRIDGE_CHILD_PROBE: "kept",
    });
  });
});
