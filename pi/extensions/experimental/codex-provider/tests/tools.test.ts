import type { SessionEntry } from "@earendil-works/pi-coding-agent";
import { initTheme } from "@earendil-works/pi-coding-agent";
import { describe, expect, it } from "vitest";

import { createExtensionHost } from "../../../../tests/harness/extension-host.js";
import toolsExtension from "../../../tools/index.js";
import { registerCodexTools } from "../tools/register.js";
import { createToolsModel } from "./fixtures.js";

const DIRECT_NAMES = [
  "exec_command",
  "write_stdin",
  "apply_patch",
  "view_image",
];
const CODE_NAMES = ["exec", "wait"];
const PI_NAMES = ["read", "bash", "edit", "write"];

const combinedExtension = (pi: Parameters<typeof toolsExtension>[0]) => {
  toolsExtension(pi);
  registerCodexTools(pi);
};

const selectModel = async (
  host: ReturnType<typeof createExtensionHost>,
  previousModel: ReturnType<typeof createToolsModel>,
  model: ReturnType<typeof createToolsModel>
) => {
  await host.emit(
    "model_select",
    { model, previousModel, source: "set", type: "model_select" },
    host.createContext({ model })
  );
};

const messageEntry = (id: string, parentId: string | null): SessionEntry => ({
  id,
  message: { content: "message", role: "user", timestamp: 1 },
  parentId,
  timestamp: "2026-04-20T00:00:00.000Z",
  type: "message",
});

const selectionEntry = (
  id: string,
  parentId: string | null,
  tools: Record<string, boolean>
): SessionEntry => ({
  customType: "codex-provider-tools",
  data: tools,
  id,
  parentId,
  timestamp: "2026-04-20T00:00:00.000Z",
  type: "custom",
});

describe("Codex tools", () => {
  it("normalizes Pi's initial all-extension-tool activation", async () => {
    const model = createToolsModel("gpt-5.6-sol", true);
    const host = createExtensionHost(registerCodexTools, { model });

    expect(host.getActiveTools()).toStrictEqual([
      ...PI_NAMES,
      ...DIRECT_NAMES,
      ...CODE_NAMES,
    ]);
    await host.emitSessionStart();

    expect(host.getActiveTools()).toStrictEqual(DIRECT_NAMES);
    expect([...host.getRegisteredTools().keys()]).toStrictEqual([
      ...DIRECT_NAMES,
      ...CODE_NAMES,
    ]);
  });

  it("gates activation on model and grammar-tool support", async () => {
    const model = createToolsModel("gpt-5.6-sol");
    const host = createExtensionHost(registerCodexTools, { model });

    await host.emitSessionStart();

    expect(host.getActiveTools()).toStrictEqual(PI_NAMES);
  });

  it("restores Pi tools after a model switch without the tools extension", async () => {
    const codex = createToolsModel("gpt-5.6-sol", true);
    const host = createExtensionHost(registerCodexTools, { model: codex });
    await host.emitSessionStart();

    const unsupported = createToolsModel("deepseek-v4-pro");
    await selectModel(host, codex, unsupported);

    expect(host.getActiveTools()).toStrictEqual(PI_NAMES);
  });

  it.each([
    ["openai", "openai-responses"],
    ["azure-openai-responses", "azure-openai-responses"],
  ])("does not claim a matching %s model ID", async (provider, api) => {
    const codex = createToolsModel("gpt-5.6-sol", true);
    const collision = createToolsModel("gpt-5.6-sol", true, {
      api,
      provider,
    });
    const host = createExtensionHost(combinedExtension, { model: codex });
    await host.emitSessionStart();
    expect(host.getActiveTools()).toStrictEqual(DIRECT_NAMES);

    await selectModel(host, codex, collision);
    expect(host.getActiveTools()).toStrictEqual(PI_NAMES);

    await selectModel(host, collision, codex);
    expect(host.getActiveTools()).toStrictEqual(DIRECT_NAMES);
  });

  it("toggles direct and Code Mode tools", async () => {
    const model = createToolsModel("gpt-5.6-sol", true);
    const host = createExtensionHost(registerCodexTools, { model });
    const ctx = host.createContext({ model });
    await host.emitSessionStart(ctx);

    await host.runCommand("code-mode", "", ctx);
    expect(host.getActiveTools()).toStrictEqual(CODE_NAMES);
    expect(
      host.getRegisteredTools().get("exec")?.definition.constrainedSampling
    ).toMatchObject({ type: "grammar" });
    expect(host.getNotifications()).toContainEqual({
      message: "Code Mode enabled",
      type: "info",
    });

    await host.runCommand("code-mode", "", ctx);
    expect(host.getActiveTools()).toStrictEqual(DIRECT_NAMES);
  });

  it("delegates provider-owned choices from /tools", async () => {
    const model = createToolsModel("gpt-5.6-sol", true);
    const host = createExtensionHost(combinedExtension, {
      entries: [messageEntry("root", null), messageEntry("branch-b", "root")],
      leafId: "root",
      model,
    });
    await host.emitSessionStart();
    initTheme("dark");
    const rendered: string[] = [];
    const ctx = host.createContext();
    const custom: typeof ctx.ui.custom = async (factory) => {
      const component = await factory(
        { requestRender() {} } as never,
        ctx.ui.theme,
        {} as never,
        () => null
      );
      rendered.push(...component.render(120));
      component.handleInput?.(" ");
      return null as never;
    };
    ctx.ui.custom = custom;

    await host.runCommand("tools", "", ctx);

    expect(rendered.join("\n")).not.toContain("read");
    expect(host.getActiveTools()).toStrictEqual(DIRECT_NAMES.slice(1));
    expect(host.getAppendedEntries().at(-1)).toMatchObject({
      customType: "codex-provider-tools",
      data: { exec_command: false },
    });

    host.setLeafId("branch-b");
    await host.emitSessionStart(ctx, "resume");
    expect(host.getActiveTools()).toStrictEqual(DIRECT_NAMES.slice(1));
  });

  it("cooperates with non-Codex profiles and external tools", async () => {
    const codex = createToolsModel("gpt-5.6-sol", true);
    const host = createExtensionHost(combinedExtension, {
      activeTools: ["read", "bash", "ask_question"],
      allTools: [
        "read",
        "bash",
        "edit",
        "write",
        "grep",
        "find",
        "ls",
        "ask_question",
      ],
      model: codex,
    });
    await host.emitSessionStart();
    expect(host.getActiveTools()).toStrictEqual([
      "ask_question",
      ...DIRECT_NAMES,
    ]);

    const claude = createToolsModel("claude-opus-5");
    await selectModel(host, codex, claude);
    expect(host.getActiveTools()).toStrictEqual([
      "ask_question",
      "Read",
      "Write",
      "Edit",
      "Glob",
      "Grep",
      "Bash",
    ]);

    const unsupported = createToolsModel("deepseek-v4-pro");
    await selectModel(host, claude, unsupported);
    expect(host.getActiveTools()).toStrictEqual([
      "read",
      "bash",
      "ask_question",
    ]);

    await selectModel(host, unsupported, codex);
    expect(host.getActiveTools()).toStrictEqual([
      "ask_question",
      ...DIRECT_NAMES,
    ]);
  });

  it("restores provider-owned choices from the active branch", async () => {
    const model = createToolsModel("gpt-5.6-terra", true);
    const host = createExtensionHost(combinedExtension, {
      entries: [
        messageEntry("root", null),
        selectionEntry("selection-a", "root", { apply_patch: false }),
        messageEntry("branch-b", "root"),
      ],
      leafId: "selection-a",
      model,
    });
    await host.emitSessionStart();
    expect(host.getActiveTools()).toStrictEqual(
      DIRECT_NAMES.filter((name) => name !== "apply_patch")
    );

    host.setLeafId("branch-b");
    await host.emitSessionTree();
    expect(host.getActiveTools()).toStrictEqual(DIRECT_NAMES);
  });
});
