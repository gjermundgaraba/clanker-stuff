import type {
  ExtensionUIContext,
  KeybindingsManager,
} from "@earendil-works/pi-coding-agent";
import { expect } from "vitest";

import { createExtensionHost } from "../../tests/harness/extension-host.js";
import {
  createCustomUiDriver,
  createKeybindings as createSharedKeybindings,
} from "../../tests/harness/tui.js";
import { parseQuestionsFromParameters } from "../contract.js";
import type {
  buildCancelledToolResult,
  buildSuccessToolResult,
} from "../contract.js";
import askQuestion from "../index.js";
import { runAskQuestionTuiFlow } from "../tui.js";

type FlowResult = Awaited<ReturnType<typeof runAskQuestionTuiFlow>>;
type AskQuestionKeybindings = Pick<KeybindingsManager, "matches" | "getKeys">;
interface HarnessOptions {
  customKeys?: string[];
  mode?: "json" | "rpc" | "tui";
  customKeybindings?: AskQuestionKeybindings;
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
  "tui.select.cancel": [KEY_ESCAPE],
  "tui.select.confirm": [KEY_ENTER],
});

export const VIM_STYLE_KEYBINDINGS = createSharedKeybindings({
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
  params: unknown,
  options: HarnessOptions = {}
): Promise<{ result: ToolResult; abortCalls: number }> => {
  const host = createAskQuestionHost();
  const customUi = createCustomUiDriver<FlowResult>({
    keybindings: options.customKeybindings ?? DEFAULT_KEYBINDINGS,
    keys: options.customKeys ?? [],
  });
  let abortCalls = 0;

  const ctx = host.createContext({
    ...(options.mode === undefined ? {} : { mode: options.mode }),
    abort: () => {
      abortCalls += 1;
    },
    ui: {
      custom: options.custom ?? customUi.custom,
    },
  });

  const result = (await host.runTool("ask_question", params, {
    ctx,
    signal: options.signal,
  })) as ToolResult;

  return { abortCalls, result };
};

export const renderFlowWithKeys = async (
  params: unknown,
  keys: string[],
  keybindings: AskQuestionKeybindings = DEFAULT_KEYBINDINGS
): Promise<string> => {
  const host = createAskQuestionHost();
  const customUi = createCustomUiDriver<FlowResult>({
    captureRender: "after",
    keybindings,
    keys,
    resolveWith: { cancelled: true, reason: "user_cancelled" },
  });
  const ctx = host.createContext({
    ui: {
      custom: customUi.custom,
    },
  });

  await runAskQuestionTuiFlow(ctx, parseQuestionsFromParameters(params));

  return customUi.getLastRender() ?? "";
};
