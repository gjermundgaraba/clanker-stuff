import type { CustomEditor } from "@earendil-works/pi-coding-agent";

interface Position {
  lines: string[];
  cursorLine: number;
  cursorCol: number;
}

interface NativeSnapshot {
  state: Position;
  pastes: Map<number, string>;
  pasteCounter: number;
}

export interface Draft extends NativeSnapshot {
  undo: NativeSnapshot[];
  historyIndex: number;
  historyDraft: Position | null;
  scrollOffset: number;
  lastAction: string | null;
  preferredVisualCol: number | null;
  snappedFromCursorCol: number | null;
}

export interface DocumentView {
  readonly text: string;
  readonly cursor: number;
  readonly atoms: readonly {
    readonly start: number;
    readonly end: number;
    readonly content: string;
  }[];
}

const markers = /\[paste #(\d+)(?: [^\]\n]*)?\]/g;

function cursorOffset(state: Position) {
  return (
    state.lines.slice(0, state.cursorLine).reduce((n, line) => n + line.length + 1, 0) +
    state.cursorCol
  );
}

function documentView({ state, pastes }: NativeSnapshot): DocumentView {
  const text = state.lines.join("\n");

  return {
    text,
    cursor: cursorOffset(state),
    atoms: text
      .matchAll(markers)
      .filter((match) => pastes.has(Number(match[1])))
      .map((match) => ({
        start: match.index,
        end: match.index + match[0].length,
        content: pastes.get(Number(match[1]))!,
      }))
      .toArray(),
  };
}

interface NativeEditor extends NativeSnapshot {
  killRing: {
    push(text: string, options: { prepend: boolean; accumulate?: boolean }): void;
    peek(): string | undefined;
    rotate(): void;
    readonly length: number;
  };
  undoStack: { stack: NativeSnapshot[]; clear(): void };
  historyIndex: number;
  historyDraft: Position | null;
  scrollOffset: number;
  lastWidth: number;
  renderedVisibleLineCount: number;
  lastAction: string | null;
  preferredVisualCol: number | null;
  snappedFromCursorCol: number | null;
  expandPasteMarkers(text: string): string;
  cancelAutocomplete(): void;
  buildVisualLineMap(width: number): { logicalLine: number; startCol: number; length: number }[];
}

function nativeEditor(instance: unknown): NativeEditor {
  // SAFETY: Validate the required private Editor layout before exposing the document/undo adapter.
  // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- Pi exposes no public document/undo adapter; the pinned private layout is checked below and covered by native editor contract tests.
  const native = instance as NativeEditor;

  if (
    !Array.isArray(native.state?.lines) ||
    !(native.pastes instanceof Map) ||
    !Array.isArray(native.undoStack?.stack) ||
    typeof native.killRing?.push !== "function" ||
    typeof native.killRing?.peek !== "function" ||
    typeof native.killRing?.rotate !== "function" ||
    typeof native.expandPasteMarkers !== "function" ||
    typeof native.cancelAutocomplete !== "function" ||
    typeof native.buildVisualLineMap !== "function"
  ) {
    throw new Error("Unsupported Pi editor layout: required document/undo APIs are unavailable");
  }

  return native;
}

export function connect(editor: CustomEditor) {
  const native = nativeEditor(editor);
  const text = () => native.state.lines.join("\n");

  const capture = (): Draft =>
    structuredClone({
      state: native.state,
      pastes: native.pastes,
      pasteCounter: native.pasteCounter,
      undo: native.undoStack.stack,
      historyIndex: native.historyIndex,
      historyDraft: native.historyDraft,
      scrollOffset: native.scrollOffset,
      lastAction: native.lastAction,
      preferredVisualCol: native.preferredVisualCol,
      snappedFromCursorCol: native.snappedFromCursorCol,
    });

  const restore = (draft: Draft) => {
    native.cancelAutocomplete();
    const value = structuredClone(draft);
    native.state = value.state;
    native.pastes = value.pastes;
    native.pasteCounter = value.pasteCounter;
    native.undoStack.stack = value.undo;
    native.historyIndex = value.historyIndex;
    native.historyDraft = value.historyDraft;
    native.scrollOffset = value.scrollOffset;
    native.lastAction = value.lastAction;
    native.preferredVisualCol = value.preferredVisualCol;
    native.snappedFromCursorCol = value.snappedFromCursorCol;
  };

  const view = () => documentView(native);
  const cursor = () => cursorOffset(native.state);

  const move = (offset: number) => {
    const value = text();
    const bounded = Math.max(0, Math.min(value.length, offset));
    const lines = value.slice(0, bounded).split("\n");
    native.state.cursorLine = lines.length - 1;
    native.state.cursorCol = lines.at(-1)!.length;
    native.preferredVisualCol = null;
    native.snappedFromCursorCol = null;
  };

  const expand = (text: string) =>
    text.replace(markers, (marker, id: string) => native.pastes.get(Number(id)) ?? marker);

  // Native retrieval and submission share nonrecursive payload ownership.
  native.expandPasteMarkers = expand;

  const replace = (start: number, end: number, insertion: string, target: number) => {
    native.cancelAutocomplete();
    const value = text();
    native.state.lines = (value.slice(0, start) + insertion + value.slice(end)).split("\n");
    native.historyIndex = -1;
    native.historyDraft = null;
    native.lastAction = null;
    move(target);
  };

  // Views own immutable strings, including payloads, so they also serve as modal checkpoints.
  const restoreView = (view: DocumentView) => {
    native.pastes = new Map();
    native.pasteCounter = 0;

    for (const atom of view.atoms) {
      const id = Number([...view.text.slice(atom.start, atom.end).matchAll(markers)][0]![1]);
      native.pastes.set(id, atom.content);
      native.pasteCounter = Math.max(native.pasteCounter, id);
    }

    replace(0, text().length, view.text, view.cursor);
    native.undoStack.clear();
    native.scrollOffset = 0;
  };

  // Payload text never becomes terminal control input. Complex register content uses native markers.
  const encode = (text: string) => {
    if (
      !/\p{Cc}/u.test(text.replaceAll("\n", "")) &&
      !text.includes("[paste #") &&
      text.length < 1000
    )
      return text;
    const id = ++native.pasteCounter;
    native.pastes.set(id, text);

    return `[paste #${id} +${text.split("\n").length} lines]`;
  };

  // Native kill-ring entries otherwise retain marker IDs after their payload map is cleared.
  // Keep its accumulation/rotation semantics, but own payloads at this per-instance boundary.
  const ring = native.killRing;
  let cached: { raw: string; encoded: string } | undefined;
  native.killRing = {
    push: (value, options) => ring.push(expand(value), options),
    peek: () => {
      const raw = ring.peek();

      if (raw === undefined) return undefined;

      if (!cached || cached.raw !== raw || expand(cached.encoded) !== raw)
        cached = { raw, encoded: encode(raw) };

      return cached.encoded;
    },
    rotate: () => ring.rotate(),
    get length() {
      return ring.length;
    },
  };

  return {
    text,
    capture,
    restore,
    cursor,
    move,
    replace,
    expand,
    view,
    restoreView,
    historyIndex: () => native.historyIndex,
    encode,
    cancelCompletion: () => native.cancelAutocomplete(),
    clearNativeUndo: () => native.undoStack.clear(),
    layout: () => ({
      rows: native.buildVisualLineMap(native.lastWidth),
      scroll: native.scrollOffset,
      visible: native.renderedVisibleLineCount,
    }),
  };
}

export type DocumentAdapter = ReturnType<typeof connect>;
