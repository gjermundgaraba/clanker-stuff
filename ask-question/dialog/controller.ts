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
import type { EditMode, PromptView } from "./render.js";

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
      let editMode: EditMode = { kind: "none" };
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
        editMode = { kind: "none" };
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
        if (question.type === "free_text") {
          return;
        }
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
        editMode = { kind: "none" };
        tui.requestRender();
      };

      const handleEditorSave = (value: string) => {
        if (editMode.kind === "none") {
          return;
        }

        const { state } = questionSessions[editMode.questionIndex];

        if (editMode.kind === "option_text") {
          state.textByOptionIndex[editMode.optionIndex] =
            value.length === 0 ? undefined : value;
          closeEditor();
          return;
        }

        state.freeText = value;
        closeEditor();
      };

      const openEditor = (
        mode: Exclude<EditMode, { kind: "none" }>,
        initialText: string
      ) => {
        editMode = mode;
        hint = "";
        activeEditor = createInlineEditor(tui, theme);
        activeEditor.focused = surfaceFocused;
        activeEditor.setText(initialText);
        activeEditor.onSubmit = handleEditorSave;
        tui.requestRender();
      };

      const openOptionTextEditor = (
        questionIndex: number,
        optionIndex: number
      ) => {
        const { state } = questionSessions[questionIndex];
        openEditor(
          {
            kind: "option_text",
            optionIndex,
            questionIndex,
          },
          state.textByOptionIndex[optionIndex] ?? ""
        );
      };

      const openNoteEditorForCurrentSelection = (questionIndex: number) => {
        const { question, state } = questionSessions[questionIndex];

        if (question.type === "free_text") {
          setHint("Notes are not available for free-text questions");
          return;
        }

        if (question.type === "single_select") {
          if (typeof state.selectedIndex !== "number") {
            setHint("Select an option first, then press n to add/edit note");
            return;
          }

          if (isOtherOption(question.options[state.selectedIndex])) {
            setHint("Use the Other field itself instead of a note");
            return;
          }

          openOptionTextEditor(questionIndex, state.selectedIndex);
          return;
        }

        const optionIndex = state.cursor;
        if (isOtherOption(question.options[optionIndex])) {
          setHint("Use the Other field itself instead of a note");
          return;
        }

        if (!state.selectedIndexes.has(optionIndex)) {
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

        if (editMode.kind === "none" || !activeEditor) {
          return;
        }

        if (hint !== "") {
          hint = "";
        }
        activeEditor.handleInput(data);
        tui.requestRender();
      };

      const handleQuestionInput = (
        questionIndex: number,
        question: Question,
        intent: DecodedIntent
      ) => {
        const { state } = questionSessions[questionIndex];

        if (question.type !== "free_text") {
          if (intent.type === "up") {
            moveCursor(questionIndex, -1);
            return;
          }
          if (intent.type === "down") {
            moveCursor(questionIndex, 1);
            return;
          }
        }

        if (question.type === "single_select") {
          if (intent.type === "confirm") {
            const option = question.options[state.cursor];

            state.selectedIndex = state.cursor;
            hint = "";
            tui.requestRender();

            if (isOtherOption(option)) {
              openOptionTextEditor(questionIndex, state.cursor);
            }
            return;
          }

          if (isSingleCharShortcut(intent, "n")) {
            openNoteEditorForCurrentSelection(questionIndex);
          }
          return;
        }

        if (question.type === "multi_select") {
          if (intent.type === "space") {
            const option = question.options[state.cursor];

            if (state.selectedIndexes.has(state.cursor)) {
              state.selectedIndexes.delete(state.cursor);
            } else {
              state.selectedIndexes.add(state.cursor);
              if (isOtherOption(option)) {
                hint = "";
                tui.requestRender();
                openOptionTextEditor(questionIndex, state.cursor);
                return;
              }
            }

            hint = "";
            tui.requestRender();
            return;
          }

          if (intent.type === "confirm") {
            const option = question.options[state.cursor];
            if (isOtherOption(option)) {
              state.selectedIndexes.add(state.cursor);
              hint = "";
              tui.requestRender();
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

          if (isSingleCharShortcut(intent, "n")) {
            openNoteEditorForCurrentSelection(questionIndex);
          }
          return;
        }

        if (intent.type === "confirm") {
          openEditor(
            {
              kind: "free_text",
              questionIndex,
            },
            state.freeText ?? ""
          );
          return;
        }

        if (isSingleCharShortcut(intent, "n")) {
          setHint("Notes are not available for free-text questions");
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

        if (editMode.kind !== "none") {
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
        editMode,
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
