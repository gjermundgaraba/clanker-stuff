import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { elicitationParamsSchema } from "../elicitation-schema.js";
import { describe, expect, it, vi } from "vite-plus/test";
import { elicit } from "../interactions.js";
import { setupMcpTest } from "./helpers.js";

describe("MCP interaction UI", () => {
  const t = setupMcpTest();

  it("strips terminal controls from form displays without changing field names or answers", async () => {
    const controls = "\x1b[2J\x1b]52;c;dGVzdA==\x07\x1b[31m\x1b[0m\r\b\u009b";
    const key = `note${controls}`;
    const value = `value${controls}`;
    const host = t.createExtensionHost(() => {}, { hasUI: true });
    const input = vi.fn<ExtensionContext["ui"]["input"]>().mockResolvedValue(value);
    let pickedTag = false;
    const select = vi.fn<ExtensionContext["ui"]["select"]>(async (_title, options) => {
      if (options.includes("Done")) {
        if (pickedTag) return "Done";
        pickedTag = true;
        return options[0];
      }
      return options[0] === "1. Choice" ? options[1] : options[0];
    });
    const result = await elicit(
      host.createContext({ ui: { select, input } }),
      `remote${controls}`,
      elicitationParamsSchema.parse({
        message: `Message${controls}\nNext\tline`,
        requestedSchema: {
          type: "object",
          properties: {
            [key]: { type: "string", default: `Suggested${controls}` },
            choice: {
              type: "string",
              title: `Title${controls}`,
              description: `Description${controls}`,
              oneOf: [
                { const: "plain", title: "Choice" },
                { const: value, title: `Choice${controls}` },
              ],
            },
            tags: {
              type: "array",
              items: { anyOf: [{ const: value, title: `Tag${controls}` }] },
            },
          },
          required: [key, "choice", "tags"],
        },
      }),
      new AbortController().signal,
    );
    expect(result).toEqual({
      action: "accept",
      content: { [key]: value, choice: value, tags: [value] },
    });
    expect(select.mock.calls[0]![0]).toBe("MCP remote: Message\nNext   line");
    expect(select.mock.calls[1]![0]).toContain("Title — Description");
    expect(select.mock.calls[1]![1]).toEqual(["1. Choice", "2. Choice"]);
    expect(input.mock.calls[0]![0]).toContain("\nnote");
    expect(input.mock.calls[0]![1]).toBe("Suggested: Suggested");
    for (const text of [
      ...select.mock.calls.flatMap(([title, options]) => [title, ...options]),
      ...input.mock.calls.flatMap(([title, placeholder]) => [title, placeholder ?? ""]),
    ]) {
      expect(text.replaceAll("\n", "")).not.toMatch(/\p{Cc}/u);
    }
  });

  it("sanitizes URL interaction titles and notifications before navigation is accepted", async () => {
    const controls = "\x1b]52;c;dGVzdA==\x1b\\\x1b[2J";
    const host = t.createExtensionHost(() => {}, { hasUI: true });
    const select = vi
      .fn<ExtensionContext["ui"]["select"]>()
      .mockResolvedValueOnce("Open URL")
      .mockResolvedValueOnce("Completed");
    const notify = vi.fn<ExtensionContext["ui"]["notify"]>();
    const result = await elicit(
      host.createContext({ mode: "rpc", ui: { select, notify } }),
      `remote${controls}`,
      { mode: "url", message: `Verify${controls}`, url: "https://example.com/verify" },
      new AbortController().signal,
    );
    expect(result).toEqual({ action: "accept" });
    expect(select.mock.calls[0]![0]).toBe("MCP remote: Verify\nhttps://example.com/verify");
    expect(notify).toHaveBeenCalledWith(
      "Open https://example.com/verify to complete the request from remote",
      "info",
    );
    expect(select.mock.calls[1]![0]).not.toContain("\x1b");
  });

  it("preserves ordinary and inherited-property names as own form answers", async () => {
    const host = t.createExtensionHost(() => {}, { hasUI: true });
    const input = vi
      .fn<ExtensionContext["ui"]["input"]>()
      .mockResolvedValueOnce("")
      .mockResolvedValueOnce("prototype answer")
      .mockResolvedValueOnce("constructor answer")
      .mockResolvedValueOnce("string answer")
      .mockResolvedValueOnce("ordinary answer");
    const select = vi
      .fn<ExtensionContext["ui"]["select"]>()
      .mockResolvedValueOnce("Fill form")
      .mockResolvedValueOnce("Accept");
    const params = elicitationParamsSchema.parse(
      JSON.parse(`{
        "mode": "form",
        "message": "Provide values",
        "requestedSchema": {
          "type": "object",
          "properties": {
            "__proto__": { "type": "string", "minLength": 1 },
            "constructor": { "type": "string", "minLength": 1 },
            "toString": { "type": "string", "minLength": 1 },
            "ordinary": { "type": "string", "minLength": 1 }
          },
          "required": ["__proto__", "constructor", "toString", "ordinary"]
        }
      }`),
    );
    const result = await elicit(
      host.createContext({ ui: { select, input } }),
      "remote",
      params,
      new AbortController().signal,
    );
    expect(result.action).toBe("accept");
    expect(Object.getPrototypeOf(result.content)).toBeNull();
    expect(Object.keys(result.content!)).toEqual([
      "__proto__",
      "constructor",
      "toString",
      "ordinary",
    ]);
    const serialized = JSON.stringify(result.content);
    expect(serialized).toBe(
      '{"__proto__":"prototype answer","constructor":"constructor answer","toString":"string answer","ordinary":"ordinary answer"}',
    );
    expect(JSON.parse(serialized)["__proto__"]).toBe("prototype answer");
    expect(input).toHaveBeenCalledTimes(5);
  });

  it("accepts a URL completion notification when Pi's aborted select resolves undefined", async () => {
    const host = t.createExtensionHost(() => {}, { hasUI: true });
    const completed = new AbortController();
    const select = vi
      .fn<ExtensionContext["ui"]["select"]>()
      .mockResolvedValueOnce("Open URL")
      .mockImplementationOnce(
        (_title, _options, opts) =>
          new Promise((resolve) =>
            opts!.signal!.addEventListener("abort", () => resolve(undefined), { once: true }),
          ),
      );
    const ctx = host.createContext({ mode: "rpc", ui: { select } });
    const result = elicit(
      ctx,
      "remote",
      {
        mode: "url",
        elicitationId: "interaction-1",
        message: "Verify",
        url: "https://example.com/verify",
      },
      new AbortController().signal,
      completed.signal,
    );
    await expect.poll(() => select.mock.calls.length).toBe(2);
    completed.abort();
    await expect(result).resolves.toEqual({ action: "accept" });
  });

  it.each([
    ["email", "not-email", "ada@example.com"],
    ["date", "2026-02-30", "2026-09-13"],
    ["date-time", "2026-09-13", "2026-09-13T12:00:00Z"],
    ["uri", "not a uri", "https://example.com/"],
  ] as const)(
    "validates %s format before accepting a typed form",
    async (format, invalid, valid) => {
      const host = t.createExtensionHost(() => {}, { hasUI: true });
      const input = vi
        .fn<ExtensionContext["ui"]["input"]>()
        .mockResolvedValueOnce(invalid)
        .mockResolvedValueOnce(valid);
      const select = vi
        .fn<ExtensionContext["ui"]["select"]>()
        .mockResolvedValueOnce("Fill form")
        .mockResolvedValueOnce("Accept");
      const ctx = host.createContext({ ui: { select, input } });
      const result = await elicit(
        ctx,
        "remote",
        {
          mode: "form",
          message: "Provide value",
          requestedSchema: {
            type: "object",
            properties: { value: { type: "string", format } },
            required: ["value"],
          },
        },
        new AbortController().signal,
      );
      expect(result).toEqual({ action: "accept", content: { value: valid } });
      expect(input).toHaveBeenCalledTimes(2);
    },
  );

  it("counts Unicode code points and leaves suggested defaults unsubmitted", async () => {
    const host = t.createExtensionHost(() => {}, { hasUI: true });
    const input = vi.fn<ExtensionContext["ui"]["input"]>().mockResolvedValue("🐈");
    const select = vi
      .fn<ExtensionContext["ui"]["select"]>()
      .mockResolvedValueOnce("Fill form")
      .mockResolvedValueOnce("Accept");
    const ctx = host.createContext({ ui: { select, input } });
    const result = await elicit(
      ctx,
      "remote",
      {
        message: "Name",
        requestedSchema: {
          type: "object",
          properties: { value: { type: "string", minLength: 1, maxLength: 1, default: "X" } },
          required: ["value"],
        },
      },
      new AbortController().signal,
    );
    expect(result).toEqual({ action: "accept", content: { value: "🐈" } });
    expect(input.mock.calls[0]![1]).toBe("Suggested: X");
  });
});
