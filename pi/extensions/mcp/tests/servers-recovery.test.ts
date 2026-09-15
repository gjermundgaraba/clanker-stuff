import { syncBuiltinESMExports } from "node:module";
import timers from "node:timers/promises";
import { raceWithAbortSignal } from "@earendil-works/pi-ai/utils/abort";
import {
  ProtocolError,
  ProtocolErrorCode,
  SdkError,
  SdkErrorCode,
  SdkHttpError,
  UnauthorizedError,
} from "@modelcontextprotocol/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";

import { toGeneratedToolName } from "../bridge.js";
import type { McpClient, McpClientConnection, McpConnectionFactory } from "../connection.js";
import { McpServerPool } from "../servers.js";
import { setupMcpTest } from "./helpers.js";

const expired = () => new SdkHttpError(SdkErrorCode.SendFailed, "session expired", { status: 404 });
const timeout = () => new SdkError(SdkErrorCode.RequestTimeout, "ping timed out");

// Deferred requests must honor cancellation, just like the SDK's ping implementation.
const pendingPing =
  (promise: ReturnType<McpClient["ping"]>): McpClient["ping"] =>
  (options) =>
    options?.signal ? raceWithAbortSignal(promise, options.signal) : promise;

const makeConnection = (toolName = "mutate") => {
  const lifetime = new AbortController();
  return {
    client: {
      ping: vi.fn<McpClient["ping"]>(async () => ({})),
      listTools: vi.fn<McpClient["listTools"]>(async () => ({
        tools: [{ name: toolName, inputSchema: { type: "object" } }],
      })),
      callTool: vi.fn<McpClient["callTool"]>(async () => ({ content: [] })),
    },
    closed: lifetime.signal,
    close: vi.fn(async () => {
      lifetime.abort();
    }),
    transport: { sessionId: "test-session" },
  };
};

describe("MCP connection maintenance", () => {
  const t = setupMcpTest();
  let pool: McpServerPool;
  let host: ReturnType<typeof t.createExtensionHost>;
  let warn: ReturnType<typeof vi.fn<(message: string) => void>>;

  beforeEach(async () => {
    warn = vi.fn();
    host = t.createExtensionHost(
      (pi) => {
        pool = new McpServerPool(pi, warn);
        pi.on("session_shutdown", () => pool.closeAll());
      },
      { activeTools: ["read"], allTools: ["read"], hasUI: false },
    );
    await host.ready;
    vi.useFakeTimers();
    // Node's promise timers need an explicit bridge to the controlled clock.
    vi.spyOn(timers, "setTimeout").mockImplementation(async (delay, value, options) => {
      let timer: ReturnType<typeof setTimeout> | undefined;
      const pending = new Promise<typeof value>((resolve) => {
        timer = setTimeout(() => resolve(value), delay);
      });
      try {
        return await (options?.signal ? raceWithAbortSignal(pending, options.signal) : pending);
      } finally {
        clearTimeout(timer);
      }
    });
    syncBuiltinESMExports();
  });

  afterEach(async () => {
    await pool.closeAll();
    vi.useRealTimers();
    vi.restoreAllMocks();
    syncBuiltinESMExports();
  });

  const load = (connectionFactory: McpConnectionFactory, heartbeatIntervalMs?: number) =>
    pool.loadServer({
      serverName: "remote",
      interactive: true,
      connectionFactory,
      heartbeatIntervalMs,
    });

  const execute = (id: string, signal?: AbortSignal) =>
    host.runTool(toGeneratedToolName("remote", "mutate"), {}, { toolCallId: id, signal });

  it("pings at the default interval with a bounded timeout and stops on shutdown", async () => {
    const connection = makeConnection();
    await load(async () => connection);
    await vi.advanceTimersByTimeAsync(59_999);
    expect(connection.client.ping).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    expect(connection.client.ping).toHaveBeenCalledExactlyOnceWith({
      signal: expect.any(AbortSignal),
      timeout: 10_000,
    });
    await vi.advanceTimersByTimeAsync(60_000);
    expect(connection.client.ping).toHaveBeenCalledTimes(2);
    await pool.closeAll();
    expect(vi.getTimerCount()).toBe(0);
    await vi.advanceTimersByTimeAsync(120_000);
    expect(connection.client.ping).toHaveBeenCalledTimes(2);
    expect(connection.close).toHaveBeenCalledOnce();
  });

  it("uses configured heartbeat settings and never overlaps pings", async () => {
    const connection = makeConnection();
    const ping = Promise.withResolvers<{}>();
    connection.client.ping.mockImplementationOnce(pendingPing(ping.promise));
    await pool.loadServer({
      serverName: "remote",
      interactive: false,
      connectionFactory: async () => connection,
      heartbeatIntervalMs: 200,
      heartbeatTimeoutMs: 5_000,
    });
    await vi.advanceTimersByTimeAsync(200);
    expect(connection.client.ping).toHaveBeenCalledExactlyOnceWith({
      signal: expect.any(AbortSignal),
      timeout: 5_000,
    });
    await vi.advanceTimersByTimeAsync(2_000);
    expect(connection.client.ping).toHaveBeenCalledOnce();
    ping.resolve({});
    await vi.advanceTimersByTimeAsync(200);
    expect(connection.client.ping).toHaveBeenCalledTimes(2);
  });

  it("disables pings with zero but still reconnects a closed connection noninteractively", async () => {
    const first = makeConnection();
    const second = makeConnection("replacement");
    const factory = vi
      .fn<McpConnectionFactory>()
      .mockResolvedValueOnce(first)
      .mockResolvedValue(second);
    await load(factory, 0);
    await vi.advanceTimersByTimeAsync(120_000);
    expect(first.client.ping).not.toHaveBeenCalled();
    await first.close();
    await vi.advanceTimersByTimeAsync(0);
    expect(factory.mock.calls.map(([interactive]) => interactive)).toEqual([true, false]);
    expect(host.getActiveTools()).toEqual(["read", toGeneratedToolName("remote", "replacement")]);
    expect(second.client.callTool).not.toHaveBeenCalled();
  });

  it.each([expired, timeout])(
    "repairs a failed idle ping without executing any tools (%#)",
    async (failure) => {
      const first = makeConnection();
      const second = makeConnection();
      first.client.ping.mockRejectedValueOnce(failure());
      const factory = vi
        .fn<McpConnectionFactory>()
        .mockResolvedValueOnce(first)
        .mockResolvedValue(second);
      await load(factory, 100);
      await vi.advanceTimersByTimeAsync(100);
      expect(first.close).toHaveBeenCalledOnce();
      expect(factory).toHaveBeenCalledTimes(2);
      expect(second.client.listTools).toHaveBeenCalledOnce();
      expect(first.client.callTool).not.toHaveBeenCalled();
      expect(second.client.callTool).not.toHaveBeenCalled();
      expect(host.getActiveTools()).toContain(toGeneratedToolName("remote", "mutate"));
      await vi.advanceTimersByTimeAsync(100);
      expect(second.client.ping).toHaveBeenCalledOnce();
    },
  );

  it("coalesces concurrent session failures without replaying either mutation", async () => {
    const first = makeConnection();
    const second = makeConnection();
    const failure = Promise.withResolvers<never>();
    first.client.callTool.mockReturnValue(failure.promise);
    const factory = vi
      .fn<McpConnectionFactory>()
      .mockResolvedValueOnce(first)
      .mockResolvedValue(second);
    await load(factory);
    const calls = Promise.allSettled([execute("one"), execute("two")]);
    await vi.advanceTimersByTimeAsync(0);
    failure.reject(expired());
    expect((await calls).map((call) => call.status)).toEqual(["rejected", "rejected"]);
    await vi.advanceTimersByTimeAsync(0);
    expect(first.client.callTool).toHaveBeenCalledTimes(2);
    expect(second.client.callTool).not.toHaveBeenCalled();
    expect(factory).toHaveBeenCalledTimes(2);
    await execute("next");
    expect(second.client.callTool).toHaveBeenCalledOnce();
  });

  it.each([
    new ProtocolError(ProtocolErrorCode.MethodNotFound, "no ping"),
    new SdkError(SdkErrorCode.MethodNotSupportedByProtocolVersion, "no ping"),
  ])("disables unsupported pings without reconnect loops (%#)", async (error) => {
    const connection = makeConnection();
    connection.client.ping.mockRejectedValue(error);
    const factory = vi.fn<McpConnectionFactory>(async () => connection);
    await load(factory, 100);
    await vi.advanceTimersByTimeAsync(1_000);
    expect(connection.client.ping).toHaveBeenCalledOnce();
    expect(factory).toHaveBeenCalledOnce();
    expect(pool.hasServer("remote")).toBe(true);
  });

  it("skips pings during tool calls and does not interrupt a tool that starts during a ping", async () => {
    const connection = makeConnection();
    const result = Promise.withResolvers<Awaited<ReturnType<McpClient["callTool"]>>>();
    const ping = Promise.withResolvers<{}>();
    connection.client.callTool.mockReturnValue(result.promise);
    connection.client.ping.mockImplementationOnce(pendingPing(ping.promise));
    const factory = vi.fn<McpConnectionFactory>(async () => connection);
    await load(factory, 100);
    await vi.advanceTimersByTimeAsync(100);
    const call = execute("long-running");
    await vi.advanceTimersByTimeAsync(0);
    ping.reject(timeout());
    await vi.advanceTimersByTimeAsync(1_000);
    expect(connection.client.ping).toHaveBeenCalledOnce();
    expect(connection.close).not.toHaveBeenCalled();
    result.resolve({ content: [] });
    await call;
    await vi.advanceTimersByTimeAsync(100);
    expect(connection.client.ping).toHaveBeenCalledTimes(2);
    expect(factory).toHaveBeenCalledOnce();
  });

  it("stops immediately and warns when background authorization is required", async () => {
    const connection = makeConnection();
    connection.client.ping.mockRejectedValue(new UnauthorizedError("login required"));
    const factory = vi.fn<McpConnectionFactory>(async () => connection);
    await load(factory, 100);
    await vi.advanceTimersByTimeAsync(1_000);
    expect(factory).toHaveBeenCalledOnce();
    expect(host.getActiveTools()).toEqual(["read"]);
    expect(warn).toHaveBeenCalledExactlyOnceWith(expect.stringContaining("requires authorization"));
  });

  it("continues capped retries through a long outage and recovers without replay", async () => {
    const connection = makeConnection();
    const replacement = makeConnection();
    const factory = vi
      .fn<McpConnectionFactory>()
      .mockResolvedValueOnce(connection)
      .mockRejectedValue(new Error("offline"));
    await load(factory, 0);
    await connection.close();
    await vi.advanceTimersByTimeAsync(243_000);
    expect(vi.mocked(timers.setTimeout).mock.calls.map(([delay]) => delay)).toEqual([
      1_000, 2_000, 4_000, 8_000, 16_000, 32_000, 60_000, 60_000, 60_000, 60_000,
    ]);
    expect(factory).toHaveBeenCalledTimes(11);
    expect(warn).toHaveBeenCalledExactlyOnceWith(
      expect.stringContaining("will continue every 60 seconds"),
    );
    expect(host.getActiveTools()).toEqual(["read"]);
    factory.mockResolvedValue(replacement);
    await vi.advanceTimersByTimeAsync(59_999);
    expect(factory).toHaveBeenCalledTimes(11);
    await vi.advanceTimersByTimeAsync(1);
    expect(factory).toHaveBeenCalledTimes(12);
    expect(host.getActiveTools()).toContain(toGeneratedToolName("remote", "mutate"));
    expect(replacement.client.callTool).not.toHaveBeenCalled();
    expect(factory.mock.calls.slice(1).every(([interactive]) => !interactive)).toBe(true);
  });

  it("retains per-server backoff across connections that close just after discovery", async () => {
    const factory = vi.fn<McpConnectionFactory>(async () => {
      const connection = makeConnection();
      setTimeout(() => {
        void connection.close();
      }, 5);
      return connection;
    });
    await load(factory, 0);
    await vi.advanceTimersByTimeAsync(200);
    expect(factory).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(63_000);
    expect(factory).toHaveBeenCalledTimes(8);
    await vi.advanceTimersByTimeAsync(60_000);
    expect(factory).toHaveBeenCalledTimes(9);
    expect(vi.mocked(timers.setTimeout).mock.calls.map(([delay]) => delay)).toEqual([
      1_000, 2_000, 4_000, 8_000, 16_000, 32_000, 60_000, 60_000,
    ]);
    expect(warn).not.toHaveBeenCalled();
  });

  it.each(["ping", "tool"])(
    "resets backoff only after sustained health confirmed by a %s",
    async (probe) => {
      const first = makeConnection();
      const second = makeConnection();
      const healthy = makeConnection();
      const replacement = makeConnection();
      const factory = vi
        .fn<McpConnectionFactory>()
        .mockResolvedValueOnce(first)
        .mockResolvedValueOnce(second)
        .mockResolvedValueOnce(healthy)
        .mockResolvedValue(replacement);
      await load(factory, probe === "ping" ? 100 : 0);
      await first.close();
      await vi.advanceTimersByTimeAsync(100);
      if (probe === "tool") await execute("early");
      await second.close();
      await vi.advanceTimersByTimeAsync(999);
      expect(factory).toHaveBeenCalledTimes(2);
      await vi.advanceTimersByTimeAsync(1);
      expect(factory).toHaveBeenCalledTimes(3);
      await vi.advanceTimersByTimeAsync(60_000);
      if (probe === "tool") await execute("healthy");
      await healthy.close();
      await vi.advanceTimersByTimeAsync(0);
      expect(factory).toHaveBeenCalledTimes(4);
      expect(vi.mocked(timers.setTimeout).mock.calls.map(([delay]) => delay)).toEqual([1_000]);
    },
  );

  it.each(["branch", "shutdown"])("cancels retry backoff on %s", async (action) => {
    const connection = makeConnection();
    const factory = vi
      .fn<McpConnectionFactory>()
      .mockResolvedValueOnce(connection)
      .mockRejectedValue(new Error("offline"));
    await load(factory, 0);
    await connection.close();
    await vi.advanceTimersByTimeAsync(0);
    expect(factory).toHaveBeenCalledTimes(2);
    if (action === "shutdown") await pool.closeAll();
    else pool.reconcileActiveServers([]);
    await vi.advanceTimersByTimeAsync(600_000);
    expect(factory).toHaveBeenCalledTimes(2);
    expect(vi.getTimerCount()).toBe(0);
    expect(warn).not.toHaveBeenCalled();
  });

  it("does not repeatedly reconnect when saved credentials cannot authorize", async () => {
    const connection = makeConnection();
    const factory = vi
      .fn<McpConnectionFactory>()
      .mockResolvedValueOnce(connection)
      .mockRejectedValue(new UnauthorizedError("login required"));
    await load(factory);
    await connection.close();
    await vi.advanceTimersByTimeAsync(60_000);
    expect(factory).toHaveBeenCalledTimes(2);
    expect(warn).toHaveBeenCalledOnce();
    expect(host.getActiveTools()).toEqual(["read"]);
  });

  it.each(["backoff", "connecting"])(
    "preserves recovery during ordinary restoration while %s",
    async (phase) => {
      const first = makeConnection();
      const replacement = makeConnection("replacement");
      const pending = Promise.withResolvers<McpClientConnection>();
      const factory = vi.fn<McpConnectionFactory>().mockResolvedValueOnce(first);
      if (phase === "backoff") factory.mockRejectedValue(new Error("offline"));
      else factory.mockReturnValue(pending.promise);
      await load(factory, 0);
      await first.close();
      await vi.advanceTimersByTimeAsync(0);
      expect(factory).toHaveBeenCalledTimes(2);
      const restoreFactory = vi.fn<McpConnectionFactory>().mockRejectedValue(new Error("offline"));
      // Match restoration's selection/load/reconciliation sequence while still offline.
      pool.reconcileActiveServers(["remote"]);
      await pool.restoreServer({ serverName: "remote", connectionFactory: restoreFactory });
      pool.reconcileActiveServers(["remote"]);
      expect(restoreFactory).not.toHaveBeenCalled();
      expect(factory.mock.calls[1]?.[1]?.aborted).toBe(false);
      expect(host.getActiveTools()).toEqual(["read"]);

      if (phase === "backoff") {
        factory.mockResolvedValue(replacement);
        await vi.advanceTimersByTimeAsync(999);
        expect(factory).toHaveBeenCalledTimes(2);
        await vi.advanceTimersByTimeAsync(1);
      } else {
        pending.resolve(replacement);
        await vi.advanceTimersByTimeAsync(0);
      }
      expect(host.getActiveTools()).toContain(toGeneratedToolName("remote", "replacement"));
      expect(replacement.client.callTool).not.toHaveBeenCalled();
      expect(warn).not.toHaveBeenCalled();
    },
  );

  it("still stops recovery for authorization failure after a branch restore", async () => {
    const first = makeConnection();
    const factory = vi
      .fn<McpConnectionFactory>()
      .mockResolvedValueOnce(first)
      .mockRejectedValue(new Error("offline"));
    await load(factory, 0);
    await first.close();
    await vi.advanceTimersByTimeAsync(0);
    await pool.restoreServer({ serverName: "remote", connectionFactory: factory });
    factory.mockRejectedValue(new UnauthorizedError("login required"));
    await vi.advanceTimersByTimeAsync(120_000);
    expect(factory).toHaveBeenCalledTimes(3);
    expect(warn).toHaveBeenCalledExactlyOnceWith(expect.stringContaining("login required"));
    expect(host.getActiveTools()).toEqual(["read"]);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("lets an explicit reconnect supersede retry backoff and keeps the new configuration", async () => {
    const first = makeConnection();
    const replacement = makeConnection("new-config");
    const oldFactory = vi
      .fn<McpConnectionFactory>()
      .mockResolvedValueOnce(first)
      .mockRejectedValue(new Error("offline"));
    await load(oldFactory, 100);
    await first.close();
    await vi.advanceTimersByTimeAsync(0);
    const newFactory = vi.fn<McpConnectionFactory>(async () => replacement);
    await pool.loadServer({
      serverName: "remote",
      interactive: true,
      reconnect: true,
      connectionFactory: newFactory,
      heartbeatIntervalMs: 0,
    });
    await vi.advanceTimersByTimeAsync(60_000);
    expect(oldFactory).toHaveBeenCalledTimes(2);
    expect(newFactory).toHaveBeenCalledOnce();
    expect(host.getActiveTools()).toEqual(["read", toGeneratedToolName("remote", "new-config")]);
    expect(warn).not.toHaveBeenCalled();
  });

  it("pauses maintenance for inactive branches and resumes it when selected again", async () => {
    const connection = makeConnection();
    await load(async () => connection, 100);
    pool.reconcileActiveServers([]);
    await vi.advanceTimersByTimeAsync(1_000);
    expect(connection.client.ping).not.toHaveBeenCalled();
    expect(host.getActiveTools()).toEqual(["read"]);
    pool.reconcileActiveServers(["remote"]);
    await vi.advanceTimersByTimeAsync(100);
    expect(connection.client.ping).toHaveBeenCalledOnce();
  });

  it.each(["branch", "shutdown"])(
    "disposes a late recovery without reactivating tools after %s",
    async (action) => {
      const first = makeConnection();
      const late = makeConnection("late");
      const deferred = Promise.withResolvers<McpClientConnection>();
      const factory = vi
        .fn<McpConnectionFactory>()
        .mockResolvedValueOnce(first)
        .mockReturnValue(deferred.promise);
      await load(factory);
      await first.close();
      await vi.advanceTimersByTimeAsync(0);
      expect(factory).toHaveBeenCalledTimes(2);
      const shutdown = action === "shutdown" ? pool.closeAll() : undefined;
      if (action === "branch") pool.reconcileActiveServers([]);
      deferred.resolve(late);
      await shutdown;
      await vi.advanceTimersByTimeAsync(60_000);
      expect(late.close).toHaveBeenCalledOnce();
      expect(host.getActiveTools()).toEqual(["read"]);
      expect(factory).toHaveBeenCalledTimes(2);
      expect(warn).not.toHaveBeenCalled();
    },
  );

  it("cancels an outstanding heartbeat during shutdown without starting recovery", async () => {
    const connection = makeConnection();
    const deferred = Promise.withResolvers<{}>();
    connection.client.ping.mockImplementation(pendingPing(deferred.promise));
    const factory = vi.fn<McpConnectionFactory>(async () => connection);
    await load(factory, 100);
    await vi.advanceTimersByTimeAsync(100);
    const signal = connection.client.ping.mock.calls[0]?.[0]?.signal;
    await pool.closeAll();
    expect(signal?.aborted).toBe(true);
    deferred.reject(timeout());
    await vi.advanceTimersByTimeAsync(1_000);
    expect(factory).toHaveBeenCalledOnce();
    expect(warn).not.toHaveBeenCalled();
  });

  it("ignores a stale ping failure without canceling the replacement connection's heartbeat", async () => {
    const first = makeConnection();
    const second = makeConnection();
    const ping = Promise.withResolvers<Awaited<ReturnType<McpClient["ping"]>>>();
    first.client.ping.mockImplementation(pendingPing(ping.promise));
    const factory = vi
      .fn<McpConnectionFactory>()
      .mockResolvedValueOnce(first)
      .mockResolvedValue(second);
    await load(factory, 100);
    await vi.advanceTimersByTimeAsync(100);
    await first.close();
    await vi.advanceTimersByTimeAsync(0);
    expect(factory).toHaveBeenCalledTimes(2);
    ping.reject(timeout());
    await vi.advanceTimersByTimeAsync(100);
    expect(second.client.ping).toHaveBeenCalledOnce();
    expect(second.close).not.toHaveBeenCalled();
    expect(factory).toHaveBeenCalledTimes(2);
  });
});
