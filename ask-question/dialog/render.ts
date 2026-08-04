import type { Theme } from "@earendil-works/pi-coding-agent";
import {
  truncateToWidth,
  visibleWidth,
  wrapTextWithAnsi,
} from "@earendil-works/pi-tui";
import type { Editor } from "@earendil-works/pi-tui";

import {
  allQuestionsComplete,
  answerEntryToText,
  buildAnswerEntry,
  isOptionSelected,
  isOtherOption,
  isQuestionComplete,
  missingQuestionHeaders,
} from "../questions.js";
import type { Question, QuestionSession, QuestionState } from "../questions.js";
import { HELP_EDITOR, formatKeyLabel } from "./input.js";
import type { HelpText } from "./input.js";

export type EditMode =
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

export interface PromptView {
  activeEditor?: Editor;
  currentTab: number;
  editMode: EditMode;
  helpText: HelpText;
  hint: string;
  sessions: QuestionSession[];
  theme: Theme;
}

const MAX_FREE_TEXT_PREVIEW_LINES = 4;
const MAX_OPTION_TEXT_PREVIEW_LINES = 3;

const ANSI_RESET_BEFORE_ELLIPSIS = "\u001B[0m…";

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

const pushPreviewLines = (
  theme: Theme,
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
  view: PromptView,
  state: QuestionState,
  width: number,
  lines: string[],
  add: (line: string) => void
) => {
  const { helpText, theme } = view;
  if (typeof state.freeText === "string" && state.freeText !== "") {
    const wrappedPreview = wrapWithPrefix(
      "Current answer: ",
      state.freeText,
      width
    );
    pushPreviewLines(
      theme,
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
  view: PromptView,
  question: Exclude<Question, { type: "free_text" }>,
  state: QuestionState,
  index: number,
  width: number,
  lines: string[],
  add: (line: string) => void,
  addWrapped: (prefix: string, text: string) => void
) => {
  const { helpText, theme } = view;
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
    typeof option.details === "string" && option.details !== "" ? " *" : "";
  add(
    `${prefix}${theme.fg(color, `${marker} ${index + 1}. ${option.label}${detailsMarker}`)}`
  );

  const optionText = state.textByOptionIndex[index];
  if (isOtherOption(option)) {
    if (selected) {
      if (typeof optionText === "string" && optionText !== "") {
        const wrappedPreview = wrapWithPrefix("    text: ", optionText, width);
        pushPreviewLines(
          theme,
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
      add(theme.fg("dim", `    Press ${helpText.confirm} to edit${multiHint}`));
    }
    return;
  }

  if (selected && typeof optionText === "string" && optionText !== "") {
    addWrapped("    note: ", optionText);
  }
};

const highlightedOptionDetails = (
  session: QuestionSession
): string | undefined => {
  const { question, state } = session;
  if (question.type === "free_text") {
    return undefined;
  }

  const option = question.options[state.cursor];
  if (option === undefined || isOtherOption(option)) {
    return undefined;
  }

  return option.details;
};

const renderQuestionPanel = (
  view: PromptView,
  questionIndex: number,
  width: number
): string[] => {
  const { sessions, theme } = view;
  const { question, state } = sessions[questionIndex];
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
  if (typeof question.placeholder === "string" && question.placeholder !== "") {
    addWrapped("Hint: ", theme.fg("muted", question.placeholder));
  }
  lines.push("");

  if (question.type === "free_text") {
    renderFreeTextBody(view, state, width, lines, add);
    return lines;
  }

  for (let index = 0; index < question.options.length; index += 1) {
    renderOptionRow(
      view,
      question,
      state,
      index,
      width,
      lines,
      add,
      addWrapped
    );
  }

  const details = highlightedOptionDetails(sessions[questionIndex]);
  if (typeof details === "string" && details !== "") {
    lines.push("");
    add(theme.bold("Details"));
    addWrapped("", theme.fg("muted", details));
  }

  return lines;
};

const renderSubmitPanel = (view: PromptView, width: number): string[] => {
  const { helpText, sessions, theme } = view;
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

  for (const { question, state } of sessions) {
    const answer = buildAnswerEntry(question, state);
    if (answer) {
      addWrapped(`✓ ${question.header}: `, answerEntryToText(answer));
    } else {
      add(`• ${question.header}: incomplete`);
    }
  }

  lines.push("");
  if (allQuestionsComplete(sessions)) {
    add(theme.fg("success", `Press ${helpText.confirm} to submit`));
  } else {
    addWrapped("Unanswered: ", missingQuestionHeaders(sessions).join(", "));
  }

  return lines;
};

const renderTabBar = (
  view: PromptView,
  maxWidth: number,
  add: (line: string) => void
) => {
  const { currentTab, sessions, theme } = view;
  const tabs: string[] = [];
  for (const [index, { question, state }] of sessions.entries()) {
    const complete = isQuestionComplete(question, state);
    const tabLabel = `${complete ? "●" : "○"} ${question.header}`;
    if (index === currentTab) {
      tabs.push(theme.bg("selectedBg", theme.fg("text", ` ${tabLabel} `)));
    } else {
      tabs.push(theme.fg(complete ? "success" : "muted", ` ${tabLabel} `));
    }
  }

  const submitActive = currentTab === sessions.length;
  const submitText = " ✓ Submit ";
  tabs.push(
    submitActive
      ? theme.bg("selectedBg", theme.fg("text", submitText))
      : theme.fg(allQuestionsComplete(sessions) ? "success" : "dim", submitText)
  );

  add(tabs.join(" "));
};

const renderFooterHelp = (view: PromptView, add: (line: string) => void) => {
  const { currentTab, editMode, helpText, sessions, theme } = view;
  if (editMode.kind !== "none") {
    add(theme.fg("dim", HELP_EDITOR));
    return;
  }

  add(theme.fg("dim", helpText.globalTabs));
  if (currentTab >= sessions.length) {
    add(theme.fg("dim", helpText.submit));
    return;
  }

  const { question, state } = sessions[currentTab];
  const otherFocused =
    question.type !== "free_text" &&
    isOtherOption(question.options[state.cursor]);
  if (question.type === "single_select") {
    add(theme.fg("dim", otherFocused ? helpText.singleOther : helpText.single));
    return;
  }
  if (question.type === "multi_select") {
    add(theme.fg("dim", otherFocused ? helpText.multiOther : helpText.multi));
    return;
  }
  add(theme.fg("dim", helpText.freeText));
};

export const renderPrompt = (view: PromptView, width: number): string[] => {
  const { activeEditor, currentTab, editMode, hint, sessions, theme } = view;
  const maxWidth = Math.max(1, width);
  const lines: string[] = [];
  const add = (line: string) => {
    lines.push(truncateLine(line, maxWidth));
  };

  add(theme.fg("accent", "─".repeat(maxWidth)));
  renderTabBar(view, maxWidth, add);
  lines.push("");

  const panelLines =
    currentTab === sessions.length
      ? renderSubmitPanel(view, maxWidth)
      : renderQuestionPanel(view, currentTab, maxWidth);
  for (const line of panelLines) {
    lines.push(line);
  }

  if (editMode.kind !== "none") {
    lines.push("");
    add(view.theme.fg("muted", "Editing..."));
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
  renderFooterHelp(view, add);
  add(theme.fg("accent", "─".repeat(maxWidth)));
  return lines;
};
