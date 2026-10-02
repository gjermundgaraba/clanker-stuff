import { FOOTER_READY_EVENT } from "@clanker-stuff/footer-protocol";
import { fauxAssistantMessage } from "@earendil-works/pi-ai";
import type { ExtensionFactory, ExtensionUIContext } from "@earendil-works/pi-coding-agent";
import { afterEach, describe, expect, it } from "vite-plus/test";

import { createAgentSessionHarness } from "../../../../tests/harness/agent-session.js";
import type { AgentSessionHarness } from "../../../../tests/harness/agent-session.js";
import { createIdentityTheme, createMockTui } from "../../../../tests/harness/tui.js";
import { cloneFooterConfig, DEFAULT_CONFIG } from "@clanker-stuff/footer-protocol/config";
import type { FooterConfigStore } from "../config.js";
import footerExtension from "../index.js";
import { formatTokenCount } from "../widgets.js";

type FooterFactory = Exclude<Parameters<ExtensionUIContext["setFooter"]>[0], undefined>;

type FooterComponent = ReturnType<FooterFactory>;

const testUiContext = (setFooter: ExtensionUIContext["setFooter"]): ExtensionUIContext => ({
  addAutocompleteProvider: () => {},
  confirm: async () => await Promise.resolve(false),
  custom: async () => {
    await Promise.resolve();
    throw new Error("custom UI is not used in this test");
  },
  editor: async () => await Promise.resolve(undefined),
  getAllThemes: () => [],
  getEditorComponent: () => undefined,
  getEditorText: () => "",
  getTheme: () => undefined,
  getToolsExpanded: () => false,
  input: async () => await Promise.resolve(undefined),
  notify: () => {},
  onTerminalInput: () => () => {},
  pasteToEditor: () => {},
  select: async () => await Promise.resolve(undefined),
  setEditorComponent: () => {},
  setEditorText: () => {},
  setFooter,
  setHeader: () => {},
  setHiddenThinkingLabel: () => {},
  setStatus: () => {},
  setTheme: () => ({ success: true }),
  setTitle: () => {},
  setToolsExpanded: () => {},
  setWidget: () => {},
  setWorkingIndicator: () => {},
  setWorkingMessage: () => {},
  setWorkingVisible: () => {},
  theme: createIdentityTheme(),
});

const sessionConfig = () => {
  const config = cloneFooterConfig(DEFAULT_CONFIG);
  config.rows[2]?.left.push("footer.session");

  return config;
};

const configStore = (): FooterConfigStore => ({
  load: async () => ({
    config: sessionConfig(),
  }),
  path: "/tmp/footer.json",
  save: async () => {
    await Promise.resolve();
  },
});

const extension: ExtensionFactory = (pi) => footerExtension(pi, configStore(), async () => null);

describe("footer AgentSession lifecycle", () => {
  let harness: AgentSessionHarness | undefined;

  afterEach(() => {
    harness?.cleanup();
    harness = undefined;
  });

  it("removes process-bus listeners before a real session reload", async () => {
    let generation = 0;
    const readyGenerations: number[] = [];

    const producer: ExtensionFactory = (pi) => {
      generation += 1;
      const current = generation;

      const unsubscribe = pi.events.on(FOOTER_READY_EVENT, () => {
        readyGenerations.push(current);
      });

      pi.on("session_shutdown", unsubscribe);
    };

    harness = await createAgentSessionHarness({
      extensionFactories: [extension, producer],
      mode: "tui",
      uiContext: testUiContext(() => {}),
    });
    expect(readyGenerations).toStrictEqual([1]);

    await harness.session.reload();

    expect(readyGenerations).toStrictEqual([1, 2]);
  });

  it("renders selected and executed virtual-model status after real routing", async () => {
    let component: FooterComponent | undefined;

    const footerData = {
      getAvailableProviderCount: () => 1,
      getExtensionStatuses: () => new Map<string, string>(),
      getGitBranch: () => null,
      onBranchChange: () => () => {},
    };

    const uiContext = testUiContext((factory) => {
      component?.dispose?.();
      component = factory?.(createMockTui(), createIdentityTheme(), footerData);
    });

    const routing: ExtensionFactory = (pi) => {
      pi.registerVirtualModel({
        provider: "router",
        id: "auto",
        name: "Auto",
        thinkingLevels: ["off", "low", "high"],
        route: (_request, ctx) => {
          const model = ctx.modelRegistry.find("anthropic", "physical");

          if (!model) throw new Error("missing physical model");

          return { model, thinkingLevel: "high" };
        },
      });
    };

    harness = await createAgentSessionHarness({
      provider: "anthropic",
      models: [{ id: "physical", reasoning: true }],
      extensionFactories: [routing, extension],
      mode: "tui",
      uiContext,
    });
    const virtual = harness.session.modelRuntime.getModel("router", "auto");

    if (!virtual) throw new Error("missing virtual model");
    await harness.session.setModel(virtual);
    harness.session.setThinkingLevel("low");
    harness.setResponses([fauxAssistantMessage("routed reply")]);
    await harness.prompt("route this");
    const rendered = component?.render(240).join("\n");
    expect(rendered).toContain("selected: Auto");
    expect(rendered).toContain("last: anthropic/physical");
    expect(rendered).toContain("selected: low");
    expect(rendered).toContain("last: high");
  });

  it("renders the completed turn's persisted usage during turn_end", async () => {
    let component: FooterComponent | undefined;
    let renderedAtTurnEnd: string | undefined;

    const footerData = {
      getAvailableProviderCount: () => 1,
      getExtensionStatuses: () => new Map<string, string>(),
      getGitBranch: () => null,
      onBranchChange: () => () => {
        // No branch source in this integration test.
      },
    };

    const uiContext = testUiContext((factory) => {
      component?.dispose?.();
      component =
        factory === undefined
          ? undefined
          : factory(createMockTui(), createIdentityTheme(), footerData);
    });

    const probe: ExtensionFactory = (pi) => {
      pi.on("turn_end", () => {
        renderedAtTurnEnd = component?.render(240).join("\n");
      });
    };

    harness = await createAgentSessionHarness({
      extensionFactories: [extension, probe],
      mode: "tui",
      uiContext,
    });
    harness.setResponses([fauxAssistantMessage("persisted reply")]);

    await harness.prompt("count this completed turn");

    const assistant = harness.messages().findLast((message) => message.role === "assistant");

    if (assistant?.role !== "assistant") {
      throw new Error("expected assistant message");
    }

    expect(assistant.usage.input).toBeGreaterThan(0);
    expect(assistant.usage.output).toBeGreaterThan(0);
    expect(renderedAtTurnEnd).toContain(`in ${formatTokenCount(assistant.usage.input)}`);
    expect(renderedAtTurnEnd).toContain(`out ${formatTokenCount(assistant.usage.output)}`);
  });
});
