import path from "node:path";
import { DatabaseSync } from "node:sqlite";

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import {
  afterEach,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vite-plus/test";

import { createExtensionHost } from "../../../tests/harness/extension-host.js";
import { patchEnv } from "../../../tests/helpers/env.js";
import { createTempDir } from "../../../tests/helpers/fs.js";
import extension from "../index.js";

const getStorePath = (agentDir: string) =>
  path.join(agentDir, "data", "stash", "stash.sqlite");

const createHarness = async (
  cwd: string,
  options: {
    factory?: (pi: ExtensionAPI) => void;
    mode?: "json" | "rpc" | "tui";
  } = {}
) => {
  const host = createExtensionHost(options.factory ?? extension);
  const ctx = host.createContext({ cwd, mode: options.mode ?? "tui" });
  await host.emitSessionStart(ctx);

  return {
    ctx,
    async input(source: "interactive" | "extension" = "interactive") {
      return await host.emitInput(
        { source, text: "prompt", type: "input" },
        ctx
      );
    },
    notifications: () => host.getNotifications(),
    async pop() {
      await host.runCommand("pop-stash", "", ctx);
    },
    async shortcut() {
      await host.runShortcut("ctrl+s", ctx);
    },
    async stash(text: string) {
      ctx.ui.setEditorText(text);
      await host.runShortcut("ctrl+s", ctx);
    },
  };
};

const openReaderBlockingCommit = (file: string) => {
  const reader = new DatabaseSync(file, { readOnly: true });
  reader.exec("BEGIN; SELECT name FROM sqlite_schema;");

  return reader;
};

describe("stash", () => {
  let agentDir: string;
  let cwd: string;
  let restoreEnv: () => void;

  beforeEach(async () => {
    agentDir = await createTempDir("stash-agent-");
    cwd = await createTempDir("stash-cwd-");
    restoreEnv = patchEnv({ PI_CODING_AGENT_DIR: agentDir });
  });

  afterEach(() => {
    restoreEnv();
  });

  it("shares one LIFO stack across already-started Pi instances in the same project", async () => {
    const first = await createHarness(cwd);
    const second = await createHarness(cwd);

    await first.stash("first draft");
    await second.stash("second\n  draft \u0000");
    expect(first.ctx.ui.getEditorText()).toBe("");
    expect(second.ctx.ui.getEditorText()).toBe("");
    expect(second.notifications()).toStrictEqual([
      { message: "Stashed.", type: "info" },
    ]);

    await expect(first.input()).resolves.toStrictEqual({ action: "continue" });
    expect(first.ctx.ui.getEditorText()).toBe("second\n  draft \u0000");
    await second.pop();
    expect(second.ctx.ui.getEditorText()).toBe("first draft");

    first.ctx.ui.setEditorText("");
    await first.input();
    expect(first.ctx.ui.getEditorText()).toBe("");
  });

  it("does not restore drafts from a different working directory", async () => {
    const owner = await createHarness(cwd);
    const other = await createHarness(await createTempDir("stash-other-cwd-"));
    await owner.stash("project draft");

    other.ctx.ui.setEditorText("  \n\t  ");
    await other.shortcut();
    expect(other.ctx.ui.getEditorText()).toBe("  \n\t  ");
    expect(other.notifications()).toStrictEqual([
      { message: "Nothing stashed.", type: "info" },
    ]);
    await owner.pop();
    expect(owner.ctx.ui.getEditorText()).toBe("project draft");
  });

  it("does not clear or confirm a draft when the push cannot commit", async () => {
    const harness = await createHarness(cwd);
    await harness.stash("previous stash");

    using reader = openReaderBlockingCommit(getStorePath(agentDir));

    harness.ctx.ui.setEditorText("keep typing here");
    const editorWrites = vi.mocked(harness.ctx.ui.setEditorText).mockClear();

    await harness.shortcut();
    expect(harness.ctx.ui.getEditorText()).toBe("keep typing here");
    expect(editorWrites).not.toHaveBeenCalled();
    expect(harness.notifications()).toStrictEqual([
      { message: "Stashed.", type: "info" },
      {
        message: "Could not stash draft; editor text was kept.",
        type: "warning",
      },
    ]);
    reader.exec("ROLLBACK");

    const observer = await createHarness(cwd);
    await observer.pop();
    expect(observer.ctx.ui.getEditorText()).toBe("previous stash");
  });

  it("leaves a draft stashed when automatic restore cannot commit", async () => {
    const harness = await createHarness(cwd);
    await harness.stash("previous stash");

    using reader = openReaderBlockingCommit(getStorePath(agentDir));

    await expect(harness.input()).resolves.toStrictEqual({
      action: "continue",
    });
    expect(harness.ctx.ui.getEditorText()).toBe("");
    expect(harness.notifications()).toContainEqual({
      message: "Could not restore stash.",
      type: "warning",
    });
    reader.exec("ROLLBACK");

    await harness.input();
    expect(harness.ctx.ui.getEditorText()).toBe("previous stash");
  });

  it("does not consume a stash when the user types while an earlier input handler is pending", async () => {
    const entered = Promise.withResolvers<undefined>();
    const resume = Promise.withResolvers<undefined>();

    const harness = await createHarness(cwd, {
      factory: (pi) => {
        pi.on("input", async () => {
          entered.resolve(undefined);
          await resume.promise;
        });
        extension(pi);
      },
    });

    await harness.stash("stashed draft");

    const submitting = harness.input();
    await entered.promise;
    harness.ctx.ui.setEditorText("typed after submit");
    resume.resolve(undefined);
    await submitting;
    expect(harness.ctx.ui.getEditorText()).toBe("typed after submit");

    await harness.pop();
    expect(harness.ctx.ui.getEditorText()).toBe("typed after submit");
    expect(harness.notifications()).toContainEqual({
      message: "Stash or clear the editor before restoring a draft.",
      type: "warning",
    });
    harness.ctx.ui.setEditorText("");
    await harness.pop();
    expect(harness.ctx.ui.getEditorText()).toBe("stashed draft");
  });

  it("does not automatically restore on extension input or outside TUI mode", async () => {
    const tui = await createHarness(cwd);
    const json = await createHarness(cwd, { mode: "json" });
    await tui.stash("draft message");

    await tui.input("extension");
    await json.input();
    expect(tui.ctx.ui.getEditorText()).toBe("");
    expect(json.ctx.ui.getEditorText()).toBe("");
    await tui.pop();
    expect(tui.ctx.ui.getEditorText()).toBe("draft message");
  });

  it("rejects /pop-stash in RPC, where Pi cannot inspect the client editor", async () => {
    const tui = await createHarness(cwd);
    const rpc = await createHarness(cwd, { mode: "rpc" });
    await tui.stash("draft message");

    await expect(rpc.pop()).rejects.toThrow(
      "pop-stash requires the interactive terminal UI"
    );
    await tui.pop();
    expect(tui.ctx.ui.getEditorText()).toBe("draft message");
  });
});
