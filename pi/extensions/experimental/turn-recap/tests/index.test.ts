import { rm } from "node:fs/promises";

import { fauxAssistantMessage, fauxProvider } from "@earendil-works/pi-ai";
import type { AssistantMessage } from "@earendil-works/pi-ai";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import type { SessionEntry } from "@earendil-works/pi-coding-agent";
import { visibleWidth } from "@earendil-works/pi-tui";
import type { Component } from "@earendil-works/pi-tui";
import { describe, expect, it, onTestFinished, vi } from "vite-plus/test";

import extension from "../index.js";
import { Value } from "typebox/value";

import { ENTRY_TYPE, RECAP_ENTRY_TYPE, SnapshotSchema } from "../entry.js";
import { appendTurn, createRecapConfigFile, queuedStream, snapshot } from "./fixtures.js";
import { createExtensionHost } from "../../../../tests/harness/extension-host.js";
import { createIdentityTheme, createMockTui } from "../../../../tests/harness/tui.js";

/** Builds a saved entry's component through the renderer the extension registered. */
const cardComponent = (
  host: ReturnType<typeof createExtensionHost>,
  entry: SessionEntry | undefined,
  expanded = false,
) => {
  const renderer = host.getEntryRenderer(ENTRY_TYPE);

  if (!renderer || entry?.type !== "custom") throw new Error("Missing card or renderer");

  return renderer(entry, { expanded }, createIdentityTheme());
};

/** Draws a saved entry as the transcript would. */
const renderEntry = (
  host: ReturnType<typeof createExtensionHost>,
  entry: SessionEntry | undefined,
  expanded = false,
) => cardComponent(host, entry, expanded)?.render(100).join("\n");

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
    const [card] = host.getAppendedEntries();

    const runId =
      card?.type === "custom" && Value.Check(SnapshotSchema, card.data) ? card.data.runId : "none";

    // The transcript keeps one component per card and redraws it.
    const component = cardComponent(host, card);
    const draw = (width = 100) => component?.render(width).join("\n");
    expect(host.getAppendedEntries()).toHaveLength(1);
    expect(draw()).toContain("Generating recap…");
    response.resolve(fauxAssistantMessage("Ready"));
    await vi.waitFor(() => expect(host.getAppendedEntries()).toHaveLength(2));
    expect(host.getAppendedEntries()[1]).toMatchObject({
      customType: RECAP_ENTRY_TYPE,
      data: {
        runId,
        recap: { status: "ready", text: "Ready" },
      },
    });
    expect(draw()).toContain("Ready");
    expect(draw()).not.toContain("Generating");
    expect(component?.render(40).every((line) => visibleWidth(line) <= 40)).toBe(true);
  });

  it("renders finished cards in the transcript and ignores retired or malformed entries", async () => {
    const host = createExtensionHost(extension);
    await host.ready;

    const render = (data: unknown, expanded = false) =>
      renderEntry(
        host,
        {
          type: "custom",
          customType: ENTRY_TYPE,
          data,
          id: "entry",
          parentId: null,
          timestamp: new Date(0).toISOString(),
        },
        expanded,
      );

    expect(render(snapshot())).toContain("Completed in 1.5s");
    expect(render(snapshot())).not.toContain("Reported cost");
    expect(render(snapshot(), true)).toContain("Reported cost");

    const { runId: _runId, ...withoutRunId } = snapshot();

    for (const retired of [
      withoutRunId,
      { ...snapshot(), recap: { status: "ready", text: "Old", usage: snapshot().metrics.usage } },
      { ...snapshot(), activeMs: -1 },
      { ...snapshot(), activeMs: Infinity },
      { ...snapshot(), metrics: { extra: 1 } },
      { completedTurns: 1, recap: "Old" },
    ]) {
      expect(render(retired)).toBeUndefined();
    }
  });

  it("wires the live widget, async prompts, settlement, overlapping recaps, and cleanup", async () => {
    vi.useFakeTimers();
    const response = Promise.withResolvers<AssistantMessage>();
    const { directory } = await createRecapConfigFile();
    vi.stubEnv("PI_CODING_AGENT_DIR", directory);
    onTestFinished(() => {
      vi.unstubAllEnvs();
      vi.useRealTimers();
    });
    let component: (Component & { dispose?(): void }) | undefined;
    const session = SessionManager.inMemory();
    const model = fauxProvider({ models: [{ id: "small" }], provider: "cheap" }).getModel();
    const host = createExtensionHost(extension);

    const ctx = host.createContext({
      signal: undefined,
      sessionManager: session,
      modelRegistry: { find: () => model, streamSimple: queuedStream(() => response.promise) },
      ui: {
        // Like Pi, replacing or clearing a widget disposes the previous one.
        setWidget: (_key, content) => {
          component?.dispose?.();
          component =
            typeof content === "function"
              ? content(createMockTui(), createIdentityTheme())
              : undefined;
        },
      },
    });

    const render = () => component?.render(100).join("\n");
    await host.emitSessionStart(ctx);
    expect(render()).toBeUndefined();
    await host.emit("agent_start", { type: "agent_start" }, ctx);
    vi.advanceTimersByTime(1000);
    host.events.emit("clanker:async-prompt", { active: true });
    await host.emit(
      "ui_prompt_start",
      { type: "ui_prompt_start", reason: "ui_prompt", kind: "custom" },
      ctx,
    );
    vi.advanceTimersByTime(1000);
    expect(render()).toContain("2s active");
    host.events.emit("clanker:async-prompt", { active: false });
    await host.emit(
      "ui_prompt_start",
      { type: "ui_prompt_start", reason: "ui_prompt", kind: "custom" },
      ctx,
    );
    vi.advanceTimersByTime(1000);
    // A blocking prompt freezes active time.
    expect(render()).toContain("2s active");
    await host.emit(
      "ui_prompt_end",
      { type: "ui_prompt_end", reason: "ui_prompt", kind: "custom" },
      ctx,
    );
    appendTurn(session, 1);
    await host.emit("agent_settled", { type: "agent_settled" }, ctx);
    const [card] = host.getAppendedEntries();
    expect(component).toBeUndefined();
    expect(card).toMatchObject({ data: { activeMs: 2000, wallMs: 3000 } });
    expect(renderEntry(host, card)).toContain("Generating recap…");
    await host.emit("agent_start", { type: "agent_start" }, ctx);
    expect(render()).toContain("0s active");
    response.resolve(fauxAssistantMessage("Arrived during the next run"));
    await vi.advanceTimersByTimeAsync(0);
    expect(host.getAppendedEntries()).toHaveLength(2);
    expect(renderEntry(host, card)).toContain("Arrived during the next run");
    await host.emitSessionShutdown(ctx);
    expect(component).toBeUndefined();
    expect(vi.getTimerCount()).toBe(0);
  });
});
