import { initTheme } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { Value } from "typebox/value";
import { describe, expect, it } from "vite-plus/test";

import { createExtensionHost } from "../../../../tests/harness/extension-host.js";
import { createCustomUiDriver } from "../../../../tests/harness/tui.js";
import toolPickerExtension from "../../../tool-picker/index.js";
import { COLLABORATION_CONTRACT_REQUEST } from "../collaboration.js";
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
    pi.events.on(COLLABORATION_CONTRACT_REQUEST, (request) => {
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

describe("Codex tools", () => {
  it("resolves refreshed policy for commands without changing the manual preference", async () => {
    const model = createToolsModel("gpt-5.6-sol", true);
    let refreshed = { ...model, codexToolMode: "code_mode_only" };
    const host = createExtensionHost(registerCodexTools, { model });
    const ctx = host.createContext({
      model,
      modelRegistry: { find: () => refreshed },
    });
    await host.emitSessionStart();
    await host.runCommand("code-mode", "", ctx);
    expect(host.getActiveTools()).toStrictEqual(CODE_NAMES);
    expect(host.getNotifications()).toContainEqual({
      message: "gpt-5.6-sol requires Code Mode; /code-mode cannot change it.",
      type: "info",
    });
    refreshed = { ...model, codexToolMode: "future" };
    await host.emit(
      "session_before_compact",
      { type: "session_before_compact" },
      {
        ...ctx,
        isIdle: () => false,
      },
    );
    expect(host.getActiveTools()).toStrictEqual(CODE_NAMES);
    await host.emit("input", { text: "test", source: "interactive", type: "input" }, ctx);
    expect(host.getActiveTools()).toStrictEqual(DIRECT_NAMES);
  });

  it.each(["gpt-6-astra", "gpt-5.6-sol"])(
    "starts %s in catalog-required Code Mode and cannot toggle it off",
    async (id) => {
      const model = { ...createToolsModel(id, true), codexToolMode: "code_mode_only" };
      const host = createExtensionHost(registerCodexTools, { model });
      const ctx = host.createContext({ model });
      await host.emitSessionStart(ctx);
      expect(host.getActiveTools()).toStrictEqual(CODE_NAMES);
      expect(host.getStatus("codex-code-mode")).toBe("</>");

      await host.runCommand("code-mode", "", ctx);
      expect(host.getActiveTools()).toStrictEqual(CODE_NAMES);
      expect(host.getNotifications()).toContainEqual({
        message: `${id} requires Code Mode; /code-mode cannot change it.`,
        type: "info",
      });
    },
  );

  it.each([false, true])(
    "preserves the optional Code Mode preference %s across every declared mode",
    async (enabled) => {
      const optional = createToolsModel("gpt-5.6-sol", true);
      const host = createExtensionHost(registerCodexTools, { model: optional });
      await host.emitSessionStart();
      if (enabled) {
        await host.runCommand("code-mode", "", host.createContext({ model: optional }));
      }
      for (const [mode, names, label] of [
        ["direct", DIRECT_NAMES, "direct tools"],
        ["code_mode", [...DIRECT_NAMES, ...CODE_NAMES], "direct tools with Code Mode"],
        ["code_mode_only", CODE_NAMES, "Code Mode"],
      ] as const) {
        const required = { ...createToolsModel("gpt-6-astra", true), codexToolMode: mode };
        await selectModel(host, optional, required);
        expect(host.getActiveTools()).toStrictEqual(names);
        expect(host.getStatus("codex-code-mode")).toBe(mode === "direct" ? undefined : "</>");
        await host.runCommand("code-mode", "", host.createContext({ model: required }));
        expect(host.getActiveTools()).toStrictEqual(names);
        expect(host.getNotifications()).toContainEqual({
          message: `gpt-6-astra requires ${label}; /code-mode cannot change it.`,
          type: "info",
        });
        await selectModel(host, required, optional);
        expect(host.getActiveTools()).toStrictEqual(enabled ? CODE_NAMES : DIRECT_NAMES);
      }

      const unsupported = createToolsModel("deepseek-v4-pro");
      await selectModel(host, optional, unsupported);
      expect(host.getActiveTools()).toStrictEqual(PI_NAMES);
    },
  );

  it("preserves external tools while applying declared hybrid and direct modes", async () => {
    const model = { ...createToolsModel("gpt-6-astra", true), codexToolMode: "code_mode" };
    const host = createExtensionHost(registerCodexTools, {
      activeTools: [...PI_NAMES, "ask_question"],
      allTools: [...PI_NAMES, "ask_question"],
      externalTools: ["ask_question"],
      model,
    });
    await host.emitSessionStart();
    expect(host.getActiveTools()).toStrictEqual(["ask_question", ...DIRECT_NAMES, ...CODE_NAMES]);
    // Picker changes are allowed, but a model event reapplies the declared set.
    host.setActiveTools(
      host.getActiveTools().filter((name) => name !== "apply_patch" && name !== "wait"),
    );
    const direct = { ...model, codexToolMode: "direct" };
    await selectModel(host, model, direct);
    expect(host.getActiveTools()).toStrictEqual(["ask_question", ...DIRECT_NAMES]);
    await selectModel(host, direct, model);
    expect(host.getActiveTools()).toStrictEqual(["ask_question", ...DIRECT_NAMES, ...CODE_NAMES]);
  });

  it("keeps unknown selectors manually toggleable", async () => {
    const model = { ...createToolsModel("gpt-6-astra", true), codexToolMode: "future" };
    const host = createExtensionHost(registerCodexTools, { model });
    await host.emitSessionStart();
    expect(host.getActiveTools()).toStrictEqual(DIRECT_NAMES);
    await host.runCommand("code-mode", "", host.createContext({ model }));
    expect(host.getActiveTools()).toStrictEqual(CODE_NAMES);
  });

  it.each(["picker first", "picker last"])("changes tools independently with %s", async (order) => {
    const model = createToolsModel("gpt-5.6-sol", true);
    const host = createExtensionHost(
      (pi) => {
        for (const extension of order === "picker first"
          ? [toolPickerExtension, registerCodexTools]
          : [registerCodexTools, toolPickerExtension]) {
          extension(pi);
        }
      },
      { model },
    );
    await host.emitSessionStart();
    initTheme("dark");
    const ui = createCustomUiDriver({ keys: [" ", "\u001B"], captureRender: "before" });
    await host.runCommand("tools", "", host.createContext({ ui: { custom: ui.custom } }));

    for (const name of [...PI_NAMES, ...DIRECT_NAMES, ...CODE_NAMES]) {
      expect(ui.getLastRender()).toContain(name);
    }
    // The picker can enable a Pi built-in even while Codex tools are active.
    expect(host.getActiveTools()).toStrictEqual([...DIRECT_NAMES, "read"]);
    expect(host.getAppendedEntries().at(-1)).toMatchObject({
      customType: "tool-picker-config",
      data: { read: true },
    });

    // A model event applies the provider's normal set; the picker does not fight it.
    await selectModel(host, model, createToolsModel("gpt-5.6-terra", true));
    expect(host.getActiveTools()).toStrictEqual(DIRECT_NAMES);
    await host.runCommand("code-mode");
    expect(host.getActiveTools()).toStrictEqual(CODE_NAMES);
    expect(host.getAppendedEntries()).toMatchObject([
      { customType: "tool-picker-baseline" },
      { customType: "tool-picker-config" },
    ]);
  });

  it("preserves unrelated extension tools across model changes", async () => {
    const codex = createToolsModel("gpt-5.6-sol", true);
    const host = createExtensionHost(registerCodexTools, {
      activeTools: ["read", "ask_question"],
      allTools: [...PI_NAMES, "ask_question"],
      externalTools: ["ask_question"],
      model: codex,
    });
    await host.emitSessionStart();
    expect(host.getActiveTools()).toStrictEqual(["ask_question", ...DIRECT_NAMES]);
    await selectModel(host, codex, createToolsModel("deepseek-v4-pro"));
    expect(host.getActiveTools()).toStrictEqual(["read", "ask_question"]);
  });

  it("normalizes Pi's initial all-extension-tool activation", async () => {
    const model = createToolsModel("gpt-5.6-sol", true);
    const host = createExtensionHost(registerCodexTools, { model });
    await host.ready;

    expect(host.getActiveTools()).toStrictEqual([...PI_NAMES, ...DIRECT_NAMES, ...CODE_NAMES]);
    await host.emitSessionStart();

    expect(host.getActiveTools()).toStrictEqual(DIRECT_NAMES);
    expect([...host.getRegisteredTools().keys()]).toStrictEqual([...DIRECT_NAMES, ...CODE_NAMES]);
  });

  it.each([true, false])("normalizes tools on input only when idle is %s", async (idle) => {
    const host = createExtensionHost(registerCodexTools, {
      model: createToolsModel("gpt-5.6-sol", true),
    });
    await host.emitSessionStart();
    const selected = ["read", "write_stdin"];
    host.setActiveTools(selected);

    await host.emit(
      "input",
      { text: "test", source: "interactive", type: "input" },
      host.createContext({ isIdle: () => idle }),
    );

    expect(host.getActiveTools()).toStrictEqual(idle ? DIRECT_NAMES : selected);
  });

  it("does not normalize tools after prompt metadata has been captured", async () => {
    const host = createExtensionHost(registerCodexTools, {
      model: createToolsModel("gpt-5.6-sol", true),
    });
    await host.emitSessionStart();
    const selected = ["write_stdin"];
    host.setActiveTools(selected);

    await host.emit("before_agent_start", {
      prompt: "test",
      systemPrompt: "Base",
      systemPromptOptions: { selectedTools: selected },
      type: "before_agent_start",
    });

    expect(host.getActiveTools()).toStrictEqual(selected);
  });

  it.each(["gpt-5.6-sol", "gpt-6-astra"])(
    "gates %s activation on grammar-tool support",
    async (id) => {
      const model = { ...createToolsModel(id), codexToolMode: "code_mode_only" };
      const host = createExtensionHost(registerCodexTools, { model });

      await host.emitSessionStart();

      expect(host.getActiveTools()).toStrictEqual(PI_NAMES);
    },
  );

  it("restores Pi tools after a model switch", async () => {
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

  it.each([
    ["openai", "openai-responses"],
    ["azure-openai-responses", "azure-openai-responses"],
  ])("does not claim a matching %s model ID", async (provider, api) => {
    const codex = createToolsModel("gpt-5.6-sol", true);
    const collision = createToolsModel("gpt-5.6-sol", true, {
      api,
      provider,
    });
    const host = createExtensionHost(registerCodexTools, { model: codex });
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
      const model =
        protocol === "v2"
          ? { ...createToolsModel("gpt-6-astra", true), codexToolMode: "code_mode_only" }
          : createToolsModel("gpt-5.6-sol", true);
      const host = createExtensionHost(withCollaborationContract(protocol), {
        activeTools: ["spawn_agent"],
        allTools: ["spawn_agent"],
        model,
      });
      const ctx = host.createContext({ model });
      await host.emitSessionStart(ctx);
      if (protocol === "v1") {
        await host.runCommand("code-mode", "", ctx);
      }

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
      expect(host.getActiveTools()).toStrictEqual(["spawn_agent", ...CODE_NAMES]);
    },
  );
});
