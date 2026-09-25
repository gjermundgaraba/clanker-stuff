import { mkdir, rm, writeFile } from "node:fs/promises";

import { fauxAssistantMessage, fauxProvider } from "@earendil-works/pi-ai";
import type { AssistantMessage } from "@earendil-works/pi-ai";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import type { AgentBeforeSettleEvent, ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { Component } from "@earendil-works/pi-tui";

import { afterEach, describe, expect, it, onTestFinished, vi } from "vite-plus/test";

import { renderCard } from "../card.js";
import { getRollingFontDirectory, getRollingFontPath } from "../font.js";
import { ENTRY_TYPE, RECAP_ENTRY_TYPE, RecapEntrySchema, SnapshotSchema } from "../entry.js";
import { createTurnRecapRuntime } from "../runtime.js";
import { RECAP_REQUEST_TIMEOUT_MS } from "../recap.js";
import { Value } from "typebox/value";
import {
  appendTurn,
  createRecapConfigFile,
  queuedStream,
  sampleUsage,
  fontManifest,
} from "./fixtures.js";
import type { ResponseStep } from "./fixtures.js";
import { createExtensionHost } from "../../../../tests/harness/extension-host.js";
import { createIdentityTheme, createMockTui } from "../../../../tests/harness/tui.js";

const boundary = (outcome: AgentBeforeSettleEvent["outcome"]): AgentBeforeSettleEvent => ({
  type: "agent_before_settle",
  outcome,
  entries: [],
  continue: false,
  context: {
    canContinue: false,
    contextEntries: [],
    contextMessages: [],
    llmMessages: [],
    pendingMessages: [],
  },
});

const setup = async (...responses: ResponseStep[]) => {
  const { configPath, directory } = await createRecapConfigFile();
  vi.stubEnv("PI_CODING_AGENT_DIR", directory);
  onTestFinished(() => {
    vi.unstubAllEnvs();
  });
  const session = SessionManager.inMemory();
  const stream = queuedStream(...responses);
  const model = fauxProvider({ models: [{ id: "small" }], provider: "cheap" }).getModel();
  const find = vi.fn<ExtensionContext["modelRegistry"]["find"]>(() => model);

  const auth = vi.fn(async () => {
    throw new Error("Authentication belongs to streamSimple");
  });

  let runtime: ReturnType<typeof createTurnRecapRuntime> | undefined;

  const host = createExtensionHost((pi) => {
    runtime = createTurnRecapRuntime(
      {
        ...pi,
        appendEntry: (type, data) => {
          session.appendCustomEntry(type, data);
        },
      },
      configPath,
    );
  });

  await host.ready;

  if (!runtime) throw new Error("Missing runtime");
  const controller = new AbortController();
  const tui = createMockTui();
  const theme = createIdentityTheme();
  let component: (Component & { dispose?(): void }) | undefined;

  const ctx = host.createContext({
    signal: controller.signal,
    sessionManager: session,
    modelRegistry: {
      find,
      getApiKeyAndHeaders: auth,
      streamSimple: stream,
    },
    ui: {
      setWidget: (_key, content) => {
        component?.dispose?.();
        component = typeof content === "function" ? content(tui, theme) : undefined;
      },
    },
  });

  const readyRuntime = runtime;
  onTestFinished(() => readyRuntime.shutdown(ctx));
  await runtime.start(ctx);

  const snapshots = () =>
    session
      .getBranch()
      .flatMap((entry) =>
        entry.type === "custom" &&
        entry.customType === ENTRY_TYPE &&
        Value.Check(SnapshotSchema, entry.data)
          ? [entry.data]
          : [],
      );

  const recaps = () =>
    session
      .getEntries()
      .flatMap((entry) =>
        entry.type === "custom" &&
        entry.customType === RECAP_ENTRY_TYPE &&
        Value.Check(RecapEntrySchema, entry.data)
          ? [entry.data.recap]
          : [],
      );

  return {
    configPath,
    find,
    auth,
    tui,
    theme,
    session,
    stream,
    ctx,
    host,
    runtime,
    controller,
    snapshots,
    recaps,
    render: () => component?.render(100).join("\n") ?? "",
    // The latest card as the transcript draws it, recap looked up live.
    card: (expanded = false) => {
      const latest = snapshots().at(-1);

      return latest
        ? renderCard(latest, readyRuntime.recap(latest.runId), 100, theme, expanded).join("\n")
        : "";
    },
  };
};

afterEach(() => vi.useRealTimers());

const glyph = String.fromCodePoint(0xf1004);

const installFont = async (manifest: unknown = fontManifest()) => {
  await mkdir(getRollingFontDirectory(), { recursive: true });
  await writeFile(getRollingFontPath(), JSON.stringify(manifest));
};

describe("turn recap runtime", () => {
  it("rolls live digits whenever a font manifest exists", async () => {
    vi.useFakeTimers();
    const env = await setup();
    await installFont();

    for (let run = 0; run < 2; run++) {
      await env.runtime.start(env.ctx);
      env.runtime.begin(env.ctx);
      expect(env.render()).toContain("0s active");
      vi.advanceTimersByTime(1000);
      env.render();
      vi.advanceTimersByTime(130);
      expect(env.render()).toContain(`${glyph}s active`);
      vi.advanceTimersByTime(370);
      expect(env.render()).toContain("1s active");
    }

    expect(env.host.getNotifications()).toEqual([]);
    env.runtime.shutdown(env.ctx);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("starts each run's live row without the previous run's rolling history", async () => {
    vi.useFakeTimers();
    const env = await setup(() => fauxAssistantMessage("Done"));
    await installFont();
    await env.runtime.start(env.ctx);
    env.runtime.begin(env.ctx);
    env.render();
    vi.advanceTimersByTime(1000);
    env.render();
    vi.advanceTimersByTime(500);
    expect(env.render()).toContain("1s active");
    appendTurn(env.session, 1);
    await env.runtime.settled(env.ctx);

    // Same digit width, so carried-over history would roll 1s back down to 0s.
    env.runtime.begin(env.ctx);
    expect(env.render()).toContain("0s active");
    vi.advanceTimersByTime(130);
    expect(env.render()).toContain("0s active");
  });

  it.each(["missing", "invalid"])("keeps recaps working with a %s font manifest", async (kind) => {
    vi.useFakeTimers();
    const env = await setup(() => fauxAssistantMessage("Recap still works"));

    if (kind === "invalid") await installFont({ version: 1 });
    await env.runtime.start(env.ctx);
    env.runtime.begin(env.ctx);
    vi.advanceTimersByTime(1000);
    expect(env.render()).toContain("1s active");

    const notifications = env.host.getNotifications();

    if (kind === "missing") expect(notifications).toEqual([]);
    else {
      expect(notifications).toHaveLength(1);
      expect(notifications[0]?.message).toContain("Rolling numbers disabled");
      expect(notifications[0]?.type).toBe("error");
    }

    appendTurn(env.session, 1);
    await env.runtime.settled(env.ctx);
    expect(env.card()).toContain("Recap still works");
  });

  it("keeps rolling numbers when the recap configuration is invalid", async () => {
    vi.useFakeTimers();
    const env = await setup();
    await installFont();
    await writeFile(env.configPath, "{");
    await env.runtime.start(env.ctx);
    env.runtime.begin(env.ctx);
    env.render();
    vi.advanceTimersByTime(1000);
    env.render();
    vi.advanceTimersByTime(130);
    expect(env.render()).toContain(`${glyph}s active`);
    appendTurn(env.session, 1);
    await env.runtime.settled(env.ctx);
    expect(env.snapshots()).toHaveLength(1);
    expect(env.recaps()).toEqual([]);
    expect(env.host.getNotifications()).toHaveLength(1);
    expect(env.host.getNotifications()[0]?.message).toContain("generated recaps disabled");
    expect(env.stream).not.toHaveBeenCalled();
  });

  it("writes the card when the run settles and fills in its recap when it arrives", async () => {
    vi.useFakeTimers();
    const response = Promise.withResolvers<AssistantMessage>();
    const env = await setup(() => response.promise);
    expect(env.render()).toBe("");
    env.runtime.begin(env.ctx);
    expect(env.render()).toContain("0s active");
    vi.advanceTimersByTime(1200);
    appendTurn(env.session, 1);
    env.session.appendMessage({ ...fauxAssistantMessage("finished"), usage: sampleUsage() });
    env.runtime.refresh(env.ctx);
    expect(env.render()).toContain("370 processed");
    const completion = env.runtime.settled(env.ctx);
    expect(env.render()).toBe("");
    expect(env.snapshots()).toHaveLength(1);
    expect(env.snapshots()[0]).toMatchObject({
      activeMs: 1200,
      metrics: { usage: { input: 100 } },
    });
    expect(env.card()).toContain("Generating recap…");
    expect(env.card()).toContain("370 processed");
    vi.advanceTimersByTime(5000);
    response.resolve({ ...fauxAssistantMessage("Ready for review"), usage: sampleUsage() });
    await completion;
    expect(env.snapshots()).toHaveLength(1);
    expect(env.recaps()).toMatchObject([{ status: "ready", text: "Ready for review" }]);
    expect(env.card()).toContain("Ready for review");
    expect(env.card()).not.toContain("Generating");
    expect(env.card(true)).toContain("Recap only: 370 tokens");
    expect(vi.getTimerCount()).toBe(0);
  });

  it("restores recaps into their cards after a reload", async () => {
    const env = await setup(() => fauxAssistantMessage("Restored recap"));
    env.runtime.begin(env.ctx);
    appendTurn(env.session, 1);
    await env.runtime.settled(env.ctx);
    await env.runtime.start(env.ctx);
    expect(env.card()).toContain("Restored recap");
  });

  it("keeps timing across retries, pauses blocking prompts, and ignores async prompts", async () => {
    vi.useFakeTimers();
    const env = await setup();
    await rm(env.configPath);
    await env.runtime.start(env.ctx);
    env.runtime.pause();
    env.runtime.begin(env.ctx);
    vi.advanceTimersByTime(1000);
    expect(env.render()).toContain("0s active");
    env.runtime.resume();
    vi.advanceTimersByTime(2000);
    env.runtime.begin(env.ctx);
    env.runtime.setAsyncPrompt({ active: true });
    env.runtime.pause();
    vi.advanceTimersByTime(1000);
    env.runtime.resume();
    env.runtime.setAsyncPrompt({ active: false });
    env.runtime.pause();
    vi.advanceTimersByTime(3000);
    await env.runtime.settled(env.ctx);
    env.runtime.resume();
    expect(env.snapshots()).toHaveLength(1);
    expect(env.snapshots()[0]).toMatchObject({ activeMs: 3000, wallMs: 7000 });
    expect(env.recaps()).toEqual([]);
    expect(env.host.getNotifications()).toEqual([]);
    expect(env.stream).not.toHaveBeenCalled();
    expect(env.render()).toBe("");
    expect(vi.getTimerCount()).toBe(0);
  });

  it.each(["completed", "aborted", "error"] as const)(
    "writes a %s run without a recap when there is nothing to recap",
    async (outcome) => {
      const env = await setup();
      env.runtime.begin(env.ctx);
      env.runtime.boundary(boundary(outcome), env.ctx);
      await env.runtime.settled(env.ctx);
      expect(env.snapshots()[0]?.outcome).toBe(outcome);
      expect(env.card()).not.toContain("Generating");
      expect(env.recaps()).toEqual([]);
      expect(env.stream).not.toHaveBeenCalled();
    },
  );

  it("shows context growth from the first frame", async () => {
    const env = await setup();
    const size = { tokens: 500, contextWindow: 1000, percent: 50 };
    vi.spyOn(env.ctx, "getContextUsage").mockReturnValue(size);
    env.runtime.begin(env.ctx);
    expect(env.render()).toContain("+0 context");
  });

  it("measures context growth from the first known size when the run starts unmeasured", async () => {
    const env = await setup();
    await rm(env.configPath);
    await env.runtime.start(env.ctx);

    const sizes = [null, 150, 180].map((tokens) => ({
      tokens,
      contextWindow: 1000,
      percent: tokens === null ? null : tokens / 10,
    }));

    // Pi reports an unknown size after compaction until the next response.
    vi.spyOn(env.ctx, "getContextUsage").mockImplementation(() => sizes.shift());
    env.runtime.begin(env.ctx);
    env.runtime.refresh(env.ctx);
    await env.runtime.settled(env.ctx);
    expect(env.snapshots()[0]?.metrics.context).toMatchObject({ tokens: 180, startTokens: 150 });
    expect(env.card()).toContain("+30 context");
  });

  it("recognizes aborts after the before-settle notification", async () => {
    const env = await setup();
    env.runtime.begin(env.ctx);
    env.runtime.boundary(boundary("completed"), env.ctx);
    env.controller.abort();
    await env.runtime.settled(env.ctx);
    expect(env.snapshots()[0]?.outcome).toBe("aborted");
  });

  it("lets a pending recap finish across later runs and fills in its own card", async () => {
    const first = Promise.withResolvers<AssistantMessage>();

    const env = await setup(
      () => first.promise,
      () => fauxAssistantMessage("Second recap"),
    );

    env.runtime.begin(env.ctx);
    appendTurn(env.session, 1);
    const pending = env.runtime.settled(env.ctx);
    env.runtime.begin(env.ctx);
    appendTurn(env.session, 2);
    await env.runtime.settled(env.ctx);
    expect(env.stream.mock.calls[0]?.[2]?.signal?.aborted).toBe(false);

    const [earlier, later] = env.snapshots();

    if (!earlier || !later) throw new Error("Missing cards");
    expect(env.runtime.recap(earlier.runId)).toEqual({ status: "generating" });
    expect(env.runtime.recap(later.runId)).toMatchObject({ text: "Second recap" });
    first.resolve(fauxAssistantMessage("First recap"));
    await pending;
    expect(env.runtime.recap(earlier.runId)).toMatchObject({ text: "First recap" });
    expect(env.recaps()).toHaveLength(2);
  });

  it("abandons pending recaps on shutdown, leaving their cards without one", async () => {
    const response = Promise.withResolvers<AssistantMessage>();
    const env = await setup(() => response.promise);
    env.runtime.begin(env.ctx);
    appendTurn(env.session, 1);
    const completion = env.runtime.settled(env.ctx);
    const cards = env.snapshots();
    env.runtime.shutdown(env.ctx);
    expect(env.stream.mock.calls[0]?.[2]?.signal?.aborted).toBe(true);
    response.resolve(fauxAssistantMessage("Stale result"));
    await completion;
    expect(env.snapshots()).toEqual(cards);
    expect(env.recaps()).toEqual([]);
    expect(env.host.getNotifications()).toEqual([]);
  });

  it.each(["missing", "invalid"])(
    "skips recap preparation but still refreshes context statistics with %s config",
    async (kind) => {
      const env = await setup();

      if (kind === "missing") await rm(env.configPath);
      else await writeFile(env.configPath, "{");
      await env.runtime.start(env.ctx);
      const project = vi.spyOn(env.ctx.sessionManager, "buildSessionProjection");
      const start = { tokens: 60, contextWindow: 1000, percent: 6 };
      const context = { tokens: 100, contextWindow: 1000, percent: 10 };

      // Pi's real context accounting also projects history; only recap preparation is skipped.
      const contextUsage = vi.spyOn(env.ctx, "getContextUsage").mockImplementation(() => {
        env.ctx.sessionManager.buildSessionProjection();

        return contextUsage.mock.calls.length === 1 ? start : context;
      });

      env.runtime.begin(env.ctx);
      appendTurn(env.session, 1);
      await env.runtime.settled(env.ctx);
      expect(contextUsage).toHaveBeenCalledTimes(2);
      expect(project).toHaveBeenCalledTimes(2);
      expect(env.snapshots()[0]?.metrics.context).toEqual({ ...context, startTokens: 60 });
      expect(env.recaps()).toEqual([]);
      expect(env.stream).not.toHaveBeenCalled();
    },
  );

  it("recovers from request-time authentication failure without reinitialization", async () => {
    const env = await setup(
      () => {
        throw new Error("No credentials");
      },
      () => fauxAssistantMessage("Authenticated"),
    );

    expect(env.find).not.toHaveBeenCalled();
    expect(env.auth).not.toHaveBeenCalled();
    env.runtime.begin(env.ctx);
    appendTurn(env.session, 1);
    await env.runtime.settled(env.ctx);
    expect(env.recaps().at(-1)).toMatchObject({ status: "failed", error: "No credentials" });
    env.runtime.begin(env.ctx);
    appendTurn(env.session, 2);
    await env.runtime.settled(env.ctx);
    expect(env.recaps().at(-1)).toMatchObject({ status: "ready", text: "Authenticated" });
    expect(env.find).toHaveBeenCalledTimes(2);
    expect(env.auth).not.toHaveBeenCalled();
    expect(env.host.getNotifications()).toEqual([]);
  });

  it("re-resolves models on each request and recovers when a model becomes available", async () => {
    const env = await setup(() => fauxAssistantMessage("Model available"));
    env.find.mockReturnValueOnce(undefined);
    env.runtime.begin(env.ctx);
    appendTurn(env.session, 1);
    await env.runtime.settled(env.ctx);
    expect(env.recaps().at(-1)?.status).toBe("failed");
    expect(env.stream).not.toHaveBeenCalled();
    env.runtime.begin(env.ctx);
    appendTurn(env.session, 2);
    await env.runtime.settled(env.ctx);
    expect(env.recaps().at(-1)).toMatchObject({ status: "ready", text: "Model available" });
  });

  it("keeps the card if optional prompt preparation fails", async () => {
    const env = await setup();
    vi.spyOn(env.ctx.sessionManager, "buildSessionProjection").mockImplementation(() => {
      throw new Error("Projection failed");
    });
    env.runtime.begin(env.ctx);
    appendTurn(env.session, 1);
    await env.runtime.settled(env.ctx);
    expect(env.snapshots()).toHaveLength(1);
    expect(env.recaps()).toEqual([{ status: "failed", error: "Projection failed" }]);
    expect(env.card()).toContain("Recap unavailable: Projection failed");
    expect(env.stream).not.toHaveBeenCalled();
  });

  it("bounds persisted failure text", async () => {
    const env = await setup(() => {
      throw new Error("failure ".repeat(10_000));
    });

    env.runtime.begin(env.ctx);
    appendTurn(env.session, 1);
    await env.runtime.settled(env.ctx);
    const recap = env.recaps()[0];

    expect(recap?.status === "failed" && Array.from(recap.error).length).toBe(1000);
  });

  it("times out without retrying and recovers on the next run", async () => {
    vi.useFakeTimers();
    const response = Promise.withResolvers<AssistantMessage>();

    const env = await setup(
      () => response.promise,
      () => fauxAssistantMessage("Recovered"),
    );

    env.runtime.begin(env.ctx);
    appendTurn(env.session, 1);
    const completion = env.runtime.settled(env.ctx);
    await vi.advanceTimersByTimeAsync(RECAP_REQUEST_TIMEOUT_MS);
    await completion;
    expect(env.card()).toContain("Recap unavailable");
    env.runtime.begin(env.ctx);
    appendTurn(env.session, 2);
    await env.runtime.settled(env.ctx);
    expect(env.card()).toContain("Recovered");
    response.resolve(fauxAssistantMessage("Late"));
    await vi.advanceTimersByTimeAsync(0);
    expect(env.recaps()).toHaveLength(2);
    expect(env.stream).toHaveBeenCalledTimes(2);
  });

  it("records stats without mounting widgets or timers outside the TUI", async () => {
    vi.useFakeTimers();
    const env = await setup();
    await rm(env.configPath);
    const ctx = { ...env.ctx, mode: "json" as const };
    await env.runtime.start(ctx);
    env.runtime.begin(ctx);
    vi.advanceTimersByTime(1000);
    await env.runtime.settled(ctx);
    expect(env.render()).toBe("");
    expect(env.snapshots()[0]?.activeMs).toBe(1000);
    expect(vi.getTimerCount()).toBe(0);
  });
});
