import { once } from "node:events";
import { createServer } from "node:http";

import { describe, expect, it, vi } from "vite-plus/test";
import { z } from "zod/v4";

import { connectToServer } from "../connection.js";
import { fixtureServer, setupMcpTest } from "./helpers.js";

describe("mcp connection", () => {
  const t = setupMcpTest();

  it("keeps an in-flight HTTP call alive when 30-second deadlines expire", async () => {
    const deadlines: AbortController[] = [];
    const timeout = AbortSignal.timeout.bind(AbortSignal);
    vi.spyOn(AbortSignal, "timeout").mockImplementation((ms) => {
      if (ms !== 30_000) return timeout(ms);
      const deadline = new AbortController();
      deadlines.push(deadline);

      return deadline.signal;
    });
    const fixture = await t.startHttpFixture();
    const release = fixture.pauseToolCalls();
    const connection = await connectToServer({ serverConfig: { type: "http", url: fixture.url } });

    try {
      const call = connection.client.callTool({ name: "search", arguments: { query: "slow" } });

      const result = expect(call).resolves.toMatchObject({
        content: [{ type: "text", text: "result: slow" }],
      });

      await expect.poll(fixture.getToolCallCount).toBe(1);
      expect(deadlines.length).toBeGreaterThan(0);

      // Expire setup and any accidental per-fetch deadline while the real request is pending.
      for (const deadline of deadlines)
        deadline.abort(new DOMException("Deadline expired", "TimeoutError"));
      release();
      await result;
    } finally {
      release();
      await connection.close();
    }
  });

  it("still cancels an established HTTP tool request", async () => {
    const fixture = await t.startHttpFixture();
    const release = fixture.pauseToolCalls();
    const connection = await connectToServer({ serverConfig: { type: "http", url: fixture.url } });
    const controller = new AbortController();

    try {
      const call = connection.client.callTool(
        { name: "search", arguments: { query: "cancel" } },
        {
          signal: controller.signal,
        },
      );

      const rejected = expect(call).rejects.toThrow();
      await expect.poll(fixture.getToolCallCount).toBe(1);
      controller.abort();
      await rejected;
    } finally {
      release();
      await connection.close();
    }
  });

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

      const connection = connectToServer({
        serverConfig:
          type === "http"
            ? { type, url }
            : {
                type,
                command: process.execPath,
                args: ["-e", "process.stdin.once('data', () => void fetch(process.argv[1]));", url],
              },
        signal: controller.signal,
      });

      let error: unknown;

      const settled = connection.then(
        (value) => value.close(),
        // oxlint-disable-next-line anti-slop/no-unknown-parameters -- Capture the actual connection rejection without assuming dependencies throw Error objects.
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

      const connection = await connectToServer({
        serverConfig:
          type === "http" ? { type, url: (await t.startHttpFixture()).url } : fixtureServer(),
        signal: controller.signal,
      });

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
  it.each(["image", "structured", "mixed"])(
    "serves %s results from the shared HTTP fixture",
    async (scenario) => {
      const fixture = await t.startHttpFixture({ scenario });

      const connection = await connectToServer({
        serverConfig: { type: "http", url: fixture.url },
      });

      try {
        const result = await connection.client.callTool({
          name: "search",
          arguments: { query: "content" },
        });

        if (scenario === "image" || scenario === "mixed") {
          const image = result.content.find((item) => item.type === "image");
          expect(image).toBeDefined();

          if (image?.type === "image")
            expect(Buffer.from(image.data, "base64").subarray(1, 4).toString()).toBe("PNG");
        }

        if (scenario === "structured" || scenario === "mixed")
          expect(result.structuredContent).toMatchObject({ query: "content" });
        expect(fixture.state.operations).toBe(1);
      } finally {
        await connection.close();
      }
    },
  );

  it("exposes deterministic pause/release and malformed-result controls without replay", async () => {
    const fixture = await t.startHttpFixture();
    const connection = await connectToServer({ serverConfig: { type: "http", url: fixture.url } });
    const origin = new URL(fixture.url).origin;

    try {
      await fetch(`${origin}/control?action=pause`, { method: "POST" });
      const call = connection.client.callTool({ name: "search", arguments: { query: "paused" } });
      await expect.poll(fixture.getToolCallCount).toBe(1);
      expect(fixture.state.operations).toBe(0);
      await fetch(`${origin}/control?action=release`, { method: "POST" });
      await call;
      await fetch(`${origin}/control?action=malformed-next`, { method: "POST" });
      await expect(
        connection.client.callTool({ name: "search", arguments: { query: "malformed" } }),
      ).rejects.toThrow();
      const records = await (await fetch(`${origin}/records`)).json();
      expect(records).toMatchObject({ operations: 1, records: [{ tool: "search", round: 0 }] });
      expect(fixture.requests.filter((request) => request.method === "tools/call")).toHaveLength(2);
    } finally {
      await connection.close();
    }
  });
});
