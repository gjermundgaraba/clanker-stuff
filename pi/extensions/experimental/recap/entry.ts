import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { stripTerminalSequences, truncateToWidth, wrapTextWithAnsi } from "@earendil-works/pi-tui";
import { Type } from "typebox";
import type { Static } from "typebox";
import { Value } from "typebox/value";

export const RECAP_ENTRY_TYPE = "@clanker-stuff/recap";
export const RECAP_MAX_CHARS = 320;

const UNSAFE_TEXT_PATTERN =
  // oxlint-disable-next-line eslint/no-control-regex -- Model output must not control the terminal.
  /[\u0000-\u0009\u000B-\u001F\u007F-\u009F\u061C\u200E\u200F\u202A-\u202E\u2066-\u2069]/gu;

export const sanitizeRecapText = (value: string): string =>
  stripTerminalSequences(value).replaceAll(UNSAFE_TEXT_PATTERN, "");

const EntryInputSchema = Type.Unknown();
type EntryInput = Static<typeof EntryInputSchema>;
const RecapEntrySchema = Type.Object(
  {
    completedTurns: Type.Integer({ minimum: 0 }),
    recap: Type.String({ minLength: 1, maxLength: RECAP_MAX_CHARS }),
  },
  { additionalProperties: false },
);

export type RecapEntryData = Static<typeof RecapEntrySchema>;

export const parseRecapEntry = (value: EntryInput): RecapEntryData | undefined =>
  Value.Check(RecapEntrySchema, value) ? value : undefined;

export const registerRecapEntry = (pi: ExtensionAPI): void => {
  pi.registerEntryRenderer(RECAP_ENTRY_TYPE, (entry, _options, theme) => {
    const data = parseRecapEntry(entry.data);
    if (data === undefined) {
      return undefined;
    }

    return {
      invalidate() {},
      render(width) {
        if (width <= 0) {
          return [];
        }

        const heading = truncateToWidth(`─ Conversation recap ${"─".repeat(width)}`, width, "");
        const indent = width > 2 ? "  " : "";
        const recap = sanitizeRecapText(data.recap);
        return [
          theme.fg("accent", heading),
          "",
          ...wrapTextWithAnsi(recap, Math.max(1, width - indent.length)).map(
            (line) => `${indent}${line}`,
          ),
        ];
      },
    };
  });
};
