import { displayText } from "@clanker-stuff/pi-tool-rendering/text";
import { isDeepStrictEqual } from "node:util";

import type { Theme } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import type { Static } from "typebox";
import { Value } from "typebox/value";

import { highlightJsonIfPossible } from "../tools/renderers.js";

import type { RuntimeToolResult, RuntimeToolTrace } from "./types.js";

// This is a display recognizer for direct.ts's native process result, not a tool schema.
const ProcessEnvelopeSchema = Type.Object(
  {
    exit_code: Type.Union([Type.Number(), Type.Null()]),
    original_token_count: Type.Optional(Type.Number()),
    output: Type.String(),
    session_id: Type.Optional(Type.Number()),
    wall_time_seconds: Type.Number(),
  },
  { additionalProperties: false },
);
const CapturedResultSchema = Type.Object({ codeModeResult: ProcessEnvelopeSchema });
type ProcessEnvelope = Static<typeof ProcessEnvelopeSchema>;
interface OutputBlock {
  /** Unstyled sanitized text, for previews that apply their own color. */
  plain: string;
  /** Highlighted text for the script output section. */
  text: string;
  traceId?: string;
}

const parseEnvelope = (text: string): ProcessEnvelope | undefined => {
  try {
    const parsed: unknown = JSON.parse(text);
    return Value.Check(ProcessEnvelopeSchema, parsed) ? parsed : undefined;
  } catch {
    return undefined;
  }
};

/** Render script output without changing the values returned to the model. */
export function codeModeOutput(
  items: RuntimeToolResult["content"],
  traces: readonly RuntimeToolTrace[],
  theme: Theme,
  expanded: boolean,
): OutputBlock[] {
  const blocks: OutputBlock[] = [];
  for (const item of items) {
    if (item.type !== "text") {
      continue;
    }
    const envelope = parseEnvelope(item.text);
    const trace =
      envelope === undefined
        ? undefined
        : traces.find(
            (candidate) =>
              (candidate.name === "exec_command" || candidate.name === "write_stdin") &&
              Value.Check(CapturedResultSchema, candidate.result?.details) &&
              isDeepStrictEqual(envelope, candidate.result?.details.codeModeResult),
          );
    const output = displayText(
      !expanded && trace !== undefined && envelope !== undefined ? envelope.output : item.text,
    );
    if (output.length > 0) {
      const block: OutputBlock = {
        plain: output,
        text: highlightJsonIfPossible(output, theme),
      };
      if (trace !== undefined) {
        block.traceId = trace.id;
      }
      blocks.push(block);
    }
  }
  return blocks;
}
