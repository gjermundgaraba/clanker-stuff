import { displayText } from "@clanker-stuff/pi-tool-rendering/text";
import { renderDiff } from "@earendil-works/pi-coding-agent";
import type { Theme, ThemeColor } from "@earendil-works/pi-coding-agent";
import { diffWordsWithSpace } from "diff";
import { Value } from "typebox/value";

import { parseDiffLine, SyntaxSchema } from "./highlight.js";
import type { DiffSyntax, SyntaxRole } from "./highlight.js";

// This replaces native code rendering: keep its syntax roles, not a separate RGB palette.
const colors = {
  text: "text",
  comment: "syntaxComment",
  keyword: "syntaxKeyword",
  string: "syntaxString",
  number: "syntaxNumber",
  type: "syntaxType",
  function: "syntaxFunction",
  variable: "syntaxVariable",
  operator: "syntaxOperator",
  punctuation: "syntaxPunctuation",
} satisfies Record<SyntaxRole, ThemeColor>;

type Range = [start: number, end: number];

function wordChanges(before: string, after: string): [Range[], Range[]] {
  const removed: Range[] = [];
  const added: Range[] = [];
  let oldOffset = 0;
  let newOffset = 0;

  for (const part of diffWordsWithSpace(before, after)) {
    if (part.removed) {
      removed.push([oldOffset, oldOffset + part.value.length]);
      oldOffset += part.value.length;
    } else if (part.added) {
      added.push([newOffset, newOffset + part.value.length]);
      newOffset += part.value.length;
    } else {
      oldOffset += part.value.length;
      newOffset += part.value.length;
    }
  }

  return [removed, added];
}

function renderCode(
  text: string,
  spans: NonNullable<DiffSyntax[number]>,
  changed: Range[],
  theme: Theme,
): string {
  let start = 0;
  const output: string[] = [];

  for (const [end, role] of spans) {
    const boundaries = [start, end];

    for (const [from, to] of changed) {
      if (from > start && from < end) boundaries.push(from);

      if (to > start && to < end) boundaries.push(to);
    }

    boundaries.sort((a, b) => a - b);

    for (let i = 1; i < boundaries.length; i++) {
      const from = boundaries[i - 1];
      const to = boundaries[i];

      if (from === undefined || to === undefined) continue;
      let content = displayText(text.slice(from, to));

      if (changed.some(([left, right]) => left <= from && to <= right))
        content = theme.inverse(content);
      output.push(theme.fg(colors[role], content));
    }

    start = end;
  }

  return output.join("");
}

function validSpans(text: string, spans: NonNullable<DiffSyntax[number]>): boolean {
  let start = 0;

  for (const [end] of spans) {
    if (end <= start || end > text.length) return false;
    start = end;
  }

  return start === text.length;
}

export function renderHighlightedDiff(diff: string, syntax: unknown, theme: Theme): string {
  if (!Value.Check(SyntaxSchema, syntax)) return renderDiff(displayText(diff));
  const rows = diff.split("\n");

  if (syntax.length !== rows.length) return renderDiff(displayText(diff));
  const lines = rows.map(parseDiffLine);

  if (
    lines.some((line, index) => {
      const spans = syntax[index];

      return spans && (!line || !validSpans(line.text, spans));
    })
  )
    return renderDiff(displayText(diff));

  const changes = new Map<number, Range[]>();

  // Like Pi's native renderer, emphasize words only for one removed/one added line.
  for (let i = 0; i < rows.length - 1; i++) {
    const old = lines[i];
    const next = lines[i + 1];
    const previous = lines[i - 1];
    const following = lines[i + 2];

    if (
      old?.kind === "-" &&
      next?.kind === "+" &&
      previous?.kind !== "-" &&
      following?.kind !== "+"
    ) {
      const [removed, added] = wordChanges(old.text, next.text);
      changes.set(i, removed);
      changes.set(i + 1, added);
    }
  }

  return rows
    .map((raw, index) => {
      const line = lines[index];
      const spans = syntax[index];

      if (!line || !spans) return renderDiff(displayText(raw));

      return (
        renderDiff(line.prefix) + renderCode(line.text, spans, changes.get(index) ?? [], theme)
      );
    })
    .join("\n");
}
