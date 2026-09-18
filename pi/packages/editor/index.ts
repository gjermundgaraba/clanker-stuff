import { CustomEditor } from "@earendil-works/pi-coding-agent";
import type {
  ExtensionContext,
  ExtensionUIContext,
  KeybindingsManager,
  Theme,
} from "@earendil-works/pi-coding-agent";
import { truncateToWidth, type EditorTheme, type TUI } from "@earendil-works/pi-tui";
import { connect, type Draft, type DocumentView, type DocumentAdapter } from "./adapter.js";
import { decorateRows, type Decoration } from "./render.js";

/** Changes made outside the modal engine. Its own edits, restores and previews are not reported. */
export type Change = "input" | "insert" | "replace";

type Kind = Change | "edit" | "restore" | "preview";

export interface Editing {
  input(data: string): boolean;
  changed(kind: Change, before?: DocumentView): void;
  submitted(): void;
  suspend(): (restore: boolean) => void;
  selection(): Decoration[];
}

export interface Border {
  render(line: string, width: number, color: (text: string) => string): string;
}

interface Contributions {
  editing?: Editing;
  foreground?: (text: string) => Decoration[];
  border?: Border;
}

class SharedEditor extends CustomEditor {
  readonly document: DocumentAdapter;
  readonly keys: KeybindingsManager;
  private kind: Kind = "input";
  private before: DocumentView | undefined;

  constructor(
    tui: TUI,
    theme: EditorTheme,
    keys: KeybindingsManager,
    private readonly contributions: Contributions,
    private readonly uiTheme: () => Theme,
    changed: (kind: Kind, before?: DocumentView) => void,
  ) {
    super(tui, theme, keys, { embedWorkingStatus: true });
    this.keys = keys;
    this.document = connect(this);
    let change: typeof this.onChange;
    let submit: typeof this.onSubmit;
    // Pi assigns callbacks after the factory returns. Keep observation at that instance boundary.
    Object.defineProperty(this, "onChange", {
      configurable: true,
      get: () => (text: string) => {
        changed(this.kind, this.before);

        if (this.before) this.before = this.document.view();
        change?.(text);
      },
      set: (next: typeof this.onChange) => {
        change = next;
      },
    });
    Object.defineProperty(this, "onSubmit", {
      configurable: true,
      get: () => (text: string) => {
        contributions.editing?.submitted();
        submit?.(text);
      },
      set: (next: typeof this.onSubmit) => {
        submit = next;
      },
    });
  }
  private withChange(kind: Kind, action: () => void) {
    const previous = this.kind;
    const before = this.before;

    if (kind === "insert" && this.contributions.editing) this.before = this.document.view();
    this.kind = kind;

    try {
      action();
    } finally {
      this.kind = previous;
      this.before = before;
    }
  }
  // Pi copies getText() alone when swapping editors. Never export orphaned paste markers.
  override getText() {
    return this.getExpandedText();
  }
  nativeInput(data: string) {
    super.handleInput(data);
  }
  override handleInput(data: string) {
    // ProcessTerminal delivers complete packets, already framed by StdinBuffer.
    if (data.startsWith("\x1b[200~")) this.withChange("insert", () => super.handleInput(data));
    else if (data && !this.contributions.editing?.input(data)) this.nativeInput(data);
  }
  previewText(text: string) {
    this.withChange("preview", () => super.setText(text));
  }
  override setText(text: string) {
    // Pi round-trips getText() through setText(), e.g. when a custom view closes. Keep the
    // cursor, folded payloads, native undo and modal state when nothing is being replaced.
    if (text === this.getExpandedText()) return;
    this.withChange("replace", () => super.setText(text));
  }
  override insertTextAtCursor(text: string) {
    this.withChange("insert", () => super.insertTextAtCursor(text));
  }
  restore(draft: Draft, kind: "restore" | "preview" = "restore") {
    this.withChange(kind, () => {
      this.document.restore(draft);
      this.onChange?.(this.getText());
    });
    this.tui.requestRender();
  }
  restoreView(view: DocumentView) {
    this.withChange("restore", () => {
      this.document.restoreView(view);
      this.onChange?.(this.getText());
    });
    this.tui.requestRender();
  }
  edit(start: number, end: number, insertion: string, cursor: number) {
    this.withChange("edit", () => {
      this.document.replace(start, end, insertion, cursor);
      this.onChange?.(this.getText());
    });
    this.tui.requestRender();
  }
  refresh() {
    this.tui.requestRender();
  }
  override render(width: number) {
    const native = super.render(width);
    const text = this.document.text();

    const spans = [
      ...(this.contributions.foreground?.(text) ?? []),
      ...(this.contributions.editing?.selection() ?? []),
    ];

    const padding = Math.min(this.getPaddingX(), Math.max(0, Math.floor((width - 1) / 2)));

    const rows = spans.length
      ? decorateRows(native, text, padding, this.document, spans, this.uiTheme(), width)
      : native.map((row) => truncateToWidth(row, width, ""));

    if (rows.length && this.contributions.border)
      rows[0] = this.contributions.border.render(rows[0]!, width, this.borderColor);

    return rows;
  }
}

export class EditorHost {
  editor: SharedEditor | undefined;
  private readonly contributions: Contributions = {};
  private revision = 0;
  private history: string[] = [];
  private readonly mounts = new Set<(editor: SharedEditor) => void>();
  constructor(private readonly theme: () => Theme) {}
  create(tui: TUI, theme: EditorTheme, keys: KeybindingsManager) {
    if (this.editor) return this.editor;

    const editor = new SharedEditor(
      tui,
      theme,
      keys,
      this.contributions,
      this.theme,
      (kind, before) => {
        this.revision++;

        if (kind === "input" || kind === "insert" || kind === "replace")
          this.contributions.editing?.changed(kind, before);
      },
    );

    this.editor = editor;

    for (const entry of this.history) editor.addToHistory(entry);

    for (const mounted of this.mounts) mounted(editor);

    return editor;
  }
  /** One owner per slot; the release leaves a later owner's contribution in place. */
  contribute<K extends keyof Contributions>(slot: K, value: NonNullable<Contributions[K]>) {
    this.contributions[slot] = value;
    this.editor?.refresh();

    return () => {
      if (this.contributions[slot] !== value) return;
      delete this.contributions[slot];
      this.editor?.refresh();
    };
  }
  onMount(mounted: (editor: SharedEditor) => void) {
    this.mounts.add(mounted);

    if (this.editor) mounted(this.editor);

    return () => {
      this.mounts.delete(mounted);
    };
  }
  seedHistory(entries: string[]) {
    this.history = entries;

    for (const entry of entries) this.editor?.addToHistory(entry);
  }
  preview() {
    const editor = this.editor;

    if (!editor) throw new Error("History preview requires a mounted editor");
    const draft = editor.document.capture();
    const resume = this.contributions.editing?.suspend();
    let expected = this.revision;
    let active = true;

    return {
      show: (text: string) => {
        if (!active) return;

        if (expected !== this.revision) {
          active = false;
          resume?.(false);

          return;
        }

        editor.previewText(text);
        expected = this.revision;
      },
      close: (cancel: boolean) => {
        if (!active) return;
        active = false;

        if (expected !== this.revision) {
          resume?.(false);

          return;
        }

        if (cancel) editor.restore(draft, "preview");
        else editor.document.clearNativeUndo();
        resume?.(cancel);
        editor.refresh();
      },
    };
  }
}

// The factory is Pi's existing shared ownership boundary, including across separate jiti loads.
// The key versions the host's shape; a copy built for another shape sees a foreign editor.
const owner = Symbol.for("clanker-stuff.editor/1");

interface Owned {
  host: EditorHost;
  failure?: string;
}

type OwnedFactory = NonNullable<ReturnType<ExtensionUIContext["getEditorComponent"]>> & {
  [owner]?: Owned;
};

/** Install or join the shared editor. Undefined means editor-dependent features are skipped. */
export function acquireEditorHost(ctx: Pick<ExtensionContext, "ui">): EditorHost | undefined {
  const ui = ctx.ui;
  // SAFETY: The optional symbol property is set only on factories created below.
  const factory = ui.getEditorComponent() as OwnedFactory | undefined;
  let owned = factory?.[owner];

  if (factory && !owned) {
    ui.setStatus("shared-editor", "Custom editor: shared editing features unavailable");

    return undefined;
  }

  if (!owned) {
    const installed: Owned = { host: new EditorHost(() => ui.theme) };
    owned = installed;

    const next: OwnedFactory = (tui, theme, keys) => {
      try {
        return installed.host.create(tui, theme, keys);
      } catch (error) {
        // Pi has already cleared its editor container; an unsupported Pi keeps a stock prompt.
        installed.failure = error instanceof Error ? error.message : String(error);

        return new CustomEditor(tui, theme, keys, { embedWorkingStatus: true });
      }
    };

    next[owner] = installed;
    const draft = ui.getEditorText();
    ui.setEditorComponent(next);
    // Pi transfers only the previous editor's getText(), which can contain orphaned markers.
    // Its public UI getter is expanded; repair that lossy initial handoff.
    installed.host.editor?.setText(draft);
  }

  ui.setStatus("shared-editor", owned.failure);

  return owned.failure === undefined ? owned.host : undefined;
}

export type Preview = ReturnType<EditorHost["preview"]>;

export type { Draft, DocumentView } from "./adapter.js";

export type { Decoration } from "./render.js";
