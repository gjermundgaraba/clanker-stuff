import type { AssistantMessage } from "@earendil-works/pi-ai";
import {
  AssistantMessageComponent,
  CustomEditor,
  getMarkdownTheme,
  getSelectListTheme,
  UserMessageComponent,
} from "@earendil-works/pi-coding-agent";
import type { KeybindingsManager, Theme } from "@earendil-works/pi-coding-agent";
import { Key, matchesKey, truncateToWidth, TuiAltScreen } from "@earendil-works/pi-tui";
import type { Focusable, TUI } from "@earendil-works/pi-tui";

import { isSideActivityActive } from "./session.js";
import type { SideConversation, SideTranscriptItem } from "./session.js";

export type SidePanelConversation = Pick<SideConversation, "state" | "submit" | "subscribe">;

// oxlint-disable-next-line eslint/no-control-regex -- OSC 133 uses ESC and BEL control characters.
const PROMPT_ZONE_PATTERN = /\u001B\]133;[ABC]\u0007/gu;
const stripPromptZones = (text: string): string => text.replaceAll(PROMPT_ZONE_PATTERN, "");

const formatKey = (key: string): string => {
  switch (key) {
    case "enter":
    case "return": {
      return "Enter";
    }
    case "escape": {
      return "Esc";
    }
    case "pageDown": {
      return "PgDn";
    }
    case "pageUp": {
      return "PgUp";
    }
    case "space": {
      return "Space";
    }
    case "tab": {
      return "Tab";
    }
  }
  const parts = key.endsWith("+")
    ? [...key.slice(0, -1).split("+").filter(Boolean), "+"]
    : key.split("+");
  return parts
    .map((part) =>
      part === "+" || part.length === 1
        ? part.toUpperCase()
        : `${part[0]?.toUpperCase()}${part.slice(1)}`,
    )
    .join("+");
};

const renderAssistant = (message: AssistantMessage, width: number): string[] =>
  new AssistantMessageComponent(message, false, getMarkdownTheme(), undefined, 0)
    .render(width)
    .map(stripPromptZones);

const pad = (text: string, width: number): string =>
  truncateToWidth(text, Math.max(1, width), "…", true);

interface SidePanelActions {
  getMainWorking: () => boolean;
  getWorkingMarker: () => string;
  onClose: () => void;
  onDismiss: () => void;
  onInsertLatest: () => void;
}

export class SidePanel implements Focusable {
  private _focused = false;
  private readonly actions: SidePanelActions;
  private readonly conversation: SidePanelConversation;
  private readonly editor: CustomEditor;
  private readonly keybindings: KeybindingsManager;
  private readonly theme: Theme;
  private readonly tui: TUI;
  private scrollOffset = 0;
  private unsubscribe?: () => void;

  constructor(
    tui: TUI,
    theme: Theme,
    keybindings: KeybindingsManager,
    conversation: SidePanelConversation,
    actions: SidePanelActions,
    draft = "",
  ) {
    this.actions = actions;
    this.conversation = conversation;
    this.keybindings = keybindings;
    this.theme = theme;
    this.tui = tui;
    this.editor = new CustomEditor(
      tui,
      {
        borderColor: (text: string) => theme.fg("borderAccent", text),
        selectList: getSelectListTheme(),
      },
      keybindings,
    );
    for (const item of conversation.state.transcript) {
      if (item.kind === "user") {
        this.editor.addToHistory(item.text);
      }
    }
    this.editor.setText(draft);
    this.editor.onEscape = actions.onDismiss;
    this.editor.onCtrlD = actions.onClose;
    this.editor.onAction("app.message.copy", () => {
      if (tui instanceof TuiAltScreen && !tui.getCopyOnSelect() && tui.hasActiveSelection()) {
        void tui.copyActiveSelectionToClipboard();
      }
    });
    this.editor.onSubmit = (prompt) => {
      if (!this.conversation.submit(prompt)) {
        this.editor.setText(prompt);
        return;
      }
      this.editor.addToHistory(prompt);
      this.scrollOffset = 0;
    };
    this.unsubscribe = conversation.subscribe(() => {
      this.tui.requestRender();
    });
  }

  get focused(): boolean {
    return this._focused;
  }

  set focused(value: boolean) {
    this._focused = value;
    this.editor.focused = value;
  }

  handleInput(data: string): void {
    if (matchesKey(data, Key.ctrl("/"))) {
      this.actions.onDismiss();
      return;
    }
    if (matchesKey(data, Key.alt("enter"))) {
      this.actions.onInsertLatest();
      return;
    }
    if (matchesKey(data, Key.pageUp)) {
      this.scrollOffset += Math.max(1, Math.floor(this.tui.terminal.rows / 3));
      return;
    }
    if (matchesKey(data, Key.pageDown)) {
      this.scrollOffset = Math.max(
        0,
        this.scrollOffset - Math.max(1, Math.floor(this.tui.terminal.rows / 3)),
      );
      return;
    }
    this.editor.handleInput(data);
  }

  render(width: number): string[] {
    const safeWidth = Math.max(1, width);
    const innerWidth = Math.max(1, safeWidth - 2);
    const height = Math.max(1, this.tui.terminal.rows);
    const borderColor = this.focused ? "borderAccent" : "borderMuted";
    const border = (text: string) => this.theme.fg(borderColor, text);
    const row = (text: string) => `${border("│")}${pad(` ${text}`, innerWidth)}${border("│")}`;
    const sideState = isSideActivityActive(this.conversation.state.activity)
      ? `${this.actions.getWorkingMarker()} working`
      : "· ready";
    const mainState = this.actions.getMainWorking() ? "working" : "idle";
    const editorLines = this.editor
      .render(Math.max(10, innerWidth - 2))
      .slice(-Math.max(1, Math.min(6, Math.floor(height / 4))));
    const { statusMessage } = this.conversation.state;
    const statusHeight = statusMessage === undefined || statusMessage.length === 0 ? 0 : 1;
    const transcriptHeight = Math.max(0, height - 7 - editorLines.length - statusHeight);
    const interruptKeys = this.keybindings.getKeys("app.interrupt").map(formatKey).join("/");
    const exitKeys = this.keybindings.getKeys("app.exit").map(formatKey).join("/");
    const hints = [
      `${["Ctrl+/", interruptKeys].filter(Boolean).join(" or ")} dismiss`,
      exitKeys ? `${exitKeys} close` : "",
      "Alt+Enter insert",
      "PgUp/PgDn scroll",
    ]
      .filter(Boolean)
      .join(" · ");

    const lines = [
      border(`╭${"─".repeat(innerWidth)}╮`),
      row(`${this.theme.bold("Side")} ${sideState}`),
      row(this.theme.fg("dim", `Main ${mainState}`)),
      border(`├${"─".repeat(innerWidth)}┤`),
    ];

    for (const line of this.visibleTranscript(Math.max(1, innerWidth - 2), transcriptHeight)) {
      lines.push(row(line));
    }

    lines.push(border(`├${"─".repeat(innerWidth)}┤`));
    for (const line of editorLines) {
      lines.push(row(line));
    }
    if (statusMessage !== undefined && statusMessage.length > 0) {
      lines.push(row(this.theme.fg("warning", statusMessage)));
    }
    lines.push(row(this.theme.fg("dim", hints)), border(`╰${"─".repeat(innerWidth)}╯`));

    return lines.map((line) => truncateToWidth(line, safeWidth, "")).slice(0, height);
  }

  invalidate(): void {
    this.editor.invalidate();
  }

  getDraft(): string {
    return this.editor.getExpandedText();
  }

  submitExternalPrompt(text: string): void {
    const prompt = text.trim();
    if (!prompt) {
      return;
    }
    if (this.conversation.submit(prompt)) {
      this.editor.addToHistory(prompt);
      this.scrollOffset = 0;
      this.tui.requestRender();
      return;
    }
    const current = this.editor.getExpandedText();
    this.editor.setText(current ? `${current}\n${prompt}` : prompt);
    this.tui.requestRender();
  }

  dispose(): void {
    this.unsubscribe?.();
    this.unsubscribe = undefined;
  }

  private renderTranscriptItem(item: SideTranscriptItem, width: number): string[] {
    switch (item.kind) {
      case "user": {
        return new UserMessageComponent(item.text, getMarkdownTheme(), 1)
          .render(width)
          .map(stripPromptZones);
      }
      case "assistant": {
        return renderAssistant(item.message, width);
      }
      case "tool": {
        let marker = "✓";
        let color: "error" | "success" | "warning" = "success";
        if (item.status === "running") {
          marker = "●";
          color = "warning";
        } else if (item.status === "error") {
          marker = "✗";
          color = "error";
        }
        return [this.theme.fg(color, `${marker} ${item.name} ${item.status}`)];
      }
      case "error": {
        return [this.theme.fg("error", `Error: ${item.text}`)];
      }
      default: {
        item satisfies never;
        return [];
      }
    }
  }

  private transcriptLines(width: number): string[] {
    const lines: string[] = [];
    for (const item of this.conversation.state.transcript) {
      lines.push(...this.renderTranscriptItem(item, width), "");
    }
    const { activity } = this.conversation.state;
    if (activity.kind === "streaming") {
      lines.push(...renderAssistant(activity.message, width));
    }
    if (lines.at(-1) === "") {
      lines.pop();
    }
    return lines.length > 0
      ? lines
      : [this.theme.fg("dim", "Ask anything in this side conversation.")];
  }

  private visibleTranscript(width: number, height: number): string[] {
    const all = this.transcriptLines(width);
    const maxOffset = Math.max(0, all.length - height);
    this.scrollOffset = Math.min(this.scrollOffset, maxOffset);
    const end = all.length - this.scrollOffset;
    const visible = all.slice(Math.max(0, end - height), end);
    while (visible.length < height) {
      visible.unshift("");
    }
    return visible;
  }
}
