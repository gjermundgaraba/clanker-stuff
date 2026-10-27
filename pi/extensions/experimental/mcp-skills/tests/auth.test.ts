import { rm } from "node:fs/promises";
import path from "node:path";

import { getAgentDir } from "@earendil-works/pi-coding-agent";
import { afterEach, describe, expect, it } from "vite-plus/test";

import { createStoredTokenAuth } from "../auth.js";
// Pi does not export its MCP credential store; this checks the file format auth.ts reads.
import { McpOAuthCredentialStore } from "../node_modules/@earendil-works/pi-coding-agent/dist/extensions/mcp/oauth.js";

const URL = "https://example.com/mcp";

describe("createStoredTokenAuth", () => {
  afterEach(async () => {
    await rm(path.join(getAgentDir(), "mcp-auth.json"), { force: true });
  });

  it("sends the OAuth token Pi stores at /mcp sign-in", async () => {
    await new McpOAuthCredentialStore().forServer("docs-server", URL).save({
      serverUrl: URL,
      tokens: { access_token: "stored-token", token_type: "Bearer" },
    });

    await expect(
      createStoredTokenAuth(getAgentDir(), "docs-server", URL).token()
    ).resolves.toBe("stored-token");
  });
});
