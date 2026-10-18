import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { fauxAssistantMessage } from "@earendil-works/pi-ai";
import { Type } from "typebox";
import { describe, expect, it, onTestFinished } from "vite-plus/test";

import { createAgentSessionHarness } from "../../../tests/harness/agent-session.js";
import type { AgentSessionHarnessOptions } from "../../../tests/harness/agent-session.js";
import extension from "../index.js";
import { skillBlock } from "../mentions.js";
import type { LoadedSkill } from "../mentions.js";

const PayloadSchema = Type.Object({ messages: Type.Array(Type.Unknown()) });

const BODIES = {
  alpha: "Alpha instructions; see $beta.",
  beta: "Beta instructions.",
} as const;

const setup = async (options: AgentSessionHarnessOptions = {}) => {
  const directory = await mkdtemp(path.join(tmpdir(), "dollah-skills-session-"));
  onTestFinished(() => rm(directory, { force: true, recursive: true }));

  const skill = (name: keyof typeof BODIES): LoadedSkill => ({
    content: `References are relative to ${path.join(directory, name)}.\n\n${BODIES[name]}`,
    location: path.join(directory, name, "SKILL.md"),
    name,
  });

  const skillPaths = await Promise.all(
    (["alpha", "beta"] as const).map(async (name) => {
      const { location } = skill(name);
      await mkdir(path.dirname(location));
      await writeFile(
        location,
        `---\nname: ${name}\ndescription: ${name} skill\n---\n${BODIES[name]}\n`,
      );

      return location;
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

  /** Conversation messages after the system prompt. */
  const conversation = () => harness.messages().filter((message) => message.role !== "system");

  return { ...harness, conversation, skill };
};

const userMessage = (text: string) => ({ content: [{ text, type: "text" }], role: "user" });

describe("skill mentions in a session", () => {
  it("records the skill block ahead of the typed text as the user message Pi sends", async () => {
    const harness = await setup();
    harness.setResponses([fauxAssistantMessage("done")]);
    await harness.prompt("Use $beta:");

    expect(harness.conversation()).toStrictEqual([
      expect.objectContaining(userMessage(`${skillBlock([harness.skill("beta")])}\n\nUse $beta:`)),
      expect.objectContaining({ role: "assistant" }),
    ]);
    const sent = JSON.stringify(harness.lastProviderPayload(PayloadSchema).messages);

    expect(sent).toContain("Beta instructions.");
    expect(sent).toContain("Use $beta:");
  });

  it("leaves a registered command to Pi, mentions included", async () => {
    const harness = await setup();
    harness.setResponses([fauxAssistantMessage("done")]);
    await harness.prompt("/skill:alpha use $beta");
    const sent = JSON.stringify(harness.lastProviderPayload(PayloadSchema).messages);

    expect(harness.conversation()[0]).toMatchObject(
      userMessage(`${skillBlock([harness.skill("alpha")])}\n\nuse $beta`),
    );
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
        expect(JSON.stringify(payloads[1])).toContain("Beta instructions.");
        expect(harness.conversation().findLast((message) => message.role === "user")).toMatchObject(
          userMessage(`${skillBlock([harness.skill("beta")])}\n\nUse $beta and $gamma`),
        );
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
        { content: "An unrelated wake", customType: "test.wake", display: false },
        { triggerTurn: true },
      );
      release.resolve();
      await submitted;
      const payloads = harness.providerPayloads(PayloadSchema);

      expect(payloads).toHaveLength(2);
      expect(JSON.stringify(payloads[0])).not.toContain("Alpha instructions;");
      expect(JSON.stringify(payloads[1])).toContain("Alpha instructions;");
      expect(JSON.stringify(payloads[1])).not.toContain("Beta instructions.");
      expect(harness.conversation().findLast((message) => message.role === "user")).toMatchObject(
        userMessage(`${skillBlock([harness.skill("alpha")])}\n\nUse $alpha`),
      );
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
