import type {
  ExtensionContext,
  ReadonlyFooterDataProvider,
} from "@earendil-works/pi-coding-agent";
import { describe, expect, it, vi } from "vitest";

import { createExtensionHost } from "../../tests/harness/extension-host.js";
import { createIdentityTheme, createMockTui } from "../../tests/harness/tui.js";
import { createFooterExtension } from "../index.js";

type FooterFactory = NonNullable<
  Parameters<ExtensionContext["ui"]["setFooter"]>[0]
>;

describe("legacy footer without provider usage", () => {
  it("renders core and arbitrary native status data", async () => {
    let factory: FooterFactory | undefined;
    const setFooter: ExtensionContext["ui"]["setFooter"] = (next) => {
      factory = next;
    };
    const runGitStatus = vi.fn<() => Promise<null>>(async () => null);
    const host = createExtensionHost(createFooterExtension({ runGitStatus }));
    const context = host.createContext({
      model: {
        id: "demo",
        reasoning: true,
      } as never,
      ui: { setFooter },
    });
    await host.emitSessionStart(context);
    expect(factory).toBeDefined();

    const statuses = new Map([
      ["voice", "voice ready"],
      ["timer", "12s"],
    ]);
    const footerData: ReadonlyFooterDataProvider = {
      getAvailableProviderCount: () => 0,
      getExtensionStatuses: () => statuses,
      getGitBranch: () => null,
      onBranchChange: () => vi.fn<() => void>(),
    };
    const component = factory?.(
      createMockTui(),
      createIdentityTheme(),
      footerData
    );
    const rendered = component?.render(120).join("\n") ?? "";
    expect(rendered).toContain("demo");
    expect(rendered).toContain("voice ready");
    expect(rendered).toContain("12s");
    expect(runGitStatus).toHaveBeenCalledOnce();
  });
});
