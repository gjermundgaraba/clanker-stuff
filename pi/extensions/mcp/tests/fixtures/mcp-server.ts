import { McpServer } from "@modelcontextprotocol/server";
import type { CallToolResult } from "@modelcontextprotocol/server";
import { z } from "zod/v4";

export const createFixtureMcpServer = (scenario = "normal"): McpServer => {
  const server = new McpServer({
    name: "mcp-test-fixture",
    version: "1.0.0",
  });

  if (scenario === "collision") {
    server.registerTool(
      "foo-bar",
      { inputSchema: z.object({ query: z.string() }) },
      async () => ({ content: [{ text: "collision", type: "text" }] })
    );
    server.registerTool(
      "foo_bar",
      { inputSchema: z.object({ query: z.string() }) },
      async () => ({ content: [{ text: "collision", type: "text" }] })
    );
    return server;
  }

  server.registerTool(
    "search",
    {
      description: "Search the fixture",
      inputSchema: z.object({ query: z.string() }),
    },
    async ({ query }): Promise<CallToolResult> => ({
      content: [
        {
          text:
            scenario === "large"
              ? "result\n".repeat(20_000)
              : `result: ${query}`,
          type: "text",
        },
      ],
    })
  );
  return server;
};
