import { afterEach, describe, expect, it } from "vite-plus/test";

import { patchEnv } from "../../../../tests/helpers/env.js";
import { childEnv } from "../child.js";

describe("childEnv", () => {
  let restoreEnv: (() => void) | undefined;

  afterEach(() => {
    restoreEnv?.();
    restoreEnv = undefined;
  });

  it("keeps Claude Code's hands off state pi owns, overriding the parent's settings", () => {
    restoreEnv = patchEnv({
      DISABLE_AUTO_COMPACT: "0",
      CLAUDE_BRIDGE_CHILD_PROBE: "kept",
    });

    expect(childEnv()).toMatchObject({
      ENABLE_CLAUDEAI_MCP_SERVERS: "0",
      DISABLE_AUTO_COMPACT: "1",
      CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: "1",
      CLAUDE_BRIDGE_CHILD_PROBE: "kept",
    });
  });

  it("retries Claude Code's API calls 15 times unless pi's env says otherwise", () => {
    restoreEnv = patchEnv({ CLAUDE_CODE_MAX_RETRIES: undefined });

    expect(childEnv()["CLAUDE_CODE_MAX_RETRIES"]).toBe("15");

    restoreEnv();
    restoreEnv = patchEnv({ CLAUDE_CODE_MAX_RETRIES: "3" });

    expect(childEnv()["CLAUDE_CODE_MAX_RETRIES"]).toBe("3");
  });

  it("injects gateway settings into the child env and clears conflicting ANTHROPIC_API_KEY", () => {
    restoreEnv = patchEnv({
      ANTHROPIC_API_KEY: "sk-parent-key",
      ANTHROPIC_BASE_URL: undefined,
      ANTHROPIC_AUTH_TOKEN: undefined,
    });

    const env = childEnv({
      baseUrl: "http://127.0.0.1:8317",
      authToken: "gateway-token",
    });

    expect(env["ANTHROPIC_BASE_URL"]).toBe("http://127.0.0.1:8317");
    expect(env["ANTHROPIC_AUTH_TOKEN"]).toBe("gateway-token");
    expect(env["ANTHROPIC_API_KEY"]).toBeUndefined();
    expect(process.env["ANTHROPIC_BASE_URL"]).toBeUndefined();
    expect(process.env["ANTHROPIC_AUTH_TOKEN"]).toBeUndefined();
    expect(process.env["ANTHROPIC_API_KEY"]).toBe("sk-parent-key");
  });

  it("preserves parent ANTHROPIC_API_KEY when no gateway authToken is given", () => {
    restoreEnv = patchEnv({
      ANTHROPIC_API_KEY: "sk-parent-key",
      ANTHROPIC_BASE_URL: undefined,
      ANTHROPIC_AUTH_TOKEN: undefined,
    });

    const direct = childEnv();
    const urlOnly = childEnv({ baseUrl: "http://127.0.0.1:8317" });

    expect(direct["ANTHROPIC_BASE_URL"]).toBeUndefined();
    expect(direct["ANTHROPIC_AUTH_TOKEN"]).toBeUndefined();
    expect(direct["ANTHROPIC_API_KEY"]).toBe("sk-parent-key");
    expect(urlOnly["ANTHROPIC_BASE_URL"]).toBe("http://127.0.0.1:8317");
    expect(urlOnly["ANTHROPIC_AUTH_TOKEN"]).toBeUndefined();
    expect(urlOnly["ANTHROPIC_API_KEY"]).toBe("sk-parent-key");
  });
});
