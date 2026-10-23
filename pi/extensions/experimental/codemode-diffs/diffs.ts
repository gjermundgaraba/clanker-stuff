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
    // Syntax is optional display metadata; malformed/newer metadata must not hide the diff.
    syntax: Type.Optional(Type.Unknown()),
  },
  { additionalProperties: false },
);

// Decode only the extension-owned part; Pi and other renderers own the remaining details.
export const DiffDetailsSchema = Type.Object(
  {
    codemodeDiffs: Type.Array(EditDiffSchema),
  },
  { additionalProperties: true },
);

type EditDiff = Static<typeof EditDiffSchema>;

// An extension can override edit, so its result must actually contain a display diff.
const EditDetailsSchema = Type.Object(
  {
    diff: Type.String(),
  },
  { additionalProperties: true },
);

export class EditDiffs {
  private readonly calls = new Map<string, EditDiff[]>();
  private readonly pending = new Map<string, { diff: string; rows: DiffSyntax } | undefined>();

  onCall(event: ToolCallEvent): void {
    if (event.toolName === "codemode") this.calls.set(event.toolCallId, []);

    if (
      event.toolName === "edit" &&
      event.parentToolCallId &&
      this.calls.has(event.parentToolCallId)
    )
      this.pending.set(event.toolCallId, undefined);
  }

  onResult(event: ToolResultEvent): ToolResultEventResult | undefined {
    if (event.toolName === "codemode") {
      const edits = this.calls.get(event.toolCallId);
      this.calls.delete(event.toolCallId);

      if (!edits?.length) return;

      const details: unknown = event.details;

      return {
        details: {
          ...(typeof details === "object" && details !== null ? details : {}),
          codemodeDiffs: edits,
        },
      };
    }

    if (event.toolName !== "edit") return;
    const syntax = this.pending.get(event.toolCallId);
    this.pending.delete(event.toolCallId);

    if (event.isError || !event.parentToolCallId) return;
    const edits = this.calls.get(event.parentToolCallId);
    const details: unknown = event.details;
    const path = event.input.path;

    if (!edits || typeof path !== "string" || !Value.Check(EditDetailsSchema, details)) return;
    edits.push({
      toolCallId: event.toolCallId,
      path,
      diff: details.diff,
      ...(syntax?.diff === details.diff ? { syntax: syntax.rows } : {}),
    });
  }

  isCapturing(id: string): boolean {
    return this.pending.has(id);
  }

  setSyntax(id: string, diff: string, rows: DiffSyntax): void {
    if (this.pending.has(id)) this.pending.set(id, { diff, rows });
  }

  clear(): void {
    this.calls.clear();
    this.pending.clear();
  }
}
