import { readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";

import { fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai";
import { createCodemodeExtension } from "@earendil-works/pi-coding-agent";
import { Value } from "typebox/value";
import { describe, expect, it, onTestFinished } from "vite-plus/test";

import extension from "../index.js";
import { DiffDetailsSchema } from "../diffs.js";
import { SyntaxSchema } from "../highlight.js";
import { createAgentSessionHarness } from "../../../../tests/harness/agent-session.js";
import type {
  AgentSessionHarness,
  AgentSessionHarnessOptions,
} from "../../../../tests/harness/agent-session.js";
import { toolRenderContext, renderedRows } from "../../../../tests/harness/tool-rendering.js";
import { createIdentityTheme } from "../../../../tests/harness/tui.js";
import { createTempDir } from "../../../../tests/helpers/fs.js";

const setup = async (options: AgentSessionHarnessOptions = {}) => {
  const harness = await createAgentSessionHarness({
    extensionFactories: [createCodemodeExtension(), extension],
    settings: {
      defaultTools: ["+codemode"],
      compaction: { enabled: false },
      retry: { enabled: false },
    },
    ...options,
  });

  onTestFinished(harness.cleanup);

  return harness;
};

const results = (harness: AgentSessionHarness) =>
  harness
    .messages()
    .filter((message) => message.role === "toolResult")
    .filter((message) => message.toolName === "codemode");

const edit = (file: string, before: string, after: string) =>
  `await tools.edit(${JSON.stringify({ path: file, edits: [{ oldText: before, newText: after }] })});`;

describe("Code Mode edit diffs in real sessions", () => {
  it("isolates concurrent scripts and retains each edit without changing script output", async () => {
    const harness = await setup();
    await writeFile(path.join(harness.tempDir, "a.txt"), "alpha\n");
    await writeFile(path.join(harness.tempDir, "b.txt"), "bravo\n");
    harness.setResponses([
      fauxAssistantMessage([
        fauxToolCall("codemode", { code: edit("a.txt", "alpha", "ALPHA") }),
        fauxToolCall("codemode", {
          code: [edit("b.txt", "bravo", "BRAVO"), edit("b.txt", "BRAVO", "charlie")].join("\n"),
        }),
      ]),
      fauxAssistantMessage("Done"),
    ]);

    await harness.prompt("Edit both files");
    const messages = results(harness);
    expect(messages).toHaveLength(2);

    const captured = messages.map(
      (message) => Value.Parse(DiffDetailsSchema, message.details).codemodeDiffs,
    );

    const a = captured.find((edits) => edits[0]?.path === "a.txt");
    const b = captured.find((edits) => edits[0]?.path === "b.txt");
    expect(a).toHaveLength(1);
    expect(a?.[0]?.diff).toContain("+1 ALPHA");
    expect(b).toHaveLength(2);
    expect(b?.[0]?.diff).toContain("+1 BRAVO");
    expect(b?.[1]?.diff).toContain("-1 BRAVO");
    expect(b?.[1]?.diff).toContain("+1 charlie");

    for (const message of messages) {
      // The extension must augment, not replace Code Mode's existing details.
      expect(message.details).toHaveProperty("calls");
      expect(message.content).toHaveLength(1);
      const block = message.content[0];

      if (block?.type !== "text") throw new Error("Expected script text output");
      expect(block.text).toMatch(/^Script completed\nWall time [\d.]+ seconds\nOutput:\n$/);
    }

    expect(harness.messages().some((message) => message.role === "custom")).toBe(false);
  });

  it("keeps successful edits when another edit fails and the script later throws", async () => {
    const harness = await setup();
    await writeFile(path.join(harness.tempDir, "a.txt"), "before\n");
    harness.setResponses([
      fauxAssistantMessage([
        fauxToolCall("codemode", {
          code: `await Promise.allSettled([
          tools.edit({path:"a.txt", edits:[{oldText:"missing",newText:"bad"}]}),
          tools.edit({path:"a.txt", edits:[{oldText:"before",newText:"after"}]})
        ]); throw new Error("script failed after editing");`,
        }),
      ]),
      fauxAssistantMessage("Failed after editing"),
    ]);

    await harness.prompt("Edit then fail");
    const message = results(harness)[0];
    expect(message?.isError).toBe(true);
    const captured = Value.Parse(DiffDetailsSchema, message?.details).codemodeDiffs;
    expect(captured).toHaveLength(1);
    expect(captured[0]?.diff).toContain("+1 after");
    expect(await readFile(path.join(harness.tempDir, "a.txt"), "utf8")).toBe("after\n");

    const output = message?.content
      .flatMap((block) => (block.type === "text" ? [block.text] : []))
      .join("\n");

    expect(output).toContain("script failed after editing");
  });

  it("captures per-call source snapshots under the native queue during concurrent edits", async () => {
    const harness = await setup();
    const prefix = "/*\n" + "unshown source\n".repeat(12);
    await writeFile(path.join(harness.tempDir, "source.ts"), prefix + "const old = 1;\n*/\n");
    harness.setResponses([
      fauxAssistantMessage([
        fauxToolCall("codemode", {
          code: `await Promise.all([
        tools.edit({path:"source.ts",edits:[{oldText:"const old = 1;",newText:"const next = 2;"}]}),
        tools.edit({path:"source.ts",edits:[{oldText:"/*",newText:"//"}]})
      ]);`,
        }),
      ]),
      fauxAssistantMessage("Done"),
    ]);

    await harness.prompt("Edit concurrently");
    const message = results(harness)[0];
    const captured = Value.Parse(DiffDetailsSchema, message?.details).codemodeDiffs;
    const first = captured.find((item) => item.diff.includes("+14 const next"));
    const syntax = Value.Parse(SyntaxSchema, first?.syntax);
    const addedIndex = first?.diff.split("\n").findIndex((line) => line.startsWith("+14"));
    expect(addedIndex).toBeGreaterThanOrEqual(0);
    expect(addedIndex === undefined ? undefined : syntax[addedIndex]).toEqual([
      ["const next = 2;".length, "comment"],
    ]);
    expect(JSON.stringify(message?.details)).not.toContain(prefix);
    expect(await readFile(path.join(harness.tempDir, "source.ts"), "utf8")).toBe(
      "//\n" + "unshown source\n".repeat(12) + "const next = 2;\n*/\n",
    );
  });

  it("renders saved syntax after reopening a session, without rereading edited files", async () => {
    const directory = await createTempDir("codemode-diffs-");
    onTestFinished(() => rm(directory, { recursive: true, force: true }));
    const options = { cwd: directory, sessionDir: path.join(directory, "sessions") };
    const harness = await setup(options);
    await writeFile(path.join(directory, "saved.ts"), "const before = 1;\n");
    harness.setResponses([
      fauxAssistantMessage([
        fauxToolCall("codemode", {
          code: edit("saved.ts", "const before = 1;", "const after = 2;"),
        }),
      ]),
      fauxAssistantMessage("Done"),
    ]);
    await harness.prompt("Edit");
    harness.cleanup();
    await rm(path.join(directory, "saved.ts"));

    const resumed = await setup({ ...options, continueSession: true });
    const message = results(resumed)[0];

    if (!message) throw new Error("Missing resumed Code Mode result");

    const renderers = resumed.session.extensionRunner.resolveToolRenderers("codemode", () =>
      resumed.session.getToolDefinition("codemode"),
    );

    const component = renderers?.renderResult?.(
      { content: message.content, details: message.details },
      { expanded: true, isPartial: false },
      createIdentityTheme(),
      toolRenderContext({ expanded: true }),
    );

    if (!component) throw new Error("Missing Code Mode renderer");
    const rendered = renderedRows(component, 100).join("\n");
    expect(rendered).toContain("saved.ts");
    expect(rendered).toContain("-1 const before = 1;");
    expect(rendered).toContain("+1 const after = 2;");
    const captured = Value.Parse(DiffDetailsSchema, message.details).codemodeDiffs;
    expect(Value.Check(SyntaxSchema, captured[0]?.syntax)).toBe(true);
    expect(rendered).toContain("✓ edit");
  });
});
