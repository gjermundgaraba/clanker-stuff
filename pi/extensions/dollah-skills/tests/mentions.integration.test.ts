import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { fauxAssistantMessage } from "@earendil-works/pi-ai";
import { Type } from "typebox";
import { describe, expect, it, onTestFinished } from "vite-plus/test";

import { createAgentSessionHarness } from "../../../tests/harness/agent-session.js";
import type { AgentSessionHarnessOptions } from "../../../tests/harness/agent-session.js";
import extension from "../index.js";

const PayloadSchema = Type.Object({ messages: Type.Array(Type.Unknown()) });

const setup = async (options: AgentSessionHarnessOptions = {}) => {
  const directory = await mkdtemp(path.join(tmpdir(), "dollah-skills-session-"));
  onTestFinished(() => rm(directory, { force: true, recursive: true }));

  const skillPaths = await Promise.all(
    (
      [
        ["alpha", "Alpha instructions; see $beta."],
        ["beta", "Beta instructions."],
      ] as const
    ).map(async ([name, body]) => {
      const filePath = path.join(directory, name, "SKILL.md");
      await mkdir(path.dirname(filePath));
      await writeFile(filePath, `---\nname: ${name}\ndescription: ${name} skill\n---\n${body}\n`);

      return filePath;
    }),
  );

  const harness = await createAgentSessionHarness({
    ...options,
    extensionFactories: [extension, ...(options.extensionFactories ?? [])],
    skillPaths,
  });

  onTestFinished(async () => {
    await harness.session.abort();
    harness.cleanup();
  });

  return harness;
};

describe("skill mentions in a session", () => {
  it("records the expanded skill with the user input sent to the provider", async () => {
    const harness = await setup();
    harness.setResponses([fauxAssistantMessage("done")]);
    await harness.prompt("Use $beta:");
    const user = harness.messages().find((message) => message.role === "user");

    expect(JSON.stringify(user)).toContain("Beta instructions.");
    expect(JSON.stringify(harness.lastProviderPayload(PayloadSchema).messages)).toContain(
      "Beta instructions.",
    );
  });

  it("loads nothing that an expanded /skill file mentions", async () => {
    const harness = await setup();
    harness.setResponses([fauxAssistantMessage("done")]);
    await harness.prompt("/skill:alpha use $alpha");
    const sent = JSON.stringify(harness.lastProviderPayload(PayloadSchema).messages);

    expect(sent).toContain("see $beta");
    expect(sent).not.toContain("Beta instructions.");
  });

  it.each(["steer", "followUp"] as const)(
    "carries an expanded %s message through Pi's native queue",
    async (streamingBehavior) => {
      const harness = await setup();
      const entered = Promise.withResolvers<void>();
      const release = Promise.withResolvers<void>();
      harness.setResponses([
        async () => {
          entered.resolve();
          await release.promise;

          return fauxAssistantMessage("first");
        },
        fauxAssistantMessage("second"),
      ]);

      try {
        const running = harness.prompt("Start");
        await entered.promise;
        await harness.prompt("Use $beta and $gamma", { streamingBehavior });
        release.resolve();
        await running;
        const payloads = harness.providerPayloads(PayloadSchema);

        expect(payloads).toHaveLength(2);
        expect(JSON.stringify(payloads[0])).not.toContain("Beta instructions.");
        expect(JSON.stringify(payloads[1])).toContain("Use $beta and $gamma");
        expect(JSON.stringify(payloads[1])).toContain("Beta instructions.");
        const user = harness.messages().findLast((message) => message.role === "user");
        expect(JSON.stringify(user)).toContain("Beta instructions.");
      } finally {
        release.resolve();
      }
    },
  );

  it("keeps an in-flight submission's expansion through an unrelated custom wake", async () => {
    const entered = Promise.withResolvers<void>();
    const release = Promise.withResolvers<void>();

    const harness = await setup({
      extensionFactories: [
        (pi) => {
          pi.on("input", async () => {
            entered.resolve();
            await release.promise;
          });
        },
      ],
    });

    harness.setResponses([fauxAssistantMessage("wake"), fauxAssistantMessage("user")]);

    try {
      const submitted = harness.prompt("Use $alpha");
      await entered.promise;
      expect(harness.session.isIdle).toBe(true);
      await harness.session.sendCustomMessage(
        {
          customType: "test.wake",
          content: "An unrelated wake",
          display: false,
        },
        { triggerTurn: true },
      );
      release.resolve();
      await submitted;
      const payloads = harness.providerPayloads(PayloadSchema);

      expect(payloads).toHaveLength(2);
      expect(JSON.stringify(payloads[0])).not.toContain("Alpha instructions;");
      expect(JSON.stringify(payloads[1])).toContain("Alpha instructions;");
      expect(JSON.stringify(payloads[1])).not.toContain("Beta instructions.");
    } finally {
      release.resolve();
    }
  });

  it("leaves nothing in the session when Pi rejects the prompt", async () => {
    const harness = await setup({ withConfiguredAuth: false });

    await expect(harness.prompt("Use $beta")).rejects.toThrow();
    expect(harness.messages()).toStrictEqual([]);
  });
});
