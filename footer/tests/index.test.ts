import type { Api, Model } from "@earendil-works/pi-ai";
import type {
  ExtensionContext,
  ReadonlyFooterDataProvider,
} from "@earendil-works/pi-coding-agent";
import { afterEach, describe, expect, it, vi } from "vitest";

import { createExtensionHost } from "../../tests/harness/extension-host.js";
import { createIdentityTheme, createMockTui } from "../../tests/harness/tui.js";
import type { ProviderAuthClient } from "../auth.js";
import type { GitStatus } from "../git.js";
import type { FetchJson } from "../http.js";
import { createFooterExtension } from "../index.js";
import { absent } from "./adapters/helpers.js";

const makeJwt = (accountId: string): string => {
  const header = Buffer.from(JSON.stringify({ alg: "none" })).toString(
    "base64url"
  );
  const body = Buffer.from(
    JSON.stringify({
      "https://api.openai.com/auth": { chatgpt_account_id: accountId },
    })
  ).toString("base64url");
  return `${header}.${body}.sig`;
};

const model = (id: string, provider: string): Model<Api> => ({
  api: "test",
  baseUrl: "",
  contextWindow: 200_000,
  cost: { cacheRead: 0, cacheWrite: 0, input: 0, output: 0 },
  id,
  input: ["text"],
  maxTokens: 16_000,
  name: id,
  provider,
  reasoning: true,
});

const codexModel = model("gpt-5", "openai-codex");
const xaiModel = model("grok-4", "xai");
const goModel = model("go", "opencode-go");

const codexPayload = {
  rate_limit: {
    primary_window: { used_percent: 32 },
    secondary_window: { used_percent: 34 },
  },
};

const xaiPayload = {
  config: { monthlyLimit: 100, used: 10 },
};

const codexBarUsageJson = JSON.stringify([
  {
    plan: "Pro",
    provider: "opencodego",
    usage: {
      primary: { usedPercent: 40 },
      secondary: { usedPercent: 55 },
    },
  },
]);

const defaultFetch: FetchJson = async (url) => {
  if (url.includes("chatgpt.com")) {
    return { json: codexPayload, ok: true };
  }
  if (url.includes("cli-chat-proxy.grok.com")) {
    return { json: xaiPayload, ok: true };
  }
  return { message: "HTTP 404", ok: false };
};

const scopedAuthClient = (providers: string[]): ProviderAuthClient => ({
  getProviderAuth: async (provider) =>
    providers.includes(provider)
      ? {
          auth: { apiKey: makeJwt("acct_1") },
          source: "OAuth",
        }
      : undefined,
});

const noAuthClient: ProviderAuthClient = {
  getProviderAuth: absent,
};

type FooterFactory = NonNullable<
  Parameters<ExtensionContext["ui"]["setFooter"]>[0]
>;

const captureFooter = () => {
  let factory: FooterFactory | undefined;
  const setFooter: ExtensionContext["ui"]["setFooter"] = (next) => {
    factory = next;
  };
  return {
    getFactory: () => factory,
    ui: { setFooter },
  };
};

const footerData: ReadonlyFooterDataProvider = {
  getAvailableProviderCount: () => 0,
  getExtensionStatuses: () => new Map(),
  getGitBranch: () => null,
  onBranchChange: () => () => {},
};

const renderWith = (factory: FooterFactory | undefined, width = 120) => {
  if (factory === undefined) {
    throw new Error("Footer was not installed");
  }

  const tui = createMockTui();
  const requestRender = vi.spyOn(tui, "requestRender");
  const component = factory(tui, createIdentityTheme(), footerData);
  return {
    lines: () => component.render(width),
    requestRender,
    text: () => component.render(width).join("\n"),
  };
};

const setup = (
  options: {
    authClient?: ProviderAuthClient;
    discover?: () => Promise<string | undefined>;
    exec?: () => Promise<{ code: number; stdout: string; stderr: string }>;
    fetchImpl?: FetchJson;
    model?: Model<Api>;
    now?: () => number;
    runGitStatus?: () => Promise<GitStatus | null>;
  } = {}
) => {
  const fetchJson = vi.fn<FetchJson>(options.fetchImpl ?? defaultFetch);
  const now = options.now ?? (() => 1000);
  const extension = createFooterExtension({
    authClientFromContext: () =>
      options.authClient ?? scopedAuthClient(["openai-codex", "xai"]),
    discoverCodexBar: options.discover ?? absent,
    execCodexBar:
      options.exec ??
      (async () => ({ code: 1, stderr: "missing", stdout: "" })),
    fetchJson,
    now,
    runGitStatus: options.runGitStatus ?? (async () => null),
  });

  const host = createExtensionHost(extension, {
    model: options.model ?? codexModel,
  });

  return { fetchJson, host };
};

describe("footer extension", () => {
  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it("installs the footer and renders usage once the fetch completes", async () => {
    const { host } = setup();
    const footer = captureFooter();
    const ctx = host.createContext({ model: codexModel, ui: footer.ui });
    await host.emitSessionStart(ctx);

    const view = renderWith(footer.getFactory());
    expect(view.text()).toContain("gpt-5");
    await vi.waitFor(() => {
      expect(view.text()).toContain("Codex");
    });
    expect(view.text()).toContain("32%");
  });

  it("does not run footer work outside TUI mode", async () => {
    const runGitStatus = vi.fn<() => Promise<null>>(async () => null);
    const { fetchJson, host } = setup({ runGitStatus });
    const footer = captureFooter();
    const ctx = host.createContext({
      hasUI: false,
      mode: "print",
      model: codexModel,
      ui: footer.ui,
    });

    await host.emitSessionStart(ctx);
    await host.emit(
      "model_select",
      {
        model: codexModel,
        previousModel: undefined,
        source: "set",
        type: "model_select",
      },
      ctx
    );
    await host.emit("agent_settled", { type: "agent_settled" }, ctx);
    await host.emitTurnEnd(undefined, ctx);

    expect(footer.getFactory()).toBeUndefined();
    expect(fetchJson).not.toHaveBeenCalled();
    expect(runGitStatus).not.toHaveBeenCalled();
  });

  it("renders the git branch once the status resolves", async () => {
    const { host } = setup({
      runGitStatus: async () => ({
        ahead: 0,
        behind: 0,
        branch: "main",
        dirty: false,
      }),
    });
    const footer = captureFooter();
    const ctx = host.createContext({ model: codexModel, ui: footer.ui });
    await host.emitSessionStart(ctx);

    const view = renderWith(footer.getFactory());
    await vi.waitFor(() => {
      expect(view.text()).toContain("main");
    });
  });

  it("refreshes git once when a turn settles", async () => {
    const runGitStatus = vi.fn<() => Promise<null>>(async () => null);
    const { host } = setup({ runGitStatus });
    const footer = captureFooter();
    const ctx = host.createContext({ model: codexModel, ui: footer.ui });
    await host.emitSessionStart(ctx);
    runGitStatus.mockClear();

    await host.emitTurnEnd(undefined, ctx);
    await host.emit("agent_settled", { type: "agent_settled" }, ctx);

    expect(runGitStatus).toHaveBeenCalledOnce();
  });

  it("ignores a late response after model_select changes provider", async () => {
    const { promise: codexGate, resolve: releaseCodex } =
      Promise.withResolvers<boolean>();
    let codexCompleted = false;

    const { host } = setup({
      fetchImpl: async (url) => {
        if (url.includes("chatgpt.com")) {
          await codexGate;
          codexCompleted = true;
          return { json: codexPayload, ok: true };
        }
        return { json: xaiPayload, ok: true };
      },
    });

    const footer = captureFooter();
    const codexCtx = host.createContext({ model: codexModel, ui: footer.ui });
    await host.emitSessionStart(codexCtx);
    const view = renderWith(footer.getFactory());

    const xaiCtx = host.createContext({ model: xaiModel });
    await host.emit(
      "model_select",
      {
        model: xaiModel,
        previousModel: codexModel,
        source: "set",
        type: "model_select",
      },
      xaiCtx
    );

    await vi.waitFor(() => {
      expect(view.text()).toContain("Grok");
    });

    const afterXai = view.text();
    releaseCodex(true);
    await vi.waitFor(() => {
      expect(codexCompleted).toBeTruthy();
    });

    expect(view.text()).toBe(afterXai);
    expect(view.text()).not.toContain("Codex");
  });

  it("keeps the previous usage when a refresh fails", async () => {
    const { promise: refreshGate, resolve: releaseRefresh } =
      Promise.withResolvers<boolean>();
    let shouldFail = false;
    let now = 1000;
    const { host } = setup({
      fetchImpl: async () => {
        if (shouldFail) {
          await refreshGate;
          return { message: "HTTP 500", ok: false };
        }
        return { json: codexPayload, ok: true };
      },
      now: () => now,
    });

    const footer = captureFooter();
    const ctx = host.createContext({ model: codexModel, ui: footer.ui });
    await host.emitSessionStart(ctx);
    const view = renderWith(footer.getFactory());
    await vi.waitFor(() => {
      expect(view.text()).toContain("Codex");
    });
    const first = view.text();

    shouldFail = true;
    now = 61_000;
    await host.emit("agent_settled", { type: "agent_settled" }, ctx);
    const rendersBeforeRefresh = view.requestRender.mock.calls.length;
    releaseRefresh(true);
    await vi.waitFor(() => {
      expect(view.requestRender.mock.calls.length).toBeGreaterThan(
        rendersBeforeRefresh
      );
    });

    expect(view.text()).toBe(first);
  });

  it("refreshes usage on the interval and stops the timer on shutdown", async () => {
    vi.useFakeTimers();
    try {
      const { host, fetchJson } = setup({ now: () => Date.now() });
      const footer = captureFooter();
      const ctx = host.createContext({ model: codexModel, ui: footer.ui });
      await host.emitSessionStart(ctx);
      renderWith(footer.getFactory());
      await vi.advanceTimersByTimeAsync(10);
      const initial = fetchJson.mock.calls.length;
      expect(initial).toBeGreaterThan(0);

      await vi.advanceTimersByTimeAsync(5 * 60_000 + 1000);
      expect(fetchJson.mock.calls.length).toBeGreaterThan(initial);

      await host.emitSessionShutdown(ctx);
      const atShutdown = fetchJson.mock.calls.length;
      await vi.advanceTimersByTimeAsync(15 * 60_000);
      expect(fetchJson).toHaveBeenCalledTimes(atShutdown);
    } finally {
      vi.useRealTimers();
    }
  });

  it("rejects invalid /usage args without fetching", async () => {
    const { host, fetchJson } = setup();
    const ctx = host.createContext({ model: codexModel });
    await host.runCommand("usage", "nope", ctx);
    expect(host.getNotifications()[0]?.message).toMatch(/^usage: expected/u);
    expect(fetchJson).not.toHaveBeenCalled();
  });

  it("prints detail for all available providers on bare /usage", async () => {
    const discover = vi.fn<() => Promise<string>>(
      async () => "/usr/local/bin/codexbar"
    );
    const { host } = setup({
      discover,
      exec: async () => ({
        code: 0,
        stderr: "",
        stdout: codexBarUsageJson,
      }),
    });
    const footer = captureFooter();
    const theme = Object.assign(createIdentityTheme(), {
      bold: (text: string) => `<bold>${text}</bold>`,
    });
    const ctx = host.createContext({
      model: codexModel,
      ui: { ...footer.ui, theme },
    });
    await host.emitSessionStart(ctx);
    const view = renderWith(footer.getFactory());

    await host.runCommand("usage", "", ctx);
    const message = host.getNotifications()[0]?.message ?? "";
    expect(
      [
        "<bold>Codex</bold>",
        "<bold>Grok</bold>",
        "<bold>OpenCode Go (Pro)</bold>",
        "% left",
      ].every((fragment) => message.includes(fragment))
    ).toBeTruthy();
    expect(view.text()).toContain("Codex");
    expect(discover).toHaveBeenCalledOnce();
  });

  it("omits opencode-go from bare /usage when CodexBar is missing", async () => {
    const { host } = setup({
      discover: absent,
      model: codexModel,
    });
    const ctx = host.createContext({ model: codexModel });
    await host.runCommand("usage", "", ctx);
    const message = host.getNotifications()[0]?.message ?? "";
    expect(message).toContain("Codex");
    expect(message).toContain("Grok");
    expect(message).not.toContain("OpenCode Go");
  });

  it("reports no available providers for bare /usage when none are available", async () => {
    const { host, fetchJson } = setup({
      authClient: noAuthClient,
      discover: absent,
      model: xaiModel,
    });
    const ctx = host.createContext({ model: xaiModel });
    await host.runCommand("usage", "", ctx);
    expect(host.getNotifications()[0]?.message).toBe(
      "usage: no supported providers are available (log in to a supported provider; opencode-go also requires CodexBar)"
    );
    expect(fetchJson).not.toHaveBeenCalled();
  });

  it("shows opencode-go usage in the footer when CodexBar is available", async () => {
    const { host } = setup({
      discover: async () => "/usr/local/bin/codexbar",
      exec: async () => ({
        code: 0,
        stderr: "",
        stdout: codexBarUsageJson,
      }),
      model: goModel,
    });
    const footer = captureFooter();
    const ctx = host.createContext({ model: goModel, ui: footer.ui });
    await host.emitSessionStart(ctx);

    const view = renderWith(footer.getFactory());
    await vi.waitFor(() => {
      expect(view.text()).toContain("OpenCode Go");
    });
  });
});
