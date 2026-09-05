import {
  TOOL_OWNER_PROTOCOL_VERSION,
  TOOL_OWNER_REQUEST_EVENT,
} from "@clanker-stuff/tool-owner-protocol";
import type { ToolOwnerRegistration } from "@clanker-stuff/tool-owner-protocol";
import type { SessionEntry } from "@earendil-works/pi-coding-agent";
import { initTheme } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { Value } from "typebox/value";
import { describe, expect, it } from "vite-plus/test";

import { createExtensionHost } from "../../../../tests/harness/extension-host.js";
import { createCustomUiDriver } from "../../../../tests/harness/tui.js";
import toolsExtension from "../../tools/index.js";
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
    await host.emit(
      "before_agent_start",
      {
        prompt: "test",
        systemPrompt: "Base",
        systemPromptOptions: {},
        type: "before_agent_start",
      },
      ctx,
    );
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

  it("uses the requested model for tool-owner visibility", async () => {
    const optional = createToolsModel("gpt-5.6-sol", true);
    const required = { ...createToolsModel("gpt-6-astra", true), codexToolMode: "code_mode_only" };
    let owner: ToolOwnerRegistration | undefined;
    const host = createExtensionHost(
      (pi) => {
        registerCodexTools(pi);
        pi.on("session_start", () => {
          pi.events.emit(TOOL_OWNER_REQUEST_EVENT, {
            protocol: TOOL_OWNER_PROTOCOL_VERSION,
            provide: (registration: ToolOwnerRegistration) => {
              owner = registration;
            },
            type: "request",
          });
        });
      },
      { model: optional },
    );
    await host.emitSessionStart();
    expect(owner?.visibleNames(required)).toStrictEqual(CODE_NAMES);
    const hybrid = { ...required, codexToolMode: "code_mode" };
    expect(owner?.visibleNames(hybrid)).toStrictEqual([...DIRECT_NAMES, ...CODE_NAMES]);
    await selectModel(host, optional, required);
    expect(owner?.visibleNames(optional)).toStrictEqual(DIRECT_NAMES);
    expect(owner?.visibleNames()).toStrictEqual(CODE_NAMES);
  });

  it("honors individual hybrid choices and preserves external tools across mode changes", async () => {
    const model = { ...createToolsModel("gpt-6-astra", true), codexToolMode: "code_mode" };
    const host = createExtensionHost(registerCodexTools, {
      activeTools: [...PI_NAMES, "ask_question"],
      externalTools: ["ask_question"],
      entries: [selectionEntry("choices", null, { apply_patch: false, wait: false })],
      leafId: "choices",
      model,
    });
    await host.emitSessionStart();
    expect(host.getActiveTools()).toStrictEqual([
      "ask_question",
      "exec_command",
      "write_stdin",
      "view_image",
      "exec",
    ]);
    const direct = { ...model, codexToolMode: "direct" };
    await selectModel(host, model, direct);
    expect(host.getActiveTools()).toStrictEqual([
      "ask_question",
      "exec_command",
      "write_stdin",
      "view_image",
    ]);
    await selectModel(host, direct, model);
    expect(host.getActiveTools()).toContain("exec");
    expect(host.getActiveTools()).not.toContain("wait");
  });

  it("keeps unknown selectors manually toggleable", async () => {
    const model = { ...createToolsModel("gpt-6-astra", true), codexToolMode: "future" };
    const host = createExtensionHost(registerCodexTools, { model });
    await host.emitSessionStart();
    expect(host.getActiveTools()).toStrictEqual(DIRECT_NAMES);
    await host.runCommand("code-mode", "", host.createContext({ model }));
    expect(host.getActiveTools()).toStrictEqual(CODE_NAMES);
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

  it.each(["gpt-5.6-sol", "gpt-6-astra"])(
    "gates %s activation on grammar-tool support",
    async (id) => {
      const model = { ...createToolsModel(id), codexToolMode: "code_mode_only" };
      const host = createExtensionHost(registerCodexTools, { model });

      await host.emitSessionStart();

      expect(host.getActiveTools()).toStrictEqual(PI_NAMES);
    },
  );

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
