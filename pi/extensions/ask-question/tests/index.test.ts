import { describe, expect, it } from "vite-plus/test";

import { createAskQuestionHost } from "./helpers.js";

describe("ask-question registration", () => {
  it("registers as a sequential tool with preferred strict sampling", async () => {
    const host = createAskQuestionHost();
    await host.ready;
    const tool = host.getRegisteredTools().get("ask_question");

    for (const name of ["ask_question", "request_user_input_async", "send_message_to_user_async"]) {
      const definition = host.getRegisteredTools().get(name)?.definition;
      expect(definition?.renderCall).toBeTypeOf("function");
      expect(definition?.renderResult).toBeTypeOf("function");
    }
    expect(tool?.definition.executionMode).toBe("sequential");
    expect(tool?.definition.constrainedSampling).toStrictEqual({
      strict: "prefer",
      type: "json_schema",
    });
  });
});
