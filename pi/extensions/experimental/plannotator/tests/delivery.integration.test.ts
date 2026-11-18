import assert from "node:assert/strict";

import { fauxAssistantMessage } from "@earendil-works/pi-ai";
import type { ExtensionFactory } from "@earendil-works/pi-coding-agent";
import { describe, expect, it, onTestFinished, vi } from "vite-plus/test";

import { createAgentSessionHarness } from "../../../../tests/harness/agent-session.js";
import { createExtensionHost } from "../../../../tests/harness/extension-host.js";
import extension from "../index.js";
import { createStarter, exited, signaled } from "./helpers.js";

const setup = async (extra: ExtensionFactory[] = []) => {
  const { pending, starter } = createStarter();
  const uiHost = createExtensionHost(() => {});
  const { ui } = uiHost.createContext();

  const env = await createAgentSessionHarness({
    extensionFactories: [
      (pi) => {
        extension(pi, starter);
      },
      ...extra,
    ],
    mode: "tui",
    settings: { compaction: { enabled: false }, retry: { enabled: false } },
    uiContext: ui,
  });

  onTestFinished(async () => {
    const shutdown = env.session.extensionRunner.emit({
      type: "session_shutdown",
      reason: "quit",
    });

    for (const child of pending) {
      child.resolve(signaled("SIGTERM"));
    }

    await shutdown;
    env.cleanup();
  });

  return {
    ...env,
    notifications: () => uiHost.getNotifications(),
    ui,
    complete(stdout: string) {
      const [child] = pending;
      assert.ok(
        child,
        "the command returned with the browser CLI still running"
      );
      child.resolve(exited(stdout));
    },
  };
};

const gate = () => {
  const entered = Promise.withResolvers<undefined>();
  const release = Promise.withResolvers<undefined>();

  onTestFinished(() => {
    release.resolve(undefined);
  });

  return {
    entered: entered.promise,
    release: () => {
      release.resolve(undefined);
    },
    hold: async () => {
      entered.resolve(undefined);
      await release.promise;
    },
  };
};

const notes = "Please clarify the assumptions.";
const annotation = JSON.stringify({ decision: "annotated", feedback: notes });

describe("Plannotator delivery in Pi", () => {
  it.each([
    { command: "/plannotator-review", stdout: notes },
    { command: "/plannotator-annotate docs.md", stdout: annotation },
    { command: "/plannotator-last", stdout: annotation },
  ])(
    "retains $command feedback after navigation without prompting the destination branch",
    async ({ command, stdout }) => {
      const env = await setup();
      env.setResponses([
        fauxAssistantMessage("Base"),
        fauxAssistantMessage("Original branch"),
        fauxAssistantMessage("Destination branch"),
        fauxAssistantMessage("Unexpected prompt"),
      ]);
      await env.prompt("Start");
      const base = env.sessionManager.getLeafId();
      assert.ok(base !== null);
      await env.prompt("Explore the original branch");
      await env.prompt(command);
      await env.session.navigateTree(base);
      await env.prompt("Explore the other branch");
      const destination = env.sessionManager.getLeafId();

      env.complete(stdout);
      await vi.waitFor(() => {
        expect(env.notifications().at(-1)?.message).toContain(
          "/plannotator-feedback"
        );
      });
      await env.prompt("/plannotator-feedback");
      expect(env.ui.getEditorText()).toContain(notes);
      expect(env.sessionManager.getLeafId()).toBe(destination);
      expect(env.getPendingResponseCount()).toBe(1);
    }
  );

  it("queues a normal follow-up even after the originating leaf advances", async () => {
    const request = gate();
    let holdNextRequest = false;

    const env = await setup([
      (pi) => {
        pi.on("before_provider_request", async () => {
          if (holdNextRequest) {
            holdNextRequest = false;
            await request.hold();
          }
        });
      },
    ]);

    env.setResponses([
      fauxAssistantMessage("Original"),
      fauxAssistantMessage("Next answer"),
      fauxAssistantMessage("Feedback answer"),
    ]);
    await env.prompt("Start");
    await env.prompt("/plannotator-review");
    holdNextRequest = true;
    const advance = env.prompt("Keep working on this branch");
    await request.entered;

    env.complete(notes);
    await vi.waitFor(() => {
      expect(env.session.getFollowUpMessages()).toStrictEqual([notes]);
    });
    request.release();
    await advance;
    expect(env.session.getLastAssistantText()).toBe("Feedback answer");
  });

  it("checks the branch again if Pi defers the handoff until after agent_settled", async () => {
    const settle = gate();
    let holdSettlement = false;

    const env = await setup([
      (pi) => {
        pi.on("agent_settled", async () => {
          if (holdSettlement) {
            holdSettlement = false;
            await settle.hold();
          }
        });
      },
    ]);

    env.setResponses([
      fauxAssistantMessage("Base"),
      fauxAssistantMessage("Original branch"),
      fauxAssistantMessage("Unexpected prompt"),
    ]);
    await env.prompt("Start");
    const base = env.sessionManager.getLeafId();
    assert.ok(base !== null);
    await env.prompt("/plannotator-review");

    holdSettlement = true;
    const advance = env.prompt("Explore original branch");
    await settle.entered;
    const handoff = vi.spyOn(env.session, "sendUserMessage");
    env.complete(notes);
    await vi.waitFor(() => {
      expect(handoff).toHaveBeenCalledOnce();
    });
    await env.session.navigateTree(base);
    settle.release();
    await advance;

    await env.prompt("/plannotator-feedback");
    expect(env.ui.getEditorText()).toBe(notes);
    expect(env.sessionManager.getLeafId()).toBe(base);
    expect(env.getPendingResponseCount()).toBe(1);
  });
});
