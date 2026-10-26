import { McpServer } from "@modelcontextprotocol/server";
import type { McpServerFactory } from "@modelcontextprotocol/server";
import { loadSkills } from "@modelcontextprotocol/server/ext/skills/node";

export { serveHttp } from "./http.ts";

export type { HttpServer } from "./http.ts";

export interface TestServerOptions {
  /** Folder of skills to serve. Without it the server does not offer the skills extension. */
  skillsDir?: string;
}

/**
 * A fresh server for each connection or request, with the features the options turn on. Skills are
 * read when the server is made: once per stdio connection, and on every HTTP request.
 */
export const createTestServer =
  (options: TestServerOptions): McpServerFactory =>
  async () => {
    const server = new McpServer({ name: "mcp-test-server", version: "0.1.0" });

    if (options.skillsDir !== undefined) (await loadSkills(options.skillsDir)).attach(server);

    return server;
  };
