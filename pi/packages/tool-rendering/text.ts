import { stripVTControlCharacters } from "node:util";

const UNSAFE_DISPLAY_CHARACTERS =
  /[[\p{Cc}--[\t\n]]\u061C\u200E\u200F\u202A-\u202E\u2066-\u2069]/gv;

/** Remove terminal controls and bidi overrides, preserving log newlines and tabs. */
export const safeText = (text: string): string =>
  stripVTControlCharacters(text).replaceAll(UNSAFE_DISPLAY_CHARACTERS, "");

/** Normalize tabs before layout so terminal tab stops cannot change measured widths. */
export const displayText = (text: string): string =>
  safeText(text).replaceAll("\t", "   ");

export const inlineText = (text: string): string =>
  displayText(text).replaceAll("\n", " ");

const unicodeEscape = (character: string): string =>
  `\\u${character.charCodeAt(0).toString(16).padStart(4, "0")}`;

/** Serialize first: escaping unsafe display characters must not change the JSON value. */
export const jsonText = (value: unknown): string =>
  JSON.stringify(value)
    .replaceAll(UNSAFE_DISPLAY_CHARACTERS, unicodeEscape)
    .replaceAll(/[\u2028\u2029]/gu, unicodeEscape);
