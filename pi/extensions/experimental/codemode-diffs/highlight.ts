import path from "node:path";

import { getLanguageFromPath } from "@earendil-works/pi-coding-agent";
import type { Theme as HighlightsTheme } from "@pierre/highlights";
import { Type } from "typebox";
import type { Static } from "typebox";

// Palette names are semantic labels, not colors. No Pierre palette is baked into saved sessions.
export const SyntaxRoleSchema = Type.Union([
  Type.Literal("text"),
  Type.Literal("comment"),
  Type.Literal("keyword"),
  Type.Literal("string"),
  Type.Literal("number"),
  Type.Literal("type"),
  Type.Literal("function"),
  Type.Literal("variable"),
  Type.Literal("operator"),
  Type.Literal("punctuation"),
]);

export type SyntaxRole = Static<typeof SyntaxRoleSchema>;

export const SyntaxSchema = Type.Array(
  Type.Union([
    Type.Null(),
    Type.Array(Type.Tuple([Type.Integer({ minimum: 1 }), SyntaxRoleSchema])),
  ])
);

export type DiffSyntax = Static<typeof SyntaxSchema>;

const palette = {
  attribute: "variable",
  boolean: "number",
  comment: "comment",
  constant: "number",
  constructor: "type",
  enum: "type",
  function: "function",
  keyword: "keyword",
  label: "variable",
  namespace: "type",
  number: "number",
  operator: "operator",
  preproc: "keyword",
  property: "variable",
  punctuation: "punctuation",
  selector: "type",
  string: "string",
  tag: "keyword",
  title: "function",
  type: "type",
  variable: "variable",
  variant: "type",
} as const satisfies Record<string, SyntaxRole>;

const lexerTheme: HighlightsTheme = {
  name: "Pi syntax roles",
  appearance: "dark",
  cssVariables: { prefix: "--pi-" },
  style: { syntax: palette },
};

const roles = new Map<string, SyntaxRole>(
  Object.values(palette).map((role) => [`var(--pi-${role})`, role])
);

export interface DiffLine {
  prefix: string;
  kind: " " | "+" | "-";
  number: number;
  text: string;
}

export const parseDiffLine = (line: string): DiffLine | undefined => {
  const match = /^(?<kind>[ +-])(?<number>\s*\d+) (?<text>.*)$/su.exec(line);
  const kind = match?.groups?.["kind"];
  const number = match?.groups?.["number"];
  const text = match?.groups?.["text"];

  if (
    (kind !== " " && kind !== "+" && kind !== "-") ||
    number === undefined ||
    text === undefined
  ) {
    return;
  }

  return { prefix: `${kind}${number} `, kind, number: Number(number), text };
};

// Match Pi's BOM and newline normalization before projecting lexer offsets onto its display diff.
const normalize = (source: string) =>
  source.replace(/^\uFEFF/u, "").replaceAll(/\r\n?/gu, "\n");

export const highlightDiff = async (
  file: string,
  diff: string,
  before: string,
  after: string
): Promise<DiffSyntax | undefined> => {
  const { codeToTokens, isSupportedLanguage } =
    await import("@pierre/highlights");

  // Pi aliases TSX/JSX to TS/JS; prefer Highlights' dedicated lexer when it recognizes the suffix.
  const suffix = (
    path.extname(file).slice(1) || path.basename(file)
  ).toLowerCase();

  if (["txt", "text", "plain", "plaintext"].includes(suffix)) {
    return;
  }

  const lang = isSupportedLanguage(suffix) ? suffix : getLanguageFromPath(file);

  if (lang === undefined || lang === "" || !isSupportedLanguage(lang)) {
    return;
  }

  const oldSource = normalize(before);
  const newSource = normalize(after);
  const oldLines = oldSource.split("\n");
  const newLines = newSource.split("\n");

  const oldTokens = codeToTokens(oldSource, {
    lang,
    theme: lexerTheme,
    tokenizeMaxLineLength: 10_000,
  }).tokens;

  const newTokens = codeToTokens(newSource, {
    lang,
    theme: lexerTheme,
    tokenizeMaxLineLength: 10_000,
  }).tokens;

  return diff.split("\n").map((raw) => {
    const line = parseDiffLine(raw);

    if (!line) {
      return null;
    }

    // Pi numbers unchanged context in the old file, so it uses the old side's lexer state.
    const lines = line.kind === "+" ? newLines : oldLines;
    const tokens = (line.kind === "+" ? newTokens : oldTokens)[line.number - 1];

    if (lines[line.number - 1] !== line.text || !tokens) {
      return null;
    }

    let end = 0;
    const spans: NonNullable<DiffSyntax[number]> = [];

    for (const token of tokens) {
      end += token.content.length;

      if (!token.content.length) {
        continue;
      }

      const role =
        token.color === undefined ? "text" : (roles.get(token.color) ?? "text");

      const last = spans.at(-1);

      if (last?.[1] === role) {
        last[0] = end;
      } else {
        spans.push([end, role]);
      }
    }

    return end === line.text.length ? spans : null;
  });
};
