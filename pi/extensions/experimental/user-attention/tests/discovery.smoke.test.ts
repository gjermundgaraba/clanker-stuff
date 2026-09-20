import { resolve } from "node:path";
import { describe, expect, it } from "vite-plus/test";
import { createExtensionSmokeHarness } from "../../../../tests/harness/extension-smoke.js";

describe("user-attention discovery", () => {
  it.each([false, true])("loads independently, with questionnaires=%s", async (withQuestions) => {
    const harness = await createExtensionSmokeHarness({
      extensions: [
        resolve(import.meta.dirname, ".."),
        ...(withQuestions ? [resolve(import.meta.dirname, "../../../ask-question")] : []),
      ],
    });

    try {
      expect(harness.extensionsResult.errors).toEqual([]);
      const tools = harness.extensionsResult.extensions.flatMap((e) => [...e.tools.keys()]);
      expect(tools.toSorted()).toEqual(
        withQuestions
          ? [
              "request_user_input",
              "request_user_input_async",
              "revise_user_input",
              "send_message_to_user_async",
            ]
          : ["send_message_to_user_async"],
      );
    } finally {
      harness.cleanup();
    }
  });
});
