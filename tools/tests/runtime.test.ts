import { describe, expect, it } from "vitest";

import { createExtensionHost } from "../../tests/harness/extension-host.js";
import extension from "../index.js";
import { createModel } from "./fixtures.js";

const profileCases = [
  {
    id: "claude-sonnet-5",
    names: ["Read", "Write", "Edit", "Glob", "Grep", "Bash"],
  },
  {
    id: "grok-4.5",
    names: [
      "run_terminal_cmd",
      "read_file",
      "search_replace",
      "grep",
      "list_dir",
    ],
  },
  {
    id: "glm-5.2",
    names: ["Read", "Write", "Edit", "Glob", "Grep", "Bash"],
  },
  {
    id: "kimi-k3",
    names: ["Read", "ReadMediaFile", "Write", "Edit", "Grep", "Glob", "Bash"],
  },
] as const;

describe("native harness routing", () => {
  it.each(profileCases)("activates $id", async (profile) => {
    const host = createExtensionHost(extension, {
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
      model: createModel(profile.id),
    });

    await host.emitSessionStart();

    expect(host.getActiveTools()).toStrictEqual([
      "ask_question",
      ...profile.names,
    ]);
    expect([...host.getRegisteredTools().keys()]).toStrictEqual(profile.names);
    for (const tool of host.getRegisteredTools().values()) {
      expect(tool.definition.parameters).toHaveProperty(
        "additionalProperties",
        false
      );
    }
  });

  it("uses pi tools directly for unsupported models", async () => {
    const activeTools = ["read", "bash", "ask_question"];
    const host = createExtensionHost(extension, {
      activeTools,
      allTools: [...activeTools, "edit", "write", "grep", "find", "ls"],
      model: createModel("deepseek-v4-pro"),
    });

    await host.emitSessionStart();

    expect(host.getActiveTools()).toStrictEqual(activeTools);
    expect(host.getRegisteredTools().size).toBe(0);
  });

  it("gates Codex on grammar-tool transport support", async () => {
    const unsupported = createExtensionHost(extension, {
      model: createModel("gpt-5.6-sol"),
    });
    await unsupported.emitSessionStart();
    expect(unsupported.getRegisteredTools().size).toBe(0);

    const supported = createExtensionHost(extension, {
      model: createModel("gpt-5.6-sol", true),
    });
    await supported.emitSessionStart();
    expect([...supported.getRegisteredTools().keys()]).toStrictEqual([
      "exec_command",
      "write_stdin",
      "apply_patch",
      "view_image",
    ]);
  });

  it("toggles Codex Code Mode", async () => {
    const model = createModel("gpt-5.6-sol", true);
    const supported = createExtensionHost(extension, { model });
    await supported.emitSessionStart();
    const ctx = supported.createContext({
      model,
    });

    expect(supported.getActiveTools()).toStrictEqual([
      "exec_command",
      "write_stdin",
      "apply_patch",
      "view_image",
    ]);
    await supported.runCommand("code-mode", "", ctx);
    expect(supported.getActiveTools()).toStrictEqual(["exec", "wait"]);
    expect(
      supported.getRegisteredTools().get("exec")?.definition.constrainedSampling
    ).toMatchObject({ type: "grammar" });
    expect(supported.getNotifications()).toContainEqual({
      message: "Code Mode enabled",
      type: "info",
    });

    await supported.runCommand("code-mode", "", ctx);
    expect(supported.getActiveTools()).toStrictEqual([
      "exec_command",
      "write_stdin",
      "apply_patch",
      "view_image",
    ]);
  });

  it("replaces colliding definitions when the model changes", async () => {
    const claude = createModel("claude-opus-5");
    const host = createExtensionHost(extension, { model: claude });
    await host.emitSessionStart();
    const claudeRead = host.getRegisteredTools().get("Read")?.definition;
    expect(claudeRead?.parameters).toHaveProperty("properties.file_path");

    const kimi = createModel("kimi-k3");
    const ctx = host.createContext({ model: kimi });
    await host.emit(
      "model_select",
      {
        model: kimi,
        previousModel: claude,
        source: "set",
        type: "model_select",
      },
      ctx
    );

    const kimiRead = host.getRegisteredTools().get("Read")?.definition;
    expect(kimiRead).not.toBe(claudeRead);
    expect(kimiRead?.parameters).toHaveProperty("properties.path");
    expect(kimiRead?.parameters).not.toHaveProperty("properties.file_path");
    expect(host.getActiveTools()).toStrictEqual([
      "Read",
      "ReadMediaFile",
      "Write",
      "Edit",
      "Grep",
      "Glob",
      "Bash",
    ]);
  });

  it("restores a generic definition after a native-name collision", async () => {
    const grok = createModel("grok-4.5");
    const host = createExtensionHost(extension, {
      activeTools: ["grep"],
      allTools: ["read", "bash", "edit", "write", "grep", "find", "ls"],
      model: grok,
    });
    await host.emitSessionStart();
    expect(
      host.getRegisteredTools().get("grep")?.definition.parameters
    ).toHaveProperty("properties.-i");

    const deepseek = createModel("deepseek-v4-pro");
    await host.emit(
      "model_select",
      {
        model: deepseek,
        previousModel: grok,
        source: "set",
        type: "model_select",
      },
      host.createContext({ model: deepseek })
    );

    const restored = host.getRegisteredTools().get("grep")?.definition;
    expect(restored?.parameters).toHaveProperty("properties.ignoreCase");
    expect(restored?.parameters).not.toHaveProperty("properties.-i");
    expect(host.getActiveTools()).toStrictEqual(["grep"]);
  });

  it("restores the original generic selection after an adapted model", async () => {
    const claude = createModel("claude-fable-5");
    const host = createExtensionHost(extension, {
      activeTools: ["read", "ask_question"],
      allTools: ["read", "bash", "edit", "write", "ask_question"],
      model: claude,
    });
    await host.emitSessionStart();

    const deepseek = createModel("deepseek-v4-flash");
    await host.emit(
      "model_select",
      {
        model: deepseek,
        previousModel: claude,
        source: "set",
        type: "model_select",
      },
      host.createContext({ model: deepseek })
    );

    expect(host.getActiveTools()).toStrictEqual(["read", "ask_question"]);
  });
});
