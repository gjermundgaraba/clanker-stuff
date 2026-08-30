import type { SessionEntry } from "@earendil-works/pi-coding-agent";
import { describe, expect, it, vi } from "vite-plus/test";

import { createExtensionHost } from "../../../../tests/harness/extension-host.js";
import type { CollaborationContractRequest } from "../collaboration.js";
import { registerCodexUltra } from "../ultra/index.js";
import { createToolsModel } from "./fixtures.js";

const CONTRACT_REQUEST = "clanker-stuff:subagents:contract:request";
const MODEL = createToolsModel("gpt-5.6-sol", true);
const SECOND_MODEL = createToolsModel("gpt-5.6-terra", true);
const catalog = {
  supportsUltra: (model: typeof MODEL | undefined) => model === MODEL,
};

type CustomEntry = Extract<SessionEntry, { type: "custom" }>;

const state = (enabled: boolean): CustomEntry => ({
  customType: "codex-ultra-state",
  data: { enabled },
  id: `ultra-${enabled}`,
  parentId: null,
  timestamp: "2026-08-25T00:00:00.000Z",
  type: "custom",
});

const createHost = (
  entries: SessionEntry[] = [],
  testCatalog = catalog,
  collaboration: "missing" | "v2" = "v2",
  inheritedUltra = false,
  flags?: Record<string, boolean | string>,
) =>
  createExtensionHost(
    (pi) => {
      if (collaboration === "v2") {
        pi.events.on(CONTRACT_REQUEST, (value) => {
          // SAFETY: this host handles only collaboration requests emitted by registerCodexUltra.
          const request = value as CollaborationContractRequest;
          request.provide({
            inheritedUltra,
            nestedTools: [],
            protocol: "v2",
            sessionId: request.sessionId,
            version: 1,
          });
        });
      }
      registerCodexUltra(pi, testCatalog);
    },
    {
      entries,
      flags,
      leafId: entries.at(-1)?.id,
      model: MODEL,
    },
  );

const beforeAgentStart = {
  prompt: "test",
  systemPrompt: "Base prompt",
  systemPromptOptions: {},
  type: "before_agent_start",
} as const;

describe("Codex Ultra", () => {
  it("enables only with eligible metadata and V2 collaboration", async () => {
    const host = createHost();
    const ctx = host.createContext({ model: MODEL });
    await host.emitSessionStart(ctx);
    await host.runCommand("ultra", "", ctx);

    expect(host.getAppendedEntries()).toMatchObject([
      { customType: "codex-ultra-state", data: { enabled: true } },
    ]);
    expect(host.getThinkingLevel()).toBe("max");

    const missing = createHost([], catalog, "missing");
    const missingCtx = missing.createContext({ model: MODEL });
    await missing.emitSessionStart(missingCtx);
    await missing.runCommand("ultra", "", missingCtx);
    expect(missing.getAppendedEntries()).toStrictEqual([]);
    expect(missing.getNotifications()).toContainEqual({
      message: "Codex Ultra requires the companion V2 subagents extension.",
      type: "warning",
    });

    const unsupported = createToolsModel("gpt-5.6-luna", true);
    const ineligible = createHost([], catalog);
    const unsupportedCtx = ineligible.createContext({ model: unsupported });
    await ineligible.emitSessionStart(unsupportedCtx);
    await ineligible.runCommand("ultra", "", unsupportedCtx);
    expect(ineligible.getAppendedEntries()).toStrictEqual([]);
    expect(ineligible.getNotifications()).toContainEqual({
      message: "The selected model does not advertise Ultra.",
      type: "warning",
    });
  });

  it("restores startup, branch, and inherited intent through one activation path", async () => {
    for (const [host, reason] of [
      [createHost([], catalog, "v2", false, { ultra: true }), "startup"],
      [createHost([state(true)]), "resume"],
      [createHost([], catalog, "v2", true), "startup"],
    ] as const) {
      const ctx = host.createContext({ model: MODEL });
      await host.emitSessionStart(ctx, reason);
      expect(host.getThinkingLevel()).toBe("max");
      const [result] = await host.emit("before_agent_start", beforeAgentStart, ctx);
      expect(result).toMatchObject({
        systemPrompt: expect.stringContaining("Proactive multi-agent delegation is active."),
      });
    }
  });

  it("seeds --ultra only at initial startup", async () => {
    const host = createHost([], catalog, "v2", false, { ultra: true });
    const ctx = host.createContext({ model: MODEL });

    await host.emitSessionStart(ctx, "new");

    expect(host.getAppendedEntries()).toStrictEqual([]);
    expect(host.getThinkingLevel()).toBe("off");
  });

  it("explicitly disables via /ultra and removes policy from the next fresh prompt", async () => {
    const host = createHost([state(true)]);
    const ctx = host.createContext({ model: MODEL });
    await host.emitSessionStart(ctx, "resume");

    await host.runCommand("ultra", "", ctx);
    expect(host.getAppendedEntries().at(-1)).toMatchObject({
      customType: "codex-ultra-state",
      data: { enabled: false },
    });
    const [result] = await host.emit("before_agent_start", beforeAgentStart, ctx);
    expect(result).toBeUndefined();
    expect(host.getThinkingLevel()).toBe("max");
  });

  it("reasserts Max across thinking changes and compatible model switches", async () => {
    const eligible = {
      supportsUltra: (model: typeof MODEL | undefined) => model === MODEL || model === SECOND_MODEL,
    };
    const host = createHost([], eligible);
    const ctx = host.createContext({ model: MODEL });
    await host.emitSessionStart(ctx);
    await host.runCommand("ultra", "", ctx);

    host.setThinkingLevel("high");
    await host.emit(
      "thinking_level_select",
      { level: "high", previousLevel: "max", type: "thinking_level_select" },
      ctx,
    );
    expect(host.getThinkingLevel()).toBe("max");

    const nextCtx = host.createContext({ model: SECOND_MODEL });
    host.setThinkingLevel("high");
    await host.emit(
      "thinking_level_select",
      { level: "high", previousLevel: "max", type: "thinking_level_select" },
      nextCtx,
    );
    await host.emit(
      "model_select",
      { model: SECOND_MODEL, previousModel: MODEL, source: "set", type: "model_select" },
      nextCtx,
    );

    expect(host.getThinkingLevel()).toBe("max");
    expect(host.getAppendedEntries()).not.toContainEqual(
      expect.objectContaining({ data: { enabled: false } }),
    );
  });

  it("disables on an ineligible model switch", async () => {
    const host = createHost([state(true)]);
    const ctx = host.createContext({ model: MODEL });
    await host.emitSessionStart(ctx, "resume");
    const unsupported = createToolsModel("deepseek-v4", true, {
      api: "openai-responses",
      provider: "openai",
    });

    await host.emit(
      "model_select",
      { model: unsupported, previousModel: MODEL, source: "set", type: "model_select" },
      host.createContext({ model: unsupported }),
    );

    expect(host.getAppendedEntries().at(-1)).toMatchObject({
      customType: "codex-ultra-state",
      data: { enabled: false },
    });
  });

  it("refreshes missing metadata only while restoring or explicitly enabling", async () => {
    let live = false;
    const restoring = createHost([state(true)], { supportsUltra: () => live });
    const restoringCtx = restoring.createContext({ model: MODEL });
    const restoreRefresh = vi
      .spyOn(restoringCtx.modelRegistry, "refresh")
      .mockImplementation(async () => {
        live = true;
        return { aborted: false, errors: new Map() };
      });

    await restoring.emitSessionStart(restoringCtx, "resume");

    expect(restoreRefresh).toHaveBeenCalledOnce();
    expect(restoring.getThinkingLevel()).toBe("max");
    await restoring.emit("before_agent_start", beforeAgentStart, restoringCtx);
    expect(restoreRefresh).toHaveBeenCalledOnce();

    live = false;
    const enabling = createHost([], { supportsUltra: () => live });
    const enablingCtx = enabling.createContext({ model: MODEL });
    await enabling.emitSessionStart(enablingCtx);
    const release = Promise.withResolvers<null>();
    const enableRefresh = vi
      .spyOn(enablingCtx.modelRegistry, "refresh")
      .mockImplementation(async () => {
        await release.promise;
        live = true;
        return { aborted: false, errors: new Map() };
      });
    const command = enabling.runCommand("ultra", "", enablingCtx);
    await vi.waitFor(() => expect(enableRefresh).toHaveBeenCalledOnce());
    release.resolve(null);
    await command;
    expect(enabling.getThinkingLevel()).toBe("max");
  });

  it("ignores a stale enable refresh after the selected model changes", async () => {
    let live = false;
    const host = createHost([], {
      supportsUltra: (model) => model === MODEL && live,
    });
    const ctx = host.createContext({ model: MODEL });
    await host.emitSessionStart(ctx);
    const release = Promise.withResolvers<null>();
    const refresh = vi.spyOn(ctx.modelRegistry, "refresh").mockImplementation(async () => {
      await release.promise;
      live = true;
      return { aborted: false, errors: new Map() };
    });

    const enabling = host.runCommand("ultra", "", ctx);
    await vi.waitFor(() => expect(refresh).toHaveBeenCalledOnce());
    const unsupported = createToolsModel("deepseek-v4", true, {
      api: "openai-responses",
      provider: "openai",
    });
    await host.emit(
      "model_select",
      { model: unsupported, previousModel: MODEL, source: "set", type: "model_select" },
      host.createContext({ model: unsupported }),
    );
    release.resolve(null);
    await enabling;

    expect(host.getAppendedEntries()).not.toContainEqual(
      expect.objectContaining({ data: { enabled: true } }),
    );
    expect(host.getThinkingLevel()).toBe("off");
  });

  it("treats the newest malformed branch state as disabled", async () => {
    const valid = state(true);
    const malformed: CustomEntry = {
      ...state(false),
      data: { enabled: "yes" },
      id: "ultra-malformed",
      parentId: valid.id,
    };
    const host = createHost([valid, malformed]);
    const ctx = host.createContext({ model: MODEL });

    await host.emitSessionStart(ctx, "resume");
    const [result] = await host.emit("before_agent_start", beforeAgentStart, ctx);

    expect(host.getThinkingLevel()).toBe("off");
    expect(result).toBeUndefined();
  });
});
