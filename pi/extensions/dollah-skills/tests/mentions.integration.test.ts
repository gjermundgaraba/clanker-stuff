import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { fauxAssistantMessage } from "@earendil-works/pi-ai";
import { Type } from "typebox";
import { describe, expect, it, onTestFinished } from "vite-plus/test";

import { createAgentSessionHarness } from "../../../tests/harness/agent-session.js";
import type { AgentSessionHarnessOptions } from "../../../tests/harness/agent-session.js";
import extension from "../index.js";
import { LOADED_SKILLS_SECTION } from "../mentions.js";

const PayloadSchema = Type.Object({ messages: Type.Array(Type.Unknown()) });

/** Alpha's own instructions mention beta; only typed mentions may load it. */
const setup = async (options: AgentSessionHarnessOptions = {}) => {
  const directory = await mkdtemp(path.join(tmpdir(), "dollah-skills-session-"));
  onTestFinished(() => rm(directory, { force: true, recursive: true }));

  const skillPaths = await Promise.all(
    [
      ["alpha", "Alpha instructions; see $beta."],
      ["beta", "Beta instructions."],
    ].map(async ([name = "", body = ""]) => {
      const filePath = path.join(directory, name, "SKILL.md");
      await mkdir(path.dirname(filePath));
      await writeFile(filePath, `---\nname: ${name}\ndescription: ${name} skill\n---\n${body}\n`);

      return filePath;
    }),
  );

  const harness = await createAgentSessionHarness({
    ...options,
    extensionFactories: [extension],
    skillPaths,
  });

  onTestFinished(harness.cleanup);

  /** Every loaded-skills section the transcript recorded. */
  const loaded = () =>
    harness
      .messages()
      .flatMap((message) =>
        message.role === "system" && message.sections?.[LOADED_SKILLS_SECTION] !== undefined
          ? [message.sections[LOADED_SKILLS_SECTION]]
          : [],
      );

  return { harness, loaded };
};

describe("skill mentions in a session", () => {
  it("loads an idle mention into that turn's prompt section", async () => {
    const { harness, loaded } = await setup();
    harness.setResponses([fauxAssistantMessage("done")]);

    await harness.prompt("Use $beta:");

    expect(loaded()).toHaveLength(1);
    expect(loaded()[0]).toContain("Beta instructions.");
  });

  it("loads nothing that an expanded /skill file mentions", async () => {
    const { harness, loaded } = await setup();
    harness.setResponses([fauxAssistantMessage("done")]);

    await harness.prompt("/skill:alpha use $alpha");

    const sent = JSON.stringify(harness.lastProviderPayload(PayloadSchema).messages);
    expect(sent).toContain("see $beta");
    expect(sent).not.toContain("Beta instructions.");
    expect(loaded()).toStrictEqual([]);
  });

  it("warns that a queued mention loads nothing and sends it unchanged, without an extra turn", async () => {
    const { harness, loaded } = await setup();
    const notices: [string, string | undefined][] = [];
    await harness.session.bindExtensions({
      uiContext: {
        ...harness.session.extensionRunner.getUIContext(),
        notify: (message, type) => {
          notices.push([message, type]);
        },
      },
    });
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

    const running = harness.prompt("Start");
    await entered.promise;
    await harness.prompt("Use $beta and $gamma", { streamingBehavior: "steer" });
    release.resolve();
    await running;

    // Only a skill Pi knows is named; gamma is not one.
    expect(notices).toStrictEqual([
      [
        "Queued message: $beta not loaded. Queue /skill:beta instead, or send once Pi is idle.",
        "warning",
      ],
    ]);
    const payloads = harness.providerPayloads(PayloadSchema);
    expect(payloads).toHaveLength(2);
    expect(JSON.stringify(payloads.at(-1)?.messages)).toContain("Use $beta and $gamma");
    expect(JSON.stringify(payloads)).not.toContain("Beta instructions.");
    expect(loaded()).toStrictEqual([]);
  });

  it("leaves nothing in the session when Pi rejects the prompt", async () => {
    const { harness } = await setup({ withConfiguredAuth: false });

    await expect(harness.prompt("Use $beta")).rejects.toThrow();
    expect(harness.messages()).toStrictEqual([]);
  });
});
