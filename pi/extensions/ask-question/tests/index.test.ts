import { describe, expect, it } from "vitest";

import { createAskQuestionHost } from "./helpers.js";

describe("ask-question registration", () => {
  it("registers as a sequential tool with preferred strict sampling", () => {
    const tool = createAskQuestionHost()
      .getRegisteredTools()
      .get("ask_question");

    expect(tool?.definition.executionMode).toBe("sequential");
    expect(tool?.definition.constrainedSampling).toStrictEqual({
      strict: "prefer",
      type: "json_schema",
    });
  });
});
