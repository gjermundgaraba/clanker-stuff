import { resolveJsonSchemaStrictSampling } from "@earendil-works/pi-ai/api/constrained-sampling";
import { initTheme } from "@earendil-works/pi-coding-agent";
import { describe, expect, it, vi } from "vite-plus/test";

import { createExtensionHost } from "../../../tests/harness/extension-host.js";
import {
  createCustomUiDriver,
  createKeybindings,
} from "../../../tests/harness/tui.js";
import { Coordinator } from "../coordinator.js";
import extension from "../index.js";
import { QuestionnaireParameters, validateQuestionnaire } from "../request.js";

describe("questionnaire contract", () => {
  it.each([true, false])(
    "rejects invalid requests at the tool boundary with wait: %s",
    async (wait) => {
      const host = createExtensionHost(extension);
      await host.ready;
      const question = { id: "q", header: "Question", question: "Proceed?" };

      await expect(
        host.runTool("request_user_input", {
          wait,
          questions: [question, question],
        })
      ).rejects.toThrow("Duplicate question ID");
      await expect(
        host.runTool("request_user_input", { wait, questions: [] })
      ).rejects.toThrow("Invalid questionnaire arguments");
    }
  );

  it("opens the same inbox from Alt+I and /answers", async () => {
    const answer = vi
      .spyOn(Coordinator.prototype, "answer")
      .mockResolvedValue(undefined);

    try {
      const host = createExtensionHost(extension);
      await host.ready;
      await host.runShortcut("alt+i");
      await host.runCommand("answers");
      expect(answer).toHaveBeenCalledTimes(2);
      expect(answer.mock.contexts[0]).toBe(answer.mock.contexts[1]);
    } finally {
      answer.mockRestore();
    }
  });

  it("fails a blocking questionnaire whose branch changed while it was open", async () => {
    initTheme("dark");
    const driver = createCustomUiDriver({ keybindings: createKeybindings({}) });
    const host = createExtensionHost(extension);
    const ctx = host.createToolContext({ ui: { custom: driver.custom } });
    await host.emitSessionStart(ctx);
    const question = { id: "q1", header: "Tests", question: "Which test?" };

    const asking = host.runTool(
      "request_user_input",
      { wait: true, questions: [question] },
      { ctx }
    );

    await expect.poll(() => driver.component).toBeDefined();
    await host.emitSessionTree(ctx);

    await expect(asking).rejects.toThrow(
      "Questionnaire belongs to an inactive session branch"
    );
  });

  it("registers one question tool with a schema strict sampling can represent", async () => {
    const host = createExtensionHost(extension);
    await host.ready;

    const tools = [...host.getRegisteredTools()].map(
      ([name, { definition }]) => ({
        executionMode: definition.executionMode,
        name,
        parameters: definition.parameters,
        renders:
          definition.renderCall !== undefined &&
          definition.renderResult !== undefined,
        strict: resolveJsonSchemaStrictSampling(definition, true),
      })
    );

    expect(tools).toStrictEqual([
      {
        executionMode: "sequential",
        name: "request_user_input",
        parameters: QuestionnaireParameters,
        renders: true,
        strict: true,
      },
    ]);
  });

  it("owns the limits the structural schemas no longer carry", () => {
    const question = { id: "q1", header: "Tests", question: "Which test?" };

    expect(
      validateQuestionnaire({ wait: false, questions: [question] })
    ).toStrictEqual({ wait: false, questions: [question] });

    for (const invalid of [
      {},
      { questions: [question] },
      { wait: true, questions: [] },
      {
        wait: true,
        questions: Array.from({ length: 6 }, (_, i) => ({
          ...question,
          id: `q${i}`,
        })),
      },
      { wait: true, questions: [{ ...question, id: "1-leading-digit" }] },
      { wait: true, questions: [{ ...question, header: "x".repeat(65) }] },
      { wait: true, questions: [{ ...question, options: [] }] },
      { wait: true, questions: [question], unknown: true },
    ]) {
      expect(() => validateQuestionnaire(invalid)).toThrow(
        "Invalid questionnaire arguments"
      );
    }

    expect(() =>
      validateQuestionnaire({
        wait: true,
        questions: [
          {
            ...question,
            options: [{ id: "unit", label: "Unit tests" }],
            recommendation: { option_ids: ["missing"], reason: "why" },
          },
        ],
      })
    ).toThrow(/Invalid recommendation/u);
  });
});
