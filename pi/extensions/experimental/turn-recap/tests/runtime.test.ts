import { rm, writeFile } from "node:fs/promises";

import { fauxAssistantMessage, fauxProvider } from "@earendil-works/pi-ai";
import type { AssistantMessage } from "@earendil-works/pi-ai";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import type { AgentBeforeSettleEvent, ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { Component } from "@earendil-works/pi-tui";
import { afterEach, describe, expect, it, onTestFinished, vi } from "vite-plus/test";

import { ENTRY_TYPE, restoreSnapshots, SnapshotSchema } from "../entry.js";
import { createTurnRecapRuntime } from "../runtime.js";
import { RECAP_REQUEST_TIMEOUT_MS } from "../recap.js";
import { Value } from "typebox/value";
import { appendTurn, createRecapConfigFile, queuedStream, sampleUsage } from "./fixtures.js";
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
  const { configPath } = await createRecapConfigFile();
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
  onTestFinished(() => readyRuntime.dispose(ctx));
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

  return {
    configPath,
    find,
    auth,
    tui,
    session,
    stream,
    ctx,
    host,
    runtime,
    controller,
    snapshots,
    render: () => component?.render(100).join("\n") ?? "",
  };
};

afterEach(() => vi.useRealTimers());

describe("turn recap runtime", () => {
  it("shows and persists stats before the recap arrives, then updates the same widget", async () => {
    vi.useFakeTimers();
    const response = Promise.withResolvers<AssistantMessage>();
    const env = await setup(() => response.promise);
    env.runtime.begin(env.ctx);
    expect(env.render()).toContain("Running");
    vi.advanceTimersByTime(1200);
    appendTurn(env.session, 1);
    const final = { ...fauxAssistantMessage("finished"), usage: sampleUsage() };
    env.session.appendMessage(final);
    env.runtime.refresh(env.ctx);
    expect(env.render()).toContain("370 processed");
    const project = env.ctx.sessionManager.buildSessionProjection.bind(env.ctx.sessionManager);

    const projection = vi
      .spyOn(env.ctx.sessionManager, "buildSessionProjection")
      .mockImplementation(() => {
        expect(env.snapshots()).toHaveLength(1);
        expect(env.render()).toContain("Completed");
        expect(env.runtime.view().running).toBe(false);
        vi.advanceTimersByTime(5000);
        expect(env.runtime.view().snapshot?.activeMs).toBe(1200);

        return project();
      });

    const completion = env.runtime.settled(env.ctx);
    expect(env.snapshots()).toHaveLength(1);
    expect(env.render()).toContain("1.2s active");
    expect(env.render()).toContain("Generating recap");
    const complete = { ...fauxAssistantMessage("Ready for review"), usage: sampleUsage() };
    response.resolve(complete);
    await completion;
    expect(projection).toHaveBeenCalledTimes(2);
    expect(env.render()).toContain("Ready for review");
    expect(env.snapshots()[0]?.runId).toBe(env.snapshots()[1]?.runId);
    expect(env.snapshots()[1]?.metrics.usage.input).toBe(100);
    env.runtime.toggle();
    expect(env.render()).toContain("Recap only: 370 tokens");
    await env.runtime.settled(env.ctx);
    expect(env.snapshots()).toHaveLength(2);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("keeps timing across retries, pauses blocking prompts, and ignores async prompts", async () => {
    vi.useFakeTimers();
    const env = await setup();
    await rm(env.configPath);
    await env.runtime.start(env.ctx);
    env.runtime.pause();
    env.runtime.begin(env.ctx);
    vi.advanceTimersByTime(1000);
    expect(env.render()).toContain("Waiting for you");
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
    expect(env.snapshots()[0]).toMatchObject({
      activeMs: 3000,
      wallMs: 7000,
      recap: { status: "off" },
    });
    expect(env.host.getNotifications()).toEqual([]);
    expect(env.stream).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
  });

  it.each(["completed", "aborted", "error"] as const)(
    "persists %s runs even without assistant output",
    async (outcome) => {
      const env = await setup();
      env.runtime.begin(env.ctx);
      env.runtime.boundary(boundary(outcome), env.ctx);
      await env.runtime.settled(env.ctx);
      expect(env.snapshots()[0]?.outcome).toBe(outcome);
    },
  );

  it("recognizes aborts after the before-settle notification", async () => {
    const env = await setup();
    env.runtime.begin(env.ctx);
    env.runtime.boundary(boundary("completed"), env.ctx);
    env.controller.abort();
    await env.runtime.settled(env.ctx);
    expect(env.snapshots()[0]?.outcome).toBe("aborted");
  });

  it("cancels pending generation on the next run and retains a labeled previous recap", async () => {
    const response = Promise.withResolvers<AssistantMessage>();

    const env = await setup(
      () => fauxAssistantMessage("Previous success"),
      () => response.promise,
    );

    env.runtime.begin(env.ctx);
    appendTurn(env.session, 1);
    await env.runtime.settled(env.ctx);
    expect(env.render()).toContain("Previous success");
    env.runtime.begin(env.ctx);
    expect(env.render()).toContain("Previous recap: Previous success");
    appendTurn(env.session, 2);
    const completion = env.runtime.settled(env.ctx);
    env.runtime.begin(env.ctx);
    expect(env.stream.mock.calls[1]?.[2]?.signal?.aborted).toBe(true);
    response.resolve(fauxAssistantMessage("Stale result"));
    await completion;
    expect(restoreSnapshots(env.session.getBranch()).current?.recap.status).toBe("cancelled");
    expect(env.render()).not.toContain("Stale result");
    expect(env.render()).toContain("Previous recap: Previous success");
    expect(env.snapshots()).toHaveLength(3);
  });

  it.each(["branch", "reload", "shutdown", "context"] as const)(
    "discards late results after %s changes",
    async (change) => {
      const response = Promise.withResolvers<AssistantMessage>();
      const env = await setup(() => response.promise);
      env.runtime.begin(env.ctx);
      appendTurn(env.session, 1);
      const assistantId = env.session.getLeafId();

      if (!assistantId) throw new Error("Missing assistant entry");
      const completion = env.runtime.settled(env.ctx);

      if (change === "branch") {
        env.session.branch(assistantId);
        env.runtime.restore(env.ctx);
      } else if (change === "reload") await env.runtime.start(env.ctx);
      else if (change === "shutdown") env.runtime.dispose(env.ctx);
      else env.session.appendContextEdit(assistantId, { content: "corrected answer" });
      const beforeSnapshots = env.snapshots();
      const beforeView = env.runtime.view();
      response.resolve(fauxAssistantMessage("Stale result"));
      await completion;

      if (change === "context") {
        expect(env.runtime.view().snapshot?.recap.status).toBe("cancelled");
      } else {
        expect(env.snapshots()).toEqual(beforeSnapshots);
        expect(env.runtime.view()).toEqual(beforeView);
      }

      expect(env.stream).toHaveBeenCalledTimes(1);
      expect(env.render()).not.toContain("Stale result");
      expect(env.snapshots().every((snapshot) => snapshot.recap.status !== "ready")).toBe(true);
      expect(env.host.getNotifications()).toEqual([]);
    },
  );

  it("restores the latest card and previous recap only from the selected branch", async () => {
    const env = await setup(
      () => fauxAssistantMessage("First recap"),
      () => fauxAssistantMessage("Second recap"),
    );

    env.runtime.begin(env.ctx);
    appendTurn(env.session, 1);
    await env.runtime.settled(env.ctx);
    expect(env.render()).toContain("First recap");
    const firstLeaf = env.session.getLeafId();

    if (!firstLeaf) throw new Error("Missing snapshot");
    env.runtime.begin(env.ctx);
    appendTurn(env.session, 2);
    await env.runtime.settled(env.ctx);
    expect(env.render()).toContain("Second recap");
    await env.runtime.start(env.ctx);
    expect(env.render()).toContain("Second recap");
    expect(env.runtime.view().previousRecap).toBe("First recap");
    env.session.branch(firstLeaf);
    env.runtime.restore(env.ctx);
    expect(env.render()).toContain("First recap");
    expect(env.runtime.view().previousRecap).toBeUndefined();
    expect(env.stream).toHaveBeenCalledTimes(2);
  });

  it("keeps stats when config is invalid, without falling back to the active model", async () => {
    const env = await setup();
    await writeFile(env.configPath, "{");
    await env.runtime.start(env.ctx);
    env.runtime.begin(env.ctx);
    appendTurn(env.session, 1);
    await env.runtime.settled(env.ctx);
    expect(env.snapshots()[0]?.recap.status).toBe("failed");
    expect(env.host.getNotifications()).toHaveLength(1);
    expect(env.stream).not.toHaveBeenCalled();
    expect(env.render()).toContain("Completed");
  });

  it.each(["missing", "invalid"])(
    "skips recap preparation but still refreshes context statistics with %s config",
    async (kind) => {
      const env = await setup();

      if (kind === "missing") await rm(env.configPath);
      else await writeFile(env.configPath, "{");
      await env.runtime.start(env.ctx);
      const project = vi.spyOn(env.ctx.sessionManager, "buildSessionProjection");
      const context = { tokens: 100, contextWindow: 1000, percent: 10 };

      // Pi's real context accounting also projects history; only recap preparation is skipped.
      const contextUsage = vi.spyOn(env.ctx, "getContextUsage").mockImplementation(() => {
        env.ctx.sessionManager.buildSessionProjection();

        return context;
      });

      env.runtime.begin(env.ctx);
      appendTurn(env.session, 1);
      await env.runtime.settled(env.ctx);
      expect(contextUsage).toHaveBeenCalledTimes(1);
      expect(project).toHaveBeenCalledTimes(1);
      expect(env.snapshots()[0]?.metrics.context).toEqual(context);
      expect(env.stream).not.toHaveBeenCalled();
      expect(env.snapshots()).toHaveLength(1);
      expect(env.render()).toContain("Completed");
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
    expect(env.runtime.view().snapshot?.recap).toMatchObject({
      status: "failed",
      error: "No credentials",
    });
    env.runtime.begin(env.ctx);
    appendTurn(env.session, 2);
    await env.runtime.settled(env.ctx);
    expect(env.runtime.view().snapshot?.recap).toMatchObject({
      status: "ready",
      text: "Authenticated",
    });
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
    expect(env.runtime.view().snapshot?.recap.status).toBe("failed");
    expect(env.stream).not.toHaveBeenCalled();
    env.runtime.begin(env.ctx);
    appendTurn(env.session, 2);
    await env.runtime.settled(env.ctx);
    expect(env.runtime.view().snapshot?.recap).toMatchObject({
      status: "ready",
      text: "Model available",
    });
  });

  it("keeps stats if optional prompt preparation fails", async () => {
    const env = await setup();
    vi.spyOn(env.ctx.sessionManager, "buildSessionProjection").mockImplementation(() => {
      throw new Error("Projection failed");
    });
    env.runtime.begin(env.ctx);
    appendTurn(env.session, 1);
    await env.runtime.settled(env.ctx);
    expect(env.snapshots()[0]?.recap.status).toBe("pending");
    expect(env.runtime.view().snapshot?.recap).toMatchObject({
      status: "failed",
      error: "Projection failed",
    });
    expect(env.render()).toContain("Completed");
    expect(env.stream).not.toHaveBeenCalled();
  });

  it("reads terminal height again after resizing", async () => {
    const env = await setup(() => fauxAssistantMessage("Ready"));
    env.runtime.begin(env.ctx);
    appendTurn(env.session, 1);
    await env.runtime.settled(env.ctx);
    env.runtime.toggle();
    expect(env.render().split("\n").length).toBeGreaterThan(3);
    Object.defineProperty(env.tui.terminal, "rows", { value: 6 });
    expect(env.render().split("\n")).toHaveLength(3);
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
    expect(env.render()).toContain("Recap unavailable");
    await env.runtime.settled(env.ctx);
    await vi.advanceTimersByTimeAsync(RECAP_REQUEST_TIMEOUT_MS);
    expect(env.stream).toHaveBeenCalledTimes(1);
    env.runtime.begin(env.ctx);
    appendTurn(env.session, 2);
    await env.runtime.settled(env.ctx);
    expect(env.render()).toContain("Recovered");
    response.resolve(fauxAssistantMessage("Late"));
    expect(env.snapshots()).toHaveLength(4);
  });

  it("records stats without mounting widgets or timers outside the TUI", async () => {
    vi.useFakeTimers();
    const env = await setup();
    const ctx = { ...env.ctx, mode: "json" as const };
    env.runtime.dispose(env.ctx);
    await env.runtime.start(ctx);
    env.runtime.begin(ctx);
    vi.advanceTimersByTime(1000);
    await env.runtime.settled(ctx);
    expect(env.render()).toBe("");
    expect(env.snapshots()[0]?.activeMs).toBe(1000);
    expect(vi.getTimerCount()).toBe(0);
  });
});
