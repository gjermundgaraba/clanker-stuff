import { createJiti } from "jiti/static";
import { expect, it } from "vite-plus/test";

it("shares cookie state across independent bundled-Pi Jiti loaders and reloads", async () => {
  const load = () =>
    createJiti(import.meta.url, { moduleCache: false, tryNative: false, fsCache: false }).import<
      typeof import("../index.js")
    >(new URL("../index.ts", import.meta.url).pathname);
  const first = await load();
  const second = await load();
  expect(first.fetchCodexHttp).not.toBe(second.fetchCodexHttp);
  const origin = "https://loader-test.chatgpt.com/backend-api/codex/responses";
  await first.fetchCodexHttp(
    origin,
    undefined,
    async () =>
      new Response(null, {
        headers: { "set-cookie": "__oailb=shared; Path=/backend-api; Secure" },
      }),
  );
  for (const loaded of [second, await load()]) {
    for (const [url, expected] of [
      ["https://loader-test.chatgpt.com/backend-api/wham/usage", "__oailb=shared"],
      ["https://other-loader-test.chatgpt.com/backend-api/wham/usage", null],
      ["https://loader-test.chatgpt.com/outside", null],
    ]) {
      await loaded.fetchCodexHttp(url!, undefined, async (_input, init) => {
        expect(new Headers(init?.headers).get("cookie")).toBe(expected);
        return new Response();
      });
    }
  }
  await second.fetchCodexHttp(
    origin,
    undefined,
    async () =>
      new Response(null, {
        headers: { "set-cookie": "__oailb=; Path=/backend-api; Secure; Max-Age=0" },
      }),
  );
  await first.fetchCodexHttp(origin, undefined, async (_input, init) => {
    expect(new Headers(init?.headers).has("cookie")).toBe(false);
    return new Response();
  });
});
