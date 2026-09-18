import { describe, expect, it, vi } from "vite-plus/test";
import { Value } from "typebox/value";
import { convertResponsesTools } from "@earendil-works/pi-ai/api/openai-responses-shared";
import {
  resolveJsonSchemaStrictSampling,
  makeStrictJsonSchema,
} from "@earendil-works/pi-ai/api/constrained-sampling";
import { createExtensionHost } from "../../../tests/harness/extension-host.js";
import extension from "../index.js";
import { Coordinator } from "../coordinator.js";
import {
  QuestionnaireSchema,
  RequestSchema,
  RevisionSchema,
  prepareAsyncArguments,
  validateRequest,
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
  it("registers only the new shared tools, with honest preferred sampling", async () => {
    const host = createExtensionHost(extension);
    await host.ready;
    expect([...host.getRegisteredTools().keys()]).toEqual([
      "request_user_input",
      "request_user_input_async",
    ]);

    for (const name of ["request_user_input", "request_user_input_async"]) {
      const tool = host.getRegisteredTools().get(name)!.definition;
      expect(tool.renderCall).toBeTypeOf("function");
      expect(tool.renderResult).toBeTypeOf("function");
      expect(tool.parameters).toBe(RequestSchema);
      expect(tool.executionMode).toBe("sequential");
      expect(tool.constrainedSampling).toEqual({ type: "json_schema", strict: "prefer" });
      expect(resolveJsonSchemaStrictSampling(tool, true)).toBeUndefined();
      expect(() => makeStrictJsonSchema(tool.parameters)).toThrow();
      expect(() =>
        resolveJsonSchemaStrictSampling(
          { ...tool, constrainedSampling: { type: "json_schema", strict: "require" } },
          true,
        ),
      ).toThrow();
    }
  });
  it("prepares surviving persisted async calls without admitting them into the public schema", () => {
    const old = { questions: [{ title: "Choose?", options: ["Yes", "No"] }] };
    expect(() => validateRequest(old)).toThrow();
    expect(validateRequest(prepareAsyncArguments(old))).toMatchObject({
      questions: [
        {
          id: "q1",
          options: [
            { id: "o1", label: "Yes" },
            { id: "o2", label: "No" },
          ],
        },
      ],
    });
    const invalid = { ...old, extra: true };
    expect(() => prepareAsyncArguments(invalid)).toThrow();
  });
  it("exposes both branches at the provider schema root without relaxing validation", async () => {
    const host = createExtensionHost(extension);
    await host.ready;
    const tools = [...host.getRegisteredTools().values()].map((tool) => tool.definition);

    const questionnaire = {
      questions: [{ id: "q1", header: "Tests", question: "Which test?" }],
    };

    const revision = {
      revise: { interaction_id: "i1", base_revision: 1, reason: "Update" },
    };

    for (const tool of convertResponsesTools(tools, { supportsStrictMode: false })) {
      expect(tool.type).toBe("function");

      if (tool.type !== "function") throw new Error("Expected a function tool");

      const schema = tool.parameters!;

      const expectedProperties = {
        ...QuestionnaireSchema.properties,
        ...RevisionSchema.properties,
      };

      expect(schema.properties).toEqual(expectedProperties);
      expect(Object.keys(expectedProperties)).toEqual([
        "title",
        "context",
        "linked_interaction_id",
        "questions",
        "revise",
      ]);
      expect(schema.anyOf).toEqual(RequestSchema.anyOf);

      for (const valid of [questionnaire, revision]) {
        expect(Value.Check(schema, valid)).toBe(true);
      }

      for (const invalid of [
        {},
        { title: "Missing questions" },
        { questions: [] },
        { revise: {} },
        { ...questionnaire, ...revision },
        { ...questionnaire, unknown: true },
        { ...revision, unknown: true },
        { questions: [{ title: "Retired shape" }] },
      ]) {
        expect(Value.Check(schema, invalid)).toBe(false);
      }
    }
  });
});
