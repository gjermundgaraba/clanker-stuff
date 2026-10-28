import { McpServer } from "@modelcontextprotocol/server";
import type { McpServerFactory } from "@modelcontextprotocol/server";
import { loadSkills } from "@modelcontextprotocol/server/ext/skills/node";

export { serveHttp } from "./http.ts";

export type { HttpServer } from "./http.ts";

export interface TestServerOptions {
  skillsDir?: string;
}

export const createTestServer =
  (options: TestServerOptions): McpServerFactory =>
  async () => {
    const server = new McpServer({ name: "mcp-test-server", version: "0.1.0" });

    if (options.skillsDir !== undefined) {
      const skills = await loadSkills(options.skillsDir);
      skills.attach(server);
    }

    return server;
  };
