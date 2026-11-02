import { displayText } from "@clanker-stuff/pi-tool-rendering/text";
import type {
  ExtensionContext,
  Theme,
  KeybindingsManager,
} from "@earendil-works/pi-coding-agent";
import { getMarkdownTheme } from "@earendil-works/pi-coding-agent";
import {
  CURSOR_MARKER,
  Editor,
  Markdown,
  truncateToWidth,
} from "@earendil-works/pi-tui";
import type {
  TUI,
  TuiMouseEvent,
  TuiMouseEventResult,
} from "@earendil-works/pi-tui";

import type { Outcome } from "../delivery.js";
import type { Action, Fields, Interaction } from "../interaction.js";
import { answered } from "../interaction.js";
import { MAX_NOTE, MAX_TEXT } from "../request.js";
import type { Question } from "../request.js";
import { intent, keyLabel } from "./input.js";
import {
  Viewport,
  optionDetailText,
  optionLines,
  padded,
  progressLine,
  renderQuestionView,
  renderScrollablePage,
  reviewText,
  textLines,
} from "./render.js";

/** A submitted or dismissed outcome; "closed" keeps the draft; "stopped" means the view was aborted. */
export type FormResult = Outcome | "closed" | "stopped";

export interface FormPort {
  mutate: (action: Action) => Interaction;
  current: () => Interaction;
  subscribe: (listener: () => void) => () => void;
  /** Submits or dismisses the draft and returns the outcome. */
  finish: (kind: "submit" | "dismiss") => Outcome;
  /** Whether a tool call is waiting for this questionnaire. */
  waiting: boolean;
  setFlush: (flush: () => void) => void;
  report: (cause: unknown) => void;
}

type Field =
  | { type: "custom"; question: string }
  | { type: "note"; question: string; option?: string };

export class QuestionnaireView {
  private item: Interaction;
  private question = 0;
  private highlight = 0;
  private readonly viewport = new Viewport();
  private readonly markdown = new Map<string, Markdown>();
  private detail: { title: string; text: string } | undefined;
  private editor:
    | { component: Editor; field: Field; initial: string; limit: number }
    | undefined;
  private hint = "";
  private finished = false;
  private readonly unsubscribe: () => void;
  private _focused = false;
  private readonly abort = () => {
    try {
      this.flush();
    } catch (error) {
      this.port.report(error);
    }

    this.finish("stopped");
  };
  private readonly tui: TUI;
  private readonly theme: Theme;
  private readonly keys: KeybindingsManager;
  private readonly port: FormPort;
  private readonly done: (result: FormResult) => void;
  private readonly signal: AbortSignal;

  constructor(
    tui: TUI,
    theme: Theme,
    keys: KeybindingsManager,
    item: Interaction,
    port: FormPort,
    done: (result: FormResult) => void,
    signal: AbortSignal
  ) {
    this.tui = tui;
    this.theme = theme;
    this.keys = keys;
    this.port = port;
    this.done = done;
    this.signal = signal;
    this.item = item;

    const open = item.request.questions.findIndex(
      (q) => !answered(item.draft?.[q.id])
    );

    this.go(open === -1 ? item.request.questions.length : open);
    this.unsubscribe = port.subscribe(() => {
      this.item = port.current();
      tui.requestRender();
    });
    port.setFlush(() => {
      this.flush();
    });
    signal.addEventListener("abort", this.abort, { once: true });

    if (signal.aborted) {
      queueMicrotask(this.abort);
    }
  }
  get focused(): boolean {
    return this._focused;
  }
  set focused(value: boolean) {
    this._focused = value;

    if (this.editor) {
      this.editor.component.focused = value;
    }
  }
  flush(): void {
    this.saveField();
  }
  private change(action: Action): void {
    this.item = this.port.mutate(action);
    this.hint = "";
  }
  private saveField(force = false): void {
    const editing = this.editor;

    if (!editing) {
      return;
    }

    const text = editing.component.getText();

    if (!force && text === editing.initial) {
      return;
    }

    this.change({ ...editing.field, text });
    editing.initial = text;
  }
  private edit(field: Field, value: string): void {
    const component = new Editor(this.tui, {
      borderColor: (t) => this.theme.fg("borderAccent", t),
      selectList: {
        description: (t) => t,
        noMatch: (t) => t,
        scrollInfo: (t) => t,
        selectedPrefix: (t) => t,
        selectedText: (t) => t,
      },
    });

    component.setText(value);
    component.focused = this.focused;
    component.onSubmit = () => undefined;

    const limit = field.type === "custom" ? MAX_TEXT : MAX_NOTE;
    component.onChange = () => {
      const { length } = component.getText();
      this.hint =
        length > limit
          ? `${length}/${limit} · over the limit, shorten to save`
          : "";
    };

    this.editor = { component, field, initial: value, limit };
    this.hint = "";
    this.viewport.scroll = 0;
  }
  private go(index: number): void {
    const { questions } = this.item.request;
    this.question = Math.max(0, Math.min(index, questions.length));
    const q = questions[this.question];
    const a = q && this.item.draft?.[q.id];

    const selected =
      q?.options?.findIndex((o) => a?.selected.includes(o.id) === true) ?? -1;

    if (selected >= 0) {
      this.highlight = selected;
    } else if (a?.custom_selected === true) {
      this.highlight = q?.options?.length ?? 0;
    } else {
      this.highlight = 0;
    }

    this.viewport.scroll = 0;
  }
  private choose(index: number, toggle = false): void {
    const q = this.item.request.questions[this.question];
    const draft = q && this.item.draft?.[q.id];

    if (!q || !draft) {
      throw new Error("No editable question");
    }

    const option = q.options?.[index];

    if (!option) {
      if (toggle && q.multi_select === true) {
        this.change({ type: "toggle_custom", question: q.id });
      } else {
        this.edit({ type: "custom", question: q.id }, draft.custom);
      }

      return;
    }

    this.change({ type: "select", question: q.id, option: option.id });

    if (q.multi_select !== true) {
      this.go(this.question + 1);
    }
  }
  private finish(result: FormResult): void {
    if (this.finished) {
      return;
    }

    this.finished = true;
    this.dispose();
    this.done(result);
  }
  handleInput(data: string): void {
    if (this.finished) {
      return;
    }

    try {
      this.processInput(data);
    } catch (error) {
      this.hint = error instanceof Error ? error.message : String(error);
    }

    this.tui.requestRender();
  }
  private processInput(data: string): void {
    if (this.editor) {
      const { component, field, limit } = this.editor;

      if (this.keys.matches(data, "tui.input.newLine")) {
        component.insertTextAtCursor("\n");
      } else if (this.keys.matches(data, "tui.input.submit")) {
        try {
          this.saveField(field.type === "custom");
        } catch (error) {
          this.hint = `${component.getText().length}/${limit} · ${error instanceof Error ? error.message : String(error)}`;

          return;
        }

        this.editor = undefined;
        this.viewport.scroll = 0;

        if (field.type === "custom") {
          this.afterWritten(field.question);
        }
      } else if (this.keys.matches(data, "tui.select.cancel")) {
        this.editor = undefined;
        this.hint = "";
        this.viewport.scroll = 0;
      } else {
        component.handleInput(data);
      }

      return;
    }

    const action = intent(
      this.keys,
      data,
      !!this.detail || this.question < this.item.request.questions.length
    );

    if (action === "page_up" || action === "page_down") {
      this.viewport.pages(action === "page_up" ? -1 : 1);

      return;
    }

    this.hint = "";

    if (this.detail) {
      if (action === "close" || action === "back" || action === "confirm") {
        this.detail = undefined;
        this.viewport.scroll = 0;
      } else if (action === "up" || action === "down") {
        this.viewport.by(action === "up" ? -1 : 1);
      }

      return;
    }

    if (action === "close") {
      this.finish("closed");

      return;
    }

    if (action === "key:d") {
      this.finish(this.port.finish("dismiss"));

      return;
    }

    if (action === "back") {
      this.go(this.question - 1);

      return;
    }

    if (action === "next") {
      this.go(this.question + 1);

      return;
    }

    if (action === "key:r") {
      this.go(this.item.request.questions.length);

      return;
    }

    const q = this.item.request.questions[this.question];

    if (!q) {
      if (/^key:[1-5]$/u.test(action)) {
        this.go(Number(action.slice(-1)) - 1);

        return;
      }

      if (action === "confirm") {
        this.finish(this.port.finish("submit"));
      }

      return;
    }

    const option = q.options?.[this.highlight];

    if (action === "up" || action === "down") {
      this.highlight = Math.max(
        0,
        Math.min(
          q.options?.length ?? 0,
          this.highlight + (action === "up" ? -1 : 1)
        )
      );

      return;
    }

    if (action === "key:p") {
      const text = optionDetailText(q, this.highlight);

      if (!option || text === undefined) {
        return;
      }

      this.detail = { title: option.label, text };
      this.viewport.scroll = 0;

      return;
    }

    if (action === "key:n") {
      const a = this.item.draft?.[q.id];

      if (!a) {
        throw new Error("No editable question");
      }

      this.edit(
        {
          type: "note",
          question: q.id,
          ...(option ? { option: option.id } : {}),
        },
        option ? (a.notes[option.id] ?? "") : a.custom_note
      );

      return;
    }

    if (/^key:[1-5]$/u.test(action)) {
      const index = Number(action.slice(-1)) - 1;

      if (index < (q.options?.length ?? 0)) {
        this.highlight = index;
        this.choose(index);
      }

      return;
    }

    if (action === "toggle") {
      this.choose(this.highlight, true);

      return;
    }

    if (action === "confirm") {
      if (q.multi_select === true && option) {
        if (!answered(this.item.draft?.[q.id])) {
          throw new Error("Select at least one answer before advancing");
        }

        this.go(this.question + 1);
      } else {
        this.choose(this.highlight);
      }
    }
  }
  private afterWritten(questionId: string): void {
    const index = this.item.request.questions.findIndex(
      (q) => q.id === questionId
    );

    const a = this.item.draft?.[questionId];

    if (index === -1 || !a) {
      return;
    }

    if (a.custom.trim()) {
      this.go(index + 1);
    } else if (a.custom_selected) {
      this.change({ type: "toggle_custom", question: questionId });
    }
  }
  handleMouse(event: TuiMouseEvent): TuiMouseEventResult | undefined {
    return this.viewport.wheel(event);
  }
  render(availableWidth: number): string[] {
    return padded(availableWidth, (width) =>
      this.viewport.show(this.frame(width))
    );
  }
  private frame(width: number) {
    const q = this.item.request.questions[this.question];
    const confirm = keyLabel(this.keys, "tui.select.confirm");
    const close = keyLabel(this.keys, "tui.select.cancel");
    const scrollKeys = `${keyLabel(this.keys, "tui.select.pageUp")}/${keyLabel(this.keys, "tui.select.pageDown")}`;

    const common = {
      title: this.item.request.title ?? "Questionnaire",
      closeKey: close,
      rows: this.tui.terminal.rows,
      width,
      scroll: this.viewport.scroll,
      theme: this.theme,
    };

    if (this.editor) {
      const lines = this.editor.component.render(width);
      const cursor = lines.findIndex((line) => line.includes(CURSOR_MARKER));
      const label = QuestionnaireView.editorLabel(this.editor.field, q);
      const body = [this.theme.bold(label), "", ...lines];

      return renderScrollablePage({
        ...common,
        header: progressLine(this.item, this.question, width, this.theme),
        body,
        footer: `${keyLabel(this.keys, "tui.input.submit")} Save · ${close} Discard\n${keyLabel(this.keys, "tui.input.newLine")} Newline`,
        hint:
          this.hint ||
          `${this.editor.component.getText().length}/${this.editor.limit}${body.length > 3 ? ` · ${scrollKeys} Scroll` : ""}`,
        ...(cursor === -1 ? {} : { focusLine: cursor + 2 }),
      });
    }

    if (this.detail) {
      return renderScrollablePage({
        ...common,
        header: this.theme.fg(
          "accent",
          this.theme.bold(truncateToWidth(this.detail.title, width))
        ),
        body: this.markdownLines(this.detail.text, width),
        footer: `${close}/${confirm} Back · ↑↓/j/k/${scrollKeys} Scroll`,
        hint: this.hint,
      });
    }

    if (!q) {
      return renderScrollablePage({
        ...common,
        header: progressLine(this.item, this.question, width, this.theme),
        body: textLines(reviewText(this.item), width),
        footer: `${confirm} ${this.port.waiting ? "Submit answers" : "Send answers (starts or steers a turn)"} · ${close} Close\n1–5 Edit · ←/h Back · d Dismiss`,
        hint: this.hint,
      });
    }

    const a = this.item.draft?.[q.id];

    if (!a) {
      throw new Error("No editable question");
    }

    const option = q.options?.[this.highlight];

    let primary: string;

    if (option) {
      primary = q.multi_select === true ? "Next" : "Select + next";
    } else {
      primary =
        a.custom_selected && a.custom.trim()
          ? "Edit answer · → Next"
          : "Write answer";
    }

    const hasDetails = optionDetailText(q, this.highlight) !== undefined;

    return renderQuestionView({
      ...common,
      header: progressLine(this.item, this.question, width, this.theme),
      context: this.contextLines(q, width),
      answers: this.questionBody(q, a, this.highlight, width),
      footer: `${confirm} ${primary}${q.multi_select === true ? " · Space Toggle" : ""} · ${close} Close · d Dismiss\n${scrollKeys} Context · ↑↓/j/k Move · ←→/h/l Questions · r Review · n Note${hasDetails ? " · p Details" : ""}`,
      hint: this.hint,
    });
  }
  private markdownLines(text: string, width: number): string[] {
    let component = this.markdown.get(text);

    if (!component) {
      component = new Markdown(displayText(text), 0, 0, getMarkdownTheme());
      this.markdown.set(text, component);
    }

    return component.render(Math.max(1, width));
  }
  private contextLines(q: Question, width: number): string[] {
    const lines: string[] = [];

    for (const context of [this.item.request.context, q.context]) {
      if (context !== undefined) {
        lines.push(...this.markdownLines(context, width), "");
      }
    }

    if (lines.at(-1) === "") {
      lines.pop();
    }

    return lines;
  }
  private static editorLabel(field: Field, q: Question | undefined): string {
    if (field.type === "custom") {
      return q?.question ?? "Written answer";
    }

    const option = q?.options?.find(
      (candidate) => candidate.id === field.option
    );

    return option ? `Note · ${option.label}` : "Written-answer note";
  }
  private questionBody(
    q: Question,
    a: Fields,
    highlight: number,
    width: number
  ): string[] {
    return [
      ...textLines(q.question, width),
      "",
      ...optionLines(q, a, highlight, width, this.theme),
    ];
  }
  invalidate(): void {
    this.markdown.clear();
    this.editor?.component.invalidate();
  }
  dispose(): void {
    this.unsubscribe();
    this.signal.removeEventListener("abort", this.abort);
  }
}

export const showQuestionnaire = async (
  ctx: ExtensionContext,
  item: Interaction,
  signal: AbortSignal,
  port: FormPort
): Promise<FormResult> =>
  await ctx.ui.custom<FormResult>(
    (tui, theme, keys, done) =>
      new QuestionnaireView(tui, theme, keys, item, port, done, signal),
    port.waiting
      ? {
          blocked: {
            kind: "question",
            message: item.request.title ?? "Questions await your answers",
          },
        }
      : undefined
  );
