import { selectGlyph } from "@clanker-stuff/status-icons";
import type { IconFamily } from "@clanker-stuff/status-icons";
import type { BorderStatus } from "@clanker-stuff/border-status-protocol";
import type { Theme } from "@earendil-works/pi-coding-agent";
import { sliceByColumn, stripTerminalSequences, visibleWidth } from "@earendil-works/pi-tui";

export interface StatusEntry {
  owner: string;
  key: string;
  status: BorderStatus;
}

export interface BorderRender {
  line: string;
  state: "rendered" | "compatible" | "insufficient-space" | "incompatible";
}

/** Replace only trailing rule cells. Never alter the editor's wrapping width or labels. */
export function renderBorder(
  original: string,
  width: number,
  entries: readonly StatusEntry[],
  family: IconFamily,
  theme: Pick<Theme, "fg">,
  borderColor: (text: string) => string,
): BorderRender {
  const plain = stripTerminalSequences(original);
  // Tiny Pi borders may contain only a spinner. Defer structural judgment there.
  if (width < 5) return { line: original, state: "insufficient-space" };
  if (!plain.startsWith("─") || !plain.endsWith("─") || visibleWidth(original) !== width)
    return { line: original, state: "incompatible" };
  if (!entries.length) return { line: original, state: "compatible" };
  const tail = /─+$/.exec(plain)?.[0].length ?? 0;
  // Keep two rule cells before the right block and one after it, plus spaces.
  const budget = tail - 5;
  if (budget <= 0) return { line: original, state: "insufficient-space" };
  const sorted = [...entries].sort(
    (a, b) =>
      (b.status.priority ?? 0) - (a.status.priority ?? 0) ||
      (a.owner < b.owner ? -1 : a.owner > b.owner ? 1 : a.key < b.key ? -1 : a.key > b.key ? 1 : 0),
  );
  const selected: string[] = [];
  let used = 0;
  for (const { status } of sorted) {
    const text = [selectGlyph(status.icon, family), status.text].filter(Boolean).join(" ");
    const size = visibleWidth(text);
    if (!size || used + size + (selected.length ? 3 : 0) > budget) continue;
    used += size + (selected.length ? 3 : 0);
    selected.push(theme.fg(status.tone ?? "text", text));
  }
  if (!selected.length) return { line: original, state: "insufficient-space" };
  const block = selected.join(theme.fg("muted", " · "));
  const prefix = sliceByColumn(original, 0, width - used - 3, true);
  return {
    line: `${prefix}\u001b[0m${borderColor(" ")}${block}${borderColor(" ─")}`,
    state: "rendered",
  };
}
