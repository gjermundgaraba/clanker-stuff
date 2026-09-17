export interface Range {
  start: number;
  end: number;
}
export interface Atom extends Range {
  content: string;
}
export interface View {
  readonly text: string;
  readonly cursor: number;
  readonly atoms: readonly Atom[];
}
export interface Unit extends Atom {
  text: string;
}
const segmenter = new Intl.Segmenter(undefined, { granularity: "grapheme" });

/** UTF-16 offsets at the host boundary; operations traverse whole graphemes/paste atoms. */
export function units(view: View): Unit[] {
  const result: Unit[] = [];
  let offset = 0;
  for (const atom of view.atoms) {
    for (const { index, segment } of segmenter.segment(view.text.slice(offset, atom.start)))
      result.push({
        start: offset + index,
        end: offset + index + segment.length,
        text: segment,
        content: segment,
      });
    result.push({ ...atom, text: view.text.slice(atom.start, atom.end) });
    offset = atom.end;
  }
  for (const { index, segment } of segmenter.segment(view.text.slice(offset)))
    result.push({
      start: offset + index,
      end: offset + index + segment.length,
      text: segment,
      content: segment,
    });
  return result;
}
export function line(text: string, at: number): Range {
  const start = text.lastIndexOf("\n", Math.max(-1, at - 1)) + 1;
  const end = text.indexOf("\n", at);
  return { start: at === 0 ? 0 : start, end: end < 0 ? text.length : end };
}
export function normalCursor(view: View, at: number): number {
  const bounded = Math.max(0, Math.min(view.text.length, at));
  const row = line(view.text, bounded);
  const cell = units(view).find((u) => u.start <= bounded && bounded < u.end);
  if (bounded === row.end && row.end > row.start)
    return units(view).findLast((u) => u.end <= row.end)?.start ?? row.start;
  return cell?.start ?? bounded;
}
export function next(view: View, at: number) {
  return units(view).find((unit) => unit.start <= at && at < unit.end)?.end ?? at;
}
export function previous(view: View, at: number) {
  return units(view).findLast((unit) => unit.start < at)?.start ?? 0;
}
export function category(text: string, big = false): number {
  return /^\s+$/u.test(text) ? 0 : big || /^[\p{L}\p{N}_]/u.test(text) ? 1 : 2;
}

export function exitInsert(view: View): number {
  return normalCursor(
    view,
    Math.max(line(view.text, view.cursor).start, previous(view, view.cursor)),
  );
}
