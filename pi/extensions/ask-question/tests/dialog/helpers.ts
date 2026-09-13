import type { KeybindingsManager } from "@earendil-works/pi-coding-agent";
import { expect } from "vite-plus/test";

import { createExtensionHost } from "../../../../tests/harness/extension-host.js";
import { createCustomUiDriver, createKeybindings } from "../../../../tests/harness/tui.js";
import { runQuestionPrompt } from "../../dialog/controller.js";
import type { AskQuestionFlowResult, Question } from "../../questions.js";

export const KEY_ENTER = "\r";
export const KEY_TAB = "\t";
export const KEY_SPACE = " ";

const DEFAULT_KEYBINDINGS = createKeybindings({
  "tui.input.submit": [KEY_ENTER],
  "tui.select.cancel": ["\u001B"],
  "tui.select.confirm": [KEY_ENTER],
});

export const VIM_STYLE_KEYBINDINGS = createKeybindings({
  "tui.input.submit": [KEY_ENTER],
  "tui.select.cancel": ["x"],
  "tui.select.confirm": ["y"],
  "tui.select.down": ["j"],
  "tui.select.up": ["k"],
});

export const expectAnswers = (result: AskQuestionFlowResult) => {
  expect(result.cancelled).toBe(false);
  if (result.cancelled) throw new Error("Expected answers");
  return result.answers;
};

export const executePrompt = async (
  questions: Question[],
  options: { customKeys?: string[]; customKeybindings?: KeybindingsManager } = {},
): Promise<AskQuestionFlowResult> => {
  const customUi = createCustomUiDriver({
    keybindings: options.customKeybindings ?? DEFAULT_KEYBINDINGS,
    keys: options.customKeys ?? [],
  });
  const ctx = createExtensionHost(() => {}).createContext({ ui: { custom: customUi.custom } });
  return runQuestionPrompt(ctx, questions);
};

export const renderFlowWithKeys = async (
  questions: Question[],
  keys: string[],
  keybindings: KeybindingsManager = DEFAULT_KEYBINDINGS,
): Promise<string> => {
  const abortController = new AbortController();
  const customUi = createCustomUiDriver({
    captureRender: "after",
    keybindings,
    keys,
    onAfterCapture: () => abortController.abort(),
  });
  const ctx = createExtensionHost(() => {}).createContext({ ui: { custom: customUi.custom } });
  await runQuestionPrompt(ctx, questions, abortController.signal);
  return customUi.getLastRender() ?? "";
};
