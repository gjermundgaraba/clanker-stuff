import { category, line, normalCursor, units } from "./document.js";
import type { View, Range, Unit } from "./document.js";
import type { Command } from "./parser.js";

export interface Motion {
  at: number;
  inclusive: boolean;
  linewise: boolean;
}

export const motion = (view: View, command: Command): Motion | undefined => {
  const { text, cursor } = view;
  const { motion: key, count } = command;

  if (key === undefined) {
    throw new Error(`Vim command ${command.key} has no motion`);
  }

  const cells = units(view);
  let index = cells.findIndex((u) => u.start >= cursor);

  if (index < 0) {
    index = cells.length;
  }

  let at = cursor;
  let inclusive = false;
  let linewise = false;
  const row = line(text, cursor);

  switch (key) {
    case "h": {
      at = cells[Math.max(0, index - count)]?.start ?? 0;
      at = Math.max(row.start, at);
      break;
    }

    case "l": {
      at = Math.min(row.end, cells[index + count]?.start ?? text.length);
      break;
    }

    case "0": {
      at = row.start;
      break;
    }

    case "^": {
      at =
        row.start +
        (/^\s*/u.exec(text.slice(row.start, row.end))?.[0].length ?? 0);
      break;
    }

    case "$": {
      let { end } = row;

      for (let i = 1; i < count && end < text.length; i += 1) {
        ({ end } = line(text, end + 1));
      }

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
        Math.min(rows.length - 1, current + (key === "j" ? count : -count))
      );

      if (target === current) {
        return undefined;
      }

      const start = rows.slice(0, target).reduce((n, s) => n + s.length + 1, 0);

      const column = cells.filter(
        (u) => u.start >= row.start && u.start < cursor
      ).length;

      const targetRow = rows[target];

      if (targetRow === undefined) {
        throw new Error(`Vim ${key} target row ${target} is outside the text`);
      }

      const targetCells = cells.filter(
        (u) => u.start >= start && u.start < start + targetRow.length
      );

      at =
        targetCells[Math.min(column, targetCells.length - 1)]?.start ?? start;
      linewise = true;
      break;
    }

    case "gg":
    case "G": {
      const rows = text.split("\n");

      let target = rows.length - 1;

      if (command.explicit) {
        target = Math.min(rows.length, count) - 1;
      } else if (key === "gg") {
        target = 0;
      }

      const targetRow = rows[target];

      if (targetRow === undefined) {
        throw new Error(`Vim ${key} target row ${target} is outside the text`);
      }

      at = rows.slice(0, target).reduce((n, s) => n + s.length + 1, 0);
      at += /^\s*/u.exec(targetRow)?.[0].length ?? 0;
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
        empty(i) && key.toLowerCase() !== "e"
          ? 3
          : category(cells[i]?.text ?? " ", big);

      for (let n = 0; n < count; n += 1) {
        if (key.toLowerCase() === "w") {
          const current = type(index);

          if (current === 3) {
            index += 1;
          } else {
            while (index < cells.length && type(index) === current) {
              index += 1;
            }
          }

          while (index < cells.length && type(index) === 0) {
            index += 1;
          }
        } else if (key.toLowerCase() === "b") {
          index = Math.max(0, index - 1);

          while (index > 0 && type(index) === 0) {
            index -= 1;
          }

          if (type(index) !== 3) {
            while (index > 0 && type(index - 1) === type(index)) {
              index -= 1;
            }
          }
        } else {
          index = Math.min(cells.length - 1, index + 1);

          while (index < cells.length - 1 && type(index) === 0) {
            index += 1;
          }

          while (index < cells.length - 1 && type(index + 1) === type(index)) {
            index += 1;
          }

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

      for (let n = 0; n < count; n += 1) {
        let cell: Unit | undefined;

        do {
          found += direction;
          cell = cells[found];
        } while (
          cell &&
          cell.start >= row.start &&
          cell.start < row.end &&
          cell.text !== command.target
        );

        if (!cell || cell.start < row.start || cell.start >= row.end) {
          return undefined;
        }
      }

      if (key.toLowerCase() === "t") {
        found -= direction;
      }

      const landing = cells[found];

      if (!landing) {
        throw new Error(`Vim ${key} landed outside the text at cell ${found}`);
      }

      at = landing.start;
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
          cell.text.length === 1
      );

      const opening = cells[start]?.text;

      if (opening === undefined) {
        return undefined;
      }

      const pair = pairs.indexOf(opening);
      const direction = pair % 2 === 0 ? 1 : -1;
      const closing = pairs[pair + direction];
      let depth = 1;

      const scan =
        direction > 0
          ? cells.slice(start + 1)
          : cells.slice(0, start).toReversed();

      for (const cell of scan) {
        if (cell.text === opening) {
          depth += 1;
        }

        if (cell.text === closing) {
          depth -= 1;

          if (depth === 0) {
            at = cell.start;
            inclusive = true;
            break;
          }
        }
      }

      if (depth !== 0) {
        return undefined;
      }

      break;
    }

    default: {
      return undefined;
    }
  }

  return { at, inclusive, linewise };
};

export const objectRange = (
  view: View,
  target: string,
  around: boolean,
  count: number
): Range | undefined => {
  const { text, cursor } = view;
  const cells = units(view);

  if (target === "w" || target === "W") {
    if (line(text, cursor).start === line(text, cursor).end) {
      if (!around) {
        return undefined;
      }

      const end = motion(view, {
        key: "move",
        count,
        explicit: false,
        motion: "e",
      });

      return (
        end && {
          start: cursor,
          end: cells.find((u) => u.start === end.at)?.end ?? text.length,
        }
      );
    }

    let i = cells.findIndex((u) => u.start <= cursor && cursor < u.end);

    if (i < 0) {
      return undefined;
    }

    const type = (n: number) => category(cells[n]?.text ?? " ", target === "W");
    let a = i;

    while (a > 0 && type(a - 1) === type(i)) {
      a -= 1;
    }

    const blank = type(i) === 0;

    const run = () => {
      const current = type(i);

      while (i + 1 < cells.length && type(i + 1) === current) {
        i += 1;
      }
    };

    for (let n = 0; n < count; n += 1) {
      if (n > 0) {
        i += 1;

        if (i === cells.length) {
          return undefined;
        }
      }

      run();
      const paired = blank || (n + 1 < count && type(i + 1) === 0);

      if (around && paired && i + 1 < cells.length) {
        i += 1;
        run();
      }
    }

    if (around && !blank) {
      const before = i;

      while (
        i + 1 < cells.length &&
        type(i + 1) === 0 &&
        cells[i + 1]?.text !== "\n"
      ) {
        i += 1;
      }

      if (before === i) {
        let candidate = a;

        while (
          candidate > 0 &&
          type(candidate - 1) === 0 &&
          cells[candidate - 1]?.text !== "\n"
        ) {
          candidate -= 1;
        }

        const word = cells[a];

        if (!word) {
          throw new Error(`Vim word object starts outside the text at ${a}`);
        }

        if (cells[candidate]?.start !== line(text, word.start).start) {
          a = candidate;
        }
      }
    }

    const first = cells[a];
    const last = cells[i];

    if (!first || !last) {
      throw new Error(`Vim word object ${a}..${i} is outside the text`);
    }

    return { start: first.start, end: last.end };
  }

  if (`"'\``.includes(target)) {
    const row = line(text, cursor);

    const quotes = cells.filter(
      (u) =>
        u.start >= row.start &&
        u.start < row.end &&
        u.text === target &&
        text[u.start - 1] !== "\\"
    );

    for (let i = 0; i + 1 < quotes.length; i += 2) {
      const a = quotes[i];
      const b = quotes[i + 1];

      if (!a || !b) {
        throw new Error(`Vim quote pair ${i} is outside the line`);
      }

      if (b.start >= cursor) {
        return {
          start: around ? a.start : a.end,
          end: around ? b.end : b.start,
        };
      }
    }

    return undefined;
  }

  const pairs = "()[]{}<>";
  const pair = pairs.indexOf(target);

  if (pair === -1) {
    return undefined;
  }

  const open = pairs[pair - (pair % 2)];
  const close = pairs[pair - (pair % 2) + 1];

  const stack: number[] = [];
  const ranges: Range[] = [];

  for (const cell of cells) {
    if (cell.text === open) {
      stack.push(cell.start);
    }

    if (cell.text === close) {
      const start = stack.pop();

      if (start !== undefined && start <= cursor && cursor <= cell.start) {
        ranges.push({ start, end: cell.end });
      }
    }
  }

  const found = ranges[count - 1];

  return (
    found && {
      start: found.start + (around ? 0 : 1),
      end: found.end - (around ? 0 : 1),
    }
  );
};
