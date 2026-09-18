import { execFile } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { describe, expect, it } from "vite-plus/test";

import { readOAuthState, withOAuthLock } from "../oauth-store.js";
import { setupMcpTest } from "./helpers.js";

const run = promisify(execFile);

const writer = fileURLToPath(new URL("./fixtures/oauth-writer.ts", import.meta.url));

describe("OAuth persistence", () => {
  const t = setupMcpTest();

  it("serializes read-modify-write across separate processes", async () => {
    const file = path.join(t.dataDir, "state.json");
    await Promise.all([
      run(process.execPath, [writer, file]),
      run(process.execPath, [writer, file]),
    ]);
    expect(await readOAuthState(file)).toEqual({
      tokens: { access_token: "16", token_type: "Bearer" },
    });
  });

  it("cancels a lock waiter without releasing another owner's lock", async () => {
    const file = path.join(t.dataDir, "state.auth");
    const started = Promise.withResolvers<void>();
    const release = Promise.withResolvers<void>();

    const first = withOAuthLock(file, undefined, async () => {
      started.resolve();
      await release.promise;
    });

    await started.promise;

    try {
      const controller = new AbortController();

      const second = withOAuthLock(file, controller.signal, async () => {
        throw new Error("Must not enter");
      });

      controller.abort();
      await expect(second).rejects.toMatchObject({ name: "AbortError" });
    } finally {
      release.resolve();
      await first;
    }

    await expect(withOAuthLock(file, undefined, async () => "released")).resolves.toBe("released");
  });
});
