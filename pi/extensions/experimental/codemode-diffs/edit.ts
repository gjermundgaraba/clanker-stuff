import { constants } from "node:fs";
import { access, readFile, writeFile } from "node:fs/promises";

import { invalidArguments, structuralSchema } from "@clanker-stuff/pi-tool-schema";
import { createEditToolDefinition } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { Value } from "typebox/value";

import type { EditDiffs } from "./diffs.js";
import { highlightDiff } from "./highlight.js";

export function createHighlightedEdit(diffs: EditDiffs) {
  const original = createEditToolDefinition(process.cwd());

  const parameters = Type.Object(
    {
      ...original.parameters.properties,
      edits: {
        ...original.parameters.properties.edits,
        items: Type.Object(original.parameters.properties.edits.items.properties, {
          additionalProperties: false,
        }),
        minItems: 1,
      },
    },
    { additionalProperties: false },
  );

  const tool: typeof original = {
    ...original,
    parameters: structuralSchema(parameters),
    async execute(id, input, signal, onUpdate, ctx) {
      if (!Value.Check(parameters, input)) throw invalidArguments(parameters, input, "edit");

      if (!diffs.isCapturing(id)) return original.execute(id, input, signal, onUpdate, ctx);

      let before: string | undefined;
      let after: string | undefined;

      const native = createEditToolDefinition(ctx.cwd, {
        operations: {
          access: (path) => access(path, constants.R_OK | constants.W_OK),
          async readFile(path) {
            const buffer = await readFile(path);
            before = buffer.toString("utf8");

            return buffer;
          },
          async writeFile(path, content) {
            await writeFile(path, content, "utf8");
            after = content;
          },
        },
      });

      // Native edit owns withFileMutationQueue() around these exact reads and writes.
      // Do not acquire the same queue again here; the immutable snapshots remain valid afterward.
      const result = await native.execute(id, input, signal, onUpdate, ctx);

      if (before === undefined || after === undefined || !result.details) return result;

      try {
        const syntax = await highlightDiff(input.path, result.details.diff, before, after);

        if (syntax) diffs.setSyntax(id, result.details.diff, syntax);
      } catch {
        // The edit already succeeded. Optional highlighting must never turn it into a failed edit.
      }

      return result;
    },
  };

  return tool;
}
