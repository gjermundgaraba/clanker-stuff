import { Type } from "typebox";
import { Value } from "typebox/value";
import { describe, expect, it, vi } from "vite-plus/test";
import { createExtensionHost } from "../../../tests/harness/extension-host.js";
import { ContentTools, sumUsages } from "../index.js";

describe("content capabilities", () => {
  it("publishes structured text/images and preserves usage and errors on the result", async () => {
    const usage = {
      input: 2,
      output: 3,
      cacheRead: 4,
      cacheWrite: 0,
      totalTokens: 9,
      cost: { input: 1, output: 2, cacheRead: 3, cacheWrite: 0, total: 6 },
    };

    let source: ContentTools | undefined;

    const host = createExtensionHost((pi) => {
      source = new ContentTools(pi);
      source.registerTool({
        name: "probe",
        label: "Probe",
        description: "Probe",
        parameters: Type.Object({}),
        execute: async () => ({
          content: [
            { type: "text", text: "failed" },
            { type: "image", data: "AA==", mimeType: "image/png" },
          ],
          details: { value: 1 },
          isError: true,
          usage,
        }),
      });
    });

    await host.ready;

    if (!source) throw new Error("Missing source");
    source.setEnabled();
    const result = await host.runTool("probe", {});
    expect(result).toMatchObject({
      isError: true,
      usage,
      details: { value: 1 },
      structuredContent: {
        content: [
          { type: "text", text: "failed" },
          { type: "image", image_url: "data:image/png;base64,AA==" },
        ],
      },
    });
    const schema = host.getRegisteredTools().get("probe")?.definition.outputSchema;

    if (!schema) throw new Error("Missing output schema");
    expect(Value.Check(schema, result.structuredContent)).toBe(true);
  });

  it("changes owner enablement using ordinary direct/hidden registration without touching foreign tools", async () => {
    let source: ContentTools | undefined;
    const execute = vi.fn(async () => ({ content: [], details: undefined }));

    const host = createExtensionHost((pi) => {
      source = new ContentTools(pi);

      for (const name of ["one", "two"])
        source.registerTool({
          name,
          label: name,
          description: name,
          parameters: Type.Object({}),
          execute,
        });
    });

    await host.ready;

    if (!source) throw new Error("Missing source");
    host.setActiveTools(["foreign"]);
    source.setEnabled(["one"]);
    expect(host.getRegisteredTools().get("one")?.definition.exposure).toBe("direct");
    expect(host.getRegisteredTools().get("two")?.definition.exposure).toBe("hidden");
    expect(host.getActiveTools()).toEqual(["foreign", "one"]);
    source.setEnabled(["two"]);
    expect(host.getActiveTools()).toEqual(["foreign", "two"]);
    source.registerTool({
      name: "two",
      label: "Two",
      description: "Replacement",
      parameters: Type.Object({}),
      execute,
    });
    source.setEnabled(["two"]);
    expect(host.getRegisteredTools().get("two")?.definition.description).toBe("Replacement");
  });

  it("rejects a foreign name collision before registering any staged tools", async () => {
    let source: ContentTools | undefined;

    const definition = {
      name: "foreign",
      label: "Foreign",
      description: "Original",
      parameters: Type.Object({}),
      execute: async () => ({ content: [], details: undefined }),
    };

    const host = createExtensionHost((pi) => {
      pi.registerTool(definition);
      source = new ContentTools(pi);
    });

    await host.ready;

    if (!source) throw new Error("Missing source");
    source.registerTool({ ...definition, name: "safe" });
    source.registerTool({ ...definition, description: "Collision" });
    expect(() => source?.setEnabled()).toThrow("already registered");
    expect(host.getRegisteredTools().has("safe")).toBe(false);
    expect(host.getRegisteredTools().get("foreign")?.definition.description).toBe("Original");
  });

  it("sums received usage without altering input accounting", () => {
    const usage = {
      input: 2,
      output: 3,
      cacheRead: 1,
      cacheWrite: 0,
      totalTokens: 6,
      reasoning: 1,
      cost: { input: 1, output: 2, cacheRead: 0, cacheWrite: 0, total: 3 },
    };

    expect(sumUsages([])).toBeUndefined();
    expect(sumUsages([usage, usage])).toEqual({
      input: 4,
      output: 6,
      cacheRead: 2,
      cacheWrite: 0,
      totalTokens: 12,
      reasoning: 2,
      cost: { input: 2, output: 4, cacheRead: 0, cacheWrite: 0, total: 6 },
    });
    expect(usage.totalTokens).toBe(6);
  });
});
