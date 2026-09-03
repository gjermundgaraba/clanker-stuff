import { fauxAssistantMessage } from "@earendil-works/pi-ai";
import type { ExtensionUIContext } from "@earendil-works/pi-coding-agent";
import { afterEach, describe, expect, it, vi } from "vitest";

import { createAgentSessionHarness } from "../../../../tests/harness/agent-session.js";
import type { AgentSessionHarness } from "../../../../tests/harness/agent-session.js";
import thinkingOrbExtension from "../index.js";

describe("thinking-orb AgentSession lifecycle", () => {
  let harness: AgentSessionHarness | undefined;
  const notifications: { message: string; type?: string }[] = [];

  afterEach(async () => {
    vi.unstubAllEnvs();
    harness?.cleanup();
    harness = undefined;
    notifications.length = 0;
  });

  it("loads without extension errors and registers its commands", async () => {
    vi.stubEnv("TERM_PROGRAM", "WezTerm");
    harness = await createAgentSessionHarness({
      extensionFactories: [thinkingOrbExtension],
      mode: "tui",
      uiContext: {
        notify: (message: string, type?: "info" | "warning" | "error") => {
          notifications.push({ message, type });
        },
      } as unknown as ExtensionUIContext,
    });

    expect(harness.extensionsResult.errors).toStrictEqual([]);
    expect(harness.extensionsResult.extensions).toHaveLength(1);
    const [orb] = harness.extensionsResult.extensions;
    expect([...(orb?.commands.keys() ?? [])].toSorted()).toStrictEqual([
      "orb-setup",
      "orb-start",
      "orb-status",
      "orb-stop",
    ]);
  });

  it("notifies once that the orb is unavailable outside Ghostty", async () => {
    vi.stubEnv("TERM_PROGRAM", "WezTerm");
    harness = await createAgentSessionHarness({
      extensionFactories: [thinkingOrbExtension],
      mode: "tui",
      uiContext: {
        notify: (message: string, type?: "info" | "warning" | "error") => {
          notifications.push({ message, type });
        },
      } as unknown as ExtensionUIContext,
    });

    harness.setResponses([
      fauxAssistantMessage("first"),
      fauxAssistantMessage("second"),
    ]);
    await harness.prompt("run once");
    await harness.prompt("run again");

    const unavailable = notifications.filter((notification) =>
      notification.message.includes("Thinking Orb unavailable")
    );
    expect(unavailable).toHaveLength(1);
    expect(unavailable[0]?.type).toBe("error");
    expect(unavailable[0]?.message).toContain("requires Ghostty");
  });
});
