import { CustomEditor } from "@earendil-works/pi-coding-agent";
import type {
  ExtensionContext,
  ExtensionUIContext,
  KeybindingsManager,
  Theme,
} from "@earendil-works/pi-coding-agent";
import { truncateToWidth, type EditorTheme, type TUI } from "@earendil-works/pi-tui";
import { connect, type DocumentView, type DocumentAdapter } from "./adapter.js";
import { decorateRows, type Decoration } from "./render.js";

/** Changes made outside the modal engine. Its own edits and restores are not reported. */
export type Change = "input" | "insert" | "replace";

type Kind = Change | "edit" | "restore";

export interface Editing {
  input(data: string): boolean;
  changed(kind: Change, before?: DocumentView): void;
  submitted(): void;
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
  /** Undefined when Pi's private editor layout is unsupported: document features are skipped. */
  readonly document: DocumentAdapter | undefined;
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
    unsupported: (reason: string) => void,
  ) {
    super(tui, theme, keys, { embedWorkingStatus: true });
    this.keys = keys;

    try {
      this.document = connect(this);
    } catch (error) {
      // Border, working status, history and change observation still use only public editor APIs.
      unsupported(error instanceof Error ? error.message : String(error));
    }

    let change: typeof this.onChange;
    let submit: typeof this.onSubmit;
    // Pi assigns callbacks after the factory returns. Keep observation at that instance boundary.
    Object.defineProperty(this, "onChange", {
      configurable: true,
      get: () => (text: string) => {
        changed(this.kind, this.before);

        if (this.before) this.before = this.document?.view();
        change?.(text);
      },
      set: (next: typeof this.onChange) => {
        change = next;
      },
    });
    Object.defineProperty(this, "onSubmit", {
      configurable: true,
      get: () => (text: string) => {
        this.editing?.submitted();
        submit?.(text);
      },
      set: (next: typeof this.onSubmit) => {
        submit = next;
      },
    });
  }
  /** The modal engine edits through the document adapter, so it is inactive without one. */
  private get editing() {
    return this.document && this.contributions.editing;
  }
  private withChange(kind: Kind, action: () => void) {
    const previous = this.kind;
    const before = this.before;

    if (kind === "insert" && this.editing) this.before = this.document?.view();
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
    else if (data && !this.editing?.input(data)) this.nativeInput(data);
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
  // The modal engine is the only caller and is inactive without a document.
  restoreView(view: DocumentView) {
    const document = this.document;

    if (!document) return;
    this.withChange("restore", () => {
      document.restoreView(view);
      this.onChange?.(this.getText());
    });
    this.tui.requestRender();
  }
  edit(start: number, end: number, insertion: string, cursor: number) {
    const document = this.document;

    if (!document) return;
    this.withChange("edit", () => {
      document.replace(start, end, insertion, cursor);
      this.onChange?.(this.getText());
    });
    this.tui.requestRender();
  }
  refresh() {
    this.tui.requestRender();
  }
  protected override renderTopBorder(width: number, hiddenLineCount: number): string {
    const line = super.renderTopBorder(width, hiddenLineCount);

    return this.contributions.border?.render(line, width, this.borderColor) ?? line;
  }
  override render(width: number) {
    const native = super.render(width);
    const document = this.document;

    const spans = document
      ? [
          ...(this.contributions.foreground?.(document.text()) ?? []),
          ...(this.editing?.selection() ?? []),
        ]
      : [];

    const padding = Math.min(this.getPaddingX(), Math.max(0, Math.floor((width - 1) / 2)));

    return document && spans.length
      ? decorateRows(native, document.text(), padding, document, spans, this.uiTheme(), width)
      : native.map((row) => truncateToWidth(row, width, ""));
  }
}

export class EditorHost {
  editor: SharedEditor | undefined;
  /** Why Pi's private editor layout could not be connected, if it could not. */
  unsupported: string | undefined;
  private readonly contributions: Contributions = {};
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
        if (kind === "input" || kind === "insert" || kind === "replace")
          this.contributions.editing?.changed(kind, before);
      },
      (reason) => {
        this.unsupported = reason;
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
}

// The factory is Pi's existing shared ownership boundary, including across separate jiti loads.
// The key versions the host's shape; a copy built for another shape sees a foreign editor.
const owner = Symbol.for("clanker-stuff.editor/2");

type OwnedFactory = NonNullable<ReturnType<ExtensionUIContext["getEditorComponent"]>> & {
  [owner]?: EditorHost;
};

/** The shared editor while it is Pi's current editor; another extension can replace it later. */
export function currentEditorHost(ctx: Pick<ExtensionContext, "ui">): EditorHost | undefined {
  // SAFETY: The optional symbol property is set only on factories created by acquireEditorHost.
  return (ctx.ui.getEditorComponent() as OwnedFactory | undefined)?.[owner];
}

/** Install or join the shared editor. Undefined means another editor owns the session. */
export function acquireEditorHost(ctx: Pick<ExtensionContext, "ui">): EditorHost | undefined {
  const ui = ctx.ui;
  let host = currentEditorHost(ctx);

  if (!host && ui.getEditorComponent()) {
    ui.setStatus("shared-editor", "Custom editor: shared editing features unavailable");

    return undefined;
  }

  if (!host) {
    const installed = new EditorHost(() => ui.theme);
    host = installed;
    const next: OwnedFactory = (tui, theme, keys) => installed.create(tui, theme, keys);
    next[owner] = installed;
    const draft = ui.getEditorText();
    ui.setEditorComponent(next);
    // Pi transfers only the previous editor's getText(), which can contain orphaned markers.
    // Its public UI getter is expanded; repair that lossy initial handoff.
    installed.editor?.setText(draft);
  }

  ui.setStatus("shared-editor", host.unsupported);

  return host;
}

export type { DocumentAdapter, DocumentView } from "./adapter.js";

export type { Decoration } from "./render.js";
