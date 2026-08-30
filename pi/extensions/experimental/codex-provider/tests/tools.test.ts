import type { SessionEntry } from "@earendil-works/pi-coding-agent";
import { initTheme } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { Value } from "typebox/value";
import { describe, expect, it } from "vite-plus/test";

import { createExtensionHost } from "../../../../tests/harness/extension-host.js";
import { createCustomUiDriver } from "../../../../tests/harness/tui.js";
import toolsExtension from "../../../tools/index.js";
import { registerCodexTools } from "../tools/register.js";
import { createToolsModel } from "./fixtures.js";

const DIRECT_NAMES = ["exec_command", "write_stdin", "apply_patch", "view_image"];
const CODE_NAMES = ["exec", "wait"];
const PI_NAMES = ["read", "bash", "edit", "write"];
const ContractRequestSchema = Type.Object({
  provide: Type.Function([Type.Unknown()], Type.Void()),
  sessionId: Type.String(),
});
const PromptResultSchema = Type.Object({ systemPrompt: Type.String() });

const combinedExtension = (pi: Parameters<typeof toolsExtension>[0]) => {
  toolsExtension(pi);
  registerCodexTools(pi);
};

const withCollaborationContract =
  (protocol: "v1" | "v2") => (pi: Parameters<typeof registerCodexTools>[0]) => {
    const nested = {
      description: "Spawn a test agent.",
      execute: async () => ({ content: [], details: {} }),
      label: "Spawn Agent",
      name: "spawn_agent",
      parameters: Type.Object({}, { additionalProperties: false }),
    };
    pi.registerTool(nested);
    pi.events.on("clanker-stuff:subagents:contract:request", (request) => {
      const parsed = Value.Parse(ContractRequestSchema, request);
      parsed.provide({
        nestedTools: [{ definition: nested }],
        protocol,
        sessionId: parsed.sessionId,
        version: 1,
      });
    });
    registerCodexTools(pi);
  };

const selectModel = async (
  host: ReturnType<typeof createExtensionHost>,
  previousModel: ReturnType<typeof createToolsModel>,
  model: ReturnType<typeof createToolsModel>,
) => {
  await host.emit(
    "model_select",
    { model, previousModel, source: "set", type: "model_select" },
    host.createContext({ model }),
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
  tools: Record<string, boolean>,
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
    await host.ready;

    expect(host.getActiveTools()).toStrictEqual([...PI_NAMES, ...DIRECT_NAMES, ...CODE_NAMES]);
    await host.emitSessionStart();

    expect(host.getActiveTools()).toStrictEqual(DIRECT_NAMES);
    expect([...host.getRegisteredTools().keys()]).toStrictEqual([...DIRECT_NAMES, ...CODE_NAMES]);
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

  it("suppresses and restores powershell from builtin provenance", async () => {
    const codex = createToolsModel("gpt-5.6-sol", true);
    const builtinNames = [...PI_NAMES, "powershell"];
    const host = createExtensionHost(registerCodexTools, {
      activeTools: builtinNames,
      allTools: builtinNames,
      model: codex,
    });
    await host.emitSessionStart();
    expect(host.getActiveTools()).toStrictEqual(DIRECT_NAMES);

    const unsupported = createToolsModel("deepseek-v4-pro");
    await selectModel(host, codex, unsupported);

    expect(host.getActiveTools()).toStrictEqual(builtinNames);
  });

  it("suppresses Pi tools restored after a native profile", async () => {
    const grok = createToolsModel("grok-build-0.1");
    const host = createExtensionHost(combinedExtension, {
      activeTools: ["grep"],
      allTools: [...PI_NAMES, "grep"],
      model: grok,
    });
    await host.emitSessionStart();
    expect(host.getActiveTools()).toContain("grep");

    await selectModel(host, grok, createToolsModel("gpt-5.6-sol", true));

    expect(host.getActiveTools()).toStrictEqual(DIRECT_NAMES);
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
    expect(host.getStatus("codex-code-mode")).toBe("</>");
    expect(host.getRegisteredTools().get("exec")?.definition.constrainedSampling).toMatchObject({
      type: "grammar",
    });
    expect(host.getNotifications()).toContainEqual({
      message: "Code Mode enabled",
      type: "info",
    });

    await host.runCommand("code-mode", "", ctx);
    expect({
      status: host.getStatus("codex-code-mode"),
      tools: host.getActiveTools(),
    }).toStrictEqual({ status: undefined, tools: DIRECT_NAMES });
  });

  it.each([
    ["v1", true],
    ["v2", false],
  ] as const)(
    "keeps %s collaboration on its intended Code Mode surface",
    async (protocol, nested) => {
      const model = createToolsModel("gpt-5.6-sol", true);
      const host = createExtensionHost(withCollaborationContract(protocol), {
        activeTools: ["spawn_agent"],
        allTools: ["spawn_agent"],
        model,
      });
      const ctx = host.createContext({ model });
      await host.emitSessionStart(ctx);
      await host.runCommand("code-mode", "", ctx);

      const [prompt] = await host.emit(
        "before_agent_start",
        {
          prompt: "test",
          systemPrompt: "Base",
          systemPromptOptions: {},
          type: "before_agent_start",
        },
        ctx,
      );
      const systemPrompt = Value.Check(PromptResultSchema, prompt)
        ? Value.Parse(PromptResultSchema, prompt).systemPrompt
        : "";
      expect(systemPrompt.includes("pi_subagents__spawn_agent")).toBe(nested);
      expect(host.getActiveTools()).toContain("spawn_agent");
    },
  );

  it("delegates provider-owned choices from /tools", async () => {
    const model = createToolsModel("gpt-5.6-sol", true);
    const host = createExtensionHost(combinedExtension, {
      entries: [messageEntry("root", null), messageEntry("branch-b", "root")],
      leafId: "root",
      model,
    });
    await host.emitSessionStart();
    initTheme("dark");
    const ui = createCustomUiDriver({
      captureRender: "before",
      keys: [" ", "\u001B"],
      width: 120,
    });
    const ctx = host.createContext();
    ctx.ui.custom = ui.custom;

    await host.runCommand("tools", "", ctx);

    expect(ui.getLastRender()).not.toContain("read");
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
      allTools: ["read", "bash", "edit", "write", "grep", "find", "ls", "ask_question"],
      externalTools: ["ask_question"],
      model: codex,
    });
    await host.emitSessionStart();
    expect(host.getActiveTools()).toStrictEqual(["ask_question", ...DIRECT_NAMES]);

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
    expect(host.getActiveTools()).toStrictEqual(["read", "bash", "ask_question"]);

    await selectModel(host, unsupported, codex);
    expect(host.getActiveTools()).toStrictEqual(["ask_question", ...DIRECT_NAMES]);
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
      DIRECT_NAMES.filter((name) => name !== "apply_patch"),
    );

    host.setLeafId("branch-b");
    await host.emitSessionTree();
    expect(host.getActiveTools()).toStrictEqual(DIRECT_NAMES);
  });
});
