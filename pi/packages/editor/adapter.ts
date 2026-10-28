import type { CustomEditor } from "@earendil-works/pi-coding-agent";

interface Position {
  lines: string[];
  cursorLine: number;
  cursorCol: number;
}

export interface DocumentView {
  readonly text: string;
  readonly cursor: number;
  readonly atoms: ReadonlyArray<{
    readonly start: number;
    readonly end: number;
    readonly content: string;
  }>;
}

const markers = /\[paste #(?<id>\d+)(?: [^\]\n]*)?\]/gu;

interface NativeEditor {
  state: Position;
  pastes: Map<number, string>;
  pasteCounter: number;
  killRing: {
    push: (
      text: string,
      options: { prepend: boolean; accumulate?: boolean }
    ) => void;
    peek: () => string | undefined;
    rotate: () => void;
    readonly length: number;
  };
  undoStack: { clear: () => void };
  historyIndex: number;
  historyDraft: Position | null;
  scrollOffset: number;
  lastWidth: number;
  renderedVisibleLineCount: number;
  lastAction: string | null;
  preferredVisualCol: number | null;
  snappedFromCursorCol: number | null;
  expandPasteMarkers: (text: string) => string;
  cancelAutocomplete: () => void;
  buildVisualLineMap: (
    width: number
  ) => Array<{ logicalLine: number; startCol: number; length: number }>;
}

const isPosition = (value: unknown): value is Position =>
  typeof value === "object" &&
  value !== null &&
  "lines" in value &&
  Array.isArray(value.lines) &&
  value.lines.every(
    (line: unknown): line is string => typeof line === "string"
  ) &&
  "cursorLine" in value &&
  typeof value.cursorLine === "number" &&
  "cursorCol" in value &&
  typeof value.cursorCol === "number";

const isNumberOrNull = (value: unknown): value is number | null =>
  value === null || typeof value === "number";

const isNativeEditor = (value: unknown): value is NativeEditor =>
  typeof value === "object" &&
  value !== null &&
  "state" in value &&
  isPosition(value.state) &&
  "pastes" in value &&
  value.pastes instanceof Map &&
  [...value.pastes].every(
    (paste: [unknown, unknown]): paste is [number, string] =>
      typeof paste[0] === "number" && typeof paste[1] === "string"
  ) &&
  "pasteCounter" in value &&
  typeof value.pasteCounter === "number" &&
  "killRing" in value &&
  typeof value.killRing === "object" &&
  value.killRing !== null &&
  "push" in value.killRing &&
  typeof value.killRing.push === "function" &&
  "peek" in value.killRing &&
  typeof value.killRing.peek === "function" &&
  "rotate" in value.killRing &&
  typeof value.killRing.rotate === "function" &&
  "length" in value.killRing &&
  typeof value.killRing.length === "number" &&
  "undoStack" in value &&
  typeof value.undoStack === "object" &&
  value.undoStack !== null &&
  "clear" in value.undoStack &&
  typeof value.undoStack.clear === "function" &&
  "historyIndex" in value &&
  typeof value.historyIndex === "number" &&
  "historyDraft" in value &&
  (value.historyDraft === null || isPosition(value.historyDraft)) &&
  "scrollOffset" in value &&
  typeof value.scrollOffset === "number" &&
  "lastWidth" in value &&
  typeof value.lastWidth === "number" &&
  "renderedVisibleLineCount" in value &&
  typeof value.renderedVisibleLineCount === "number" &&
  "lastAction" in value &&
  (value.lastAction === null || typeof value.lastAction === "string") &&
  "preferredVisualCol" in value &&
  isNumberOrNull(value.preferredVisualCol) &&
  "snappedFromCursorCol" in value &&
  isNumberOrNull(value.snappedFromCursorCol) &&
  "expandPasteMarkers" in value &&
  typeof value.expandPasteMarkers === "function" &&
  "cancelAutocomplete" in value &&
  typeof value.cancelAutocomplete === "function" &&
  "buildVisualLineMap" in value &&
  typeof value.buildVisualLineMap === "function";

export const connect = (editor: CustomEditor) => {
  const native: unknown = editor;

  if (!isNativeEditor(native)) {
    throw new TypeError(
      "Unsupported Pi editor layout: required document/undo APIs are unavailable"
    );
  }

  const text = () => native.state.lines.join("\n");

  const cursor = () =>
    native.state.lines
      .slice(0, native.state.cursorLine)
      .reduce((n, line) => n + line.length + 1, native.state.cursorCol);

  const view = (): DocumentView => {
    const value = text();

    return {
      text: value,
      cursor: cursor(),
      atoms: value
        .matchAll(markers)
        .flatMap((match) => {
          const content = native.pastes.get(Number(match.groups?.["id"]));

          return content === undefined
            ? []
            : [
                {
                  start: match.index,
                  end: match.index + match[0].length,
                  content,
                },
              ];
        })
        .toArray(),
    };
  };

  const move = (offset: number) => {
    const value = text();
    const bounded = Math.max(0, Math.min(value.length, offset));
    const before = value.slice(0, bounded);
    native.state.cursorLine = before.split("\n").length - 1;
    native.state.cursorCol = bounded - (before.lastIndexOf("\n") + 1);
    native.preferredVisualCol = null;
    native.snappedFromCursorCol = null;
  };

  const expand = (input: string) =>
    input.replaceAll(
      markers,
      (marker, id: string) => native.pastes.get(Number(id)) ?? marker
    );

  native.expandPasteMarkers = expand;

  const replace = (
    start: number,
    end: number,
    insertion: string,
    target: number
  ) => {
    native.cancelAutocomplete();
    const value = text();
    native.state.lines = (
      value.slice(0, start) +
      insertion +
      value.slice(end)
    ).split("\n");
    native.historyIndex = -1;
    native.historyDraft = null;
    native.lastAction = null;
    move(target);
  };

  const restoreView = (checkpoint: DocumentView) => {
    native.pastes = new Map();
    native.pasteCounter = 0;

    for (const atom of checkpoint.atoms) {
      const [marker] = checkpoint.text
        .slice(atom.start, atom.end)
        .matchAll(markers);

      if (marker === undefined) {
        throw new Error("A document view atom must span a paste marker");
      }

      const id = Number(marker.groups?.["id"]);

      native.pastes.set(id, atom.content);
      native.pasteCounter = Math.max(native.pasteCounter, id);
    }

    replace(0, text().length, checkpoint.text, checkpoint.cursor);
    native.undoStack.clear();
    native.scrollOffset = 0;
  };

  const insertableOrMarker = (payload: string) => {
    if (
      !/\p{Cc}/u.test(payload.replaceAll("\n", "")) &&
      !payload.includes("[paste #") &&
      payload.length < 1000
    ) {
      return payload;
    }

    native.pasteCounter += 1;
    const id = native.pasteCounter;
    native.pastes.set(id, payload);

    return `[paste #${id} +${payload.split("\n").length} lines]`;
  };

  const ring = native.killRing;
  let cached: { raw: string; encoded: string } | undefined;
  native.killRing = {
    push: (value, options) => {
      ring.push(expand(value), options);
    },
    peek: () => {
      const raw = ring.peek();

      if (raw === undefined) {
        return;
      }

      if (!cached || cached.raw !== raw || expand(cached.encoded) !== raw) {
        cached = { raw, encoded: insertableOrMarker(raw) };
      }

      return cached.encoded;
    },
    rotate: () => {
      ring.rotate();
    },
    get length() {
      return ring.length;
    },
  };

  return {
    text,
    cursor,
    move,
    replace,
    expand,
    view,
    restoreView,
    historyIndex: () => native.historyIndex,
    insertableOrMarker,
    cancelCompletion: () => {
      native.cancelAutocomplete();
    },
    clearNativeUndo: () => {
      native.undoStack.clear();
    },
    layout: () => ({
      rows: native.buildVisualLineMap(native.lastWidth),
      scroll: native.scrollOffset,
      visible: native.renderedVisibleLineCount,
    }),
  };
};

export type DocumentAdapter = ReturnType<typeof connect>;
