import { constants } from "node:fs";
import { access, readFile, writeFile } from "node:fs/promises";

import {
  invalidArguments,
  structuralSchema,
} from "@clanker-stuff/pi-tool-schema";
import { createEditToolDefinition } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { Value } from "typebox/value";

import type { EditDiffs } from "./diffs.js";
import { highlightDiff, MAX_HIGHLIGHT_SOURCE_BYTES } from "./highlight.js";

const tryHighlightDiff = async (
  ...args: Parameters<typeof highlightDiff>
): ReturnType<typeof highlightDiff> => {
  try {
    return await highlightDiff(...args);
  } catch {
    return undefined;
  }
};

export const createHighlightedEdit = (diffs: EditDiffs) => {
  const original = createEditToolDefinition(process.cwd());

  const parameters = Type.Object(
    {
      ...original.parameters.properties,
      edits: {
        ...original.parameters.properties.edits,
        items: Type.Object(
          original.parameters.properties.edits.items.properties,
          {
            additionalProperties: false,
          }
        ),
        minItems: 1,
      },
    },
    { additionalProperties: false }
  );

  const tool: typeof original = {
    ...original,
    parameters: structuralSchema(parameters),
    async execute(id, input, signal, onUpdate, ctx) {
      if (!Value.Check(parameters, input)) {
        throw invalidArguments(parameters, input, "edit");
      }

      if (!diffs.isCapturing(id)) {
        return await original.execute(id, input, signal, onUpdate, ctx);
      }

      let before: string | undefined;
      let after: string | undefined;

      const native = createEditToolDefinition(ctx.cwd, {
        operations: {
          access: async (path) => {
            await access(path, constants.R_OK | constants.W_OK);
          },
          async readFile(path) {
            const buffer = await readFile(path);

            if (buffer.length <= MAX_HIGHLIGHT_SOURCE_BYTES) {
              before = buffer.toString("utf-8");
            }

            return buffer;
          },
          async writeFile(path, content) {
            await writeFile(path, content, "utf-8");

            if (before !== undefined) {
              after = content;
            }
          },
        },
      });

      // Native edit holds the non-reentrant queue: https://github.com/earendil-works/pi/blob/v1.5.2/packages/coding-agent/src/core/tools/edit.ts#L158-L213
      const result = await native.execute(id, input, signal, onUpdate, ctx);

      if (
        before === undefined ||
        after === undefined ||
        !result.details ||
        !diffs.canHighlight({
          toolCallId: id,
          path: input.path,
          diff: result.details.diff,
        })
      ) {
        return result;
      }

      const syntax = await tryHighlightDiff(
        input.path,
        result.details.diff,
        before,
        after
      );

      if (syntax) {
        diffs.setSyntax(id, result.details.diff, syntax);
      }

      return result;
    },
  };

  return tool;
};
