import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { expect, it } from "vite-plus/test";

import { loadServers } from "../config.js";

it("ignores OAuth sign-in settings without weakening connection validation", async () => {
  const agentDir = await mkdtemp(path.join(os.tmpdir(), "mcp-skills-config-"));
  const url = "https://example.com/mcp";

  try {
    await writeFile(
      path.join(agentDir, "mcp.json"),
      JSON.stringify({
        mcpServers: {
          malformedBlock: { url, oauth: "unused" },
          malformedFields: {
            url,
            oauth: { clientId: 42, callbackUrl: "https://remote.example/callback" },
            auth: { provider: "example" },
          },
          unsafeProvider: {
            url: "http://remote.example/mcp",
            auth: { provider: "example" },
          },
          malformedHeaders: { url, headers: { Authorization: 42 } },
        },
      }),
    );

    expect(loadServers({ agentDir, cwd: agentDir, projectTrusted: false, registered: [] })).toEqual(
      [
        {
          name: "malformedBlock",
          timeoutMs: 60_000,
          transport: { kind: "http", url, headers: {} },
        },
        {
          name: "malformedFields",
          timeoutMs: 60_000,
          transport: { kind: "http", url, headers: {}, authProvider: "example" },
        },
      ],
    );
  } finally {
    await rm(agentDir, { recursive: true, force: true });
  }
});
