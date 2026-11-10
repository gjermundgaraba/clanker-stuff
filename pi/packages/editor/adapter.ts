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

interface NativePastes {
  pastes: Map<number, string>;
  expandPasteMarkers: (text: string) => string;
}

interface NativeLayout {
  scrollOffset: number;
  lastWidth: number;
  renderedVisibleLineCount: number;
  buildVisualLineMap: (width: number) => Layout["rows"];
}

const hasNativePastes = (value: unknown): value is NativePastes =>
  typeof value === "object" &&
  value !== null &&
  "pastes" in value &&
  value.pastes instanceof Map &&
  [...value.pastes].every(
    (paste: [unknown, unknown]): paste is [number, string] =>
      typeof paste[0] === "number" && typeof paste[1] === "string"
  ) &&
  "expandPasteMarkers" in value &&
  typeof value.expandPasteMarkers === "function";

const hasNativeLayout = (value: unknown): value is NativeLayout =>
  typeof value === "object" &&
  value !== null &&
  "scrollOffset" in value &&
  typeof value.scrollOffset === "number" &&
  "lastWidth" in value &&
  typeof value.lastWidth === "number" &&
  "renderedVisibleLineCount" in value &&
  typeof value.renderedVisibleLineCount === "number" &&
  "buildVisualLineMap" in value &&
  typeof value.buildVisualLineMap === "function";

/**
 * Expand paste markers in one pass, so a paste whose content reads `[paste #N]` stays literal; Pi
 * expands them one paste at a time. Returns false when Pi's paste internals no longer match.
 */
export const expandPastesOnce = (editor: CustomEditor): boolean => {
  const native: unknown = editor;

  if (!hasNativePastes(native)) {
    return false;
  }

  native.expandPasteMarkers = (input) =>
    input.replaceAll(
      markers,
      (marker, id: string) => native.pastes.get(Number(id)) ?? marker
    );

  return true;
};

/** Read the private layout that decorations map onto, or undefined when Pi's layout internals no longer match. */
export const connectLayout = (
  editor: CustomEditor
): (() => Layout) | undefined => {
  const native: unknown = editor;

  if (!hasNativeLayout(native)) {
    return undefined;
  }

  return () => ({
    rows: native.buildVisualLineMap(native.lastWidth),
    scroll: native.scrollOffset,
    visible: native.renderedVisibleLineCount,
  });
};
