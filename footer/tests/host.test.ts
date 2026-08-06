/* oxlint-disable vitest/max-expects -- one host lifecycle is the behavior under test */

import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { describe, expect, it, vi } from "vitest";

import { createExtensionHost } from "../../tests/harness/extension-host.js";
import { createIdentityTheme } from "../../tests/harness/tui.js";
import {
  cloneFooterConfig,
  createFooterConfigStore,
  DEFAULT_CONFIG,
} from "../config.js";
import { readGitStatus } from "../git.js";
import extension from "../index.js";
import { FOOTER_READY_EVENT, FOOTER_WIDGET_EVENT } from "../protocol.js";
import type { FooterWidgetSnapshot } from "../protocol.js";

vi.mock(import("../config.js"), { spy: true });
vi.mock(import("../git.js"), { spy: true });

type FooterFactory = Exclude<
  Parameters<ExtensionContext["ui"]["setFooter"]>[0],
  undefined
>;
type FooterComponent = ReturnType<FooterFactory>;

describe("footer host", () => {
  it("renders live native/rich state and refreshes totals post-persistence", async () => {
    vi.mocked(createFooterConfigStore).mockReturnValue({
      load: async () => ({
        config: cloneFooterConfig(DEFAULT_CONFIG),
      }),
      path: "/tmp/footer.json",
      save: async () => {
        await Promise.resolve();
      },
    });
    vi.mocked(readGitStatus).mockResolvedValue(null);
    vi.spyOn(Date, "now").mockReturnValue(
      Date.parse("2025-01-01T00:05:00.000Z")
    );
    const statuses = new Map<string, string>();
    const requestRender = vi.fn<() => void>();
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
      component =
        factory === undefined
          ? undefined
          : factory({ requestRender } as never, theme, footerData);
    };
    const host = createExtensionHost(extension);
    let ready: { instanceId: string } | undefined;
    host.events.on(FOOTER_READY_EVENT, (value) => {
      ready = value as { instanceId: string };
    });
    const context = host.createContext({
      cwd: "/tmp/project",
      getContextUsage: () => ({
        contextWindow: 100,
        percent: 42,
        tokens: 42,
      }),
      model: {
        id: "demo",
        name: "Demo",
        provider: "test",
        reasoning: true,
      } as never,
      modelRegistry: {
        getAvailable: () => [],
        getProviderDisplayName: (provider: string) => provider,
      } as never,
      sessionManager: {
        getEntries,
        getHeader: () => ({
          timestamp: "2025-01-01T00:00:00.000Z",
        }),
        getSessionName: () => "test",
      } as never,
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

    component?.dispose?.();
    expect(host.getNotifications()).toContainEqual({
      message: "Footer was replaced by another extension; run /footer doctor",
      type: "warning",
    });
    await host.emitSessionShutdown(context);
  });
});
