import { category, line, normalCursor, units, type View, type Range } from "./document.js";
import type { Command } from "./parser.js";

export interface Motion {
  at: number;
  inclusive: boolean;
  linewise: boolean;
}

export function motion(view: View, command: Command): Motion | undefined {
  const { text, cursor } = view;
  const key = command.motion!;
  const count = command.count;
  const cells = units(view);
  let index = cells.findIndex((u) => u.start >= cursor);

  if (index < 0) index = cells.length;
  let at = cursor;
  let inclusive = false;
  let linewise = false;
  const row = line(text, cursor);

  switch (key) {
    case "h":
      at = cells[Math.max(0, index - count)]?.start ?? 0;
      at = Math.max(row.start, at);
      break;
    case "l":
      // An operator's exclusive end may follow the last character; plain moves are normalized.
      at = Math.min(row.end, cells[index + count]?.start ?? text.length);
      break;
    case "0":
      at = row.start;
      break;
    case "^":
      at = row.start + (text.slice(row.start, row.end).match(/^\s*/u)?.[0].length ?? 0);
      break;
    case "$": {
      let end = row.end;

      for (let i = 1; i < count && end < text.length; i++) end = line(text, end + 1).end;
      at = normalCursor(view, end);
      inclusive = true;
      break;
    }

    case "j":
    case "k": {
      const rows = text.split("\n");
      const current = text.slice(0, cursor).split("\n").length - 1;

      const target = Math.max(
        0,
        Math.min(rows.length - 1, current + (key === "j" ? count : -count)),
      );

      // A count may be cut short by the document, but a motion that cannot move at all fails.
      if (target === current) return undefined;
      const start = rows.slice(0, target).reduce((n, s) => n + s.length + 1, 0);
      const column = cells.filter((u) => u.start >= row.start && u.start < cursor).length;

      const targetCells = cells.filter(
        (u) => u.start >= start && u.start < start + rows[target]!.length,
      );

      at = targetCells[Math.min(column, targetCells.length - 1)]?.start ?? start;
      linewise = true;
      break;
    }

    case "gg":
    case "G": {
      const rows = text.split("\n");

      const target = command.explicit
        ? Math.min(rows.length, count) - 1
        : key === "gg"
          ? 0
          : rows.length - 1;

      at = rows.slice(0, target).reduce((n, s) => n + s.length + 1, 0);
      at += rows[target]!.match(/^\s*/u)?.[0].length ?? 0;
      linewise = true;
      break;
    }

    case "w":
    case "W":
    case "b":
    case "B":
    case "e":
    case "E": {
      const big = key === key.toUpperCase();

      const empty = (i: number) =>
        cells[i]?.text === "\n" && (i === 0 || cells[i - 1]?.text === "\n");

      const type = (i: number) =>
        empty(i) && key.toLowerCase() !== "e" ? 3 : category(cells[i]?.text ?? " ", big);

      for (let n = 0; n < count; n++) {
        if (key.toLowerCase() === "w") {
          const current = type(index);

          if (current === 3) index++;
          else while (index < cells.length && type(index) === current) index++;

          while (index < cells.length && type(index) === 0) index++;
        } else if (key.toLowerCase() === "b") {
          index = Math.max(0, index - 1);

          while (index > 0 && type(index) === 0) index--;

          if (type(index) !== 3) while (index > 0 && type(index - 1) === type(index)) index--;
        } else {
          index = Math.min(cells.length - 1, index + 1);

          while (index < cells.length - 1 && type(index) === 0) index++;

          while (index < cells.length - 1 && type(index + 1) === type(index)) index++;
          inclusive = true;
        }
      }

      at = cells[index]?.start ?? text.length;
      break;
    }

    case "f":
    case "F":
    case "t":
    case "T": {
      const direction = key === key.toLowerCase() ? 1 : -1;
      let found = index;

      for (let n = 0; n < count; n++) {
        do {
          found += direction;
        } while (
          cells[found] &&
          cells[found]!.start >= row.start &&
          cells[found]!.start < row.end &&
          cells[found]!.text !== command.target
        );

        if (!cells[found] || cells[found]!.start < row.start || cells[found]!.start >= row.end)
          return undefined;
      }

      if (key.toLowerCase() === "t") found -= direction;
      at = cells[found]!.start;
      inclusive = direction > 0;
      break;
    }

    case "%": {
      const pairs = "()[]{}";

      const start = cells.findIndex(
        (cell) =>
          cell.start >= cursor &&
          cell.start < row.end &&
          pairs.includes(cell.text) &&
          cell.text.length === 1,
      );

      if (start < 0) return undefined;
      const opening = cells[start]!.text;
      const pair = pairs.indexOf(opening);
      const direction = pair % 2 === 0 ? 1 : -1;
      const closing = pairs[pair + direction];
      let depth = 1;

      for (let i = start + direction; cells[i]; i += direction) {
        if (cells[i]!.text === opening) depth++;

        if (cells[i]!.text === closing && --depth === 0) {
          at = cells[i]!.start;
          inclusive = true;
          break;
        }
      }

      if (depth !== 0) return undefined;
      break;
    }

    default:
      return undefined;
  }

  return { at, inclusive, linewise };
}

export function objectRange(
  view: View,
  target: string,
  around: boolean,
  count: number,
): Range | undefined {
  const { text, cursor } = view;
  const cells = units(view);

  if (target === "w" || target === "W") {
    if (line(text, cursor).start === line(text, cursor).end) {
      if (!around) return undefined;
      const end = motion(view, { key: "move", count, explicit: false, motion: "e" });

      return (
        end && { start: cursor, end: cells.find((u) => u.start === end.at)?.end ?? text.length }
      );
    }

    let i = cells.findIndex((u) => u.start <= cursor && cursor < u.end);

    if (i < 0) return undefined;
    const type = (n: number) => category(cells[n]?.text ?? " ", target === "W");
    let a = i;

    while (a > 0 && type(a - 1) === type(i)) a--;
    const blank = type(i) === 0;

    const run = () => {
      const current = type(i);

      while (i + 1 < cells.length && type(i + 1) === current) i++;
    };

    for (let n = 0; n < count; n++) {
      if (n > 0 && ++i === cells.length) return undefined;
      run();
      // "Inner" counts whitespace as an object. "A word" pairs each word with whitespace:
      // what follows it, or what precedes it when the object starts on whitespace.
      const paired = blank || (n + 1 < count && type(i + 1) === 0);

      if (around && paired && i + 1 < cells.length) {
        i++;
        run();
      }
    }

    if (around && !blank) {
      const before = i;

      while (i + 1 < cells.length && type(i + 1) === 0 && cells[i + 1]!.text !== "\n") i++;

      if (before === i) {
        let candidate = a;

        while (candidate > 0 && type(candidate - 1) === 0 && cells[candidate - 1]!.text !== "\n")
          candidate--;

        if (cells[candidate]!.start !== line(text, cells[a]!.start).start) a = candidate;
      }
    }

    return { start: cells[a]!.start, end: cells[i]!.end };
  }

  if (`"'\``.includes(target)) {
    const row = line(text, cursor);

    const quotes = cells.filter(
      (u) =>
        u.start >= row.start &&
        u.start < row.end &&
        u.text === target &&
        text[u.start - 1] !== "\\",
    );

    for (let i = 0; i + 1 < quotes.length; i += 2) {
      const a = quotes[i]!,
        b = quotes[i + 1]!;

      if (b.start >= cursor)
        return { start: around ? a.start : a.end, end: around ? b.end : b.start };
    }

    return undefined;
  }

  const pairs = "()[]{}<>";
  const pair = pairs.indexOf(target);

  if (pair < 0) return undefined;

  const open = pairs[pair - (pair % 2)],
    close = pairs[pair - (pair % 2) + 1];

  const stack: number[] = [];
  const ranges: Range[] = [];

  for (const cell of cells) {
    if (cell.text === open) stack.push(cell.start);

    if (cell.text === close && stack.length) {
      const start = stack.pop()!;

      if (start <= cursor && cursor <= cell.start) ranges.push({ start, end: cell.end });
    }
  }

  const found = ranges[count - 1];

  return found && { start: found.start + (around ? 0 : 1), end: found.end - (around ? 0 : 1) };
}
