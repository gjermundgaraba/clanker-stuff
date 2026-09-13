import { pathToFileURL } from "node:url";
import { serveStdio } from "@modelcontextprotocol/server/stdio";
import { McpServer, inputRequired } from "@modelcontextprotocol/server";
import type { CallToolResult, InputRequests } from "@modelcontextprotocol/server";
import { z } from "zod/v4";

export const FIXTURE_SCENARIOS = [
  "normal",
  "changed",
  "collision",
  "large",
  "error",
  "image",
  "structured",
  "mixed",
  "capabilities",
  "form",
  "roots",
  "sampling",
  "url",
  "rounds",
  "continuation-error",
  "sampling-error",
  "stalled",
  "malformed",
  "drop",
  "expired",
] as const;

export interface FixtureState {
  records: { tool: string; round: number }[];
  operations: number;
  url: string;
}
export const createFixtureState = (): FixtureState => ({
  records: [],
  operations: 0,
  url: "http://127.0.0.1:1/interaction",
});
export const createFixtureMcpServer = (
  scenario = "normal",
  state = createFixtureState(),
): McpServer => {
  if (!FIXTURE_SCENARIOS.some((value) => value === scenario))
    throw new Error(`Unknown fixture scenario: ${scenario}`);
  const server = new McpServer({
    name: "mcp-test-fixture",
    version: "1.0.0",
  });

  if (
    [
      "capabilities",
      "form",
      "roots",
      "sampling",
      "url",
      "rounds",
      "continuation-error",
      "sampling-error",
    ].includes(scenario)
  ) {
    server.registerTool(
      "interact",
      {
        inputSchema: z.object({
          maxTokens: z.number().int().positive().default(8),
          rounds: z.number().int().min(1).max(8).default(1),
        }),
      },
      async ({ maxTokens, rounds }, ctx) => {
        const round = Number(ctx.mcpReq.requestState<string>() ?? "0");
        state.records.push({ tool: "interact", round });
        if (round < rounds) {
          const requests: InputRequests = {};
          if (["capabilities", "roots"].includes(scenario))
            requests.roots = inputRequired.listRoots();
          if (
            ["capabilities", "form", "rounds", "continuation-error", "sampling-error"].includes(
              scenario,
            )
          )
            requests.form = inputRequired.elicit({
              message: `Fixture form round ${round + 1}`,
              requestedSchema: {
                type: "object",
                properties: {
                  name: { type: "string", default: "Ada" },
                  count: { type: "integer", minimum: 1, maximum: 10 },
                  enabled: { type: "boolean" },
                  choice: { type: "string", enum: ["one", "two"] },
                  tags: { type: "array", items: { type: "string", enum: ["red", "blue"] } },
                },
                required: ["name", "count", "enabled", "choice", "tags"],
              },
            });
          if (["capabilities", "sampling", "sampling-error"].includes(scenario))
            requests.sample = inputRequired.createMessage({
              maxTokens,
              systemPrompt: "You are the fixture sampling model.",
              messages: [
                { role: "user", content: { type: "text", text: "Count from one to one hundred." } },
              ],
            });
          if (scenario === "url")
            requests.url = inputRequired.elicitUrl({
              message: "Complete local interaction",
              url: state.url,
            });
          return inputRequired({ inputRequests: requests, requestState: String(round + 1) });
        }
        state.operations += 1;
        if (["continuation-error", "sampling-error"].includes(scenario))
          throw new Error("Fixture failed after receiving input");
        return { content: [{ type: "text", text: JSON.stringify(ctx.mcpReq.inputResponses) }] };
      },
    );
    return server;
  }

  if (scenario === "changed") {
    server.registerTool(
      "search",
      { inputSchema: z.object({ term: z.string() }) },
      async ({ term }) => ({
        content: [{ type: "text", text: `changed: ${term}` }],
      }),
    );
    return server;
  }

  if (scenario === "collision") {
    server.registerTool("foo-bar", { inputSchema: z.object({ query: z.string() }) }, async () => ({
      content: [{ text: "collision", type: "text" }],
    }));
    server.registerTool("foo_bar", { inputSchema: z.object({ query: z.string() }) }, async () => ({
      content: [{ text: "collision", type: "text" }],
    }));
    return server;
  }

  server.registerTool(
    "search",
    {
      description: "Search the fixture",
      inputSchema: z.object({ query: z.string() }),
    },
    async ({ query }): Promise<CallToolResult> => {
      state.records.push({ tool: "search", round: 0 });
      state.operations += 1;
      const image = {
        type: "image" as const,
        data: "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aWZkAAAAASUVORK5CYII=",
        mimeType: "image/png",
      };
      if (scenario === "image") return { content: [image] };
      if (scenario === "structured") return { content: [], structuredContent: { query, count: 3 } };
      if (scenario === "mixed")
        return {
          content: [{ type: "text", text: query }, image, { type: "text", text: "after image" }],
          structuredContent: { query },
        };
      let text = `result: ${query}`;
      if (scenario === "large") {
        text = "result\n".repeat(20_000);
      } else if (scenario === "error") {
        text = "failure\n".repeat(20_000);
      }
      return {
        content: [
          { text, type: "text" },
          ...(scenario === "error"
            ? [
                {
                  data: "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aWZkAAAAASUVORK5CYII=",
                  mimeType: "image/png",
                  type: "image" as const,
                },
              ]
            : []),
        ],
        isError: scenario === "error" ? true : undefined,
      };
    },
  );
  return server;
};

const runFixtureServer = async () => {
  const scenario = process.argv[2] ?? "normal";
  if (process.argv.includes("--http")) {
    const { startMcpHttpFixture } = await import("./http-server.ts");
    const fixture = await startMcpHttpFixture({
      scenario,
      oauth: process.argv.includes("--oauth"),
    });
    process.stderr.write(
      `MCP fixture: ${fixture.url}\nRecords: ${fixture.url.replace("/mcp", "/records")}\n`,
    );
    const stop = () => {
      void fixture.close().then(() => process.exit(0));
    };
    process.once("SIGINT", stop);
    process.once("SIGTERM", stop);
  } else if (scenario === "url") {
    const { startMcpHttpFixture } = await import("./http-server.ts");
    const pages = await startMcpHttpFixture();
    const state = createFixtureState();
    state.url = pages.url.replace("/mcp", "/interaction");
    serveStdio(() => createFixtureMcpServer(scenario, state));
    process.stdin.once("end", () => {
      void pages.close();
    });
  } else serveStdio(() => createFixtureMcpServer(scenario));
};

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  void runFixtureServer().catch((error) => {
    process.stderr.write(`${String(error)}\n`);
    process.exitCode = 1;
  });
}
