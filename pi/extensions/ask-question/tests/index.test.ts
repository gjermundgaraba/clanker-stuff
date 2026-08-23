import { describe, expect, it } from "vitest";

import { createAskQuestionHost } from "./helpers.js";

describe("ask-question registration", () => {
  it("registers as a sequential tool with preferred strict sampling", async () => {
    const host = createAskQuestionHost();
    await host.ready;
    const tool = host.getRegisteredTools().get("ask_question");

    expect(tool?.definition.executionMode).toBe("sequential");
    expect(tool?.definition.constrainedSampling).toStrictEqual({
      strict: "prefer",
      type: "json_schema",
    });
  });
});
