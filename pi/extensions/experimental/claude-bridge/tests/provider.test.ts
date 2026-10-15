// Provider registration across extension evaluations, and the session lifecycle around
// it. A subagent host can load the extension fresh for a child session while the first
// evaluation's provider keeps serving.

import { fauxProvider } from "@earendil-works/pi-ai";
import type { ExtensionAPI, SessionStartEvent } from "@earendil-works/pi-coding-agent";
import { afterEach, describe, expect, it } from "vite-plus/test";

import { createExtensionHost } from "../../../../tests/harness/extension-host.js";
import { Bridge } from "../bridge.js";
import { BridgeLifecycle, forwardRewrite } from "../provider.js";
import { forgetSessionCwd, sessionCwdFor } from "../session/cwd.js";
import { shared } from "../shared.js";
import { fakeQueryFunction } from "./helpers.js";

const PROVIDER_ID = "claude-bridge";

/** One extension evaluation: its own bridge and lifecycle, loaded into a pi host. */
async function evaluation(sessionId = "pi-session") {
  const bridge = new Bridge(fakeQueryFunction().run);
  let lifecycle: BridgeLifecycle | undefined;

  const host = createExtensionHost(
    (pi: ExtensionAPI) => {
      lifecycle = new BridgeLifecycle(pi, bridge);
      lifecycle.registerProvider();
    },
    { sessionId },
  );

  await host.ready;

  if (lifecycle === undefined) throw new Error("the extension did not load");

  const loaded = lifecycle;

  /** session_start with a model registry that has the provider registered, or not. */
  const start = (registered: boolean, reason: SessionStartEvent["reason"] = "startup") => {
    const existing = registered ? fauxProvider({ provider: PROVIDER_ID }).provider : undefined;

    const ctx = host.createContext({
      modelRegistry: { getProvider: (id) => (id === PROVIDER_ID ? existing : undefined) },
    });

    loaded.sessionStart({ type: "session_start", reason }, ctx);

    return ctx;
  };

  const registered = () => host.getRegisteredProviderConfigs().get(PROVIDER_ID);

  return { bridge, lifecycle: loaded, host, start, registered };
}

afterEach(() => {
  const state = shared();

  state.activeStream = undefined;
  state.markRebuildHooks.clear();
  forgetSessionCwd("pi-session");
});

describe("provider registration", () => {
  it("registers at load in the first evaluation, putting the models in the picker", async () => {
    const first = await evaluation();
    const config = first.registered();

    expect(config?.models?.length).toBeGreaterThan(0);
    expect(config?.streamSimple).toBeDefined();
    expect(shared().activeStream).toBe(config?.streamSimple);
  });

  it("registers a later evaluation at session_start when its registry lacks the provider", async () => {
    // The host gave the child its own registry: without a registration every
    // claude-bridge model fails there with "Model not found".
    const first = await evaluation();
    const later = await evaluation();

    expect(later.registered()).toBeUndefined();

    later.start(false);

    const config = later.registered();

    expect(config?.streamSimple).toBeDefined();
    expect(config?.streamSimple).not.toBe(first.registered()?.streamSimple);
    // The first evaluation still owns the process-wide slot.
    expect(shared().activeStream).toBe(first.registered()?.streamSimple);
  });

  it("leaves a later evaluation unregistered when its registry already has the provider", async () => {
    // The host passed the parent's registry down. Re-registering would replace the
    // parent's stream with this evaluation's empty-state one.
    await evaluation();

    const later = await evaluation();

    later.start(true);
    later.start(true);

    expect(later.registered()).toBeUndefined();
  });

  it("gives up the slot at shutdown so a reloaded evaluation registers at load again", async () => {
    const first = await evaluation();

    first.lifecycle.sessionShutdown(first.host.createContext());

    expect(shared().activeStream).toBeUndefined();

    const reloaded = await evaluation();

    expect(reloaded.registered()).toBeDefined();
    expect(shared().activeStream).toBe(reloaded.registered()?.streamSimple);
  });
});

describe("session lifecycle", () => {
  const mirror = { sessionId: "cc-1", cursor: 1, cwd: "/tmp" };

  it.each(["new", "resume", "fork"] as const)(
    "forgets every Claude Code conversation on a %s session",
    async (reason) => {
      const { bridge, start } = await evaluation();

      bridge.mirrors.set("pi-session", mirror);
      bridge.mirrors.set("pi-child", mirror);
      bridge.mirrors.rewritten.add("pi-child");

      start(false, reason);

      expect(bridge.mirrors.size).toBe(0);
      expect(bridge.mirrors.rewritten.size).toBe(0);
    },
  );

  it.each(["startup", "reload"] as const)(
    "keeps the conversations on a %s session start",
    async (reason) => {
      const { bridge, start } = await evaluation();

      bridge.mirrors.set("pi-session", mirror);

      start(false, reason);

      expect(bridge.mirrors.get("pi-session")).toEqual(mirror);
    },
  );

  it("runs the session's queries in its cwd from start until shutdown", async () => {
    const { lifecycle, host } = await evaluation();
    const ctx = host.createContext({ cwd: "/projects/session-cwd" });

    lifecycle.sessionStart({ type: "session_start", reason: "startup" }, ctx);

    expect(sessionCwdFor("pi-session")).toBe("/projects/session-cwd");

    lifecycle.sessionShutdown(ctx);

    expect(sessionCwdFor("pi-session")).toBe(process.cwd());
  });

  it("forgets every conversation at shutdown", async () => {
    const { bridge, lifecycle, host } = await evaluation();

    bridge.mirrors.set("pi-session", mirror);
    lifecycle.sessionShutdown(host.createContext());

    expect(bridge.mirrors.size).toBe(0);
  });
});

describe("forwardRewrite", () => {
  it("reaches every evaluation's bridge, wherever the rewriting session is served", async () => {
    const first = await evaluation();
    const later = await evaluation();

    forwardRewrite("pi-child", "session_compact:threshold:willRetry=false");

    expect(first.bridge.mirrors.rewritten.has("pi-child")).toBe(true);
    expect(later.bridge.mirrors.rewritten.has("pi-child")).toBe(true);
  });
});
