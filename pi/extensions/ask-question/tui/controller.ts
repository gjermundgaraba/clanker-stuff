import type { ExtensionContext, Theme, KeybindingsManager } from "@earendil-works/pi-coding-agent";
import { CURSOR_MARKER, Editor } from "@earendil-works/pi-tui";
import type { TUI, TuiMouseEvent, TuiMouseEventResult } from "@earendil-works/pi-tui";
import type { Action, Draft, Interaction } from "../interaction.js";
import { collectAnswers } from "../interaction.js";
import { MAX_NOTE, MAX_TEXT } from "../request.js";
import type { Question } from "../request.js";
import { answered } from "../summary.js";
import {
  diffText,
  markdownLines,
  optionDetailText,
  optionLines,
  progressLine,
  renderQuestionView,
  renderScrollablePage,
  reviewText,
  textLines,
} from "./render.js";
import { truncateToWidth } from "@earendil-works/pi-tui";
import { displayText } from "@clanker-stuff/pi-tool-rendering/text";
import { intent, keyLabel } from "./input.js";

export type FormOutcome = "submitted" | "closed" | "cancelled" | "stopped";

export interface FormPort {
  mutate(version: number, action: Action, unchangedDraft?: Draft): Promise<Interaction>;
  current(): Interaction;
  subscribe(listener: () => void): () => void;
  send(revision: number, uncertain: boolean): Promise<void>;
  blocking: boolean;
  setFlush(flush: () => Promise<void>): void;
  notify(text: string): void;
  report(cause: unknown): void;
}

type Field =
  | { kind: "custom"; question: string; option?: never }
  | { kind: "note"; question?: string; option?: string };

export class QuestionnaireView {
  private item: Interaction;
  private question = 0;
  private highlight = 0;
  private scroll = 0;
  private scrollPage = 1;
  private viewport = { top: 0, rows: 0 };
  private detail: { title: string; text: string; markdown: boolean } | undefined;
  private editor: { component: Editor; field: Field; initial: string } | undefined;
  private hint = "";
  private armedCancel = false;
  private finished = false;
  private working = Promise.resolve();
  private unsubscribe: () => void;
  private _focused = false;
  private readonly abort = () => {
    void this.flush()
      .catch((error) => this.port.report(error))
      .finally(() => this.finish("stopped"));
  };
  constructor(
    private readonly tui: TUI,
    private readonly theme: Theme,
    private readonly keys: KeybindingsManager,
    item: Interaction,
    private readonly port: FormPort,
    private readonly done: (result: FormOutcome) => void,
    private readonly signal: AbortSignal,
  ) {
    this.item = item;

    const open = item.request.questions.findIndex(
      (q) => !item.draft || !answered(item.draft.answers[q.id]),
    );

    this.go(open < 0 ? item.request.questions.length : open);
    this.unsubscribe = port.subscribe(() => tui.requestRender());
    port.setFlush(() => this.flush());
    signal.addEventListener("abort", this.abort, { once: true });

    if (signal.aborted) queueMicrotask(this.abort);
  }
  get focused(): boolean {
    return this._focused;
  }
  set focused(value: boolean) {
    this._focused = value;

    if (this.editor) this.editor.component.focused = value;
  }
  private enqueue(run: () => Promise<void>): void {
    this.working = this.working
      .then(async () => {
        if (!this.finished) await run();
      })
      .catch((error) => {
        this.hint = error instanceof Error ? error.message : String(error);
      })
      .finally(() => this.tui.requestRender());
  }
  /** Waits for queued input to be processed without saving an open editor. */
  async settled(): Promise<void> {
    await this.working;
  }
  /** Saves an open editor; used by Stop, close and navigation. */
  async flush(): Promise<void> {
    await this.working;
    await this.saveField();
  }
  private async change(action: Action): Promise<void> {
    const current = this.port.current();

    // Delivery/pause bookkeeping may advance without changing the authored draft.
    if (JSON.stringify(current.draft) === JSON.stringify(this.item.draft)) this.item = current;
    this.item = await this.port.mutate(this.item.version, action, this.item.draft);
    this.hint = "";
  }
  private async saveField(force = false): Promise<void> {
    const editing = this.editor;

    if (!editing) return;
    const text = editing.component.getText();

    if (!force && text === editing.initial) return;
    const field = editing.field;

    if (field.kind === "custom")
      await this.change({ type: "custom", question: field.question, text });
    else
      await this.change({
        type: "note",
        ...(field.question !== undefined ? { question: field.question } : {}),
        ...(field.option !== undefined ? { option: field.option } : {}),
        text,
      });
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
    // Completion and newline are handled with the injected app manager, not Editor's global manager.
    component.onSubmit = () => {};

    const limit = field.kind === "custom" ? MAX_TEXT : MAX_NOTE;
    component.onChange = () => {
      const length = component.getText().length;
      this.hint = length > limit ? `${length}/${limit} · over the limit, shorten to save` : "";
    };

    this.editor = { component, field, initial: value };
    this.hint = "";
    this.scroll = 0;
  }
  /** Moves to a question (or Review) and highlights its current answer. */
  private go(index: number): void {
    const questions = this.item.request.questions;
    this.question = Math.max(0, Math.min(index, questions.length));
    const q = questions[this.question];
    const a = q && this.item.draft?.answers[q.id];
    const selected = q?.options?.findIndex((o) => a?.selected.includes(o.id)) ?? -1;
    this.highlight = selected >= 0 ? selected : a?.custom_selected ? (q?.options?.length ?? 0) : 0;
    this.scroll = 0;
  }
  private async choose(index: number, toggle = false): Promise<void> {
    const q = this.item.request.questions[this.question];
    const draft = q && this.item.draft?.answers[q.id];

    if (!q || !draft) throw new Error("No editable question");
    const option = q.options?.[index];

    if (!option) {
      if (toggle && q.multi_select) await this.change({ type: "toggle_custom", question: q.id });
      else this.edit({ kind: "custom", question: q.id }, draft.custom);

      return;
    }

    await this.change({ type: "select", question: q.id, option: option.id });

    if (!q.multi_select) this.go(this.question + 1);
  }
  private async finish(outcome: FormOutcome): Promise<void> {
    if (this.finished) return;

    if (outcome !== "stopped") await this.saveField();
    this.finished = true;
    this.dispose();
    this.done(outcome);
  }
  handleInput(data: string): void {
    // Resolve the recipient after preceding transitions finish. Otherwise keys
    // arriving during an editor save are inserted into the outgoing field.
    this.enqueue(() => this.processInput(data));
  }
  private async processInput(data: string): Promise<void> {
    if (this.finished) return;

    if (this.editor) {
      const { component, field } = this.editor;

      if (this.keys.matches(data, "tui.input.newLine")) {
        component.insertTextAtCursor("\n");
      } else if (this.keys.matches(data, "tui.input.submit")) {
        try {
          // A written answer is selected by saving it, even when its text is unchanged.
          await this.saveField(field.kind === "custom");
        } catch (error) {
          const limit = field.kind === "custom" ? MAX_TEXT : MAX_NOTE;
          this.hint = `${component.getText().length}/${limit} · ${error instanceof Error ? error.message : String(error)}`;

          return;
        }

        this.editor = undefined;
        this.scroll = 0;

        if (field.kind === "custom") await this.afterWritten(field.question);
      } else if (this.keys.matches(data, "tui.select.cancel")) {
        this.editor = undefined;
        this.hint = "";
        this.scroll = 0;
      } else component.handleInput(data);
      this.tui.requestRender();

      return;
    }

    const action = intent(
      this.keys,
      data,
      !!this.detail || this.question < this.item.request.questions.length,
    );

    const confirmCancel = this.armedCancel && action === "key:x";
    this.armedCancel = false;

    if (action === "page_up" || action === "page_down") {
      this.scroll = Math.max(
        0,
        this.scroll + (action === "page_up" ? -this.scrollPage : this.scrollPage),
      );

      return;
    }

    this.hint = "";

    if (this.detail) {
      if (action === "close" || action === "back" || action === "confirm") {
        this.detail = undefined;
        this.scroll = 0;
      } else if (action === "up" || action === "down")
        this.scroll = Math.max(0, this.scroll + (action === "up" ? -1 : 1));

      return;
    }

    if (action === "close") {
      await this.finish("closed");

      return;
    }

    if (action === "key:x") {
      if (!confirmCancel) {
        this.armedCancel = true;
        this.hint = `Press x again to cancel this request and discard the draft${this.port.blocking ? " · the run stops" : ""}`;

        return;
      }

      await this.change({ type: "cancel" });
      await this.finish("cancelled");

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

    if (action === "key:g") {
      this.edit({ kind: "note" }, this.item.draft?.note ?? "");

      return;
    }

    if (action === "key:i") {
      this.detail = {
        title: "Request details",
        text: `ID: ${this.item.id}\nCreated: ${this.item.created_at}${this.item.draft?.reason ? `\nRevision requested: ${this.item.draft.reason}` : ""}`,
        markdown: false,
      };
      this.scroll = 0;

      return;
    }

    if (action === "key:d") {
      this.detail = { title: "Revision comparison", text: diffText(this.item), markdown: false };
      this.scroll = 0;

      return;
    }

    const q = this.item.request.questions[this.question];

    if (!q) {
      if (/^key:[1-5]$/.test(action)) {
        this.go(Number(action.slice(-1)) - 1);

        return;
      }

      if (action === "confirm" || action === "key:k") {
        collectAnswers(this.item);

        if (this.port.blocking && this.port.current().paused) await this.change({ type: "resume" });
        await this.change({ type: "submit" });

        try {
          if (this.port.blocking) return;

          if (action === "key:k")
            this.port.notify("Answers saved, not sent · /answers to send them");
          else await this.port.send(this.item.submissions.at(-1)!.revision, false);
        } catch (error) {
          this.port.report(error); // The immutable submission remains available in the inbox.
        } finally {
          await this.finish("submitted");
        }
      }

      return;
    }

    const option = q.options?.[this.highlight];

    if (action === "up" || action === "down") {
      this.highlight = Math.max(
        0,
        Math.min(q.options?.length ?? 0, this.highlight + (action === "up" ? -1 : 1)),
      );

      return;
    }

    if (action === "key:p") {
      const text = optionDetailText(q, this.highlight);

      if (!option || !text) return;
      this.detail = { title: option.label, text, markdown: true };
      this.scroll = 0;

      return;
    }

    if (action === "key:n") {
      const a = this.item.draft?.answers[q.id];

      if (!a) throw new Error("No editable question");
      this.edit(
        { kind: "note", question: q.id, ...(option ? { option: option.id } : {}) },
        option ? (a.notes[option.id] ?? "") : a.custom_note,
      );

      return;
    }

    if (/^key:[1-5]$/.test(action)) {
      const index = Number(action.slice(-1)) - 1;

      if (index < (q.options?.length ?? 0)) {
        this.highlight = index;
        await this.choose(index);
      }

      return;
    }

    if (action === "toggle") {
      await this.choose(this.highlight, true);

      return;
    }

    if (action === "confirm") {
      if (q.multi_select && option) {
        if (!answered(this.item.draft?.answers[q.id]))
          throw new Error("Select at least one answer before advancing");
        this.go(this.question + 1);
      } else await this.choose(this.highlight);
    }
  }
  /** Saving a written answer completes the question; a blank one deselects itself. */
  private async afterWritten(questionId: string): Promise<void> {
    const index = this.item.request.questions.findIndex((q) => q.id === questionId);
    const a = this.item.draft?.answers[questionId];

    if (index < 0 || !a) return;

    if (a.custom.trim()) this.go(index + 1);
    else if (a.custom_selected) await this.change({ type: "toggle_custom", question: questionId });
  }
  handleMouse(event: TuiMouseEvent): TuiMouseEventResult | undefined {
    if (event.type !== "wheel" || !event.wheelDelta) return;
    const { top, rows } = this.viewport;

    if (rows === 0 || event.y < top || event.y >= top + rows) return;
    this.scroll += event.wheelDelta;

    return { handled: true };
  }
  render(availableWidth: number): string[] {
    const padding = availableWidth >= 28 ? 2 : 0;
    const width = availableWidth - padding * 2;
    const q = this.item.request.questions[this.question];
    const confirm = keyLabel(this.keys, "tui.select.confirm");
    const close = keyLabel(this.keys, "tui.select.cancel");
    const scrollKeys = `${keyLabel(this.keys, "tui.select.pageUp")}/${keyLabel(this.keys, "tui.select.pageDown")}`;
    const base = this.item.draft?.base_revision;

    const common = {
      title: `${this.item.request.title ?? "Questionnaire"}${base ? ` · revising revision ${base}` : ""}`,
      closeKey: close,
      rows: this.tui.terminal.rows,
      width,
      scroll: this.scroll,
      theme: this.theme,
    };

    let view;

    if (this.editor) {
      const lines = this.editor.component.render(width);
      const cursor = lines.findIndex((line) => line.includes(CURSOR_MARKER));
      const limit = this.editor.field.kind === "custom" ? MAX_TEXT : MAX_NOTE;
      const label = this.editorLabel(q);
      const body = [this.theme.bold(label), "", ...lines];

      view = renderScrollablePage({
        ...common,
        header: progressLine(this.item, this.question, width, this.theme),
        body,
        footer: `${keyLabel(this.keys, "tui.input.submit")} Save · ${close} Discard\n${keyLabel(this.keys, "tui.input.newLine")} Newline`,
        hint:
          this.hint ||
          `${this.editor.component.getText().length}/${limit}${body.length > 3 ? ` · ${scrollKeys} Scroll` : ""}`,
        ...(cursor < 0 ? {} : { focusLine: cursor + 2 }),
      });
    } else if (this.detail) {
      view = renderScrollablePage({
        ...common,
        header: this.theme.fg("accent", this.theme.bold(truncateToWidth(this.detail.title, width))),
        body: this.detail.markdown
          ? markdownLines(this.detail.text, width)
          : textLines(this.detail.text, width),
        footer: `${close}/${confirm} Back · ↑↓/j/k/${scrollKeys} Scroll`,
        hint: this.hint,
      });
    } else if (!q) {
      view = renderScrollablePage({
        ...common,
        header: progressLine(this.item, this.question, width, this.theme),
        body: textLines(reviewText(this.item), width),
        footer: `${confirm} ${this.port.blocking ? (this.port.current().paused ? "Submit and continue" : "Submit answers") : "Send answers"}${this.port.blocking ? "" : " · k Save without sending"} · ${close} Close · x Cancel\n${this.port.blocking ? "" : "Send starts/steers a turn · "}1–5 Edit · ←/h Back · g Form note${base ? " · d Changes" : ""} · i Details`,
        hint: this.hint,
      });
    } else {
      const a = this.item.draft?.answers[q.id];

      if (!a) throw new Error("No editable question");
      const option = q.options?.[this.highlight];

      const primary = !option
        ? a.custom_selected && a.custom.trim()
          ? "Edit answer · → Next"
          : "Write answer"
        : q.multi_select
          ? "Next"
          : "Select + next";

      const hasDetails = !!optionDetailText(q, this.highlight);

      view = renderQuestionView({
        ...common,
        header: progressLine(this.item, this.question, width, this.theme),
        context: this.contextLines(q, width),
        answers: this.questionBody(q, a, this.highlight, width),
        footer: `${confirm} ${primary}${q.multi_select ? " · Space Toggle" : ""} · ${close} Close · x Cancel\n${scrollKeys} Context · ↑↓/j/k Move · ←→/h/l Questions · n Note · g Form note${hasDetails ? " · p Details" : ""} · i Details${base ? " · d Changes" : ""}`,
        hint: this.hint,
      });
    }

    this.scroll = view.scroll;
    this.scrollPage = Math.max(1, view.viewport.rows - 1);
    this.viewport = view.viewport;

    return view.lines.map((line) => " ".repeat(padding) + line);
  }
  private contextLines(q: Question, width: number): string[] {
    const lines: string[] = [];

    for (const context of [
      this.item.draft?.reason ? `**Revision requested:** ${this.item.draft.reason}` : undefined,
      this.item.request.context,
      q.context,
    ]) {
      if (context) lines.push(...markdownLines(context, width), "");
    }

    if (lines.at(-1) === "") lines.pop();

    return lines;
  }
  private editorLabel(q: Question | undefined): string {
    const field = this.editor?.field;

    if (!field || field.question === undefined) return "Questionnaire note";

    if (field.kind === "custom") return q?.question ?? "Written answer";
    const option = q?.options?.find((candidate) => candidate.id === field.option);

    return option ? `Note · ${option.label}` : "Written-answer note";
  }
  /** Compact question and answer controls pinned below the context viewport. */
  private questionBody(
    q: Question,
    a: Draft["answers"][string],
    highlight: number,
    width: number,
  ): string[] {
    const lines = [
      ...textLines(q.question, width),
      "",
      ...optionLines(q, a, highlight, width, this.theme),
    ];

    if (this.item.draft?.note)
      lines.push(
        "",
        this.theme.fg(
          "muted",
          truncateToWidth(
            `Questionnaire note: ${displayText(this.item.draft.note).split("\n")[0]}`,
            width,
            "…",
          ),
        ),
      );

    return lines;
  }
  invalidate(): void {
    this.editor?.component.invalidate();
  }
  dispose(): void {
    this.unsubscribe();
    this.signal.removeEventListener("abort", this.abort);
  }
}

export async function showQuestionnaire(
  ctx: ExtensionContext,
  item: Interaction,
  signal: AbortSignal,
  port: FormPort,
): Promise<FormOutcome> {
  return ctx.ui.custom<FormOutcome>(
    (tui, theme, keys, done) => new QuestionnaireView(tui, theme, keys, item, port, done, signal),
  );
}
