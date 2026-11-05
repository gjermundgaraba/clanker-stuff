import type { CustomEditor } from "@earendil-works/pi-coding-agent";

export interface Layout {
  readonly rows: ReadonlyArray<{
    readonly logicalLine: number;
    readonly startCol: number;
    readonly length: number;
  }>;
  readonly scroll: number;
  readonly visible: number;
}

const markers = /\[paste #(?<id>\d+)(?: [^\]\n]*)?\]/gu;

interface KillRing {
  push: (
    text: string,
    options: { prepend: boolean; accumulate?: boolean }
  ) => void;
  peek: () => string | undefined;
  rotate: () => void;
  readonly length: number;
}

interface NativeEditor {
  pastes: Map<number, string>;
  pasteCounter: number;
  killRing: KillRing;
  scrollOffset: number;
  lastWidth: number;
  renderedVisibleLineCount: number;
  expandPasteMarkers: (text: string) => string;
  buildVisualLineMap: (width: number) => Layout["rows"];
}

const isKillRing = (value: unknown): value is KillRing =>
  typeof value === "object" &&
  value !== null &&
  "push" in value &&
  typeof value.push === "function" &&
  "peek" in value &&
  typeof value.peek === "function" &&
  "rotate" in value &&
  typeof value.rotate === "function" &&
  "length" in value &&
  typeof value.length === "number";

const isNativeEditor = (value: unknown): value is NativeEditor =>
  typeof value === "object" &&
  value !== null &&
  "pastes" in value &&
  value.pastes instanceof Map &&
  [...value.pastes].every(
    (paste: [unknown, unknown]): paste is [number, string] =>
      typeof paste[0] === "number" && typeof paste[1] === "string"
  ) &&
  "pasteCounter" in value &&
  typeof value.pasteCounter === "number" &&
  "killRing" in value &&
  isKillRing(value.killRing) &&
  "scrollOffset" in value &&
  typeof value.scrollOffset === "number" &&
  "lastWidth" in value &&
  typeof value.lastWidth === "number" &&
  "renderedVisibleLineCount" in value &&
  typeof value.renderedVisibleLineCount === "number" &&
  "expandPasteMarkers" in value &&
  typeof value.expandPasteMarkers === "function" &&
  "buildVisualLineMap" in value &&
  typeof value.buildVisualLineMap === "function";

/**
 * Keep paste payloads owned by the editor across Pi's string-only handoffs, and return the private
 * layout that decorations map onto. Throws when Pi's editor internals no longer match.
 */
export const connect = (editor: CustomEditor): (() => Layout) => {
  const native: unknown = editor;

  if (!isNativeEditor(native)) {
    throw new TypeError(
      "Unsupported Pi editor layout: required paste and layout APIs are unavailable"
    );
  }

  const expand = (input: string) =>
    input.replaceAll(
      markers,
      (marker, id: string) => native.pastes.get(Number(id)) ?? marker
    );

  native.expandPasteMarkers = expand;

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

  return () => ({
    rows: native.buildVisualLineMap(native.lastWidth),
    scroll: native.scrollOffset,
    visible: native.renderedVisibleLineCount,
  });
};
