import { describe, expect, it } from "vite-plus/test";
import { mcpResultToPiContent, toGeneratedToolName } from "../bridge.js";

describe("MCP bridge", () => {
  it("generates stable bounded names without normalization collisions", () => {
    const pairs: [string, string][] = [
      ["foo-bar", "Search"],
      ["foo_bar", "search"],
      ["x".repeat(200), "y".repeat(200)],
      ["服务器", "查询"],
    ];
    const names = pairs.map(([server, tool]) => toGeneratedToolName(server, tool));
    expect(new Set(names).size).toBe(pairs.length);
    for (const [index, name] of names.entries()) {
      expect(name.length).toBeLessThanOrEqual(64);
      expect(name).toMatch(/^[a-zA-Z0-9_-]+$/u);
      expect(name).toBe(toGeneratedToolName(...pairs[index]));
    }
  });
  it("keeps captions and images in source order", () => {
    const content = [
      { type: "text" as const, text: "before" },
      { type: "image" as const, data: "aW1hZ2U=", mimeType: "image/png" },
      { type: "text" as const, text: "after" },
    ];
    expect(mcpResultToPiContent({ content }).content).toEqual(content);
  });
  it("does not duplicate equivalent JSON or unnecessarily spill a 30 KB result", () => {
    const structuredContent = { count: 1, result: "x".repeat(30_000) };
    const json = JSON.stringify({ result: structuredContent.result, count: 1 }, null, 2);
    const content = [
      { type: "text" as const, text: "caption" },
      { type: "image" as const, data: "aW1hZ2U=", mimeType: "image/png" },
      { type: "text" as const, text: json },
    ];
    const converted = mcpResultToPiContent({ content, structuredContent });
    expect(converted.content).toEqual(content);
    expect(converted.truncated).toBe(false);
    expect(converted.fullText).toBe(`caption\n${json}`);
  });

  it("retains distinct structured data alongside text and images", () => {
    const content = [
      { type: "text" as const, text: "caption" },
      { type: "image" as const, data: "aW1hZ2U=", mimeType: "image/png" },
      { type: "text" as const, text: '{"count":1}' },
    ];
    expect(mcpResultToPiContent({ content, structuredContent: { count: 2 } }).content).toEqual([
      ...content,
      { type: "text", text: JSON.stringify({ count: 2 }, null, 2) },
    ]);
  });
  it("preserves valid structured tool content", () => {
    const converted = mcpResultToPiContent({
      content: [],
      structuredContent: { count: 2, items: ["a", "b"] },
    });

    expect(converted.content).toContainEqual({
      text: JSON.stringify({ count: 2, items: ["a", "b"] }, null, 2),
      type: "text",
    });
  });
  it("reports truncation without mixing application notices into remote content", () => {
    const text = "line\n".repeat(3000);
    const converted = mcpResultToPiContent({ content: [{ type: "text", text }] });
    expect(converted.truncated).toBe(true);
    expect(converted.fullText).toBe(text);
    expect(converted.content).toHaveLength(1);
    expect(JSON.stringify(converted.content)).not.toContain("MCP output truncated");
  });
});
