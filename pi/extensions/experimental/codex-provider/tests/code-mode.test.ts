import { chmod, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { Type } from "typebox";
import { describe, expect, it, onTestFinished, vi } from "vitest";

import { createExtensionHost } from "../../../../tests/harness/extension-host.js";
import {
  createIdentityTheme,
  renderComponent,
} from "../../../../tests/harness/tui.js";
import { CodeModeHostClient } from "../code-mode/host-client.js";
import { parseExecSource } from "../code-mode/protocol.js";
import {
  CodeModeRuntime,
  toNestedTool,
  toPiContent,
} from "../code-mode/tools.js";
import { registerCodexTools } from "../tools/register.js";
import { createToolsModel } from "./fixtures.js";

describe("Codex code mode", () => {
  it.skipIf(process.platform === "win32")(
    "aborts a host startup that never handshakes",
    async () => {
      const directory = await mkdtemp(path.join(tmpdir(), "code-mode-host-"));
      onTestFinished(() => rm(directory, { force: true, recursive: true }));
      const executable = path.join(directory, "host");
      await writeFile(
        executable,
        "#!/usr/bin/env node\nsetInterval(() => {}, 1000);\n",
        "utf-8"
      );
      await chmod(executable, 0o755);
      const client = new CodeModeHostClient(executable);
      const controller = new AbortController();

      const starting = client.start(controller.signal);
      controller.abort();

      await expect(starting).rejects.toMatchObject({ name: "AbortError" });
      await client.shutdown();
    }
  );

  it("provides native-style runtime and nested tool instructions", () => {
    const runtime = new CodeModeRuntime();
    const definition = {
      description: "Runs a test operation.",
      execute: async () => ({ content: [], details: {} }),
      label: "Test",
      name: "test",
      parameters: Type.Object(
        { value: Type.String() },
        { additionalProperties: false }
      ),
    };
    const tools = runtime.createTools([definition]);

    expect(tools.find((tool) => tool.name === "exec")?.description).toContain(
      "fresh V8 isolate as an async module"
    );
    expect(tools.find((tool) => tool.name === "wait")?.description).toContain(
      "returns only new output since the last yield"
    );
    expect(runtime.prompt([definition])).toContain(
      "### `test`\nRuns a test operation.\n\nUsage: `await tools.test(input)`"
    );
    expect(runtime.prompt([{ ...definition, name: "exec_command" }])).toContain(
      "result.output"
    );
  });

  it("renders semantic execution status transitions", () => {
    const renderResult = new CodeModeRuntime()
      .createTools([])
      .find((tool) => tool.name === "exec")?.renderResult;
    if (!renderResult) {
      throw new Error("exec renderer is missing");
    }

    const render = (details: Record<string, unknown>) =>
      renderComponent(
        renderResult(
          { content: [], details },
          { expanded: false, isPartial: details.status === "running" },
          createIdentityTheme(),
          {} as never
        )
      )?.trimEnd();

    expect(render({ status: "running" })).toBe("● running");
    expect(render({ status: "yielded" })).toBe("◌ yielded");
    expect(render({ status: "result" })).toBe("✓ completed");
    expect(render({ status: "terminated" })).toBe("■ terminated");
    expect(render({ scriptError: "boom", status: "result" })).toBe("✗ error");
  });

  it("adds nested tool instructions only with Code Mode", async () => {
    const model = createToolsModel("gpt-5.6-luna", true);
    const host = createExtensionHost(registerCodexTools, { model });
    const ctx = host.createContext({ model });
    await host.emitSessionStart(ctx);
    await host.runCommand("code-mode", "", ctx);

    const [prompt] = await host.emit(
      "before_agent_start",
      {
        prompt: "test",
        systemPrompt: "Base prompt\nCurrent working directory: /tmp",
        systemPromptOptions: {},
        type: "before_agent_start",
      },
      ctx
    );
    expect(prompt).toHaveProperty(
      "systemPrompt",
      expect.stringContaining("Tools available in exec:")
    );
    const augmentedPrompt =
      typeof prompt === "object" &&
      prompt !== null &&
      "systemPrompt" in prompt &&
      typeof prompt.systemPrompt === "string"
        ? prompt.systemPrompt
        : "";
    expect(augmentedPrompt).toContain(
      "Current working directory: /tmp\n\nTools available in exec:"
    );
    const [duplicate] = await host.emit(
      "before_agent_start",
      {
        prompt: "test",
        systemPrompt: augmentedPrompt,
        systemPromptOptions: {},
        type: "before_agent_start",
      },
      ctx
    );
    expect(duplicate).toBeUndefined();
  });

  it("validates nested calls before invoking their definition", async () => {
    const execute = vi.fn<
      (
        id: string,
        params: { value: string }
      ) => Promise<{
        content: { text: string; type: "text" }[];
        details: Record<string, never>;
      }>
    >(async (_id, params) => ({
      content: [{ text: params.value, type: "text" }],
      details: {},
    }));
    const nested = toNestedTool({
      description: "test",
      execute,
      label: "test",
      name: "test",
      parameters: Type.Object(
        { value: Type.String() },
        { additionalProperties: false }
      ),
    });
    const context = {
      cwd: "/tmp",
      extensionContext: {} as never,
    };

    await expect(
      nested.invoke(
        { extra: true, value: "ok" },
        context,
        new AbortController().signal
      )
    ).rejects.toThrow('Validation failed for tool "test"');
    expect(execute).not.toHaveBeenCalled();

    await expect(
      nested.invoke({ value: "ok" }, context, new AbortController().signal)
    ).resolves.toBe("ok");
  });

  it("rejects text returned by nested view_image", async () => {
    const nested = toNestedTool({
      description: "test",
      execute: async () => ({
        content: [{ text: "<svg/>", type: "text" as const }],
        details: {},
      }),
      label: "test",
      name: "view_image",
      parameters: Type.Object(
        { path: Type.String() },
        { additionalProperties: false }
      ),
    });

    await expect(
      nested.invoke(
        { path: "/tmp/image.svg" },
        { extensionContext: {} as never },
        new AbortController().signal
      )
    ).rejects.toThrow("convert SVG to PNG first");
  });

  it("rejects unsupported host image types before they reach Pi", () => {
    expect(() =>
      toPiContent({
        image_url: "data:image/svg+xml;base64,PHN2Zy8+",
        type: "input_image",
      })
    ).toThrow('Unsupported Code Mode image type "image/svg+xml"');
  });

  it.each(["image/gif", "image/jpeg", "image/png", "image/webp"])(
    "allows %s host images",
    (mimeType) => {
      expect(
        toPiContent({
          image_url: `data:${mimeType};base64,AA==`,
          type: "input_image",
        })
      ).toStrictEqual({ data: "AA==", mimeType, type: "image" });
    }
  );

  it("parses host execution pragmas", () => {
    expect(
      parseExecSource(
        '// @exec: {"yield_time_ms": 5, "max_output_tokens": 20}\ntext("ok")'
      )
    ).toStrictEqual({
      code: 'text("ok")',
      maxOutputTokens: 20,
      yieldTimeMs: 5,
    });
  });
});
