import type { ExtensionContext, Theme } from "@earendil-works/pi-coding-agent";
import { Editor } from "@earendil-works/pi-tui";
import type { TUI } from "@earendil-works/pi-tui";

import {
  buildSuccessFlowResult,
  createQuestionSessions,
  isOtherOption,
  isQuestionComplete,
  missingQuestionHeaders,
} from "../questions.js";
import type { AskQuestionFlowResult, Question } from "../questions.js";
import {
  createHelpText,
  decodeAskQuestionIntent,
  isSingleCharShortcut,
} from "./input.js";
import type { DecodedIntent } from "./input.js";
import { renderPrompt } from "./render.js";
import type { EditTarget, PromptView } from "./render.js";

export const MAX_ANSWER_BYTES = 1000;
export const MAX_ANSWER_LINES = 50;

export const boundAnswerText = (value: string): string => {
  let bytes = 0;
  let lines = 1;
  let result = "";
  for (const char of value) {
    const charBytes = Buffer.byteLength(char);
    const nextLines = lines + (char === "\n" ? 1 : 0);
    if (bytes + charBytes > MAX_ANSWER_BYTES || nextLines > MAX_ANSWER_LINES) {
      break;
    }
    result += char;
    bytes += charBytes;
    lines = nextLines;
  }
  return result;
};

const createInlineEditor = (tui: TUI, theme: Pick<Theme, "fg">): Editor =>
  new Editor(tui, {
    borderColor: (text: string) => theme.fg("accent", text),
    selectList: {
      description: (text: string) => theme.fg("muted", text),
      noMatch: (text: string) => theme.fg("warning", text),
      scrollInfo: (text: string) => theme.fg("dim", text),
      selectedPrefix: (text: string) => theme.fg("accent", text),
      selectedText: (text: string) => theme.fg("accent", text),
    },
  });

export const runAskQuestionPrompt = async (
  ctx: ExtensionContext,
  questions: Question[],
  signal?: AbortSignal
): Promise<AskQuestionFlowResult> => {
  if (signal?.aborted === true) {
    return { cancelled: true, reason: "external_aborted" } as const;
  }

  const questionSessions = createQuestionSessions(questions);

  return await ctx.ui.custom<AskQuestionFlowResult>(
    (tui, theme, keybindings, done) => {
      const helpText = createHelpText(keybindings);
      let currentTab = 0;
      let hint = "";
      let editTarget: EditTarget | undefined;
      let activeEditor: Editor | undefined;
      let surfaceFocused = false;
      let finished = false;
      const abortListener = new AbortController();
      const finish = (result: AskQuestionFlowResult) => {
        if (finished) {
          return;
        }

        finished = true;
        abortListener.abort();
        if (activeEditor !== undefined) {
          activeEditor.focused = false;
        }
        activeEditor = undefined;
        editTarget = undefined;
        surfaceFocused = false;
        done(result);
      };

      const handleAbort = () => {
        finish({ cancelled: true, reason: "external_aborted" });
      };

      if (signal?.aborted === true) {
        queueMicrotask(handleAbort);
      } else {
        signal?.addEventListener("abort", handleAbort, {
          once: true,
          signal: abortListener.signal,
        });
      }

      const totalTabs = questionSessions.length + 1;

      const moveCursor = (questionIndex: number, delta: number) => {
        const { question, state } = questionSessions[questionIndex];
        state.cursor = Math.max(
          0,
          Math.min(question.options.length - 1, state.cursor + delta)
        );
        hint = "";
        tui.requestRender();
      };

      const setHint = (nextHint: string) => {
        hint = nextHint;
        tui.requestRender();
      };

      const moveTab = (delta: number) => {
        currentTab = (currentTab + delta + totalTabs) % totalTabs;
        hint = "";
        tui.requestRender();
      };

      const closeEditor = (preserveHint = false) => {
        if (!preserveHint) {
          hint = "";
        }
        if (activeEditor !== undefined) {
          activeEditor.focused = false;
        }
        activeEditor = undefined;
        editTarget = undefined;
        tui.requestRender();
      };

      const openOptionTextEditor = (
        questionIndex: number,
        optionIndex: number
      ) => {
        editTarget = {
          optionIndex,
          questionIndex,
        };
        hint = "";
        const { state } = questionSessions[questionIndex];
        activeEditor = createInlineEditor(tui, theme);
        activeEditor.focused = surfaceFocused;
        activeEditor.setText(
          boundAnswerText(state.textByOptionIndex[optionIndex] ?? "")
        );
        activeEditor.onSubmit = (value: string) => {
          const bounded = boundAnswerText(value);
          state.textByOptionIndex[optionIndex] =
            bounded.length === 0 ? undefined : bounded;
          closeEditor();
        };
        tui.requestRender();
      };

      const openNoteEditorForCurrentSelection = (questionIndex: number) => {
        const { question, state } = questionSessions[questionIndex];
        const optionIndex = question.multiSelect
          ? state.cursor
          : [...state.selectedIndexes][0];

        if (optionIndex === undefined) {
          setHint("Select an option first, then press n to add/edit note");
          return;
        }

        if (isOtherOption(question.options[optionIndex])) {
          setHint("Use the Other field itself instead of a note");
          return;
        }

        if (question.multiSelect && !state.selectedIndexes.has(optionIndex)) {
          setHint("Select the highlighted option before adding a note");
          return;
        }

        openOptionTextEditor(questionIndex, optionIndex);
      };

      const handleEditorInput = (data: string) => {
        const intent = decodeAskQuestionIntent(keybindings, data);
        if (intent.type === "cancel") {
          closeEditor(true);
          return;
        }

        if (editTarget === undefined || !activeEditor) {
          return;
        }

        if (hint !== "") {
          hint = "";
        }
        const editor = activeEditor;
        editor.handleInput(data);
        if (activeEditor !== editor) {
          return;
        }
        const value = editor.getText();
        const bounded = boundAnswerText(value);
        if (bounded !== value) {
          hint = `Answer limited to ${MAX_ANSWER_BYTES} bytes and ${MAX_ANSWER_LINES} lines`;
        }
        tui.requestRender();
      };

      const handleQuestionInput = (
        questionIndex: number,
        question: Question,
        intent: DecodedIntent
      ) => {
        const { state } = questionSessions[questionIndex];

        if (intent.type === "up") {
          moveCursor(questionIndex, -1);
          return;
        }
        if (intent.type === "down") {
          moveCursor(questionIndex, 1);
          return;
        }

        if (intent.type === "confirm") {
          const option = question.options[state.cursor];

          if (!question.multiSelect) {
            state.selectedIndexes = new Set([state.cursor]);
            setHint("");
            if (isOtherOption(option)) {
              openOptionTextEditor(questionIndex, state.cursor);
            }
            return;
          }

          if (isOtherOption(option)) {
            state.selectedIndexes.add(state.cursor);
            openOptionTextEditor(questionIndex, state.cursor);
            return;
          }

          if (!isQuestionComplete(question, state)) {
            setHint("This question is incomplete");
            return;
          }
          moveTab(1);
          return;
        }

        if (question.multiSelect && intent.type === "space") {
          const option = question.options[state.cursor];

          if (state.selectedIndexes.delete(state.cursor)) {
            setHint("");
            return;
          }

          state.selectedIndexes.add(state.cursor);
          setHint("");
          if (isOtherOption(option)) {
            openOptionTextEditor(questionIndex, state.cursor);
          }
          return;
        }

        if (isSingleCharShortcut(intent, "n")) {
          openNoteEditorForCurrentSelection(questionIndex);
        }
      };

      const handleSubmitTabInput = (intent: DecodedIntent) => {
        if (intent.type !== "confirm") {
          return;
        }
        const result = buildSuccessFlowResult(questionSessions);
        if (result === undefined) {
          setHint(
            `Incomplete: ${missingQuestionHeaders(questionSessions).join(", ")}`
          );
          return;
        }
        finish(result);
      };

      const handleNavigationIntent = (intent: DecodedIntent): boolean => {
        if (intent.type === "tab" || intent.type === "right") {
          moveTab(1);
          return true;
        }
        if (intent.type === "shiftTab" || intent.type === "left") {
          moveTab(-1);
          return true;
        }
        if (intent.type === "cancel") {
          finish({
            cancelled: true,
            reason: "user_cancelled",
          });
          return true;
        }
        return false;
      };

      const handleInput = (data: string) => {
        if (finished) {
          return;
        }

        if (editTarget !== undefined) {
          handleEditorInput(data);
          return;
        }

        const intent = decodeAskQuestionIntent(keybindings, data);
        if (handleNavigationIntent(intent)) {
          return;
        }

        if (currentTab === questionSessions.length) {
          handleSubmitTabInput(intent);
          return;
        }

        const questionIndex = currentTab;
        handleQuestionInput(
          questionIndex,
          questionSessions[questionIndex].question,
          intent
        );
      };

      const currentView = (): PromptView => ({
        activeEditor,
        currentTab,
        editTarget,
        helpText,
        hint,
        sessions: questionSessions,
        theme,
      });

      return {
        dispose() {
          surfaceFocused = false;
          if (activeEditor !== undefined) {
            activeEditor.focused = false;
          }
          activeEditor = undefined;
        },
        get focused(): boolean {
          return surfaceFocused;
        },
        set focused(value: boolean) {
          surfaceFocused = value;
          if (activeEditor !== undefined) {
            activeEditor.focused = value;
          }
        },
        handleInput,
        invalidate() {
          activeEditor?.invalidate();
        },
        render: (width: number) => renderPrompt(currentView(), width),
      };
    }
  );
};
