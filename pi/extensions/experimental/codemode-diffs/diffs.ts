import type {
  ToolCallEvent,
  ToolResultEvent,
  ToolResultEventResult,
} from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import type { Static } from "typebox";
import { Value } from "typebox/value";

import type { DiffSyntax } from "./highlight.js";

const EditDiffSchema = Type.Object(
  {
    toolCallId: Type.String(),
    path: Type.String(),
    diff: Type.String(),
    syntax: Type.Optional(Type.Unknown()),
  },
  { additionalProperties: false }
);

export const DiffDetailsSchema = Type.Object(
  {
    codemodeDiffs: Type.Array(EditDiffSchema),
    codemodeDiffsOmitted: Type.Optional(
      Type.Integer({ minimum: 0, maximum: Number.MAX_SAFE_INTEGER })
    ),
  },
  { additionalProperties: true }
);

type PlainEditDiff = Omit<Static<typeof EditDiffSchema>, "syntax">;

type CapturedEditDiff = PlainEditDiff & { syntax?: DiffSyntax };

export const MAX_DIFF_DETAILS_BYTES = 64 * 1024;

const RESERVED_ENVELOPE_BYTES = Buffer.byteLength(
  JSON.stringify({
    codemodeDiffs: [],
    codemodeDiffsOmitted: Number.MAX_SAFE_INTEGER,
  })
);

interface Capture {
  edits: CapturedEditDiff[];
  remainingBytes: number;
  omitted: number;
}

interface PendingEdit {
  parentId: string;
  syntax?: { diff: string; rows: DiffSyntax };
}

const recordBytes = (capture: Capture, edit: CapturedEditDiff): number =>
  Buffer.byteLength(JSON.stringify(edit)) + (capture.edits.length > 0 ? 1 : 0);

const plainRecordBytes = (capture: Capture, edit: PlainEditDiff): number => {
  const minimumBytes =
    edit.diff.length + edit.path.length + edit.toolCallId.length;

  return minimumBytes > capture.remainingBytes
    ? Number.POSITIVE_INFINITY
    : recordBytes(capture, edit);
};

const retainDiff = (
  capture: Capture,
  plain: PlainEditDiff,
  syntax: DiffSyntax | undefined
): void => {
  let edit: CapturedEditDiff = plain;
  let bytes = plainRecordBytes(capture, plain);

  if (bytes > capture.remainingBytes) {
    capture.omitted = Math.min(capture.omitted + 1, Number.MAX_SAFE_INTEGER);

    return;
  }

  if (syntax !== undefined) {
    const highlighted = { ...plain, syntax };
    const highlightedBytes = recordBytes(capture, highlighted);

    if (highlightedBytes <= capture.remainingBytes) {
      edit = highlighted;
      bytes = highlightedBytes;
    }
  }

  capture.edits.push(edit);
  capture.remainingBytes -= bytes;
};

const EditDetailsSchema = Type.Object(
  {
    diff: Type.String(),
  },
  { additionalProperties: true }
);

export class EditDiffs {
  private readonly calls = new Map<string, Capture>();
  private readonly pending = new Map<string, PendingEdit>();

  onCall(event: ToolCallEvent): void {
    if (event.toolName === "codemode") {
      this.calls.set(event.toolCallId, {
        edits: [],
        remainingBytes: MAX_DIFF_DETAILS_BYTES - RESERVED_ENVELOPE_BYTES,
        omitted: 0,
      });
    }

    if (
      event.toolName === "edit" &&
      event.parentToolCallId !== undefined &&
      event.parentToolCallId !== "" &&
      this.calls.has(event.parentToolCallId)
    ) {
      this.pending.set(event.toolCallId, { parentId: event.parentToolCallId });
    }
  }

  onResult(event: ToolResultEvent): ToolResultEventResult | undefined {
    if (event.toolName === "codemode") {
      const capture = this.calls.get(event.toolCallId);
      this.calls.delete(event.toolCallId);

      if (!capture || (capture.edits.length === 0 && capture.omitted === 0)) {
        return;
      }

      const details: unknown = event.details;

      return {
        details: {
          ...(typeof details === "object" && details !== null ? details : {}),
          codemodeDiffs: capture.edits,
          ...(capture.omitted > 0
            ? { codemodeDiffsOmitted: capture.omitted }
            : {}),
        },
      };
    }

    if (event.toolName !== "edit") {
      return;
    }

    const syntax = this.pending.get(event.toolCallId)?.syntax;
    this.pending.delete(event.toolCallId);

    if (
      event.isError ||
      event.parentToolCallId === undefined ||
      event.parentToolCallId === ""
    ) {
      return;
    }

    const capture = this.calls.get(event.parentToolCallId);
    const details: unknown = event.details;
    const { path } = event.input;

    if (
      !capture ||
      typeof path !== "string" ||
      !Value.Check(EditDetailsSchema, details)
    ) {
      return;
    }

    retainDiff(
      capture,
      { toolCallId: event.toolCallId, path, diff: details.diff },
      syntax?.diff === details.diff ? syntax.rows : undefined
    );

    return undefined;
  }

  isCapturing(id: string): boolean {
    const pending = this.pending.get(id);

    return pending !== undefined && this.calls.has(pending.parentId);
  }

  canHighlight(edit: PlainEditDiff): boolean {
    const pending = this.pending.get(edit.toolCallId);
    const capture = pending && this.calls.get(pending.parentId);

    return (
      capture !== undefined &&
      plainRecordBytes(capture, edit) < capture.remainingBytes
    );
  }

  setSyntax(id: string, diff: string, rows: DiffSyntax): void {
    const pending = this.pending.get(id);

    if (pending && this.calls.has(pending.parentId)) {
      pending.syntax = { diff, rows };
    }
  }

  clear(): void {
    this.calls.clear();
    this.pending.clear();
  }
}
