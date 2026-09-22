import { rm } from "node:fs/promises";

import { fauxAssistantMessage, fauxProvider } from "@earendil-works/pi-ai";
import type { AssistantMessage } from "@earendil-works/pi-ai";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import type { Component } from "@earendil-works/pi-tui";
import { describe, expect, it, onTestFinished, vi } from "vite-plus/test";

import extension from "../index.js";
import { ENTRY_TYPE } from "../entry.js";
import { appendTurn, createRecapConfigFile, queuedStream } from "./fixtures.js";
import { createExtensionHost } from "../../../../tests/harness/extension-host.js";
import { createIdentityTheme, createMockTui } from "../../../../tests/harness/tui.js";

describe("turn-recap registrations", () => {
  it("reports a settlement failure instead of leaving an unhandled background rejection", async () => {
    const { directory, configPath } = await createRecapConfigFile();
    await rm(configPath);
    vi.stubEnv("PI_CODING_AGENT_DIR", directory);
    onTestFinished(() => {
      vi.unstubAllEnvs();
    });

    const host = createExtensionHost((pi) =>
      extension({
        ...pi,
        appendEntry() {
          throw new Error("Snapshot write failed");
        },
      }),
    );

    const ctx = host.createContext();
    onTestFinished(() => host.emitSessionShutdown(ctx));
    await host.emitSessionStart(ctx);
    await host.emit("agent_start", { type: "agent_start" }, ctx);
    await host.emit("agent_settled", { type: "agent_settled" }, ctx);
    await vi.waitFor(() =>
      expect(host.getNotifications()).toEqual([
        { message: "Turn recap failed: Snapshot write failed", type: "error" },
      ]),
    );
  });

  it("does not hold Pi settlement open while recap generation is pending", async () => {
    const { directory } = await createRecapConfigFile();
    vi.stubEnv("PI_CODING_AGENT_DIR", directory);
    onTestFinished(() => {
      vi.unstubAllEnvs();
    });
    const response = Promise.withResolvers<AssistantMessage>();
    const session = SessionManager.inMemory();
    const model = fauxProvider({ models: [{ id: "small" }], provider: "cheap" }).getModel();
    const host = createExtensionHost(extension);

    const ctx = host.createContext({
      sessionManager: session,
      modelRegistry: { find: () => model, streamSimple: queuedStream(() => response.promise) },
    });

    onTestFinished(() => host.emitSessionShutdown(ctx));
    await host.emitSessionStart(ctx);
    await host.emit("agent_start", { type: "agent_start" }, ctx);
    appendTurn(session, 1);
    await host.emit("agent_settled", { type: "agent_settled" }, ctx);
    expect(host.getAppendedEntries()).toHaveLength(1);
    expect(host.getAppendedEntries()[0]).toMatchObject({ data: { recap: { status: "pending" } } });
    response.resolve(fauxAssistantMessage("Ready"));
    await vi.waitFor(() => expect(host.getAppendedEntries()).toHaveLength(2));
    expect(host.getAppendedEntries()[1]).toMatchObject({
      data: { recap: { status: "ready", text: "Ready" } },
    });
  });

  it("wires the live card, command, async prompts, settlement, and cleanup without transcript rendering", async () => {
    vi.useFakeTimers();
    const { directory, configPath } = await createRecapConfigFile();
    await rm(configPath);
    vi.stubEnv("PI_CODING_AGENT_DIR", directory);
    onTestFinished(() => {
      vi.unstubAllEnvs();
      vi.useRealTimers();
    });
    let component: Component | undefined;
    const host = createExtensionHost(extension);

    const ctx = host.createContext({
      signal: undefined,
      ui: {
        setWidget: (_key, content) => {
          component =
            typeof content === "function"
              ? content(createMockTui(), createIdentityTheme())
              : undefined;
        },
      },
    });

    const render = () => component?.render(100).join("\n");
    await host.emitSessionStart(ctx);
    expect([...host.getRegisteredCommands().keys()]).toEqual(["turn-recap"]);
    expect(host.getEntryRenderer(ENTRY_TYPE)).toBeUndefined();
    expect(render()).toContain("No turns yet");
    await host.emit("agent_start", { type: "agent_start" }, ctx);
    vi.advanceTimersByTime(1000);
    host.events.emit("clanker:async-prompt", { active: true });
    await host.emit(
      "ui_prompt_start",
      { type: "ui_prompt_start", reason: "ui_prompt", kind: "custom" },
      ctx,
    );
    vi.advanceTimersByTime(1000);
    expect(render()).toContain("2.0s active");
    host.events.emit("clanker:async-prompt", { active: false });
    await host.emit(
      "ui_prompt_start",
      { type: "ui_prompt_start", reason: "ui_prompt", kind: "custom" },
      ctx,
    );
    vi.advanceTimersByTime(1000);
    expect(render()).toContain("Waiting for you");
    await host.emit(
      "ui_prompt_end",
      { type: "ui_prompt_end", reason: "ui_prompt", kind: "custom" },
      ctx,
    );
    await host.emit("agent_settled", { type: "agent_settled" }, ctx);
    expect(host.getAppendedEntries()).toHaveLength(1);
    expect(render()).toContain("Completed");
    await host.runCommand("turn-recap", "", ctx);
    expect(render()).toContain("3.0s wall · 1.0s waiting");
    await host.emitSessionTree(ctx);
    expect(render()).toContain("Completed");
    await host.emitSessionShutdown(ctx);
    expect(component).toBeUndefined();
    expect(vi.getTimerCount()).toBe(0);
  });
});
