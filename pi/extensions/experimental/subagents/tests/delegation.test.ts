import { fauxProvider } from "@earendil-works/pi-ai";
import type { SessionEntry } from "@earendil-works/pi-coding-agent";
import { describe, expect, it } from "vite-plus/test";

import { createExtensionHost } from "../../../../tests/harness/extension-host.js";
import { createDelegation, inheritDelegation, readDelegation } from "../delegation.js";
import type { DelegationPolicy } from "../delegation.js";

const model = fauxProvider({ models: [{ id: "reasoner", reasoning: true }] }).getModel();

const entry = (customType: string, data: unknown): SessionEntry => ({
  id: "saved",
  parentId: null,
  timestamp: new Date().toISOString(),
  type: "custom",
  customType,
  data,
});

const setup = async (fallback: DelegationPolicy = "explicit", flag = false) => {
  let delegation: ReturnType<typeof createDelegation> | undefined;

  const host = createExtensionHost(
    (pi) => {
      pi.registerFlag("ultra", { description: "Test Ultra", type: "boolean" });
      delegation = createDelegation(pi, fallback);
      pi.on("session_start", (event, ctx) => delegation?.start(event, ctx));
      pi.on("session_tree", (_event, ctx) => delegation?.refresh(ctx));
      pi.on("session_shutdown", (_event, ctx) => delegation?.stop(ctx));
    },
    { model, flags: { ultra: flag } },
  );

  await host.ready;

  if (delegation === undefined) throw new Error("Missing delegation");
  host.setThinkingLevel("low");
  const ctx = host.createContext();
  await host.emitSessionStart(ctx);

  return { host, ctx, delegation };
};

describe("branch delegation", () => {
  it("ignores retired Ultra metadata and fails closed for malformed owned policy", () => {
    expect(
      readDelegation({ getBranch: () => [entry("ultra", { enabled: true })] }, "explicit"),
    ).toBe("explicit");
    expect(
      readDelegation({ getBranch: () => [entry("ultra", { enabled: false })] }, "proactive"),
    ).toBe("proactive");
    expect(
      readDelegation({ getBranch: () => [entry("subagents-delegation", "other")] }, "proactive"),
    ).toBe("explicit");
    expect(
      readDelegation(
        {
          getBranch: () => [
            entry("subagents-delegation", { policy: "proactive", previousThinking: "max" }),
          ],
        },
        "proactive",
      ),
    ).toBe("explicit");
  });

  it("toggles effective policy without touching thinking and reads the selected branch", async () => {
    const { host, ctx, delegation } = await setup("proactive");
    expect(host.getStatus("proactive")).toContain("proactive delegation");
    delegation.toggle("", ctx);
    const explicitLeaf = host.getLeafId();
    expect(readDelegation(ctx.sessionManager, "proactive")).toBe("explicit");
    expect(host.getThinkingLevel()).toBe("low");
    delegation.toggle("", ctx);
    const proactiveLeaf = host.getLeafId();
    host.setThinkingLevel("medium");
    host.setLeafId(explicitLeaf);
    await host.emitSessionTree(ctx);
    expect(host.getStatus("proactive")).toBeUndefined();
    expect(host.getThinkingLevel()).toBe("medium");
    host.setLeafId(proactiveLeaf);
    await host.emitSessionTree(ctx);
    expect(host.getStatus("proactive")).toContain("proactive delegation");
    expect(host.getThinkingLevel()).toBe("medium");
    const saved = host.getAppendedEntries();
    await host.emitSessionShutdown(ctx);
    expect(host.getStatus("proactive")).toBeUndefined();
    expect(host.getAppendedEntries()).toStrictEqual(saved);
  });

  it("publishes the known next policy after append without rereading the branch", async () => {
    const { host, delegation } = await setup();
    let reads = 0;

    const ctx = host.createContext({
      sessionManager: {
        getBranch: () => {
          reads += 1;

          if (reads > 1) throw new Error("Unexpected post-append verification");

          return [];
        },
      },
    });

    delegation.toggle("", ctx);
    expect(reads).toBe(1);
    expect(host.getStatus("proactive")).toContain("proactive delegation");
    expect(host.getAppendedEntries()).toMatchObject([
      { type: "custom", customType: "subagents-delegation", data: "proactive" },
    ]);
  });

  it("records an explicit Ultra choice even when the configured default is already proactive", async () => {
    const { host, ctx, delegation } = await setup("proactive");

    delegation.ultra("", ctx);
    expect(readDelegation(ctx.sessionManager, "explicit")).toBe("proactive");
    expect(host.getAppendedEntries()).toMatchObject([
      { customType: "subagents-delegation", data: "proactive" },
    ]);
  });

  it("runs Ultra on startup only and enables rather than toggling permission", async () => {
    const { host, ctx, delegation } = await setup("explicit", true);
    expect(host.getThinkingLevel()).toBe("max");
    expect(host.getNotifications().at(-1)?.message).toContain("native thinking is max");
    expect(readDelegation(ctx.sessionManager, "explicit")).toBe("proactive");
    const saved = host.getAppendedEntries();
    host.setThinkingLevel("medium");
    await host.emitSessionStart(ctx, "reload");
    expect(host.getThinkingLevel()).toBe("medium");
    delegation.ultra("", ctx);
    expect(host.getThinkingLevel()).toBe("max");
    expect(host.getAppendedEntries()).toStrictEqual(saved);
    delegation.toggle("", ctx);
    expect(host.getThinkingLevel()).toBe("max");
    delegation.toggle("on", ctx);
    delegation.ultra("off", ctx);
    expect(readDelegation(ctx.sessionManager, "proactive")).toBe("explicit");
    expect(
      host
        .getNotifications()
        .slice(-2)
        .map((notice) => notice.message),
    ).toStrictEqual(["Usage: /proactive", "Usage: /ultra"]);
  });

  it.each(["explicit", "proactive"] as const)(
    "seeds fresh %s snapshots but never overwrites owned entries",
    async (policy) => {
      const fresh = createExtensionHost((pi) => inheritDelegation(pi, policy), { model });
      await fresh.ready;
      const ctx = fresh.createContext();
      await fresh.emitSessionStart(ctx);
      expect(
        readDelegation(ctx.sessionManager, policy === "explicit" ? "proactive" : "explicit"),
      ).toBe(policy);
      expect(fresh.getThinkingLevel()).toBe("off");

      const cold = createExtensionHost((pi) => inheritDelegation(pi, undefined), {
        model,
        entries: ctx.sessionManager.getBranch(),
        leafId: fresh.getLeafId(),
      });

      await cold.ready;
      await cold.emitSessionStart(cold.createContext(), "reload");
      expect(readDelegation(cold.createContext().sessionManager, "explicit")).toBe(policy);
      expect(cold.getAppendedEntries()).toStrictEqual([]);

      const malformed = createExtensionHost((pi) => inheritDelegation(pi, policy), {
        entries: [entry("subagents-delegation", null)],
        leafId: "saved",
      });

      await malformed.ready;
      await malformed.emitSessionStart(malformed.createContext());
      expect(malformed.getAppendedEntries()).toStrictEqual([]);
      expect(readDelegation(malformed.createContext().sessionManager, "proactive")).toBe(
        "explicit",
      );
    },
  );

  it("enables permission without changing thinking when no model is selected", async () => {
    const { host, delegation } = await setup();
    const ctx = host.createContext({ model: undefined });

    delegation.ultra("", ctx);
    expect(readDelegation(ctx.sessionManager, "explicit")).toBe("proactive");
    expect(host.getThinkingLevel()).toBe("low");
    expect(host.getNotifications().at(-1)?.message).toContain("no model selected");
  });

  it("leaves cold sessions without owned state unseeded and skips headless UI", async () => {
    const host = createExtensionHost(
      (pi) => {
        inheritDelegation(pi, undefined);
        const delegation = createDelegation(pi, "explicit");
        pi.on("session_start", (event, ctx) => delegation.start(event, ctx));
        pi.on("session_shutdown", (_event, ctx) => delegation.stop(ctx));
        pi.registerCommand("proactive", {
          description: "Test",
          handler: async (args, ctx) => delegation.toggle(args, ctx),
        });
      },
      { model, hasUI: false },
    );

    await host.ready;
    const ctx = host.createContext();
    await host.emitSessionStart(ctx);
    expect(host.getAppendedEntries()).toStrictEqual([]);
    await host.runCommand("proactive", "", ctx);
    expect(readDelegation(ctx.sessionManager, "explicit")).toBe("proactive");
    expect(host.getStatus("proactive")).toBeUndefined();
    expect(host.getNotifications()).toStrictEqual([]);
  });
});
