import { Type } from "typebox";
import { describe, expect, it, vi } from "vite-plus/test";

import { defaultFetchJson } from "../http.js";

describe(defaultFetchJson, () => {
  it("classifies an AbortSignal timeout as a request timeout", async () => {
    const timeout = vi.spyOn(AbortSignal, "timeout").mockReturnValue(AbortSignal.abort());
    vi.stubGlobal("fetch", async () => {
      throw new Error("aborted");
    });

    try {
      await expect(
        defaultFetchJson("https://example.test", Type.Object({}), { timeoutMs: 1 }),
      ).resolves.toStrictEqual({ kind: "response", message: "request timed out", ok: false });
      expect(timeout).toHaveBeenCalledWith(1);
    } finally {
      timeout.mockRestore();
      vi.unstubAllGlobals();
    }
  });
});

describe("usage HTTP boundaries", () => {
  const schema = Type.Object({ remaining: Type.Number() });

  it.each([
    {
      body: "",
      status: 200,
      result: { ok: false, kind: "payload", message: "invalid usage payload" },
    },
    {
      body: '{"remaining":5}',
      status: 401,
      result: { ok: false, kind: "response", message: "HTTP 401", status: 401 },
    },
    {
      body: '{"error":{"message":"OpenCode Go subscription required."}}',
      status: 403,
      result: {
        ok: false,
        kind: "response",
        message: "OpenCode Go subscription required.",
        status: 403,
      },
    },
    {
      body: "{}",
      status: 503,
      result: { ok: false, kind: "response", message: "HTTP 503", status: 503 },
    },
    {
      body: "{broken",
      status: 200,
      result: { ok: false, kind: "response", message: "invalid JSON response" },
    },
    {
      body: '{"remaining":"5"}',
      status: 200,
      result: { ok: false, kind: "payload", message: "invalid usage payload" },
    },
    {
      body: '{"remaining":5,"extra":true}',
      status: 200,
      result: { ok: true, json: { remaining: 5, extra: true } },
    },
  ])("classifies status $status with body $body", async ({ body, status, result }) => {
    vi.stubGlobal("fetch", async () => new Response(body, { status }));

    try {
      await expect(
        defaultFetchJson("https://example.test", schema, { timeoutMs: 1000 }),
      ).resolves.toStrictEqual(result);
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("preserves acquisition failure diagnostics", async () => {
    vi.stubGlobal("fetch", async () => {
      throw new Error("connection reset");
    });

    try {
      await expect(
        defaultFetchJson("https://example.test", schema, { timeoutMs: 1000 }),
      ).resolves.toStrictEqual({ ok: false, kind: "response", message: "connection reset" });
    } finally {
      vi.unstubAllGlobals();
    }
  });
});
