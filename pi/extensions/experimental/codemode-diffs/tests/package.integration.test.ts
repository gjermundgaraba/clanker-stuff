import { writeFile } from "node:fs/promises";
import path from "node:path";

import { fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai";
import { createCodemodeExtension } from "@earendil-works/pi-coding-agent";
import { Value } from "typebox/value";
import { describe, expect, it, onTestFinished } from "vite-plus/test";

import { createAgentSessionHarness } from "../../../../tests/harness/agent-session.js";
import { DiffDetailsSchema } from "../diffs.js";
import { SyntaxSchema } from "../highlight.js";

describe("codemode-diffs package", () => {
  it("loads the installed package and its lazy Wasm highlighter through Pi's extension loader", async () => {
    const harness = await createAgentSessionHarness({
      extensionFactories: [createCodemodeExtension()],
      settings: {
        packages: [path.resolve(import.meta.dirname, "..")],
        defaultTools: ["+codemode"],
        compaction: { enabled: false },
        retry: { enabled: false },
      },
    });

    onTestFinished(harness.cleanup);
    expect(harness.extensionsResult.errors).toStrictEqual([]);
    await writeFile(
      path.join(harness.tempDir, "source.ts"),
      "const old = 1;\n"
    );
    harness.setResponses([
      fauxAssistantMessage([
        fauxToolCall("codemode", {
          code: 'await tools.edit({path:"source.ts",edits:[{oldText:"const old = 1;",newText:"const next = 2;"}]});',
        }),
      ]),
      fauxAssistantMessage("Done"),
    ]);

    await harness.prompt("Edit");

    const result = harness
      .messages()
      .find(
        (message) =>
          message.role === "toolResult" && message.toolName === "codemode"
      );

    if (result?.role !== "toolResult") {
      throw new Error("Missing Code Mode result");
    }

    const captured = Value.Parse(
      DiffDetailsSchema,
      result.details
    ).codemodeDiffs;

    const syntax = Value.Parse(SyntaxSchema, captured[0]?.syntax);
    expect(syntax[1]?.[0]?.[1]).toBe("keyword");
  });
});
