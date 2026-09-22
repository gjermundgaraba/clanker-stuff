import { rm } from "node:fs/promises";

import { fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai";
import type { ExtensionFactory } from "@earendil-works/pi-coding-agent";
import type { Component } from "@earendil-works/pi-tui";
import { Type } from "typebox";
import { Value } from "typebox/value";
import { describe, expect, it, onTestFinished, vi } from "vite-plus/test";

import extension from "../index.js";
import { ENTRY_TYPE, SnapshotSchema } from "../entry.js";
import { collectMetrics } from "../metrics.js";
import { createRecapConfigFile, sampleUsage } from "./fixtures.js";
import { createAgentSessionHarness } from "../../../../tests/harness/agent-session.js";
import type { AgentSessionHarnessOptions } from "../../../../tests/harness/agent-session.js";
import { createExtensionHost } from "../../../../tests/harness/extension-host.js";
import { createIdentityTheme, createMockTui } from "../../../../tests/harness/tui.js";

const setup = async (
  extra: ExtensionFactory[] = [],
  settings: AgentSessionHarnessOptions["settings"] = {},
) => {
  const { directory, configPath } = await createRecapConfigFile();
  await rm(configPath);
  vi.stubEnv("PI_CODING_AGENT_DIR", directory);
  onTestFinished(() => {
    vi.unstubAllEnvs();
  });
  let component: Component | undefined;
  const ui = createExtensionHost(() => {}).createContext().ui;

  const uiContext = {
    ...ui,
    setWidget: ((key, content) => {
      if (key === "turn-recap")
        component =
          typeof content === "function"
            ? content(createMockTui(), createIdentityTheme())
            : undefined;
    }) satisfies typeof ui.setWidget,
  };

  const harness = await createAgentSessionHarness({
    mode: "tui",
    uiContext,
    extensionFactories: [extension, ...extra],
    settings: { compaction: { enabled: false }, retry: { enabled: false }, ...settings },
    tools: [
      {
        name: "probe",
        label: "Probe",
        description: "Test tool",
        parameters: Type.Object({}),
        execute: async () => ({
          content: [{ type: "text", text: "ok" }],
          details: {},
          usage: sampleUsage(),
        }),
      },
    ],
  });

  onTestFinished(async () => {
    await harness.session.extensionRunner.emit({ type: "session_shutdown", reason: "quit" });
    harness.cleanup();
  });

  const snapshots = () =>
    harness.sessionManager
      .getBranch()
      .flatMap((entry) =>
        entry.type === "custom" &&
        entry.customType === ENTRY_TYPE &&
        Value.Check(SnapshotSchema, entry.data)
          ? [entry.data]
          : [],
      );

  return { ...harness, snapshots, render: () => component?.render(120).join("\n") ?? "" };
};

describe("real Pi run boundaries", () => {
  it("aggregates tool batches and queued continuations into one card, then resets for the next run", async () => {
    let queued = false;

    const env = await setup([
      (pi) => {
        pi.on("agent_end", () => {
          if (!queued) {
            queued = true;
            pi.sendUserMessage("Follow up", { deliverAs: "followUp" });
          }
        });
      },
    ]);

    env.setResponses([
      fauxAssistantMessage([fauxToolCall("probe", {})]),
      fauxAssistantMessage("First answer"),
      fauxAssistantMessage("Follow-up answer"),
      fauxAssistantMessage("Next run"),
    ]);
    await env.prompt("Work");
    expect(env.snapshots()).toHaveLength(1);
    expect(env.snapshots()[0]).toMatchObject({
      outcome: "completed",
      metrics: { responses: 3, toolCalls: 1 },
    });
    expect(env.snapshots()[0]?.metrics.usage).toEqual(
      collectMetrics(env.sessionManager.getBranch()).usage,
    );
    expect(env.render()).toContain("Completed");
    const firstLeaf = env.sessionManager.getLeafId();

    if (!firstLeaf) throw new Error("Missing card");
    await env.prompt("Again");
    expect(env.snapshots()).toHaveLength(2);
    expect(env.snapshots()[1]?.metrics.responses).toBe(1);
    expect(env.snapshots()[1]?.metrics.toolCalls).toBe(0);
    await env.session.reload();
    expect(env.render()).toContain("Completed");
    await env.session.navigateTree(firstLeaf);
    expect(env.render()).toContain("1 tools");
    expect(env.snapshots()).toHaveLength(1);
    expect(env.messages().some((message) => message.role === "custom")).toBe(false);
  });

  it("shows tool and token data before a long-running tool finishes", async () => {
    const entered = Promise.withResolvers<void>();
    const release = Promise.withResolvers<void>();

    const env = await setup([
      (pi) => {
        pi.on("tool_call", async () => {
          entered.resolve();
          await release.promise;
        });
      },
    ]);

    env.setResponses([
      fauxAssistantMessage([fauxToolCall("probe", {})]),
      fauxAssistantMessage("Done"),
    ]);
    const running = env.prompt("Work");
    await entered.promise;

    try {
      expect(env.render()).toContain("Running");
      expect(env.render()).toContain("1 tools");
      expect(env.render()).toContain("tokens reported");
      expect(env.snapshots()).toHaveLength(0);
    } finally {
      release.resolve();
      await running;
    }
  });

  it("records a real user abort and stops the active card", async () => {
    const entered = Promise.withResolvers<void>();
    const env = await setup();
    env.setResponses([
      (_context, options) =>
        new Promise((resolve) => {
          const signal = options?.signal;

          if (!signal) throw new Error("Missing signal");
          signal.addEventListener(
            "abort",
            () => resolve(fauxAssistantMessage("", { stopReason: "aborted" })),
            { once: true },
          );
          entered.resolve();
        }),
    ]);
    const running = env.prompt("Wait");
    await entered.promise;
    await env.session.abort();
    await running;
    expect(env.snapshots()).toHaveLength(1);
    expect(env.snapshots()[0]?.outcome).toBe("aborted");
    expect(env.render()).toContain("Aborted");
  });

  it("keeps one snapshot across automatic error recovery", async () => {
    const env = await setup([], {
      retry: { enabled: true, maxRetries: 1, baseDelayMs: 1 },
    });

    env.setResponses([
      fauxAssistantMessage("", { stopReason: "error", errorMessage: "overloaded" }),
      fauxAssistantMessage("Recovered"),
    ]);
    await env.prompt("Retry");
    expect(env.eventsOfType("agent_start")).toHaveLength(2);
    expect(env.snapshots()).toHaveLength(1);
    expect(env.snapshots()[0]).toMatchObject({ outcome: "completed", metrics: { responses: 2 } });
  });

  it("does not freeze the card at an actionable boundary that requests continuation", async () => {
    let continued = false;

    const env = await setup([
      (pi) => {
        pi.on("agent_before_settle", (event) => {
          if (continued) return;
          continued = true;

          return {
            continue: true,
            entries: [
              ...event.entries,
              {
                type: "custom_message",
                customType: "test-continuation",
                content: "Check once more",
                display: false,
              },
            ],
          };
        });
      },
    ]);

    env.setResponses([fauxAssistantMessage("First"), fauxAssistantMessage("Final")]);
    await env.prompt("Work");
    expect(env.snapshots()).toHaveLength(1);
    expect(env.snapshots()[0]?.metrics.responses).toBe(2);
  });

  it.each(["error", "aborted"] as const)("records a provider %s outcome", async (stopReason) => {
    const env = await setup();
    env.setResponses([fauxAssistantMessage("", { stopReason, errorMessage: "Stopped" })]);
    await env.prompt("Fail");
    expect(env.snapshots()).toHaveLength(1);
    expect(env.snapshots()[0]?.outcome).toBe(stopReason);
    expect(env.render()).toContain(stopReason === "error" ? "Failed" : "Aborted");
  });
});
