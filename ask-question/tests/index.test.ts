import { describe, expect, it } from "vitest";

import { createCustomUiDriver } from "../../tests/harness/tui.js";
import {
  KEY_ENTER,
  KEY_ESCAPE,
  KEY_TAB,
  createAskQuestionHost,
  executeTool,
  expectCancelledResult,
  expectSuccessResult,
} from "./helpers.js";

const singleQuestionParams = {
  questions: [
    {
      header: "Plan",
      options: [{ label: "Yes" }, { label: "No" }],
      question: "Which plan do you want?",
      type: "single_select" as const,
    },
  ],
};

describe("ask-question tool", () => {
  it("registers as a sequential tool", () => {
    const tool = createAskQuestionHost()
      .getRegisteredTools()
      .get("ask_question");

    expect(tool?.definition.executionMode).toBe("sequential");
  });

  it("rejects custom UI outside TUI mode", async () => {
    await expect(
      executeTool(singleQuestionParams, { mode: "rpc" })
    ).rejects.toThrow("ask_question requires interactive UI");
  });

  it("returns cancellation details and aborts the run when the user cancels", async () => {
    const { result, abortCalls } = await executeTool(singleQuestionParams, {
      customKeys: [KEY_ESCAPE],
    });

    const details = expectCancelledResult(result);
    expect(details.abortedRun).toBeTruthy();
    expect(details.reason).toBe("user_cancelled");
    expect(result.content[0]?.text).toContain("cancelled");
    expect(result).toMatchObject({ terminate: true });
    expect(abortCalls).toBe(1);
  });

  it("returns external abort details when the run is aborted while open", async () => {
    const controller = new AbortController();
    const driver = createCustomUiDriver({
      onComponent: () => controller.abort(),
    });

    const { result, abortCalls } = await executeTool(singleQuestionParams, {
      custom: driver.custom,
      signal: controller.signal,
    });

    const details = expectCancelledResult(result);
    expect(details.reason).toBe("external_aborted");
    expect(result.content[0]?.text).toContain("aborted");
    expect(result).toMatchObject({ terminate: true });
    expect(abortCalls).toBe(1);
  });

  it("returns structured answers on success", async () => {
    const { result } = await executeTool(singleQuestionParams, {
      customKeys: [KEY_ENTER, KEY_TAB, KEY_ENTER],
    });

    const details = expectSuccessResult(result);
    expect(details.answers).toStrictEqual([
      {
        answer: {
          label: "Yes",
        },
        type: "single_select",
      },
    ]);
    expect(result.content[0]?.text).toContain("[Plan]");
    expect(result.content[0]?.text).toContain("Yes");
  });
});
