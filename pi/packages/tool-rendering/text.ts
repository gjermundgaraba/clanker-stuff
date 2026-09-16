import { stripVTControlCharacters } from "node:util";

const UNSAFE_DISPLAY_CHARACTERS =
  // eslint-disable-next-line no-control-regex
  /[\u0000-\u0008\u000b-\u001f\u007f-\u009f\u061c\u200e\u200f\u202a-\u202e\u2066-\u2069]/gu;

/** Remove terminal controls and bidi overrides, preserving log newlines and tabs. */
export function safeText(text: string): string {
  return stripVTControlCharacters(text).replace(UNSAFE_DISPLAY_CHARACTERS, "");
}

/** Normalize tabs before layout so terminal tab stops cannot change measured widths. */
export const displayText = (text: string): string => safeText(text).replace(/\t/gu, "   ");
export const inlineText = (text: string): string => displayText(text).replace(/\n/gu, " ");

const unicodeEscape = (character: string): string =>
  `\\u${character.charCodeAt(0).toString(16).padStart(4, "0")}`;

/** Serialize first: escaping unsafe display characters must not change the JSON value. */
export function jsonText(value: unknown): string {
  return (
    JSON.stringify(value)
      .replace(UNSAFE_DISPLAY_CHARACTERS, unicodeEscape)
      // JSON permits these literal separators, but transcript tokens should stay on one line.
      .replace(/[\u2028\u2029]/gu, unicodeEscape)
  );
}
