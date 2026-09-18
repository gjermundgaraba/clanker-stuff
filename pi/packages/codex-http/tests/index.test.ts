import { describe, expect, it, vi } from "vite-plus/test";

import { createCodexHttp } from "../index.js";

const origin = "https://chatgpt.com/backend-api/codex/responses";

describe("Codex routing cookies", () => {
  it("preserves synchronous transport failures", () => {
    const request = createCodexHttp();
    const failure = new Error("dispatch failed");
    const fetch = vi.fn<typeof globalThis.fetch>(() => {
      throw failure;
    });
    expect(() => request(origin, undefined, fetch)).toThrow(failure);
  });

  it("shares only routing cookies across endpoints and auth owners", async () => {
    const request = createCodexHttp();
    const fetch = vi
      .fn<typeof globalThis.fetch>()
      .mockResolvedValueOnce(
        new Response(null, {
          headers: [
            ["set-cookie", "__oailb=route; Path=/backend-api; Secure; HttpOnly"],
            ["set-cookie", "session=secret; Path=/; Secure"],
          ],
        }),
      )
      .mockResolvedValue(new Response());
    await request(origin, { headers: { authorization: "Bearer first" } }, fetch);
    for (const endpoint of ["codex/models", "wham/usage", "codex/responses"]) {
      await request(
        `https://chatgpt.com/backend-api/${endpoint}`,
        {
          headers: { authorization: "Bearer second" },
        },
        fetch,
      );
      const init = fetch.mock.calls.at(-1)?.[1];
      expect(new Headers(init?.headers).get("cookie")).toBe("__oailb=route");
      expect(init?.redirect).toBe("error");
    }
  });

  it("enforces host, path, HTTPS and suffix boundaries", async () => {
    const request = createCodexHttp();
    const fetch = vi
      .fn<typeof globalThis.fetch>()
      .mockResolvedValueOnce(
        new Response(null, {
          headers: {
            "set-cookie": "__oailb=route; Path=/backend-api; Secure",
          },
        }),
      )
      .mockResolvedValue(new Response());
    await request(origin, undefined, fetch);
    for (const url of [
      "https://chatgpt.com/",
      "https://chatgpt.com/backend-api-evil",
      "https://other.chatgpt.com/backend-api/codex/responses",
      "https://api.openai.com/backend-api/codex/responses",
      "https://chatgpt.com.evil.example/backend-api/codex/responses",
      "http://chatgpt.com/backend-api/codex/responses",
    ]) {
      await request(url, undefined, fetch);
      expect(new Headers(fetch.mock.calls.at(-1)?.[1]?.headers).has("cookie")).toBe(false);
    }
  });

  it("honors Domain, expiry, deletion, and explicit caller cookies", async () => {
    const request = createCodexHttp();
    const fetch = vi
      .fn<typeof globalThis.fetch>()
      .mockResolvedValueOnce(
        new Response(null, {
          headers: {
            "set-cookie": "__oailb=route; Domain=chatgpt.com; Path=/; Max-Age=3600; Secure",
          },
        }),
      )
      .mockResolvedValue(new Response());
    await request(origin, undefined, fetch);
    await request("https://sub.chatgpt.com/", undefined, fetch);
    expect(new Headers(fetch.mock.calls.at(-1)?.[1]?.headers).get("cookie")).toBe("__oailb=route");
    await request(origin, { headers: { cookie: "__oailb=explicit" } }, fetch);
    expect(new Headers(fetch.mock.calls.at(-1)?.[1]?.headers).get("cookie")).toBe(
      "__oailb=explicit",
    );
    fetch.mockResolvedValueOnce(
      new Response(null, {
        headers: {
          "set-cookie": "__oailb=; Domain=chatgpt.com; Path=/; Max-Age=0; Secure",
        },
      }),
    );
    await request(origin, undefined, fetch);
    await request(origin, undefined, fetch);
    expect(new Headers(fetch.mock.calls.at(-1)?.[1]?.headers).has("cookie")).toBe(false);
    fetch.mockResolvedValueOnce(
      new Response(null, {
        headers: {
          "set-cookie": "__oailb=expired; Path=/; Expires=Thu, 01 Jan 1970 00:00:00 GMT",
        },
      }),
    );
    await request(origin, undefined, fetch);
    await request(origin, undefined, fetch);
    expect(new Headers(fetch.mock.calls.at(-1)?.[1]?.headers).has("cookie")).toBe(false);
  });

  it.each([undefined, "follow", "error", "manual"] as const)(
    "protects automatic redirects while preserving %s policy",
    async (redirect) => {
      const request = createCodexHttp();
      const response = new Response(null, {
        status: 302,
        headers: { location: "https://example.org/" },
      });
      const fetch = vi.fn<typeof globalThis.fetch>().mockResolvedValue(response);
      expect(await request(origin, { redirect }, fetch)).toBe(response);
      expect(fetch.mock.calls[0]?.[1]?.redirect).toBe(redirect === "manual" ? "manual" : "error");
    },
  );

  it("keeps factory-created jars isolated", async () => {
    const first = createCodexHttp();
    const second = createCodexHttp();
    await first(
      origin,
      undefined,
      async () =>
        new Response(null, {
          headers: { "set-cookie": "__oailb=isolated; Path=/; Secure" },
        }),
    );
    await second(origin, undefined, async (_input, init) => {
      expect(new Headers(init?.headers).has("cookie")).toBe(false);
      return new Response();
    });
  });

  it("ignores invalid domains and cookies from custom endpoints", async () => {
    const request = createCodexHttp();
    const fetch = vi.fn<typeof globalThis.fetch>().mockResolvedValue(
      new Response(null, {
        headers: { "set-cookie": "__oailb=bad; Domain=chatgpt.com; Path=/" },
      }),
    );
    await request("https://example.org/", undefined, fetch);
    await request("http://chatgpt.com/", undefined, fetch);
    fetch.mockResolvedValueOnce(
      new Response(null, {
        headers: {
          "set-cookie": "__oailb=bad; Domain=chatgpt-staging.com; Path=/",
        },
      }),
    );
    await request(origin, undefined, fetch);
    fetch.mockResolvedValue(new Response());
    await request(origin, undefined, fetch);
    expect(new Headers(fetch.mock.calls.at(-1)?.[1]?.headers).has("cookie")).toBe(false);
  });
});
