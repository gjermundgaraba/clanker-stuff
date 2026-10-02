import { describe, expect, it } from "vite-plus/test";
import { MAX_REQUEST_BYTES, observeRequest } from "../observation.js";

describe(observeRequest, () => {
  it("snapshots JSON without retaining it, omitting credential values/media but preserving schemas", () => {
    const schema = {
      type: "object",
      properties: {
        password: { type: "string", description: "Password parameter" },
        auth: { type: "object", properties: { mode: { type: "string" } } },
        secret: false,
      },
      required: ["password"],
      $defs: { authentication: { type: "string" } },
    };

    const payload = {
      model: "model",
      api_key: "ACTUAL-KEY",
      token: "BARE-TOKEN",
      auth: { accessToken: "ACCESS-TOKEN" },
      headers: { Authorization: "Bearer HEADER-TOKEN" },
      tools: [{ name: "password", input_schema: schema }],
      messages: [
        { role: "user", content: "original prompt" },
        { type: "image", source: { type: "base64", data: "IMAGE-BYTES" } },
        { inlineData: { mimeType: "image/png", data: "GOOGLE-BYTES" } },
        { inlineData: { mimeType: "audio/mp3", data: "AUDIO-BYTES" } },
        { image_url: "data:image/png;base64,OPENAI-BYTES" },
      ],
    };

    const before = structuredClone(payload);
    const captured = observeRequest(payload);
    expect(payload).toEqual(before);
    payload.messages[0]!.content = "later mutation";

    const expected = {
      ...before,
      api_key: "[credential omitted]",
      token: "[credential omitted]",
      auth: { accessToken: "[credential omitted]" },
      headers: { Authorization: "[credential omitted]" },
      messages: [
        before.messages[0],
        { type: "image", source: { type: "base64", data: "[base64 media omitted]" } },
        { inlineData: { mimeType: "image/png", data: "[base64 media omitted]" } },
        { inlineData: { mimeType: "audio/mp3", data: "[base64 media omitted]" } },
        { image_url: "[base64 media omitted]" },
      ],
    };

    expect(captured.body).toBe(JSON.stringify(expected, null, 2));
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
