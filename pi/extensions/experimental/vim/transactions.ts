import { units, line, previous } from "./core/document.js";
import type { Unit, View } from "./core/document.js";

export class Transactions {
  private past: View[] = [];
  private future: View[] = [];
  commit(before: View, after: View) {
    if (
      before.text === after.text &&
      before.atoms.length === after.atoms.length &&
      before.atoms.every(
        (atom, i) =>
          atom.start === after.atoms[i]?.start &&
          atom.end === after.atoms[i]?.end &&
          atom.content === after.atoms[i]?.content
      )
    ) {
      return;
    }

    this.past.push(before);

    if (this.past.length > 100) {
      this.past.shift();
    }

    this.future = [];
  }
  undo(current: View) {
    const prior = this.past.pop();

    if (prior) {
      this.future.push(current);
    }

    return prior;
  }
  redo(current: View) {
    const next = this.future.pop();

    if (next) {
      this.past.push(current);
    }

    return next;
  }
  clear() {
    this.past = [];
    this.future = [];
  }
}

const sameContent = (a: Unit[], b: Unit[]) =>
  a.length === b.length && a.every((u, i) => u.content === b[i]?.content);

export interface Delta {
  offset: number;
  remove: number;
  text: string;
}

export class Insertion {
  private start: number | undefined;
  private oldEnd = 0;
  private newEnd = 0;
  private readonly origin: number;
  private readonly before: View;

  constructor(before: View) {
    this.before = before;
    this.origin = units(before).filter((u) => u.start < before.cursor).length;
  }
  record(before: View, after: View) {
    const a = units(before);
    const b = units(after);

    if (sameContent(a, b)) {
      return;
    }

    const limit = Math.min(
      a.filter((u) => u.start < before.cursor).length,
      b.filter((u) => u.start < after.cursor).length
    );

    let start = 0;
    let suffix = 0;

    while (start < limit && a[start]?.content === b[start]?.content) {
      start += 1;
    }

    while (
      suffix < a.length - start &&
      suffix < b.length - start &&
      a[a.length - 1 - suffix]?.content === b[b.length - 1 - suffix]?.content
    ) {
      suffix += 1;
    }

    const end = a.length - suffix;

    if (this.start === undefined) {
      this.start = start;
      this.oldEnd = end;
      this.newEnd = b.length - suffix;
    } else {
      this.start = Math.min(this.start, start);
      this.oldEnd += Math.max(0, end - this.newEnd);
      this.newEnd = Math.max(this.newEnd, end) + b.length - a.length;
    }
  }
  delta(after: View): Delta {
    if (this.start === undefined) {
      return { offset: 0, remove: 0, text: "" };
    }

    const added = units(after).slice(this.start, this.newEnd);
    const removed = units(this.before).slice(this.start, this.oldEnd);

    if (sameContent(added, removed)) {
      return { offset: 0, remove: 0, text: "" };
    }

    return {
      offset: this.start - this.origin,
      remove: this.oldEnd - this.start,
      text: added.map((u) => u.content).join(""),
    };
  }
}

export const applyDelta = (view: View, delta: Delta) => {
  const cells = units(view);
  const cursor = cells.filter((u) => u.start < view.cursor).length;
  const start = Math.max(0, Math.min(cells.length, cursor + delta.offset));
  const end = Math.min(cells.length, start + delta.remove);

  return {
    start: cells[start]?.start ?? view.text.length,
    end: cells[end]?.start ?? view.text.length,
    text: delta.text,
  };
};

export interface SelectionExtent {
  linewise: boolean;
  lines: number;
  columns: number;
}

export const selectionExtent = (
  view: View,
  range: { start: number; end: number },
  linewise: boolean
): SelectionExtent => {
  const text = view.text.slice(range.start, range.end);
  const rows = text.split("\n");
  const lastRow = rows.at(-1);

  if (lastRow === undefined) {
    throw new Error("Splitting the selection produced no rows");
  }

  return {
    linewise,
    lines: linewise && text.endsWith("\n") ? rows.length - 1 : rows.length,
    columns: units(view).filter(
      (u) => u.start >= range.end - lastRow.length && u.end <= range.end
    ).length,
  };
};

export const selectionEnd = (view: View, extent: SelectionExtent): number => {
  let start = view.cursor;

  for (let n = 1; n < extent.lines; n += 1) {
    const end = view.text.indexOf("\n", start);

    if (end === -1) {
      break;
    }

    start = end + 1;
  }

  if (extent.linewise) {
    return start;
  }

  if (extent.columns === 0 && extent.lines > 1) {
    return previous(view, start);
  }

  const { end } = line(view.text, start);
  const cells = units(view).filter((u) => u.start >= start && u.start < end);

  return (
    cells[Math.max(0, extent.columns - 1)]?.start ??
    cells.at(-1)?.start ??
    start
  );
};
