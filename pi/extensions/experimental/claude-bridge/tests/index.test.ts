// The entrypoint's wiring: registration and the session lifecycle.

import { afterEach, describe, expect, it } from "vite-plus/test";

import { createExtensionHost } from "../../../../tests/harness/extension-host.js";
import { conversationFor } from "../conversations.js";
import { createClaudeBridge } from "../index.js";
import { sessionCwdFor } from "../session/cwd.js";
import { shared } from "../shared.js";
import { fakeQueryFunction } from "./helpers.js";

const SESSION_ID = "pi-session";

afterEach(() => {
  const state = shared();

  state.conversations.clear();
  state.sessionCwds.clear();
  state.uis.clear();
});

async function loaded() {
  const fake = fakeQueryFunction();
  const host = createExtensionHost(createClaudeBridge(fake.run), { sessionId: SESSION_ID });

  await host.ready;

  return { host, fake };
}

// Streams keep no state of their own, so a subagent host loading the extension fresh may
// register over the parent's provider without stranding its conversations.
it("registers the provider with its models at load", async () => {
  const { host } = await loaded();

  expect(host.getRegisteredProviderConfigs().get("claude-bridge")?.models?.length).toBeGreaterThan(
    0,
  );
});

describe("the session lifecycle", () => {
  it("runs the session's queries in its cwd from start until shutdown", async () => {
    const { host } = await loaded();
    const ctx = host.createContext({ cwd: "/projects/session-cwd" });

    await host.emitSessionStart(ctx);

    expect(sessionCwdFor(SESSION_ID)).toBe("/projects/session-cwd");

    await host.emitSessionShutdown(ctx);

    expect(sessionCwdFor(SESSION_ID)).toBe(process.cwd());
  });

  it("ends the session's conversation at shutdown, and only that one", async () => {
    const { host, fake } = await loaded();
    const own = conversationFor(SESSION_ID, fake.run);
    const other = conversationFor("other-session", fake.run);

    await host.emitSessionShutdown();

    expect(own.getSnapshot().status).toBe("stopped");
    expect(shared().conversations.has(SESSION_ID)).toBe(false);
    expect(other.getSnapshot().status).toBe("active");
  });
});
