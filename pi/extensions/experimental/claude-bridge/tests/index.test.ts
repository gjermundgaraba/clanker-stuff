// The entrypoint's wiring: registration and the session lifecycle, observed through the
// provider it registers.

import { describe, expect, it, vi } from "vite-plus/test";

import { createExtensionHost } from "../../../../tests/harness/extension-host.js";
import { createClaudeBridge } from "../index.js";
import { fakeQueryFunction, testModel, transcript } from "./helpers.js";
import type { FakeQuery } from "./helpers.js";

const SESSION_ID = "pi-session";

async function loaded() {
  const fake = fakeQueryFunction();
  const host = createExtensionHost(createClaudeBridge(fake.run), { sessionId: SESSION_ID });

  await host.ready;

  const config = host.getRegisteredProviderConfigs().get("claude-bridge");

  /** A provider call for `sessionId`, and the query it starts. */
  const ask = async (sessionId: string): Promise<FakeQuery> => {
    const count = fake.queries.length;

    config?.streamSimple?.(
      testModel(),
      transcript({ messages: [{ role: "user", content: "hi", timestamp: 0 }] }),
      { sessionId },
    );

    return vi.waitFor(() => {
      const started = fake.queries[count];

      if (started === undefined) throw new Error("no query started");

      return started;
    });
  };

  return { host, config, ask };
}

it("registers the provider with its models at load", async () => {
  const { config } = await loaded();

  expect(config?.models?.length).toBeGreaterThan(0);
});

describe("the session lifecycle", () => {
  it("runs the session's queries in its cwd from start until shutdown", async () => {
    const { host, ask } = await loaded();
    const ctx = host.createContext({ cwd: "/projects/session-cwd" });

    await host.emitSessionStart(ctx);

    const during = await ask(SESSION_ID);

    expect(during.params.options.cwd).toBe("/projects/session-cwd");

    await host.emitSessionShutdown(ctx);

    expect((await ask(SESSION_ID)).params.options.cwd).toBe(process.cwd());
  });

  it("ends the session's conversation at shutdown, and only that one", async () => {
    const { host, ask } = await loaded();
    const own = await ask(SESSION_ID);
    const other = await ask("other-session");

    await host.emitSessionShutdown();

    expect(own.closed).toBe(true);
    expect(other.closed).toBe(false);
  });
});
