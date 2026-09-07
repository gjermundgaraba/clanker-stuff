import { once } from "node:events";
import { createServer } from "node:http";

import { describe, expect, it, vi } from "vite-plus/test";
import { z } from "zod/v4";

import { connectToServer } from "../connection.js";
import { fixtureServer, setupMcpTest } from "./helpers.js";

describe("mcp connection", () => {
  const t = setupMcpTest();

  it.each(["http", "stdio"] as const)(
    "cancels a stalled %s discovery request",
    async (type) => {
      const server = createServer((req) => req.resume());
      server.listen(0, "127.0.0.1");
      await once(server, "listening");
      const { port } = z.object({ port: z.number() }).parse(server.address());
      const controller = new AbortController();
      const request = once(server, "request");
      const url = `http://127.0.0.1:${port}`;
      const connection = connectToServer(
        "stalled",
        type === "http"
          ? { type, url }
          : {
              type,
              command: process.execPath,
              args: ["-e", "process.stdin.once('data', () => void fetch(process.argv[1]));", url],
            },
        { notify: vi.fn() },
        false,
        controller.signal,
      );
      let error: unknown;
      const settled = connection.then(
        (value) => value.close(),
        (cause: unknown) => {
          error = cause;
        },
      );
      try {
        await request;
        controller.abort(new Error("Canceled discovery"));
        await expect.poll(() => error, { timeout: 1000 }).toBe(controller.signal.reason);
      } finally {
        server.closeAllConnections();
        server.close();
        await once(server, "close");
        await settled;
      }
    },
    2000,
  );

  it.each(["http", "stdio"] as const)(
    "keeps an established %s connection usable after its load signal is aborted",
    async (type) => {
      const controller = new AbortController();
      const connection = await connectToServer(
        "modern",
        type === "http" ? { type, url: (await t.startHttpFixture()).url } : fixtureServer(),
        { notify: vi.fn() },
        false,
        controller.signal,
      );
      try {
        controller.abort();
        const result = await connection.client.callTool({
          name: "search",
          arguments: { query: "needle" },
        });
        expect(result.content).toContainEqual({ type: "text", text: "result: needle" });
      } finally {
        await connection.close();
      }
    },
  );
});
