import type { ExtensionUIContext, KeybindingsManager } from "@earendil-works/pi-coding-agent";
import { expect } from "vite-plus/test";

import { createExtensionHost } from "../../../tests/harness/extension-host.js";
import {
  createCustomUiDriver,
  createKeybindings as createSharedKeybindings,
} from "../../../tests/harness/tui.js";
import { runAskQuestionPrompt } from "../dialog/controller.js";
import askQuestion from "../index.js";
import { executeAskQuestion, parseQuestionsFromParameters } from "../tool.js";
import type { AskQuestionParameters } from "../tool.js";
import type { buildCancelledToolResult, buildSuccessToolResult } from "../tool.js";

interface HarnessOptions {
  customKeys?: string[];
  mode?: "json" | "rpc" | "tui";
  customKeybindings?: KeybindingsManager;
  custom?: ExtensionUIContext["custom"];
  signal?: AbortSignal;
}
type SuccessDetails = ReturnType<typeof buildSuccessToolResult>["details"];
type CancelledDetails = ReturnType<typeof buildCancelledToolResult>["details"];

export type ToolResult =
  | ReturnType<typeof buildCancelledToolResult>
  | ReturnType<typeof buildSuccessToolResult>;

export const KEY_ENTER = "\r";
export const KEY_TAB = "\t";
export const KEY_SPACE = " ";
export const KEY_ESCAPE = "\u001B";

export const createAskQuestionHost = () => createExtensionHost(askQuestion);

const DEFAULT_KEYBINDINGS = createSharedKeybindings({
  "tui.input.submit": [KEY_ENTER],
  "tui.select.cancel": [KEY_ESCAPE],
  "tui.select.confirm": [KEY_ENTER],
});

export const VIM_STYLE_KEYBINDINGS = createSharedKeybindings({
  "tui.input.submit": [KEY_ENTER],
  "tui.select.cancel": ["x"],
  "tui.select.confirm": ["y"],
  "tui.select.down": ["j"],
  "tui.select.up": ["k"],
});

export const expectSuccessResult = (result: ToolResult): SuccessDetails => {
  expect(result.details.cancelled).toBe(false);
  if (result.details.cancelled) {
    throw new Error("Expected success details");
  }
  return result.details;
};

export const expectCancelledResult = (result: ToolResult): CancelledDetails => {
  expect(result.details.cancelled).toBe(true);
  if (!result.details.cancelled) {
    throw new Error("Expected cancellation details");
  }
  return result.details;
};

export const executeTool = async (
  params: AskQuestionParameters,
  options: HarnessOptions = {},
): Promise<{
  result: ToolResult;
  abortCalls: number;
  blockedEvents: unknown[];
}> => {
  const host = createAskQuestionHost();
  const blockedEvents: unknown[] = [];
  host.events.on("herdr:blocked", (data) => blockedEvents.push(data));
  const customUi = createCustomUiDriver({
    keybindings: options.customKeybindings ?? DEFAULT_KEYBINDINGS,
    keys: options.customKeys ?? [],
  });
  let abortCalls = 0;

  const base = {
    abort: () => {
      abortCalls += 1;
    },
    ui: {
      custom: options.custom ?? customUi.custom,
    },
  };
  const ctx = host.createContext(
    options.mode === undefined ? base : { ...base, mode: options.mode },
  );

  const result = await executeAskQuestion(host, params, options.signal, ctx);

  return { abortCalls, blockedEvents, result };
};

export const renderFlowWithKeys = async (
  params: AskQuestionParameters,
  keys: string[],
  keybindings: KeybindingsManager = DEFAULT_KEYBINDINGS,
): Promise<string> => {
  const host = createAskQuestionHost();
  const abortController = new AbortController();
  const customUi = createCustomUiDriver({
    captureRender: "after",
    keybindings,
    keys,
    onAfterCapture: () => abortController.abort(),
  });
  const ctx = host.createContext({
    ui: {
      custom: customUi.custom,
    },
  });

  await runAskQuestionPrompt(ctx, parseQuestionsFromParameters(params), abortController.signal);

  return customUi.getLastRender() ?? "";
};
