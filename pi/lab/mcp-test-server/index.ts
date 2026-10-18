import { McpServer } from "@modelcontextprotocol/server";
import type { McpServerFactory } from "@modelcontextprotocol/server";

import { registerSkills } from "./skills.ts";

export interface TestServerOptions {
  /** Folder of skills to serve. Without it the server does not offer the skills extension. */
  skillsDir?: string;
}

/** A fresh server for each connection or request, with the features the options turn on. */
export const createTestServer =
  (options: TestServerOptions): McpServerFactory =>
  ({ era }) => {
    const server = new McpServer({ name: "mcp-test-server", version: "0.1.0" });

    if (options.skillsDir !== undefined) registerSkills(server, { dir: options.skillsDir, era });

    return server;
  };
