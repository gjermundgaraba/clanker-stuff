import { safeText } from "@clanker-stuff/pi-tool-rendering/text";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { truncateToWidth, wrapTextWithAnsi } from "@earendil-works/pi-tui";
import { Type } from "typebox";
import type { Static } from "typebox";
import { Value } from "typebox/value";

export const RECAP_ENTRY_TYPE = "@clanker-stuff/recap";
export const RECAP_MAX_CHARS = 320;

/** Recaps omit tabs rather than expanding them; the terminal safety policy is shared. */
export const sanitizeRecapText = (value: string): string => safeText(value).replaceAll("\t", "");

export const RecapEntrySchema = Type.Object(
  {
    completedTurns: Type.Integer({ minimum: 0 }),
    recap: Type.String({ minLength: 1, maxLength: RECAP_MAX_CHARS }),
  },
  { additionalProperties: false },
);

export type RecapEntryData = Static<typeof RecapEntrySchema>;

export const registerRecapEntry = (pi: ExtensionAPI): void => {
  pi.registerEntryRenderer(RECAP_ENTRY_TYPE, (entry, _options, theme) => {
    const data = entry.data;
    if (!Value.Check(RecapEntrySchema, data)) {
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
          theme.fg("borderAccent", heading),
          "",
          ...wrapTextWithAnsi(recap, Math.max(1, width - indent.length)).map(
            (line) => `${indent}${line}`,
          ),
        ];
      },
    };
  });
};
