import {
  FOOTER_PROTOCOL_VERSION,
  FOOTER_READY_EVENT,
  FOOTER_READY_REQUEST_EVENT,
  FOOTER_WIDGET_EVENT,
  parseFooterReadyMessage,
} from "@clanker-stuff/footer-protocol";
import type { FooterWidgetSnapshot } from "@clanker-stuff/footer-protocol";
import type { Model } from "@earendil-works/pi-ai";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { describe, expect, it, vi } from "vite-plus/test";

import { createExtensionHost } from "../../../../tests/harness/extension-host.js";
import { createIdentityTheme, createMockTui } from "../../../../tests/harness/tui.js";
import { cloneFooterConfig, createFooterConfigStore, DEFAULT_CONFIG } from "../config.js";
import type { FooterConfig } from "../config.js";
import { readGitStatus } from "../git.js";
import extension from "../index.js";

vi.mock(import("../config.js"), { spy: true });
vi.mock(import("../git.js"), { spy: true });

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
  it("answers late ready requests for the active runtime", async () => {
    vi.mocked(createFooterConfigStore).mockReturnValue({
      load: async () => ({ config: cloneFooterConfig(DEFAULT_CONFIG) }),
      path: "/tmp/footer.json",
      save: async () => {},
    });
    vi.mocked(readGitStatus).mockResolvedValue(null);
    const host = createExtensionHost(extension);
    const ready: string[] = [];
    host.events.on(FOOTER_READY_EVENT, (value) => {
      const message = parseFooterReadyMessage(value);
      if (message !== undefined) {
        ready.push(message.instanceId);
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
    vi.mocked(createFooterConfigStore).mockReturnValue({
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
    vi.mocked(createFooterConfigStore).mockReturnValue({
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
    expect(readGitStatus).not.toHaveBeenCalled();
  });

  it("does not collect Git status when both Git widgets are hidden", async () => {
    const config = cloneFooterConfig(DEFAULT_CONFIG);
    for (const row of config.rows) {
      row.left = row.left.filter((id) => id !== "footer.git");
    }
    config.widgets["footer.git"] = { enabled: false };
    config.widgets["footer.git.details"] = { enabled: false };
    vi.mocked(createFooterConfigStore).mockReturnValue({
      load: async () => ({ config }),
      path: "/tmp/footer.json",
      save: async () => {},
    });
    vi.mocked(readGitStatus).mockClear();
    const host = createExtensionHost(extension);
    const context = host.createContext();

    await host.emitSessionStart(context);
    await host.emitTurnEnd(undefined, context);

    expect(readGitStatus).not.toHaveBeenCalled();
  });

  it("renders live native/rich state and refreshes totals post-persistence", async () => {
    const config = cloneFooterConfig(DEFAULT_CONFIG);
    config.rows[1]?.right.push("footer.session");
    vi.mocked(createFooterConfigStore).mockReturnValue({
      load: async () => ({
        config,
      }),
      path: "/tmp/footer.json",
      save: async () => {
        await Promise.resolve();
      },
    });
    vi.mocked(readGitStatus).mockResolvedValue(null);
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
      ready = parseFooterReadyMessage(value);
    });
    const context = host.createContext({
      cwd: "/tmp/project",
      getContextUsage: () => ({
        contextWindow: 100,
        percent: 42,
        tokens: 42,
      }),
      model: model("demo", "Demo"),
      sessionManager: { ...sessionManager, getEntries },
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
