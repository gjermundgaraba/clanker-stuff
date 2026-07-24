import type {
  ExtensionContext,
  KeybindingsManager,
  Theme,
} from "@earendil-works/pi-coding-agent";
import {
  Editor,
  Key,
  matchesKey,
  truncateToWidth,
  visibleWidth,
  wrapTextWithAnsi,
} from "@earendil-works/pi-tui";
import type { TUI } from "@earendil-works/pi-tui";

import {
  answerEntryToText,
  buildAnswerEntry,
  buildSuccessFlowResult,
  createQuestionSessions,
  isOptionSelected,
  isOtherOption,
  isQuestionComplete,
} from "./core.js";
import type { AskQuestionFlowResult, Question, QuestionState } from "./core.js";

type EditMode =
  | { kind: "none" }
  | {
      kind: "option_text";
      questionIndex: number;
      optionIndex: number;
    }
  | {
      kind: "free_text";
      questionIndex: number;
    };

const MAX_FREE_TEXT_PREVIEW_LINES = 4;
const MAX_OPTION_TEXT_PREVIEW_LINES = 3;
const HELP_EDITOR = "Pi editor keybindings • Enter save • Esc discard";

type DecodedIntent =
  | { type: "confirm" }
  | { type: "cancel" }
  | { type: "up" }
  | { type: "down" }
  | { type: "left" }
  | { type: "right" }
  | { type: "tab" }
  | { type: "shiftTab" }
  | { type: "space" }
  | { type: "printable"; text: string }
  | { type: "none" };

type AskQuestionKeybindings = Pick<KeybindingsManager, "matches" | "getKeys">;

const ANSI_RESET_BEFORE_ELLIPSIS = "\u001B[0m…";

const formatKeyLabel = (key: string): string => {
  switch (key) {
    case "enter":
    case "return": {
      return "Enter";
    }
    case "escape": {
      return "Esc";
    }
    case "space": {
      return "Space";
    }
    case "tab": {
      return "Tab";
    }
    case "up": {
      return "↑";
    }
    case "down": {
      return "↓";
    }
    case "left": {
      return "←";
    }
    case "right": {
      return "→";
    }
    case "pageUp": {
      return "PgUp";
    }
    case "pageDown": {
      return "PgDn";
    }
    default: {
      if (!key.includes("+")) {
        return key;
      }
      return key
        .split("+")
        .map((part) =>
          part.length === 1
            ? part.toUpperCase()
            : `${part[0].toUpperCase()}${part.slice(1)}`
        )
        .join("+");
    }
  }
};

const extractPrintableText = (data: string): string => {
  if (!data || data.includes("\u001B")) {
    return "";
  }

  let out = "";
  for (const char of data) {
    const code = char.codePointAt(0) ?? 0;
    const isControl =
      code < 32 || code === 127 || (code >= 0x80 && code <= 0x9f);
    if (!isControl) {
      out += char;
    }
  }
  return out;
};

const isSingleCharShortcut = (intent: DecodedIntent, key: string): boolean =>
  intent.type === "printable" &&
  intent.text.length === 1 &&
  intent.text.toLowerCase() === key.toLowerCase();

const truncateLine = (text: string, width: number): string => {
  if (width <= 0) {
    return "";
  }
  const truncated = truncateToWidth(text, width, "…");
  if (
    text.includes("\u001B") ||
    !truncated.endsWith(ANSI_RESET_BEFORE_ELLIPSIS)
  ) {
    return truncated;
  }
  return `${truncated.slice(0, -ANSI_RESET_BEFORE_ELLIPSIS.length)}…`;
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

const formatBindingLabel = (
  keybindings: AskQuestionKeybindings,
  keybinding: Parameters<AskQuestionKeybindings["getKeys"]>[0],
  fallback: string
): string => {
  const keys = keybindings.getKeys(keybinding);
  if (keys.length === 0) {
    return fallback;
  }
  return keys.map(formatKeyLabel).join("/");
};

const decodeAskQuestionIntent = (
  keybindings: AskQuestionKeybindings,
  data: string
): DecodedIntent => {
  type KeyId = Parameters<typeof matchesKey>[1];
  const match = (keyId: KeyId) => matchesKey(data, keyId);

  if (keybindings.matches(data, "tui.select.confirm")) {
    return { type: "confirm" };
  }
  if (keybindings.matches(data, "tui.select.cancel")) {
    return { type: "cancel" };
  }
  if (keybindings.matches(data, "tui.select.up")) {
    return { type: "up" };
  }
  if (keybindings.matches(data, "tui.select.down")) {
    return { type: "down" };
  }
  if (match(Key.left)) {
    return { type: "left" };
  }
  if (match(Key.right)) {
    return { type: "right" };
  }
  if (match(Key.tab)) {
    return { type: "tab" };
  }
  if (match(Key.shift(Key.tab))) {
    return { type: "shiftTab" };
  }
  if (match(Key.space)) {
    return { type: "space" };
  }

  const printable = extractPrintableText(data);
  if (printable.length > 0) {
    return { text: printable, type: "printable" };
  }
  return { type: "none" };
};

const wrapWithPrefix = (
  prefix: string,
  text: string,
  width: number
): string[] => {
  if (width <= 0) {
    return [""];
  }

  if (text.length === 0) {
    return [truncateLine(prefix.trimEnd(), width)];
  }

  const output: string[] = [];
  const indent = " ".repeat(Math.max(0, visibleWidth(prefix)));
  const logicalLines = text.split(/\r\n|\r|\n/u);

  for (const logicalLine of logicalLines) {
    const firstPrefix = output.length === 0 ? prefix : indent;

    if (logicalLine.length === 0) {
      output.push(truncateLine(firstPrefix.trimEnd(), width));
      continue;
    }

    const available = Math.max(1, width - visibleWidth(firstPrefix));
    const wrapped = wrapTextWithAnsi(logicalLine, available);

    for (let index = 0; index < wrapped.length; index += 1) {
      const currentPrefix = index === 0 ? firstPrefix : indent;
      const line = wrapped[index] ?? "";
      output.push(truncateLine(`${currentPrefix}${line}`, width));
    }
  }

  return output;
};

const createHelpText = (keybindings: AskQuestionKeybindings) => {
  const confirm = formatBindingLabel(
    keybindings,
    "tui.select.confirm",
    "confirm"
  );
  const cancel = formatBindingLabel(keybindings, "tui.select.cancel", "cancel");
  const up = formatBindingLabel(keybindings, "tui.select.up", "↑");
  const down = formatBindingLabel(keybindings, "tui.select.down", "↓");
  const move = `${up}/${down}`;

  return {
    cancel,
    confirm,
    freeText: `${confirm} edit answer`,
    globalTabs: `Tab/Shift+Tab or ←→ tabs • ${cancel} cancel questionnaire`,
    move,
    multi: `${move} move • Space toggle • ${confirm} confirm • n note`,
    multiOther: `${move} move • Space/${confirm} edit Other`,
    single: `${move} move • ${confirm} select • n note`,
    singleOther: `${move} move • ${confirm} edit Other`,
    submit: `${confirm} submit`,
  };
};

export const runAskQuestionTuiFlow = async (
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

      const highlightedOptionWithDetails = (
        questionIndex: number
      ): string | undefined => {
        const { question, state } = questionSessions[questionIndex];
        if (question.type === "free_text") {
          return undefined;
        }

        const option = question.options[state.cursor];
        if (option === undefined || isOtherOption(option)) {
          return undefined;
        }

        return option.details;
      };

      const moveCursor = (questionIndex: number, delta: number) => {
        const { question, state } = questionSessions[questionIndex];
        if (question.type === "free_text") {
          return;
        }
        state.cursor = Math.max(
          0,
          Math.min(question.options.length - 1, state.cursor + delta)
        );
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

      const allComplete = (): boolean =>
        questionSessions.every(({ question, state }) =>
          isQuestionComplete(question, state)
        );

      const missingHeaders = (): string[] =>
        questionSessions.flatMap(({ question, state }) =>
          isQuestionComplete(question, state) ? [] : [question.header]
        );

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
          setHint(`Incomplete: ${missingHeaders().join(", ")}`);
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

      const pushPreviewLines = (
        lines: string[],
        add: (line: string) => void,
        wrappedPreview: string[],
        maxLines: number,
        morePrefix: string
      ) => {
        for (const previewLine of wrappedPreview.slice(0, maxLines)) {
          lines.push(previewLine);
        }
        if (wrappedPreview.length > maxLines) {
          const remaining = wrappedPreview.length - maxLines;
          add(
            theme.fg(
              "dim",
              `${morePrefix}+${remaining} more line${remaining === 1 ? "" : "s"}`
            )
          );
        }
      };

      const renderFreeTextBody = (
        state: QuestionState,
        width: number,
        lines: string[],
        add: (line: string) => void
      ) => {
        if (typeof state.freeText === "string" && state.freeText !== "") {
          const wrappedPreview = wrapWithPrefix(
            "Current answer: ",
            state.freeText,
            width
          );
          pushPreviewLines(
            lines,
            add,
            wrappedPreview,
            MAX_FREE_TEXT_PREVIEW_LINES,
            "… "
          );
        } else {
          add(theme.fg("muted", "Current answer: (not set)"));
        }
        add(theme.fg("dim", `Press ${helpText.confirm} to edit`));
      };

      const renderOptionRow = (
        question: Exclude<Question, { type: "free_text" }>,
        state: QuestionState,
        index: number,
        width: number,
        lines: string[],
        add: (line: string) => void,
        addWrapped: (prefix: string, text: string) => void
      ) => {
        const option = question.options[index];
        const highlighted = index === state.cursor;
        const selected = isOptionSelected(question, state, index);
        const prefix = highlighted ? "> " : "  ";
        let marker: string;
        if (question.type === "single_select") {
          marker = selected ? "(●)" : "( )";
        } else {
          marker = selected ? "[x]" : "[ ]";
        }
        let color: "accent" | "success" | "text";
        if (highlighted) {
          color = "accent";
        } else if (selected) {
          color = "success";
        } else {
          color = "text";
        }
        const detailsMarker =
          typeof option.details === "string" && option.details !== ""
            ? " *"
            : "";
        add(
          `${prefix}${theme.fg(color, `${marker} ${index + 1}. ${option.label}${detailsMarker}`)}`
        );

        const optionText = state.textByOptionIndex[index];
        if (isOtherOption(option)) {
          if (selected) {
            if (typeof optionText === "string" && optionText !== "") {
              const wrappedPreview = wrapWithPrefix(
                "    text: ",
                optionText,
                width
              );
              pushPreviewLines(
                lines,
                add,
                wrappedPreview,
                MAX_OPTION_TEXT_PREVIEW_LINES,
                "    … "
              );
            } else {
              add(theme.fg("muted", "    text: (not set)"));
            }
          }

          if (highlighted) {
            const multiHint =
              question.type === "multi_select"
                ? ` (${formatKeyLabel("space")} toggles)`
                : "";
            add(
              theme.fg(
                "dim",
                `    Press ${helpText.confirm} to edit${multiHint}`
              )
            );
          }
          return;
        }

        if (selected && typeof optionText === "string" && optionText !== "") {
          addWrapped("    note: ", optionText);
        }
      };

      const renderQuestionPanel = (
        questionIndex: number,
        width: number
      ): string[] => {
        const { question, state } = questionSessions[questionIndex];
        const lines: string[] = [];
        const add = (line: string) => {
          lines.push(truncateLine(line, width));
        };
        const addWrapped = (prefix: string, text: string) => {
          for (const wrapped of wrapWithPrefix(prefix, text, width)) {
            lines.push(wrapped);
          }
        };

        addWrapped("", question.question);
        if (
          typeof question.placeholder === "string" &&
          question.placeholder !== ""
        ) {
          addWrapped("Hint: ", theme.fg("muted", question.placeholder));
        }
        lines.push("");

        if (question.type === "free_text") {
          renderFreeTextBody(state, width, lines, add);
          return lines;
        }

        for (let index = 0; index < question.options.length; index += 1) {
          renderOptionRow(
            question,
            state,
            index,
            width,
            lines,
            add,
            addWrapped
          );
        }

        const details = highlightedOptionWithDetails(questionIndex);
        if (typeof details === "string" && details !== "") {
          lines.push("");
          add(theme.bold("Details"));
          addWrapped("", theme.fg("muted", details));
        }

        return lines;
      };

      const renderSubmitPanel = (width: number): string[] => {
        const lines: string[] = [];
        const add = (line: string) => {
          lines.push(truncateLine(line, width));
        };
        const addWrapped = (prefix: string, text: string) => {
          for (const wrapped of wrapWithPrefix(prefix, text, width)) {
            lines.push(wrapped);
          }
        };

        add(theme.bold("Submit"));
        lines.push("");

        for (const { question, state } of questionSessions) {
          const answer = buildAnswerEntry(question, state);
          if (answer) {
            addWrapped(`✓ ${question.header}: `, answerEntryToText(answer));
          } else {
            add(`• ${question.header}: incomplete`);
          }
        }

        lines.push("");
        if (allComplete()) {
          add(theme.fg("success", `Press ${helpText.confirm} to submit`));
        } else {
          addWrapped("Unanswered: ", missingHeaders().join(", "));
        }

        return lines;
      };

      const renderTabBar = (maxWidth: number, add: (line: string) => void) => {
        const tabs: string[] = [];
        for (const [index, { question, state }] of questionSessions.entries()) {
          const complete = isQuestionComplete(question, state);
          const tabLabel = `${complete ? "●" : "○"} ${question.header}`;
          if (index === currentTab) {
            tabs.push(
              theme.bg("selectedBg", theme.fg("text", ` ${tabLabel} `))
            );
          } else {
            tabs.push(
              theme.fg(complete ? "success" : "muted", ` ${tabLabel} `)
            );
          }
        }

        const submitActive = currentTab === questionSessions.length;
        const submitText = " ✓ Submit ";
        tabs.push(
          submitActive
            ? theme.bg("selectedBg", theme.fg("text", submitText))
            : theme.fg(allComplete() ? "success" : "dim", submitText)
        );

        add(tabs.join(" "));
      };

      const renderFooterHelp = (add: (line: string) => void) => {
        if (editMode.kind !== "none") {
          add(theme.fg("dim", HELP_EDITOR));
          return;
        }

        add(theme.fg("dim", helpText.globalTabs));
        if (currentTab >= questionSessions.length) {
          add(theme.fg("dim", helpText.submit));
          return;
        }

        const { question, state } = questionSessions[currentTab];
        const otherFocused =
          question.type !== "free_text" &&
          isOtherOption(question.options[state.cursor]);
        if (question.type === "single_select") {
          add(
            theme.fg(
              "dim",
              otherFocused ? helpText.singleOther : helpText.single
            )
          );
          return;
        }
        if (question.type === "multi_select") {
          add(
            theme.fg("dim", otherFocused ? helpText.multiOther : helpText.multi)
          );
          return;
        }
        add(theme.fg("dim", helpText.freeText));
      };

      const render = (width: number): string[] => {
        const maxWidth = Math.max(1, width);
        const lines: string[] = [];
        const add = (line: string) => {
          lines.push(truncateLine(line, maxWidth));
        };

        add(theme.fg("accent", "─".repeat(maxWidth)));
        renderTabBar(maxWidth, add);
        lines.push("");

        const panelLines =
          currentTab === questionSessions.length
            ? renderSubmitPanel(maxWidth)
            : renderQuestionPanel(currentTab, maxWidth);
        for (const line of panelLines) {
          lines.push(line);
        }

        if (editMode.kind !== "none") {
          lines.push("");
          add(theme.fg("muted", "Editing..."));
          if (activeEditor !== undefined) {
            for (const editorLine of activeEditor.render(maxWidth)) {
              lines.push(editorLine);
            }
          }
        }

        if (hint !== "") {
          lines.push("");
          add(theme.fg("warning", hint));
        }

        lines.push("");
        renderFooterHelp(add);
        add(theme.fg("accent", "─".repeat(maxWidth)));
        return lines;
      };

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
        render,
      };
    }
  );
};
