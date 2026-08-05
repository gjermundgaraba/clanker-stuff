import { fauxAssistantMessage } from "@earendil-works/pi-ai";
import type {
  ExtensionFactory,
  ExtensionUIContext,
} from "@earendil-works/pi-coding-agent";
import { afterEach, describe, expect, it } from "vitest";

import { createAgentSessionHarness } from "../../tests/harness/agent-session.js";
import type { AgentSessionHarness } from "../../tests/harness/agent-session.js";
import { createIdentityTheme, createMockTui } from "../../tests/harness/tui.js";
import { cloneFooterConfig, DEFAULT_CONFIG } from "../config.js";
import type { FooterConfigStore } from "../config.js";
import { createFooterExtension } from "../index.js";
import { FOOTER_READY_EVENT } from "../types.js";
import { formatTokenCount } from "../widgets.js";

type FooterFactory = Exclude<
  Parameters<ExtensionUIContext["setFooter"]>[0],
  undefined
>;
type FooterComponent = ReturnType<FooterFactory>;

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
      extensionFactories: [
        createFooterExtension({
          configStore: configStore(),
          readGit: async () => null,
        }),
        producer,
      ],
      uiContext: {
        notify: () => {
          // Keeps the real reload lifecycle bound without installing a TUI.
        },
      } as unknown as ExtensionUIContext,
    });
    expect(readyGenerations).toStrictEqual([1]);

    await harness.session.reload();

    expect(readyGenerations).toStrictEqual([1, 2]);
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
    const uiContext = {
      notify: () => {
        // No notifications expected.
      },
      setFooter(factory: FooterFactory | undefined) {
        component?.dispose?.();
        component =
          factory === undefined
            ? undefined
            : factory(createMockTui(), createIdentityTheme(), footerData);
      },
    } as unknown as ExtensionUIContext;
    const probe: ExtensionFactory = (pi) => {
      pi.on("turn_end", () => {
        renderedAtTurnEnd = component?.render(240).join("\n");
      });
    };

    harness = await createAgentSessionHarness({
      extensionFactories: [
        createFooterExtension({
          configStore: configStore(),
          readGit: async () => null,
        }),
        probe,
      ],
      mode: "tui",
      uiContext,
    });
    harness.setResponses([fauxAssistantMessage("persisted reply")]);

    await harness.prompt("count this completed turn");

    const assistant = [...harness.messages()]
      .toReversed()
      .find((message) => message.role === "assistant");
    if (assistant?.role !== "assistant") {
      throw new Error("expected assistant message");
    }
    expect(assistant.usage.input).toBeGreaterThan(0);
    expect(assistant.usage.output).toBeGreaterThan(0);
    expect(renderedAtTurnEnd).toContain(
      `in ${formatTokenCount(assistant.usage.input)}`
    );
    expect(renderedAtTurnEnd).toContain(
      `out ${formatTokenCount(assistant.usage.output)}`
    );
  });
});
