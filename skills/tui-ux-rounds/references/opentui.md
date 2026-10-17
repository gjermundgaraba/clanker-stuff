# OpenTUI + Solid quirks

Learned while polishing OpenTUI/Solid apps. Each entry is a symptom, then the cause and the fix.

- **Padding on `<text>` is measured but not drawn.** A description shows at column 0 and its
  highlighted block gets a phantom extra line. Put the padding on a wrapping `<box>`.
- **`truncate` cuts the middle with three ASCII dots (`...`).** It clashes with `…` elsewhere and
  truncates only the rows that overflow, so columns stop lining up. Pre-fit strings to a computed
  width (keep both ends of names) and don't rely on `truncate` for tabular rows. It also doesn't
  stop wrapping: a long one-line status wraps and pushes the layout down unless it also has
  `wrapMode="none"`.
- **`on([a(), b()])` runs on every recompute of its sources**, even when the values are the same,
  so "reset scroll when the tab changes" also fires on every unrelated state update. Compare
  with the previous values (`on`'s second argument) before acting.
- **Identity checks against recomputed lists fail silently.** A plain function returning
  `.map(...)` builds new objects on every call, so `file === current()` is never true and
  highlights vanish. Memoize the list (`createMemo`) and compare by a stable field.
- **Colour inside a text run.** `<span>` styling from props may not update; set `node.fg` in a
  `ref` callback inside `createRenderEffect`.
- **Hyphens are word-wrap points.** ISO dates and versions break at `-` (`2026-10-` / `15`).
  Prefer formats without hyphens ("Oct 15") where wrapping is likely.
- **Plain-text frames hide state.** `captureCharFrame()` and `herdr pane read` drop backgrounds,
  so you can't see from text which tab or row is highlighted. Assert on a glyph (such as `▌`) or
  use ANSI.
- **Escape in mock input waits for a timeout.** Escape is ambiguous with escape sequences, so a key
  pressed right after it can merge into it (Alt+key) or arrive late. Wait for a frame between
  Escape and the next key.
- **Code points are not graphemes or cells.** `Array.from(str)` and `[...str]` split by code
  point, so `e` + a combining accent or a ZWJ emoji becomes several items. Use `Intl.Segmenter` for
  graphemes and the renderer's own width function for terminal columns.
- **A UI test timing out on `frame(...)`** means its predicate never matched, not that keys froze:
  read which predicate failed first. A correct change that removes the awaited text looks the same.
