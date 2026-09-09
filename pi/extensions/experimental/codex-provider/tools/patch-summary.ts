import { Type } from "typebox";
import type { Static } from "typebox";

const strict = { additionalProperties: false } as const;

/**
 * One change of an applied or pending patch. Keys are emitted in this order on purpose: a bounded
 * trace copy of the details is serialized key by key and an object cut partway gains a marker key,
 * so `from` must not be the tail that a cut could silently drop, and the strict schema then rejects
 * any cut entry.
 */
export const PatchChangeSchema = Type.Object(
  {
    kind: Type.Union([Type.Literal("add"), Type.Literal("delete"), Type.Literal("update")]),
    /** Source path of a move. */
    from: Type.Optional(Type.String()),
    /** Destination path. */
    path: Type.String(),
    /** Whether the file's contents differ afterwards; false for a pure rename. */
    changed: Type.Boolean(),
    /**
     * Lines the patch added and removed; a deletion removes the file's line count. Absent when the
     * count is unknown, such as a deleted file that could not be read.
     */
    lines: Type.Optional(Type.Object({ added: Type.Number(), removed: Type.Number() }, strict)),
  },
  strict,
);
export type PatchChange = Static<typeof PatchChangeSchema>;

/** `diff` precedes `index` so a diff cut mid-string leaves an entry the schema rejects. */
export const PatchDiffSchema = Type.Object(
  {
    /** Pi-style numbered diff for display. */
    diff: Type.String(),
    /** Position of the change this diff belongs to; a patch may touch one path more than once. */
    index: Type.Integer(),
  },
  strict,
);
export type PatchDiff = Static<typeof PatchDiffSchema>;

const ADD_HEADER = "*** Add File: ";
const DELETE_HEADER = "*** Delete File: ";
const UPDATE_HEADER = "*** Update File: ";
const MOVE_HEADER = "*** Move to: ";
const END_PATCH = "*** End Patch";

/** Appended in place of a display diff's cut tail. */
export const DIFF_TRUNCATED_LINE = "... [diff truncated for display]";

/** Cuts a diff at a line boundary and marks the cut, so a partial line never renders as real. */
export const truncateDiff = (diff: string, maxChars: number): string => {
  if (diff.length <= maxChars) return diff;
  const head = diff.slice(0, maxChars);
  return `${head.slice(0, Math.max(0, head.lastIndexOf("\n")))}\n${DIFF_TRUNCATED_LINE}`;
};

/**
 * Summarizes patch text without validating or applying it, so partially streamed arguments still
 * render a file list with running line counts in the same shape the applied result reports.
 */
export const summarizePatchText = (patch: string): PatchChange[] => {
  const changes: PatchChange[] = [];
  // Counts are always known while summarizing text, so the running change requires them.
  let current: (PatchChange & { lines: NonNullable<PatchChange["lines"]> }) | undefined;
  const start = (kind: PatchChange["kind"], path: string) => {
    current = { kind, path, changed: kind !== "update", lines: { added: 0, removed: 0 } };
    changes.push(current);
  };
  // Mirror parsePatch(): CRLF patches must produce the same paths the applied changes report.
  for (const line of patch.replaceAll("\r\n", "\n").split("\n")) {
    if (line.startsWith(ADD_HEADER)) {
      start("add", line.slice(ADD_HEADER.length));
    } else if (line.startsWith(DELETE_HEADER)) {
      start("delete", line.slice(DELETE_HEADER.length));
    } else if (line.startsWith(UPDATE_HEADER)) {
      start("update", line.slice(UPDATE_HEADER.length));
    } else if (line.startsWith(MOVE_HEADER)) {
      if (current?.kind === "update") {
        current.from = current.path;
        current.path = line.slice(MOVE_HEADER.length);
      }
    } else if (line.startsWith(END_PATCH)) {
      current = undefined;
    } else if (line.startsWith("***")) {
      // Begin Patch and End of File markers carry no counts.
    } else if (current !== undefined) {
      if (line.startsWith("+")) {
        current.lines.added += 1;
        current.changed = true;
      } else if (line.startsWith("-")) {
        current.lines.removed += 1;
        current.changed = true;
      }
    }
  }
  return changes;
};
