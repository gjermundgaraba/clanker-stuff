import { describe, expect, it, vi } from "vite-plus/test";
import { resolveJsonSchemaStrictSampling } from "@earendil-works/pi-ai/api/constrained-sampling";
import { createExtensionHost } from "../../../tests/harness/extension-host.js";
import extension from "../index.js";
import { Coordinator } from "../coordinator.js";
import {
  QuestionnaireParameters,
  RevisionParameters,
  validateQuestionnaire,
  validateRevision,
} from "../request.js";

describe("questionnaire contract", () => {
  it.each(["request_user_input", "request_user_input_async"])(
    "%s rejects invalid requests at the tool boundary",
    async (name) => {
      const host = createExtensionHost(extension);
      await host.ready;
      const question = { id: "q", header: "Question", question: "Proceed?" };

      await expect(host.runTool(name, { questions: [question, question] })).rejects.toThrow(
        "Duplicate question ID",
      );
      await expect(host.runTool(name, { questions: [] })).rejects.toThrow();
    },
  );
  it("opens the same inbox from Alt+I and /answers", async () => {
    const answer = vi.spyOn(Coordinator.prototype, "answer").mockResolvedValue(undefined);

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
  it("registers the question tools with schemas strict sampling can represent", async () => {
    const host = createExtensionHost(extension);
    await host.ready;

    const tools = [...host.getRegisteredTools()].map(([name, { definition }]) => ({
      executionMode: definition.executionMode,
      name,
      parameters: definition.parameters,
      renders: definition.renderCall !== undefined && definition.renderResult !== undefined,
      strict: resolveJsonSchemaStrictSampling(definition, true),
    }));

    expect(tools).toStrictEqual([
      {
        executionMode: "sequential",
        name: "request_user_input",
        parameters: QuestionnaireParameters,
        renders: true,
        strict: true,
      },
      {
        executionMode: "sequential",
        name: "request_user_input_async",
        parameters: QuestionnaireParameters,
        renders: true,
        strict: true,
      },
      {
        executionMode: "sequential",
        name: "revise_user_input",
        parameters: RevisionParameters,
        renders: true,
        strict: true,
      },
    ]);
  });
  it("owns the limits the structural schemas no longer carry", () => {
    const question = { id: "q1", header: "Tests", question: "Which test?" };

    expect(validateQuestionnaire({ questions: [question] })).toStrictEqual({
      questions: [question],
    });
    expect(
      validateRevision({ interaction_id: "i1", base_revision: 1, reason: "Update" }),
    ).toStrictEqual({ interaction_id: "i1", base_revision: 1, reason: "Update" });

    for (const invalid of [
      {},
      { questions: [] },
      { questions: Array.from({ length: 6 }, (_, i) => ({ ...question, id: `q${i}` })) },
      { questions: [{ ...question, id: "1-leading-digit" }] },
      { questions: [{ ...question, header: "x".repeat(65) }] },
      { questions: [{ ...question, options: [] }] },
      { questions: [question], unknown: true },
      { questions: [{ title: "Retired shape" }] },
    ]) {
      expect(() => validateQuestionnaire(invalid)).toThrow();
    }

    expect(() =>
      validateQuestionnaire({
        questions: [
          {
            ...question,
            options: [{ id: "unit", label: "Unit tests" }],
            recommendation: { option_ids: ["missing"], reason: "why" },
          },
        ],
      }),
    ).toThrow(/Invalid recommendation/u);

    for (const invalid of [
      {},
      { interaction_id: "i1", base_revision: 0, reason: "Update" },
      { interaction_id: "i1", base_revision: 1, reason: " " },
      { interaction_id: "i1", base_revision: 1, reason: "Update", questions: [question] },
    ]) {
      expect(() => validateRevision(invalid)).toThrow();
    }
  });
});
