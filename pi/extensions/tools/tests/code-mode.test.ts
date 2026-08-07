import { Type } from "typebox";
import { describe, expect, it, vi } from "vitest";

import { createExtensionHost } from "../../../tests/harness/extension-host.js";
import { parseExecSource } from "../code-mode/protocol.js";
import {
  RESPONSES_LITE_HEADER,
  RESPONSES_LITE_WS_METADATA_KEY,
  rewriteResponsesLiteRequest,
} from "../code-mode/provider.js";
import {
  CodeModeRuntime,
  toNestedTool,
  toPiContent,
} from "../code-mode/tools.js";
import extension from "../index.js";
import { createModel } from "./fixtures.js";

describe("Codex code mode", () => {
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
  });

  it("rewrites Responses requests to the Lite envelope", () => {
    const rewritten = rewriteResponsesLiteRequest({
      input: [{ content: [], role: "user", type: "message" }],
      instructions: "Use the harness.",
      model: "gpt-5.6-sol",
      tools: [{ name: "exec", type: "custom" }],
    });

    expect(rewritten).toMatchObject({
      client_metadata: {
        [RESPONSES_LITE_WS_METADATA_KEY]: "true",
      },
      input: [
        {
          role: "developer",
          tools: [{ name: "exec", type: "custom" }],
          type: "additional_tools",
        },
        {
          content: [{ text: "Use the harness.", type: "input_text" }],
          role: "developer",
          type: "message",
        },
        { content: [], role: "user", type: "message" },
      ],
      model: "gpt-5.6-sol",
      parallel_tool_calls: false,
      reasoning: { context: "all_turns" },
    });
    expect(rewritten).not.toHaveProperty("instructions");
    expect(rewritten).not.toHaveProperty("tools");
  });

  it("activates the provider and prompt hooks only with Code Mode", async () => {
    const model = createModel("gpt-5.6-luna", true);
    const host = createExtensionHost(extension, { model });
    const ctx = host.createContext({ model });
    await host.emitSessionStart(ctx);
    await host.runCommand("code-mode", "", ctx);

    const [request] = await host.emit(
      "before_provider_request",
      {
        payload: { input: [], model: model.id, tools: [] },
        type: "before_provider_request",
      },
      ctx
    );
    expect(request).toHaveProperty("input.0.type", "additional_tools");

    const headers: Record<string, string | null> = {};
    await host.emit(
      "before_provider_headers",
      { headers, type: "before_provider_headers" },
      ctx
    );
    expect(headers[RESPONSES_LITE_HEADER]).toBe("true");

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

  it("leaves provider requests untouched in direct fallback mode", async () => {
    const model = createModel("gpt-5.6-luna", true);
    const host = createExtensionHost(extension, { model });
    const ctx = host.createContext({ model });
    await host.emitSessionStart(ctx);

    const [request] = await host.emit(
      "before_provider_request",
      {
        payload: { input: [], model: model.id, tools: [] },
        type: "before_provider_request",
      },
      ctx
    );
    const headers: Record<string, string | null> = {};
    await host.emit(
      "before_provider_headers",
      { headers, type: "before_provider_headers" },
      ctx
    );

    expect(request).toBeUndefined();
    expect(headers).not.toHaveProperty(RESPONSES_LITE_HEADER);
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
        { cwd: "/tmp", extensionContext: {} as never },
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
