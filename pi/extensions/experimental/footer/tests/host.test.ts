import { Value } from "typebox/value";
import {
  FOOTER_ICON_PREFERENCE_EVENT,
  FOOTER_ICON_PREFERENCE_REQUEST_EVENT,
  FOOTER_PROTOCOL_VERSION,
  FOOTER_READY_EVENT,
  FOOTER_READY_REQUEST_EVENT,
  FOOTER_WIDGET_EVENT,
  FooterReadyMessageSchema,
} from "@clanker-stuff/footer-protocol";
import type { FooterWidgetSnapshot } from "@clanker-stuff/footer-protocol";
import type { Model, Usage } from "@earendil-works/pi-ai";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import type { ExtensionContext, ExtensionFactory } from "@earendil-works/pi-coding-agent";
import { describe, expect, it, vi } from "vite-plus/test";

import { createExtensionHost } from "../../../../tests/harness/extension-host.js";
import { createIdentityTheme, createMockTui } from "../../../../tests/harness/tui.js";
import { cloneFooterConfig, DEFAULT_CONFIG } from "@clanker-stuff/footer-protocol/config";
import type { createFooterConfigStore } from "../config.js";
import type { FooterConfig } from "@clanker-stuff/footer-protocol/config";
import type { readGitStatus } from "../git.js";
import footerExtension from "../index.js";

const createStore = vi.fn<typeof createFooterConfigStore>();

const readGit = vi.fn<typeof readGitStatus>(async () => null);

const extension: ExtensionFactory = (pi) => footerExtension(pi, createStore(), readGit);

type FooterFactory = Exclude<Parameters<ExtensionContext["ui"]["setFooter"]>[0], undefined>;

type FooterComponent = ReturnType<FooterFactory>;

const model = (id: string, name: string): Model<"openai-responses"> => ({
  api: "openai-responses",
  baseUrl: "https://example.com",
  contextWindow: 100_000,
  cost: { cacheRead: 0, cacheWrite: 0, input: 0, output: 0 },
  id,
  input: ["text"],
  maxTokens: 10_000,
  name,
  provider: "test",
  reasoning: true,
});

describe("footer host", () => {
  it("announces committed icon preferences even when disabled and answers late requests", async () => {
    const config = cloneFooterConfig(DEFAULT_CONFIG);
    config.enabled = false;
    config.iconFamily = "nerd";
    createStore.mockReturnValue({
      load: async () => ({ config }),
      path: "/tmp/footer.json",
      save: async () => {},
    });
    const host = createExtensionHost(extension);
    const preference = vi.fn();
    host.events.on(FOOTER_ICON_PREFERENCE_EVENT, preference);
    const ctx = host.createContext();
    await host.emitSessionStart(ctx);
    expect(preference).toHaveBeenLastCalledWith({
      protocol: FOOTER_PROTOCOL_VERSION,
      type: "icon-preference",
      iconFamily: "nerd",
    });
    host.events.emit(FOOTER_ICON_PREFERENCE_REQUEST_EVENT, {
      protocol: FOOTER_PROTOCOL_VERSION,
      type: "icon-preference-request",
    });
    expect(preference).toHaveBeenCalledTimes(2);
    host.events.emit(FOOTER_ICON_PREFERENCE_REQUEST_EVENT, { version: 1 });
    host.events.emit(FOOTER_ICON_PREFERENCE_REQUEST_EVENT, {
      protocol: 99,
      type: "icon-preference-request",
    });
    host.events.emit(FOOTER_ICON_PREFERENCE_REQUEST_EVENT, {
      protocol: FOOTER_PROTOCOL_VERSION,
      type: "icon-preference-request",
      extra: true,
    });
    expect(preference).toHaveBeenCalledTimes(2);

    await host.emitSessionShutdown(ctx);
    host.events.emit(FOOTER_ICON_PREFERENCE_REQUEST_EVENT, {
      protocol: FOOTER_PROTOCOL_VERSION,
      type: "icon-preference-request",
    });
    expect(preference).toHaveBeenCalledTimes(2);
  });

  it("answers late ready requests for the active runtime", async () => {
    createStore.mockReturnValue({
      load: async () => ({ config: cloneFooterConfig(DEFAULT_CONFIG) }),
      path: "/tmp/footer.json",
      save: async () => {},
    });
    readGit.mockResolvedValue(null);
    const host = createExtensionHost(extension);
    const ready: string[] = [];
    host.events.on(FOOTER_READY_EVENT, (value) => {
      if (Value.Check(FooterReadyMessageSchema, value)) {
        ready.push(value.instanceId);
      }
    });
    const context = host.createContext();

    await host.emitSessionStart(context);
    host.events.emit(FOOTER_READY_REQUEST_EVENT, {
      protocol: FOOTER_PROTOCOL_VERSION,
      type: "ready-request",
    });

    expect(ready).toHaveLength(2);
    expect(new Set(ready).size).toBe(1);
    await host.emitSessionShutdown(context);
  });

  it("does not finish an in-flight start after shutdown", async () => {
    const pending = Promise.withResolvers<{ config: FooterConfig }>();
    const load = vi.fn<() => Promise<{ config: FooterConfig }>>(() => pending.promise);
    createStore.mockReturnValue({
      load,
      path: "/tmp/footer.json",
      save: async () => {},
    });
    const host = createExtensionHost(extension);
    const context = host.createContext();

    const start = host.emitSessionStart(context);
    await vi.waitFor(() => {
      expect(load).toHaveBeenCalledOnce();
    });
    await host.emitSessionShutdown(context);
    pending.resolve({ config: cloneFooterConfig(DEFAULT_CONFIG) });
    await start;

    expect(context.ui.setFooter).not.toHaveBeenCalled();
  });

  it("does not initialize footer state outside TUI mode", async () => {
    const load = vi.fn<() => Promise<{ config: FooterConfig }>>(async () => ({
      config: cloneFooterConfig(DEFAULT_CONFIG),
    }));

    createStore.mockReturnValue({
      load,
      path: "/tmp/footer.json",
      save: async () => {
        await Promise.resolve();
      },
    });
    const host = createExtensionHost(extension);
    const context = host.createContext({ mode: "json" });

    await host.emitSessionStart(context);

    expect(load).not.toHaveBeenCalled();
    expect(context.ui.setFooter).not.toHaveBeenCalled();
    expect(readGit).not.toHaveBeenCalled();
  });

  it("does not collect Git status when both Git widgets are hidden", async () => {
    const config = cloneFooterConfig(DEFAULT_CONFIG);

    for (const row of config.rows) {
      row.left = row.left.filter((id) => id !== "footer.git");
    }

    config.widgets["footer.git"] = { enabled: false };
    config.widgets["footer.git.details"] = { enabled: false };
    createStore.mockReturnValue({
      load: async () => ({ config }),
      path: "/tmp/footer.json",
      save: async () => {},
    });
    readGit.mockClear();
    const host = createExtensionHost(extension);
    const context = host.createContext();

    await host.emitSessionStart(context);
    await host.emitTurnEnd(undefined, context);

    expect(readGit).not.toHaveBeenCalled();
  });

  it("refreshes idle usage on render and on the clock tick, without scanning every frame", async () => {
    vi.useFakeTimers();

    try {
      const config = cloneFooterConfig(DEFAULT_CONFIG);
      config.rows = [{ left: ["footer.session"], center: [], right: [] }];
      createStore.mockReturnValue({
        load: async () => ({ config }),
        path: "/tmp/footer.json",
        save: async () => {},
      });
      const session = SessionManager.inMemory();
      const getEntries = vi.fn(() => session.getEntries());
      let component: FooterComponent | undefined;
      const host = createExtensionHost(extension);

      const context = host.createContext({
        sessionManager: {
          getEntries,
          getLeafId: () => session.getLeafId(),
          getSessionId: () => session.getSessionId(),
          getHeader: () => session.getHeader(),
          getSessionName: () => session.getSessionName(),
        },
        ui: {
          setFooter: (factory) => {
            component = factory?.(createMockTui(), createIdentityTheme(), {
              getAvailableProviderCount: () => 1,
              getExtensionStatuses: () => new Map(),
              getGitBranch: () => null,
              onBranchChange: () => () => {},
            });
          },
        },
      });

      await host.emitSessionStart(context);

      const warm: Usage = {
        input: 0,
        output: 1,
        cacheRead: 50_000,
        cacheWrite: 0,
        totalTokens: 50_001,
        cost: { input: 0, output: 0.00001, cacheRead: 0.015, cacheWrite: 0, total: 0.01501 },
      };

      session.appendUsage("cache_warm", "anthropic", "test", warm);

      expect(component?.render(240).join("\n")).toContain("cache 50k/0 $0.02");
      expect(component?.render(240).join("\n")).toContain("cache 50k/0 $0.02");
      expect(getEntries).toHaveBeenCalledTimes(2);

      session.appendUsage("other-operation", "anthropic", "test", warm);
      await vi.advanceTimersByTimeAsync(60_000);
      expect(getEntries).toHaveBeenCalledTimes(3);
      expect(component?.render(240).join("\n")).toContain("cache 100k/0 $0.03");
      expect(getEntries).toHaveBeenCalledTimes(3);
      await host.emitSessionShutdown(context);
    } finally {
      vi.useRealTimers();
    }
  });

  it("renders live native/rich state and refreshes totals post-persistence", async () => {
    const config = cloneFooterConfig(DEFAULT_CONFIG);
    config.rows[1]?.right.push("footer.session");
    createStore.mockReturnValue({
      load: async () => ({
        config,
      }),
      path: "/tmp/footer.json",
      save: async () => {
        await Promise.resolve();
      },
    });
    readGit.mockResolvedValue(null);
    vi.spyOn(Date, "now").mockReturnValue(Date.parse("2025-01-01T00:05:00.000Z"));
    const statuses = new Map<string, string>();
    const getEntries = vi.fn<() => []>(() => []);
    let failTopLevelRender = false;
    const theme = createIdentityTheme();
    theme.fg = (_tone, text) => {
      if (failTopLevelRender && text === "·") {
        throw new Error("layout failed");
      }

      return text;
    };

    const footerData = {
      getAvailableProviderCount: () => 1,
      getExtensionStatuses: () => statuses,
      getGitBranch: () => null,
      onBranchChange: () => vi.fn<() => void>(),
    };

    let component: FooterComponent | undefined;

    const setFooter: ExtensionContext["ui"]["setFooter"] = (factory) => {
      component?.dispose?.();
      component = factory === undefined ? undefined : factory(createMockTui(), theme, footerData);
    };

    const host = createExtensionHost(extension);
    const sessionManager = host.createContext().sessionManager;
    let ready: { instanceId: string } | undefined;
    host.events.on(FOOTER_READY_EVENT, (value) => {
      ready = Value.Check(FooterReadyMessageSchema, value) ? value : undefined;
    });

    const context = host.createContext({
      cwd: "/tmp/project",
      getContextUsage: () => ({
        contextWindow: 100,
        percent: 42,
        tokens: 42,
      }),
      model: model("demo", "Demo"),
      sessionManager: {
        ...sessionManager,
        getEntries,
        getHeader: () => null,
        getSessionName: () => undefined,
      },
      thinkingLevel: "high",
      ui: { setFooter },
    });

    await host.emitSessionStart(context);
    expect(component).toBeDefined();
    expect(ready?.instanceId).toBeTruthy();
    expect(getEntries).toHaveBeenCalledOnce();
    expect(component?.render(120).join("\n")).toContain("Demo");

    statuses.set("voice", "voice ready");
    expect(component?.render(120).join("\n")).toContain("voice ready");

    const rich: FooterWidgetSnapshot = {
      content: [{ text: "rich value" }],
      id: "example.widget",
      label: "Example",
    };

    host.events.emit(FOOTER_WIDGET_EVENT, {
      instanceId: ready?.instanceId,
      protocol: 1,
      type: "upsert",
      widget: rich,
    });
    expect(component?.render(120).join("\n")).toContain("rich value");

    host.events.emit(FOOTER_WIDGET_EVENT, {
      instanceId: ready?.instanceId,
      protocol: 1,
      type: "upsert",
      widget: { ...rich, content: [{ text: "\u001B[31m" }] },
    });
    expect(component?.render(120).join("\n")).toContain("rich value");

    failTopLevelRender = true;
    expect(component?.render(120)).toStrictEqual([]);
    failTopLevelRender = false;

    await host.emit("message_end", { type: "message_end" }, context);
    expect(getEntries).toHaveBeenCalledOnce();
    await host.emitTurnEnd(undefined, context);
    expect(getEntries).toHaveBeenCalledTimes(2);

    await host.emit("agent_settled", { type: "agent_settled" }, context);
    expect(getEntries).toHaveBeenCalledTimes(2);
    await host.emit("session_tree", { type: "session_tree" }, context);
    expect(getEntries).toHaveBeenCalledTimes(3);
    await host.emit("session_compact", { type: "session_compact" }, context);
    expect(getEntries).toHaveBeenCalledTimes(4);
    await host.emit("session_info_changed", { type: "session_info_changed" }, context);
    expect(getEntries).toHaveBeenCalledTimes(5);

    await host.emit(
      "model_select",
      { type: "model_select" },
      {
        ...context,
        model: model("demo2", "Demo2"),
      },
    );
    expect(component?.render(120).join("\n")).toContain("Demo2");
    await host.emit(
      "thinking_level_select",
      { type: "thinking_level_select" },
      { ...context, thinkingLevel: "medium" },
    );
    expect(component?.render(120).join("\n")).toContain("medium");

    await host.runCommand("footer", "", host.createContext({ mode: "json" }));
    expect(host.getNotifications()).toContainEqual({
      message: "/footer requires TUI mode",
      type: "info",
    });

    component?.dispose?.();
    expect(host.getNotifications()).toContainEqual({
      message: "Footer was replaced by another extension; run /footer doctor",
      type: "warning",
    });
    await host.emitSessionShutdown(context);
  });
});
