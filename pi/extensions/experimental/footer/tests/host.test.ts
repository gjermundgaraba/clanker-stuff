import type { Usage } from "@earendil-works/pi-ai";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { stripTerminalSequences } from "@earendil-works/pi-tui";
import { describe, expect, it, vi } from "vite-plus/test";

import { createExtensionHost } from "../../../../tests/harness/extension-host.js";
import {
  createIdentityTheme,
  createKeybindings,
  createMockTui,
} from "../../../../tests/harness/tui.js";
import { DEFAULT_CONFIG, formatFooterConfig } from "../config.js";
import type { FooterConfig, FooterConfigStore } from "../config.js";
import type { GitDetails } from "../git.js";
import footerExtension from "../index.js";
import { editorTheme, sessionReads } from "./helpers.js";

type FooterFactory = NonNullable<Parameters<ExtensionContext["ui"]["setFooter"]>[0]>;

type EditorFactory = NonNullable<ReturnType<ExtensionContext["ui"]["getEditorComponent"]>>;

const DETAILS: GitDetails = { ahead: 0, behind: 0, staged: 0, unstaged: 2, untracked: 0 };

const withRows = (rows: FooterConfig["rows"], border: string[] = []): FooterConfig => ({
  ...DEFAULT_CONFIG,
  border,
  rows,
});

interface StartOptions {
  config?: FooterConfig;
  branch?: string | null;
  readGit?: () => Promise<GitDetails>;
  session?: SessionManager;
  ui?: Partial<ExtensionContext["ui"]>;
}

const start = async (options: StartOptions = {}) => {
  const statuses = new Map<string, string>();
  const branchListeners = new Set<() => void>();
  const save = vi.fn<FooterConfigStore["save"]>(async () => {});
  const readGit = vi.fn(options.readGit ?? (async () => await Promise.resolve(DETAILS)));
  const setFooter = vi.fn<ExtensionContext["ui"]["setFooter"]>();
  let component: ReturnType<FooterFactory> | undefined;

  const store: FooterConfigStore = {
    load: async () => await Promise.resolve({ config: options.config ?? DEFAULT_CONFIG }),
    path: "/tmp/footer.json",
    save,
  };

  const footerData = {
    getAvailableProviderCount: () => 1,
    getExtensionStatuses: () => statuses,
    getGitBranch: () => (options.branch === undefined ? "main" : options.branch),
    onBranchChange: (listener: () => void) => {
      branchListeners.add(listener);

      return () => branchListeners.delete(listener);
    },
  };

  const host = createExtensionHost((pi) => footerExtension(pi, store, readGit));

  const ctx = host.createContext({
    cwd: "/tmp/project",
    sessionManager: sessionReads(options.session ?? SessionManager.inMemory()),
    ui: {
      setFooter: (factory) => {
        setFooter(factory);
        component = factory?.(createMockTui(), createIdentityTheme(), footerData);
      },
      ...options.ui,
    },
  });

  await host.emitSessionStart(ctx);
  // Let the asynchronous Git scan settle.
  await Promise.resolve();

  const editor = () => {
    const factory = host.getEditorFactory();

    if (!factory) throw new Error("No editor installed");

    return factory(createMockTui(), editorTheme, createKeybindings());
  };

  return {
    border: () => stripTerminalSequences(editor().render(60)[0] ?? ""),
    ctx,
    host,
    readGit,
    render: (width = 160) => stripTerminalSequences(component?.render(width).join("\n") ?? ""),
    save,
    setFooter,
    statuses,
  };
};

describe("footer host", () => {
  it("refreshes built-in values while rendering, re-reading the session only when its leaf moves", async () => {
    const session = SessionManager.inMemory();
    const getEntries = vi.spyOn(session, "getEntries");

    const footer = await start({
      config: withRows([{ left: ["footer.session"], right: [] }]),
      session,
    });

    expect(footer.render()).toContain("in 0 out 0");

    const usage: Usage = {
      cacheRead: 50_000,
      cacheWrite: 0,
      cost: { cacheRead: 0.015, cacheWrite: 0, input: 0, output: 0, total: 0.015 },
      input: 0,
      output: 1,
      totalTokens: 50_001,
    };

    // Idle appends such as cache warming emit no extension event.
    session.appendUsage("cache_warm", "anthropic", "test", usage);
    expect(footer.render()).toContain("cache 50k/0 $0.01");

    const reads = getEntries.mock.calls.length;
    footer.render();
    expect(getEntries).toHaveBeenCalledTimes(reads);
  });

  it("names the branch from Pi's footer data without scanning the working tree", async () => {
    const footer = await start();

    expect(footer.render()).toContain("main");
    expect(footer.readGit).not.toHaveBeenCalled();
  });

  it("scans for placed details only inside a repository and again after each turn", async () => {
    const config = withRows([{ left: ["footer.git", "footer.git.details"], right: [] }]);
    const footer = await start({ config });

    expect(footer.readGit).toHaveBeenCalledWith(expect.anything(), "/tmp/project");
    expect(footer.render()).toContain("main · ~2");

    await footer.host.emitTurnEnd({}, footer.ctx);
    expect(footer.readGit).toHaveBeenCalledTimes(2);

    expect((await start({ branch: null, config })).readGit).not.toHaveBeenCalled();
  });

  it("reports a failed scan instead of showing a clean tree", async () => {
    const footer = await start({
      config: withRows([{ left: ["footer.git.details"], right: [] }]),
      readGit: async () => {
        await Promise.resolve();
        throw new Error("git status timed out after 1000ms");
      },
    });

    await footer.host.runCommand("footer", "inspect", footer.ctx);

    expect(footer.host.getNotifications().at(-1)?.message).toContain(
      "error: git status timed out after 1000ms",
    );
  });

  it("draws border statuses into the editor top border and keeps them out of footer.statuses", async () => {
    const footer = await start();
    footer.statuses.set("vim", "NORMAL");
    footer.statuses.set("other", "elsewhere");

    expect(footer.border()).toContain("NORMAL ─");
    expect(footer.render()).toContain("elsewhere");
    expect(footer.render()).not.toContain("NORMAL");

    await footer.host.emitSessionShutdown(footer.ctx);

    expect(footer.border()).not.toContain("NORMAL");
    // Pi removes the custom footer itself after shutdown handlers.
    expect(footer.setFooter).not.toHaveBeenCalledWith(undefined);
  });

  it("lists border statuses in footer.statuses while another editor owns the border", async () => {
    const footer = await start({ ui: { getEditorComponent: () => vi.fn<EditorFactory>() } });
    footer.statuses.set("vim", "NORMAL");

    expect(footer.render()).toContain("NORMAL");

    await footer.host.runCommand("footer", "inspect", footer.ctx);

    expect(footer.host.getNotifications().at(-1)?.message).toContain(
      "status:vim · footer.statuses: NORMAL",
    );
  });

  it("lists border statuses in footer.statuses after another editor takes over", async () => {
    const footer = await start();
    footer.statuses.set("vim", "NORMAL");

    expect(footer.render()).not.toContain("NORMAL");

    footer.ctx.ui.setEditorComponent(vi.fn<EditorFactory>());

    expect(footer.render()).toContain("NORMAL");

    await footer.host.runCommand("footer", "inspect", footer.ctx);

    expect(footer.host.getNotifications().at(-1)?.message).toContain(
      "status:vim · footer.statuses: NORMAL",
    );
  });

  it("draws a built-in placed in the border, and hides it while another editor owns the border", async () => {
    const footer = await start({
      config: withRows([{ left: ["footer.cwd"], right: [] }], ["footer.git"]),
    });

    expect(footer.border()).toContain("main ─");
    expect(footer.render()).not.toContain("main");

    footer.ctx.ui.setEditorComponent(vi.fn<EditorFactory>());
    await footer.host.runCommand("footer", "inspect", footer.ctx);

    expect(footer.render()).not.toContain("main");
    expect(footer.host.getNotifications().at(-1)?.message).toContain("footer.git · not placed");
  });

  it("reopens invalid JSON with the user's text, then saves and applies the edit", async () => {
    const valid = formatFooterConfig(withRows([{ left: ["footer.cwd"], right: [] }]));
    const prefills: (string | undefined)[] = [];
    const replies = ["{ broken", valid];

    const footer = await start({
      ui: {
        editor: async (_title, prefill) => {
          prefills.push(prefill);

          return await Promise.resolve(replies.shift());
        },
      },
    });

    await footer.host.runCommand("footer", "", footer.ctx);

    expect(prefills).toStrictEqual([formatFooterConfig(DEFAULT_CONFIG), "{ broken"]);
    expect(footer.host.getNotifications().map(({ type }) => type)).toStrictEqual(["error", "info"]);
    expect(footer.save).toHaveBeenCalledExactlyOnceWith(JSON.parse(valid));
    expect(footer.render()).toBe("▸ /tmp/project");
  });

  it("resets the saved layout to the default", async () => {
    const footer = await start({ config: withRows([{ left: ["footer.cwd"], right: [] }]) });

    await footer.host.runCommand("footer", "reset", footer.ctx);

    expect(footer.save).toHaveBeenCalledExactlyOnceWith(DEFAULT_CONFIG);
    expect(footer.render()).toContain("main");
  });

  it("names unknown widget IDs when loading and in inspect", async () => {
    const footer = await start({
      config: withRows([{ left: ["footer.cwd", "clanker.codex.fast"], right: [] }], ["status:vim"]),
    });

    footer.statuses.set("vim", "INSERT");

    await footer.host.runCommand("footer", "inspect", footer.ctx);

    const [warning, inspect] = footer.host.getNotifications();
    expect(warning).toStrictEqual({
      message: "Footer ignores unknown widget IDs: clanker.codex.fast",
      type: "warning",
    });
    expect(inspect?.message).toContain("clanker.codex.fast · row 1 left · not present");
    expect(inspect?.message).toContain("status:vim · border: INSERT");
  });
});
