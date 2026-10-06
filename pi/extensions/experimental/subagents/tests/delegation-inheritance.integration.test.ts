import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { getExtensionStoragePaths } from "@clanker-stuff/pi-extension-paths";
import { fauxAssistantMessage, fauxToolCall, getCurrentSystemPrompt } from "@earendil-works/pi-ai";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import { Value } from "typebox/value";
import { describe, expect, it } from "vite-plus/test";

import { createAgentSessionHarness } from "../../../../tests/harness/agent-session.js";
import subagents from "../index.js";
import { readDelegation } from "../delegation.js";
import { TreeSchema } from "../protocol.js";

describe("caller delegation snapshots", () => {
  it.each([
    { name: "ordinary child", args: {}, reasoning: "low" },
    { name: "explicit effort", args: { reasoning_effort: "medium" }, reasoning: "medium" },
    { name: "changed model", args: { model: "faux/other" }, reasoning: "medium" },
    { name: "same model", args: { model: "faux/reasoner" }, reasoning: "low" },
    { name: "role effort", args: { agent_type: "reviewer" }, reasoning: "medium" },
    { name: "changed model role", args: { agent_type: "other" }, reasoning: "medium" },
  ])("$name inherits permission independently of thinking", async ({ args, reasoning }) => {
    const paths = getExtensionStoragePaths("subagents");

    await mkdir(path.dirname(paths.configFile), { recursive: true });
    await writeFile(
      paths.configFile,
      JSON.stringify({
        version: 2,
        roles: { reviewer: { thinking: "medium" }, other: { model: "faux/other" } },
      }),
    );

    const harness = await createAgentSessionHarness({
      provider: "faux",
      models: [
        { id: "reasoner", reasoning: true },
        { id: "other", reasoning: true },
      ],
      extensionFactories: [subagents],
    });

    const children: { prompt: string; reasoning: string | undefined }[] = [];
    let rootRequests = 0;

    harness.setResponses(
      Array.from({ length: 4 }, () => (context, options) => {
        const prompt = getCurrentSystemPrompt(context.messages);

        if (prompt.includes("You are subagent")) {
          children.push({ prompt, reasoning: options?.reasoning });

          return fauxAssistantMessage("child done");
        }

        rootRequests += 1;

        if (rootRequests === 1)
          return fauxAssistantMessage(
            fauxToolCall("spawn_agent", {
              ...args,
              task_name: "worker",
              message: "Bounded work.",
              fork_turns: "none",
            }),
            { stopReason: "toolUse" },
          );

        if (rootRequests === 2)
          return fauxAssistantMessage(fauxToolCall("wait_agent", { timeout_ms: 10_000 }), {
            stopReason: "toolUse",
          });

        return fauxAssistantMessage("root done");
      }),
    );

    try {
      harness.session.setThinkingLevel("low");
      await harness.prompt("/proactive");
      await harness.prompt("Delegate and wait.");
      expect(children).toHaveLength(1);
      expect(children[0]?.prompt).toContain("Proactive multi-agent delegation is enabled");
      expect(children[0]?.reasoning).toBe(reasoning);
      expect(
        harness.session.messages.find(
          (message) => message.role === "toolResult" && message.toolName === "spawn_agent",
        ),
      ).toMatchObject({ isError: false });
    } finally {
      await harness.session.extensionRunner.emit({ type: "session_shutdown", reason: "quit" });
      harness.cleanup();
      await rm(paths.configFile, { force: true });
    }
  });

  it.each(["explicit", "proactive"] as const)(
    "preserves a cold child's own %s policy and snapshots that nested caller, not the root",
    async (policy) => {
      const sessionDir = await mkdtemp(path.join(os.tmpdir(), "delegation-child-"));

      const harness = await createAgentSessionHarness({
        sessionDir,
        models: [{ id: "reasoner", reasoning: true }],
        extensionFactories: [subagents],
      });

      let rootRequests = 0;
      let workerRequests = 0;
      const workerPolicies: string[] = [];
      const nested: { prompt: string; reasoning: string | undefined }[] = [];

      harness.setResponses(
        Array.from({ length: 11 }, () => (context, options) => {
          const prompt = getCurrentSystemPrompt(context.messages);

          if (prompt.includes("You are subagent /root/worker/nested.")) {
            nested.push({ prompt, reasoning: options?.reasoning });

            return fauxAssistantMessage("nested done");
          }

          if (prompt.includes("You are subagent /root/worker.")) {
            workerRequests += 1;
            workerPolicies.push(prompt);

            if (workerRequests === 2)
              return fauxAssistantMessage(
                fauxToolCall("spawn_agent", {
                  task_name: "nested",
                  message: "Nested work.",
                  fork_turns: "none",
                }),
                { stopReason: "toolUse" },
              );

            if (workerRequests === 3)
              return fauxAssistantMessage(fauxToolCall("wait_agent", { timeout_ms: 10_000 }), {
                stopReason: "toolUse",
              });

            return fauxAssistantMessage("worker done");
          }

          rootRequests += 1;

          if (rootRequests === 1)
            return fauxAssistantMessage(
              fauxToolCall("spawn_agent", {
                task_name: "worker",
                message: "First work.",
                reasoning_effort: "medium",
                fork_turns: "none",
              }),
              { stopReason: "toolUse" },
            );

          if (rootRequests === 4)
            return fauxAssistantMessage(
              fauxToolCall("followup_task", {
                target: "worker",
                message: "Delegate nested work.",
              }),
              { stopReason: "toolUse" },
            );

          if (rootRequests === 2 || rootRequests === 5)
            return fauxAssistantMessage(
              fauxToolCall("wait_agent", {
                timeout_ms: 10_000,
              }),
              { stopReason: "toolUse" },
            );

          return fauxAssistantMessage("root done");
        }),
      );

      try {
        // Pi only dispatches reload session_start for sessions with native frontend bindings.
        await harness.session.bindExtensions({
          onError: (event) => {
            throw new Error(event.error);
          },
        });
        harness.session.setThinkingLevel("low");
        await harness.prompt("/proactive");
        await harness.prompt("Delegate and wait.");
        expect(workerPolicies).toHaveLength(1);
        // Native reload awaits tree shutdown, fencing retirement writes before editing a cold child.
        await harness.session.reload();

        const file = path.join(
          getExtensionStoragePaths("subagents").dataDir,
          "trees-v3",
          `${createHash("sha256").update(harness.sessionManager.getSessionId()).digest("hex")}.json`,
        );

        const raw: unknown = JSON.parse(await readFile(file, "utf-8"));
        const tree = Value.Parse(TreeSchema, raw);
        const worker = tree.nodes.find((node) => node.path === "/root/worker");

        if (worker === undefined) throw new Error("Missing worker");
        // Seed an owned branch policy through native persistence after every child runtime has closed.
        const childSession = SessionManager.open(worker.sessionFile);

        childSession.appendCustomEntry("subagents-delegation", policy);

        if (policy === "proactive") await harness.prompt("/proactive");
        expect(readDelegation(harness.sessionManager, "explicit")).toBe(
          policy === "proactive" ? "explicit" : "proactive",
        );
        await harness.prompt("Reuse worker and wait.");
        expect(workerPolicies[1]).toContain(
          policy === "proactive"
            ? "Proactive multi-agent delegation is enabled"
            : "Explicit delegation is enabled",
        );
        expect(nested).toHaveLength(1);
        expect(nested[0]?.prompt).toContain(
          policy === "proactive"
            ? "Proactive multi-agent delegation is enabled"
            : "Explicit delegation is enabled",
        );
        expect(nested[0]?.reasoning).toBe("medium");
        expect(harness.session.thinkingLevel).toBe("low");
      } finally {
        await harness.session.extensionRunner.emit({ type: "session_shutdown", reason: "quit" });
        harness.cleanup();
        await rm(sessionDir, { force: true, recursive: true });
      }
    },
  );
});
