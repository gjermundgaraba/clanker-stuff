import { mkdir, rm, writeFile } from "node:fs/promises";

import { fauxAssistantMessage, fauxProvider } from "@earendil-works/pi-ai";
import type { AssistantMessage } from "@earendil-works/pi-ai";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import type {
  ExtensionAPI,
  ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import type { Component } from "@earendil-works/pi-tui";
import { Value } from "typebox/value";
import {
  afterEach,
  describe,
  expect,
  it,
  onTestFinished,
  vi,
} from "vite-plus/test";

import { createExtensionHost } from "../../../../tests/harness/extension-host.js";
import {
  createIdentityTheme,
  createMockTui,
} from "../../../../tests/harness/tui.js";
import { renderCard } from "../card.js";
import {
  ENTRY_TYPE,
  RECAP_ENTRY_TYPE,
  RecapEntrySchema,
  SnapshotSchema,
} from "../entry.js";
import { getRollingFontDirectory, getRollingFontPath } from "../font.js";
import { RECAP_REQUEST_TIMEOUT_MS } from "../recap.js";
import { TurnRecapRuntime } from "../runtime.js";
import {
  appendTurn,
  createRecapConfigFile,
  queuedStream,
  sampleUsage,
  fontManifest,
  measuredResponse,
  userMessage,
} from "./fixtures.js";
import type { ResponseStep } from "./fixtures.js";

const setup = async (...responses: ResponseStep[]) => {
  const { configPath, directory } = await createRecapConfigFile();
  vi.stubEnv("PI_CODING_AGENT_DIR", directory);
  onTestFinished(() => {
    vi.unstubAllEnvs();
  });
  const session = SessionManager.inMemory();
  const stream = queuedStream(...responses);

  const model = fauxProvider({
    models: [{ id: "small" }],
    provider: "cheap",
  }).getModel();

  const find = vi.fn<ExtensionContext["modelRegistry"]["find"]>(() => model);

  const auth = vi.fn<ExtensionContext["modelRegistry"]["getApiKeyAndHeaders"]>(
    async () => {
      throw new Error("Authentication belongs to streamSimple");
    }
  );

  let api: ExtensionAPI | undefined;

  const host = createExtensionHost((pi) => {
    api = {
      ...pi,
      appendEntry: (type, data) => {
        session.appendCustomEntry(type, data);
      },
    };
  });

  await host.ready;

  if (!api) {
    throw new Error("Missing extension API");
  }

  const readyApi = api;
  const createRuntime = () => new TurnRecapRuntime(readyApi, configPath);
  let runtime = createRuntime();
  const tui = createMockTui();
  const theme = createIdentityTheme();
  let component: (Component & { dispose?: () => void }) | undefined;

  const ctx = host.createContext({
    sessionManager: session,
    modelRegistry: {
      find,
      getApiKeyAndHeaders: auth,
      streamSimple: stream,
    },
    ui: {
      setWidget: (_key, content) => {
        component?.dispose?.();
        component =
          typeof content === "function" ? content(tui, theme) : undefined;
      },
    },
  });

  onTestFinished(() => {
    runtime.shutdown(ctx);
  });

  const snapshots = () =>
    session
      .getBranch()
      .flatMap((entry) =>
        entry.type === "custom" &&
        entry.customType === ENTRY_TYPE &&
        Value.Check(SnapshotSchema, entry.data)
          ? [entry.data]
          : []
      );

  const recaps = () =>
    session
      .getEntries()
      .flatMap((entry) =>
        entry.type === "custom" &&
        entry.customType === RECAP_ENTRY_TYPE &&
        Value.Check(RecapEntrySchema, entry.data)
          ? [entry.data.recap]
          : []
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
    get runtime() {
      return runtime;
    },
    /** Pi's reload: the session's runtime shuts down and a new one starts over the same session. */
    reload: async () => {
      runtime.shutdown(ctx);
      runtime = createRuntime();
      await runtime.start(ctx);
    },
    snapshots,
    recaps,
    render: () => component?.render(100).join("\n") ?? "",
    // The latest card as the transcript draws it, recap looked up live.
    card: (expanded = false) => {
      const latest = snapshots().at(-1);

      return latest
        ? renderCard(
            latest,
            runtime.recap(latest.runId),
            100,
            theme,
            expanded
          ).join("\n")
        : "";
    },
  };
};

/** A runtime after Pi's session start, for tests that arrange nothing first. */
const started = async (...responses: ResponseStep[]) => {
  const env = await setup(...responses);
  await env.runtime.start(env.ctx);

  return env;
};

const glyph = String.fromCodePoint(0xf_10_04);

const installFont = async (manifest: unknown = fontManifest()) => {
  await mkdir(getRollingFontDirectory(), { recursive: true });
  await writeFile(getRollingFontPath(), JSON.stringify(manifest));
};

describe("turn recap runtime", () => {
  afterEach(() => vi.useRealTimers());

  it("rolls live digits whenever a font manifest exists", async () => {
    vi.useFakeTimers();
    const env = await setup();
    await installFont();
    await env.runtime.start(env.ctx);
    env.runtime.begin(env.ctx);
    expect(env.render()).toContain("0s elapsed");
    vi.advanceTimersByTime(1000);
    env.render();
    vi.advanceTimersByTime(130);
    expect(env.render()).toContain(`${glyph}s elapsed`);
    vi.advanceTimersByTime(370);
    expect(env.render()).toContain("1s elapsed");

    expect(env.host.getNotifications()).toStrictEqual([]);
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
    expect(env.render()).toContain("1s elapsed");
    appendTurn(env.session, 1);
    await env.runtime.settled({ aborted: false }, env.ctx);

    // Same digit width, so carried-over history would roll 1s back down to 0s.
    env.runtime.begin(env.ctx);
    expect(env.render()).toContain("0s elapsed");
    vi.advanceTimersByTime(130);
    expect(env.render()).toContain("0s elapsed");
  });

  it.each<{
    kind: string;
    manifest: { version: number } | undefined;
    notifications: Array<{ message: unknown; type: string }>;
  }>([
    { kind: "missing", manifest: undefined, notifications: [] },
    {
      kind: "invalid",
      manifest: { version: 1 },
      notifications: [
        {
          message: expect.stringContaining("Rolling numbers disabled"),
          type: "error",
        },
      ],
    },
  ])(
    "keeps recaps working with a $kind font manifest",
    async ({ manifest, notifications }) => {
      vi.useFakeTimers();
      const env = await setup(() => fauxAssistantMessage("Recap still works"));

      if (manifest !== undefined) {
        await installFont(manifest);
      }

      await env.runtime.start(env.ctx);
      env.runtime.begin(env.ctx);
      vi.advanceTimersByTime(1000);
      expect(env.render()).toContain("1s elapsed");
      expect(env.host.getNotifications()).toStrictEqual(notifications);

      appendTurn(env.session, 1);
      await env.runtime.settled({ aborted: false }, env.ctx);
      expect(env.card()).toContain("Recap still works");
    }
  );

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
    expect(env.render()).toContain(`${glyph}s elapsed`);
    appendTurn(env.session, 1);
    await env.runtime.settled({ aborted: false }, env.ctx);
    expect(env.snapshots()).toHaveLength(1);
    expect(env.recaps()).toStrictEqual([]);
    expect(env.host.getNotifications()).toHaveLength(1);
    expect(env.host.getNotifications()[0]?.message).toContain(
      "generated recaps disabled"
    );
    expect(env.stream).not.toHaveBeenCalled();
  });

  it("writes the card when the run settles and fills in its recap when it arrives", async () => {
    vi.useFakeTimers();
    const response = Promise.withResolvers<AssistantMessage>();
    const env = await started(async () => await response.promise);
    expect(env.render()).toBe("");
    env.runtime.begin(env.ctx);
    expect(env.render()).toContain("0s elapsed");
    vi.advanceTimersByTime(1200);
    appendTurn(env.session, 1);
    env.session.appendMessage({
      ...fauxAssistantMessage("finished"),
      usage: sampleUsage(),
    });
    env.runtime.refresh(env.ctx);
    expect(env.render()).toContain("370 processed");
    const completion = env.runtime.settled({ aborted: false }, env.ctx);
    expect(env.render()).toBe("");
    expect(env.snapshots()).toHaveLength(1);
    expect(env.snapshots()[0]).toMatchObject({
      wallMs: 1200,
      metrics: { usage: { input: 100 } },
    });
    expect(env.card()).toContain("Generating recap…");
    expect(env.card()).toContain("370 processed");
    vi.advanceTimersByTime(5000);
    response.resolve({
      ...fauxAssistantMessage("Ready for review"),
      usage: sampleUsage(),
    });
    await completion;
    expect(env.snapshots()).toHaveLength(1);
    expect(env.recaps()).toMatchObject([
      { status: "ready", text: "Ready for review" },
    ]);
    expect(env.card()).toContain("Ready for review");
    expect(env.card()).not.toContain("Generating");
    expect(env.card(true)).toContain("Recap only: 370 tokens");
    expect(vi.getTimerCount()).toBe(0);
  });

  it("restores recaps into their cards after a reload", async () => {
    const env = await started(() => fauxAssistantMessage("Restored recap"));
    env.runtime.begin(env.ctx);
    appendTurn(env.session, 1);
    await env.runtime.settled({ aborted: false }, env.ctx);
    await env.reload();
    expect(env.card()).toContain("Restored recap");
  });

  it("keeps timing across retries", async () => {
    vi.useFakeTimers();
    const env = await setup();
    await rm(env.configPath);
    await env.runtime.start(env.ctx);
    env.runtime.begin(env.ctx);
    vi.advanceTimersByTime(3000);
    env.runtime.begin(env.ctx);
    vi.advanceTimersByTime(4000);
    await env.runtime.settled({ aborted: false }, env.ctx);
    expect(env.snapshots()).toHaveLength(1);
    expect(env.snapshots()[0]).toMatchObject({ wallMs: 7000 });
    expect(env.recaps()).toStrictEqual([]);
    expect(env.host.getNotifications()).toStrictEqual([]);
    expect(env.stream).not.toHaveBeenCalled();
    expect(env.render()).toBe("");
    expect(vi.getTimerCount()).toBe(0);
  });

  it.each(["completed", "aborted", "error"] as const)(
    "writes a %s run without a recap when there is nothing to recap",
    async (outcome) => {
      const env = await started();
      env.runtime.begin(env.ctx);
      env.runtime.boundary({ outcome }, env.ctx);
      await env.runtime.settled({ aborted: false }, env.ctx);
      expect(env.snapshots()[0]?.outcome).toBe(outcome);
      expect(env.card()).not.toContain("Generating");
      expect(env.recaps()).toStrictEqual([]);
      expect(env.stream).not.toHaveBeenCalled();
    }
  );

  it("measures growth from the size reported before the run, from +0 on the first frame", async () => {
    const env = await setup();
    await rm(env.configPath);
    await env.runtime.start(env.ctx);
    env.session.appendMessage(measuredResponse(5000));
    env.runtime.begin(env.ctx);
    expect(env.render()).toContain("+0 context");
    env.session.appendMessage(userMessage("request"));
    env.session.appendMessage(measuredResponse(9920));
    await env.runtime.settled({ aborted: false }, env.ctx);
    expect(env.snapshots()[0]?.metrics.contextGrowth).toBe(4920);
    expect(env.card()).toContain("+4.9k context");
  });

  it("takes Pi's abort over a last turn that completed", async () => {
    const env = await started();
    env.runtime.begin(env.ctx);
    env.runtime.boundary({ outcome: "completed" }, env.ctx);
    await env.runtime.settled({ aborted: true }, env.ctx);
    expect(env.snapshots()[0]?.outcome).toBe("aborted");
  });

  it("lets a pending recap finish across later runs and fills in its own card", async () => {
    const first = Promise.withResolvers<AssistantMessage>();

    const env = await started(
      async () => await first.promise,
      () => fauxAssistantMessage("Second recap")
    );

    env.runtime.begin(env.ctx);
    appendTurn(env.session, 1);
    const pending = env.runtime.settled({ aborted: false }, env.ctx);
    env.runtime.begin(env.ctx);
    appendTurn(env.session, 2);
    await env.runtime.settled({ aborted: false }, env.ctx);
    expect(env.stream.mock.calls[0]?.[2]?.signal?.aborted).toBe(false);

    const [earlier, later] = env.snapshots();

    if (!earlier || !later) {
      throw new Error("Missing cards");
    }

    expect(env.runtime.recap(earlier.runId)).toStrictEqual({
      status: "generating",
    });
    expect(env.runtime.recap(later.runId)).toMatchObject({
      text: "Second recap",
    });
    first.resolve(fauxAssistantMessage("First recap"));
    await pending;
    expect(env.runtime.recap(earlier.runId)).toMatchObject({
      text: "First recap",
    });
    expect(env.recaps()).toHaveLength(2);
  });

  it("abandons pending recaps on shutdown, leaving their cards without one", async () => {
    const response = Promise.withResolvers<AssistantMessage>();
    const env = await started(async () => await response.promise);
    env.runtime.begin(env.ctx);
    appendTurn(env.session, 1);
    const completion = env.runtime.settled({ aborted: false }, env.ctx);
    const cards = env.snapshots();
    env.runtime.shutdown(env.ctx);
    expect(env.stream.mock.calls[0]?.[2]?.signal?.aborted).toBe(true);
    response.resolve(fauxAssistantMessage("Stale result"));
    await completion;
    expect(env.snapshots()).toStrictEqual(cards);
    expect(env.recaps()).toStrictEqual([]);
    expect(env.host.getNotifications()).toStrictEqual([]);
  });

  it.each(["missing", "invalid"])(
    "skips recap preparation but still refreshes context statistics with %s config",
    async (kind) => {
      const env = await setup();

      await (kind === "missing"
        ? rm(env.configPath)
        : writeFile(env.configPath, "{"));

      await env.runtime.start(env.ctx);

      const project = vi.spyOn(
        env.ctx.sessionManager,
        "buildSessionProjection"
      );

      const start = { tokens: 60, contextWindow: 1000, percent: 6 };
      const context = { tokens: 100, contextWindow: 1000, percent: 10 };

      // Pi's real context accounting also projects history; only recap preparation is skipped.
      const contextUsage = vi
        .spyOn(env.ctx, "getContextUsage")
        .mockImplementation(() => {
          env.ctx.sessionManager.buildSessionProjection();

          return contextUsage.mock.calls.length === 1 ? start : context;
        });

      env.runtime.begin(env.ctx);
      appendTurn(env.session, 1);
      await env.runtime.settled({ aborted: false }, env.ctx);
      expect(contextUsage).toHaveBeenCalledTimes(2);
      expect(project).toHaveBeenCalledTimes(2);
      expect(env.snapshots()[0]?.metrics.context).toStrictEqual(context);
      expect(env.recaps()).toStrictEqual([]);
      expect(env.stream).not.toHaveBeenCalled();
    }
  );

  it("recovers from request-time authentication failure without reinitialization", async () => {
    const env = await started(
      () => {
        throw new Error("No credentials");
      },
      () => fauxAssistantMessage("Authenticated")
    );

    expect(env.find).not.toHaveBeenCalled();
    expect(env.auth).not.toHaveBeenCalled();
    env.runtime.begin(env.ctx);
    appendTurn(env.session, 1);
    await env.runtime.settled({ aborted: false }, env.ctx);
    expect(env.recaps().at(-1)).toMatchObject({
      status: "failed",
      error: "No credentials",
    });
    env.runtime.begin(env.ctx);
    appendTurn(env.session, 2);
    await env.runtime.settled({ aborted: false }, env.ctx);
    expect(env.recaps().at(-1)).toMatchObject({
      status: "ready",
      text: "Authenticated",
    });
    expect(env.find).toHaveBeenCalledTimes(2);
    expect(env.auth).not.toHaveBeenCalled();
    expect(env.host.getNotifications()).toStrictEqual([]);
  });

  it("re-resolves models on each request and recovers when a model becomes available", async () => {
    const env = await started(() => fauxAssistantMessage("Model available"));
    env.find.mockReturnValueOnce(undefined);
    env.runtime.begin(env.ctx);
    appendTurn(env.session, 1);
    await env.runtime.settled({ aborted: false }, env.ctx);
    expect(env.recaps().at(-1)?.status).toBe("failed");
    expect(env.stream).not.toHaveBeenCalled();
    env.runtime.begin(env.ctx);
    appendTurn(env.session, 2);
    await env.runtime.settled({ aborted: false }, env.ctx);
    expect(env.recaps().at(-1)).toMatchObject({
      status: "ready",
      text: "Model available",
    });
  });

  it("keeps the card if optional prompt preparation fails", async () => {
    const env = await started();
    vi.spyOn(
      env.ctx.sessionManager,
      "buildSessionProjection"
    ).mockImplementation(() => {
      throw new Error("Projection failed");
    });
    env.runtime.begin(env.ctx);
    appendTurn(env.session, 1);
    await env.runtime.settled({ aborted: false }, env.ctx);
    expect(env.snapshots()).toHaveLength(1);
    expect(env.recaps()).toStrictEqual([
      { status: "failed", error: "Projection failed" },
    ]);
    expect(env.card()).toContain("Recap unavailable: Projection failed");
    expect(env.stream).not.toHaveBeenCalled();
  });

  it("bounds persisted failure text", async () => {
    const env = await started(() => {
      throw new Error("failure ".repeat(10_000));
    });

    env.runtime.begin(env.ctx);
    appendTurn(env.session, 1);
    await env.runtime.settled({ aborted: false }, env.ctx);
    const [recap] = env.recaps();

    expect(recap?.status === "failed" && Array.from(recap.error).length).toBe(
      1000
    );
  });

  it("times out without retrying and recovers on the next run", async () => {
    vi.useFakeTimers();
    const response = Promise.withResolvers<AssistantMessage>();

    const env = await started(
      async () => await response.promise,
      () => fauxAssistantMessage("Recovered")
    );

    env.runtime.begin(env.ctx);
    appendTurn(env.session, 1);
    const completion = env.runtime.settled({ aborted: false }, env.ctx);
    await vi.advanceTimersByTimeAsync(RECAP_REQUEST_TIMEOUT_MS);
    await completion;
    expect(env.card()).toContain("Recap unavailable");
    env.runtime.begin(env.ctx);
    appendTurn(env.session, 2);
    await env.runtime.settled({ aborted: false }, env.ctx);
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
    await env.runtime.settled({ aborted: false }, ctx);
    expect(env.render()).toBe("");
    expect(env.snapshots()[0]?.wallMs).toBe(1000);
    expect(vi.getTimerCount()).toBe(0);
  });
});
