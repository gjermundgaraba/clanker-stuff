// Run the test server: `node cli.ts` serves stdio; `--http <port>` serves http://127.0.0.1:<port>/mcp.
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";

import { serveStdio } from "@modelcontextprotocol/server/stdio";

import { serveHttp } from "./http.ts";
import { createTestServer } from "./index.ts";

const { values } = parseArgs({
  options: {
    help: { short: "h", type: "boolean" },
    host: { default: "127.0.0.1", type: "string" },
    http: { type: "string" },
    "no-skills": { type: "boolean" },
    skills: { default: fileURLToPath(new URL("skills/", import.meta.url)), type: "string" },
  },
});

if (values.help) {
  process.stdout
    .write(`Usage: node cli.ts [--http <port>] [--host <host>] [--skills <dir> | --no-skills]

Serves MCP over stdio, or over streamable HTTP at /mcp with --http.
--host       address to listen on with --http (default: 127.0.0.1)
--skills     folder of skills to serve (default: the bundled dummy skills)
--no-skills  do not offer the skills extension
`);
  process.exit(0);
}

const factory = createTestServer(values["no-skills"] ? {} : { skillsDir: values.skills });

if (values.http === undefined) {
  serveStdio(factory);
} else {
  const { url } = await serveHttp(factory, { host: values.host, port: Number(values.http) });
  process.stderr.write(`mcp-test-server listening on ${url}\n`);
}
