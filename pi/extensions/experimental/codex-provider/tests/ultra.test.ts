import type { SessionEntry } from "@earendil-works/pi-coding-agent";
import { describe, expect, it, vi } from "vite-plus/test";

import { createExtensionHost } from "../../../../tests/harness/extension-host.js";
import type { CollaborationContractRequest } from "../collaboration.js";
import {
  appendUltraInstructions,
  registerCodexUltra,
  resolveUltraFromBranch,
} from "../ultra/index.js";
import { createToolsModel } from "./fixtures.js";

const CONTRACT_REQUEST = "clanker-stuff:subagents:contract:request";
const COLLABORATION_TOOLS = [
  "spawn_agent",
  "send_message",
  "followup_task",
  "wait_agent",
  "interrupt_agent",
  "list_agents",
];
const MODEL = createToolsModel("gpt-5.6-sol", true);
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
) =>
  createExtensionHost(
    (pi) => {
      if (collaboration === "v2") {
        pi.events.on(CONTRACT_REQUEST, (value) => {
          // SAFETY: this test emits only the provider's collaboration contract request.
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
      leafId: entries.at(-1)?.id,
      model: MODEL,
    },
  );

describe("Codex Ultra", () => {
  it("leaves all collaboration tools to the companion extension", async () => {
    const host = createHost();
    await host.ready;

    expect(
      [...host.getRegisteredTools().keys()].filter((name) => COLLABORATION_TOOLS.includes(name)),
    ).toStrictEqual([]);
  });

  it("enables only with eligible metadata and V2 collaboration, persists state, and selects Pi Max", async () => {
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

  it("appends one proactive mode instruction without duplicating collaboration usage", () => {
    const first = appendUltraInstructions("Base prompt");
    const second = appendUltraInstructions(first);

    expect(second).toBe(first);
    expect(first.match(/<multi_agent_mode>/gu)).toHaveLength(1);
    expect(first).toContain("Proactive multi-agent delegation is active.");
    expect(first).not.toContain("codex-ultra-collaboration");
  });

  it("restores and disables eligible branch-scoped state", async () => {
    const host = createHost([state(true)]);
    const ctx = host.createContext({ model: MODEL });
    await host.emitSessionStart(ctx, "resume");

    expect(host.getThinkingLevel()).toBe("max");

    await host.runCommand("ultra", "", ctx);
    expect(host.getAppendedEntries().at(-1)).toMatchObject({
      customType: "codex-ultra-state",
      data: { enabled: false },
    });
  });

  it("persists inherited Ultra before the child starts", async () => {
    const host = createHost([], catalog, "v2", true);

    await host.emitSessionStart(host.createContext({ model: MODEL }));

    expect(host.getThinkingLevel()).toBe("max");
    expect(host.getAppendedEntries()).toMatchObject([
      { customType: "codex-ultra-state", data: { enabled: true } },
    ]);
  });

  it("refreshes live metadata before restoring or enabling Ultra", async () => {
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

    expect(restoreRefresh).toHaveBeenCalledWith({
      force: true,
      providers: ["openai-codex"],
      signal: expect.any(AbortSignal),
    });
    expect(restoring.getThinkingLevel()).toBe("max");

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
    let settled = false;
    const command = enabling.runCommand("ultra", "", enablingCtx).then(() => {
      settled = true;
    });
    await vi.waitFor(() => expect(enableRefresh).toHaveBeenCalledOnce());
    expect(settled).toBeFalsy();
    release.resolve(null);
    await command;
    expect(enabling.getThinkingLevel()).toBe("max");
  });

  it("does not let a delayed enable override newer thinking selection", async () => {
    let live = false;
    const host = createHost([], { supportsUltra: () => live });
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
    await host.emit(
      "thinking_level_select",
      { level: "high", previousLevel: "off", type: "thinking_level_select" },
      ctx,
    );
    release.resolve(null);
    await enabling;

    expect(host.getAppendedEntries()).toStrictEqual([]);
  });

  it("disables on an ineligible model and ignores ineligible persisted state", async () => {
    const host = createHost([state(true)]);
    const ctx = host.createContext({ model: MODEL });
    await host.emitSessionStart(ctx, "resume");
    const unsupported = createToolsModel("gpt-5.6-luna", true);

    await host.emit(
      "model_select",
      { model: unsupported, previousModel: MODEL, source: "set", type: "model_select" },
      host.createContext({ model: unsupported }),
    );
    expect(host.getAppendedEntries().at(-1)).toMatchObject({
      customType: "codex-ultra-state",
      data: { enabled: false },
    });

    const ineligible = createHost([state(true)], { supportsUltra: () => false });
    await ineligible.emitSessionStart(ineligible.createContext({ model: MODEL }), "resume");
    expect(ineligible.getThinkingLevel()).toBe("off");
    expect(ineligible.getAppendedEntries()).toStrictEqual([]);
  });

  it("treats the newest malformed Ultra state as disabled", () => {
    const valid = state(true);
    const malformed: CustomEntry = {
      ...state(false),
      data: { enabled: "yes" },
      id: "ultra-malformed",
      parentId: valid.id,
    };

    expect(resolveUltraFromBranch({ getBranch: () => [valid, malformed] })).toBeFalsy();
  });
});
