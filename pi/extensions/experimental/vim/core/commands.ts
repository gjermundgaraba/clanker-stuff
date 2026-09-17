import { line, next, normalCursor, previous, units, type Range, type View } from "./document.js";
import { motion, objectRange } from "./motions.js";
import type { Command } from "./parser.js";
export type Mode = "insert" | "normal" | "visual" | "visual-line";
export interface Register {
  text: string;
  linewise: boolean;
}
export interface Edit extends Range {
  text: string;
  /** Text from outside the document, such as a register. The host encodes it; text derived
   * from the collapsed document already carries its paste markers. */
  foreign?: boolean;
}
export interface Result {
  cursor: number;
  anchor?: number;
  mode?: Mode;
  edit?: Edit;
  yank?: Range & { linewise: boolean };
}
export interface State {
  mode: Mode;
  anchor: number;
  register: Register;
}

export function selection(
  view: View,
  state: State,
  linewise = state.mode === "visual-line",
): Range {
  const start = Math.min(view.cursor, state.anchor),
    end = Math.max(view.cursor, state.anchor);
  return linewise
    ? {
        start: line(view.text, start).start,
        end: Math.min(view.text.length, line(view.text, end).end + 1),
      }
    : { start, end: next(view, end) };
}

// Vim defines these as synonyms. In Visual the selection replaces the motion.
const shorthand = new Map<string, [key: string, motion: string]>([
  ["x", ["d", "l"]],
  ["X", ["d", "h"]],
  ["s", ["c", "l"]],
  ["S", ["c", "line"]],
  ["D", ["d", "$"]],
  ["C", ["c", "$"]],
]);

/** Commands produce a single edit. The adapter, not the core, owns mutation and history. */
export function execute(view: View, state: State, command: Command): Result | undefined {
  const { text, cursor } = view;
  const row = line(text, cursor);
  const visual = state.mode === "visual" || state.mode === "visual-line";
  // Visual X, D, C and S act on the selection's whole lines.
  const wholeLines = visual && "XDCS".includes(command.key);
  const synonym = shorthand.get(command.key);
  if (synonym) command = { ...command, key: synonym[0], motion: visual ? undefined : synonym[1] };
  const { key } = command;
  if (key === "select") {
    // As in Vim, a word object typed over an existing forward selection extends it.
    const extend = visual && cursor > state.anchor && /[wW]/u.test(command.target!);
    const range = objectRange(
      extend ? { ...view, cursor: next(view, cursor) } : view,
      command.target!,
      command.around ?? false,
      command.count,
    );
    return (
      range && {
        cursor: previous(view, range.end),
        anchor: extend ? state.anchor : range.start,
        mode: "visual",
      }
    );
  }
  if (key === "move") {
    const result = motion(view, command);
    return result && { cursor: normalCursor(view, result.at) };
  }
  if (key === "v" || key === "V")
    return {
      cursor,
      mode:
        state.mode === (key === "v" ? "visual" : "visual-line")
          ? "normal"
          : key === "v"
            ? "visual"
            : "visual-line",
    };
  if ("iIaAoO".includes(key)) {
    const at =
      key === "i"
        ? cursor
        : key === "I"
          ? row.start + (text.slice(row.start, row.end).match(/^\s*/u)?.[0].length ?? 0)
          : key === "a"
            ? Math.min(row.end, next(view, cursor))
            : key === "A"
              ? row.end
              : key === "o"
                ? row.end
                : row.start;
    if (key === "o" || key === "O")
      return {
        cursor: at + (key === "o" ? 1 : 0),
        mode: "insert",
        edit: { start: at, end: at, text: "\n" },
      };
    return { cursor: at, mode: "insert" };
  }
  if (key === "p" || key === "P") {
    const { text: content, linewise: lines } = state.register;
    if (!content || content.length * command.count > 1_000_000) return undefined;
    const indent = content.match(/^[ \t]*/u)![0].length;
    const lastCell = (insertion: string) =>
      previous({ text: insertion, cursor: 0, atoms: [] }, insertion.length);
    let insertion = content.repeat(command.count);
    let start = key === "P" ? cursor : next(view, cursor);
    let end: number | undefined;
    let rest: number;
    if (state.mode === "visual-line") {
      // The selection keeps its last line break, so every copy lands on a line of its own.
      start = line(text, Math.min(cursor, state.anchor)).start;
      end = line(text, Math.max(cursor, state.anchor)).end;
      insertion = Array.from({ length: command.count }, () => content.replace(/\n$/u, "")).join(
        "\n",
      );
      rest = start + indent;
    } else if (visual) {
      ({ start, end } = selection(view, state));
      // Whole lines put over part of a line split it around them.
      if (lines) insertion = "\n" + insertion;
      rest = lines ? start + 1 + indent : start + lastCell(insertion);
    } else if (lines) {
      const last = key === "p" && row.end === text.length && text.length > 0;
      start = key === "P" ? row.start : Math.min(text.length, row.end + 1);
      if (last) insertion = "\n" + insertion.replace(/\n$/u, "");
      rest = start + Number(last) + indent;
    } else rest = start + lastCell(insertion);
    const result: Result = {
      cursor: rest,
      mode: "normal",
      edit: { start, end: end ?? start, text: insertion, foreign: true },
    };
    // Visual p exchanges the selection with the register; P keeps the register.
    if (visual && key === "p")
      result.yank = { ...selection(view, state), linewise: state.mode === "visual-line" };
    return result;
  }
  if (key === "J") {
    // Visual joins the selected lines, and at least two; otherwise the count includes this line.
    const first = visual ? line(text, Math.min(cursor, state.anchor)) : row;
    let end = visual ? line(text, Math.max(cursor, state.anchor)).end : row.end;
    const more = visual ? Number(end === first.end) : Math.max(1, command.count - 1);
    for (let n = 0; n < more && end < text.length; n++) end = line(text, end + 1).end;
    if (end === first.end) return undefined;
    const parts = text.slice(first.start, end).split("\n");
    let joined = parts[0]!;
    let joinAt = joined.length;
    for (const part of parts.slice(1)) {
      joinAt = joined.length;
      const tail = part.trimStart();
      const separator =
        joined && !/\s$/u.test(joined) && tail ? (/[.!?]$/u.test(joined) ? "  " : " ") : "";
      joined += separator + tail;
    }
    return {
      cursor: first.start + joinAt,
      mode: "normal",
      edit: { start: first.start, end, text: joined },
    };
  }
  let range: Range | undefined;
  let linewise = false;
  // A yank rests at the start of what its motion or object covered.
  let rest = cursor;
  if (visual) {
    linewise = state.mode === "visual-line" || wholeLines;
    range = selection(view, state, linewise);
  } else if (key === "r" || key === "~")
    range = { start: cursor, end: motion(view, { ...command, motion: "l" })!.at };
  else if (command.motion === "line") {
    let end = row.end;
    for (let n = 1; n < command.count && end < text.length; n++) end = line(text, end + 1).end;
    range = { start: row.start, end: Math.min(text.length, end + 1) };
    linewise = true;
  } else if (command.motion === "object") {
    range = objectRange(view, command.target!, command.around ?? false, command.count);
    rest = range?.start ?? cursor;
  } else if (command.motion) {
    // Vim's cw changes through the current word, not its following whitespace.
    const changed =
      key === "c" && /[wW]/u.test(command.motion) && !/^\s/u.test(text.slice(cursor))
        ? { ...command, motion: command.motion === "w" ? "e" : "E" }
        : command;
    const word =
      changed !== command ? objectRange(view, command.motion, false, command.count) : undefined;
    const target = word
      ? { at: previous(view, word.end), inclusive: true, linewise: false }
      : motion(view, changed);
    if (!target) return undefined;
    linewise = target.linewise;
    const start = Math.min(cursor, target.at);
    rest = start;
    let end = Math.max(cursor, target.at);
    if (
      (command.motion === "w" || command.motion === "W") &&
      command.count === 1 &&
      end > row.end &&
      cursor < row.end
    )
      end = row.end;
    range = linewise
      ? { start: line(text, start).start, end: Math.min(text.length, line(text, end).end + 1) }
      : { start, end: target.inclusive && text[end] !== "\n" ? next(view, end) : end };
    if (key === "c" && command.motion === "w" && row.start === row.end)
      range = { start: cursor, end: cursor };
  }
  if (!range || (range.start === range.end && key !== "c")) return undefined;
  if (
    !visual &&
    range.start === line(text, range.start).start &&
    range.end > line(text, range.start).end + 1 &&
    range.end === line(text, Math.max(range.start, range.end - 1)).end
  ) {
    linewise = true;
    range = { start: range.start, end: Math.min(text.length, range.end + 1) };
  }
  if (key === "r" || key === "~") {
    const selected = range;
    const portion = units(view).filter((u) => u.start >= selected.start && u.end <= selected.end);
    if (portion.some((u) => u.text.length > 2 && u.text.startsWith("[paste #"))) return undefined;
    // Unlike ~, a counted r replaces exactly that many characters or none.
    if (key === "r" && !visual && portion.length < command.count) return undefined;
    const replacement =
      key === "r"
        ? portion.map((unit) => (unit.text === "\n" ? "\n" : command.target!)).join("")
        : text
            .slice(range.start, range.end)
            .replace(/\p{L}/gu, (c) => (c === c.toUpperCase() ? c.toLowerCase() : c.toUpperCase()));
    return {
      // ~ moves past the change; a counted r rests on its last replacement.
      cursor:
        key === "~"
          ? range.start + replacement.length
          : visual
            ? range.start
            : range.start + replacement.length - command.target!.length,
      mode: "normal",
      edit: { ...range, text: replacement },
    };
  }
  if (key === "y")
    return { cursor: visual ? range.start : rest, mode: "normal", yank: { ...range, linewise } };
  const yank = { ...range, linewise };
  let replacement = "";
  if (linewise && key === "c") {
    replacement = range.end < text.length ? "\n" : "";
    const indent =
      text.slice(range.start, line(text, range.start).end).match(/^\s*/u)?.[0].length ?? 0;
    range = { start: range.start + indent, end: range.end };
  }
  if (linewise && key === "d" && range.end === text.length && range.start > 0)
    range = { start: range.start - 1, end: range.end };
  const after = text.slice(0, range.start) + replacement + text.slice(range.end);
  const remaining = line(after, Math.min(after.length, range.start));
  const destination =
    linewise && key === "d"
      ? remaining.start +
        (after.slice(remaining.start, remaining.end).match(/^\s*/u)?.[0].length ?? 0)
      : range.start;
  return {
    cursor: destination,
    mode: key === "c" ? "insert" : "normal",
    yank,
    edit: { ...range, text: replacement },
  };
}
