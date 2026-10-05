import { describe, expect, it } from "vite-plus/test";
import { MAX_REQUEST_BYTES, observeRequest } from "../observation.js";

describe(observeRequest, () => {
  it("snapshots JSON without retaining it, omitting media but keeping credential-named arguments", () => {
    const payload = {
      model: "model",
      tools: [{ name: "login", input_schema: { properties: { token: { type: "string" } } } }],
      messages: [
        { role: "user", content: "original prompt" },
        {
          role: "assistant",
          content: [{ type: "tool_use", name: "login", input: { token: "TOOL-ARGUMENT" } }],
        },
        { type: "image", source: { type: "base64", data: "IMAGE-BYTES" } },
        { inlineData: { mimeType: "image/png", data: "GOOGLE-BYTES" } },
        { inlineData: { mimeType: "audio/mp3", data: "AUDIO-BYTES" } },
        { image_url: "data:image/png;base64,OPENAI-BYTES" },
      ],
    };

    const before = structuredClone(payload);
    const captured = observeRequest(payload);
    expect(payload).toEqual(before);
    payload.messages[0] = { role: "user", content: "later mutation" };

    const expected = {
      ...before,
      messages: [
        ...before.messages.slice(0, 2),
        { type: "image", source: { type: "base64", data: "[base64 media omitted]" } },
        { inlineData: { mimeType: "image/png", data: "[base64 media omitted]" } },
        { inlineData: { mimeType: "audio/mp3", data: "[base64 media omitted]" } },
        { image_url: "[base64 media omitted]" },
      ],
    };

    expect(captured.body).toBe(JSON.stringify(expected, null, 2));
    expect(captured.body).toContain("TOOL-ARGUMENT");
    expect(captured.format).toBe("json");
    expect(captured.truncated).toBe(false);
  });

  it("retains complete sub-limit payloads with many messages and a large leading system prompt", () => {
    const payload = {
      system: "s".repeat(66_000),
      messages: Array.from({ length: 129 }, (_, index) => ({
        role: "user",
        content: `message ${index}`,
      })),
      tools: [{ name: "tool", input_schema: { type: "object" } }],
    };

    const json = JSON.stringify(payload, null, 2);
    expect(Buffer.byteLength(json)).toBeLessThan(MAX_REQUEST_BYTES);
    expect(observeRequest(payload)).toMatchObject({ body: json, format: "json", truncated: false });
  });

  it("caps retained UTF-8 bytes rather than prematurely clipping characters or fields", () => {
    const suffix = "\n[request preview truncated]";

    const payload = {
      text:
        "a".repeat(
          MAX_REQUEST_BYTES - Buffer.byteLength(suffix) - Buffer.byteLength('{\n  "text": "') - 11,
        ) + "€🦄".repeat(MAX_REQUEST_BYTES),
    };

    const full = JSON.stringify(payload, null, 2);
    const captured = observeRequest(payload);

    expect(captured.format).toBe("text");
    expect(captured.truncated).toBe(true);
    expect(captured.body.includes("€")).toBe(true);
    expect(captured.body.includes("🦄")).toBe(true);
    expect(captured.body.includes("�")).toBe(false);
    expect(captured.body.endsWith(suffix)).toBe(true);
    const prefix = captured.body.slice(0, -suffix.length);
    expect(full.startsWith(prefix)).toBe(true);
    expect(Buffer.byteLength(captured.body)).toBeLessThanOrEqual(MAX_REQUEST_BYTES);
    expect(Buffer.byteLength(captured.body)).toBeGreaterThan(MAX_REQUEST_BYTES - 4);

    const exact = "x".repeat(MAX_REQUEST_BYTES - 2);
    expect(observeRequest(exact)).toMatchObject({
      body: JSON.stringify(exact),
      truncated: false,
      format: "json",
    });
  });

  it("uses normal JSON getter/toJSON semantics and reports unserializable inputs", () => {
    let calls = 0;

    const payload = {
      get input() {
        calls++;

        return "getter value";
      },
      serializable: { toJSON: () => ({ input: "toJSON value" }) },
    };

    expect(observeRequest(payload).body).toBe(
      JSON.stringify(
        {
          input: "getter value",
          serializable: { input: "toJSON value" },
        },
        null,
        2,
      ),
    );
    expect(calls).toBe(1);

    const cyclic: { self?: object } = {};
    cyclic.self = cyclic;

    for (const value of [
      cyclic,
      undefined,
      1n,
      {
        toJSON() {
          throw new Error("failed");
        },
      },
    ]) {
      expect(observeRequest(value)).toMatchObject({
        body: "Provider payload could not be serialized as JSON.",
        format: "text",
        truncated: false,
      });
    }

    for (const value of [null, false, 0, "hello"])
      expect(observeRequest(value).body).toBe(JSON.stringify(value));
  });
});
