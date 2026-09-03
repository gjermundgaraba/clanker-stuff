# Thinking Orbs font

`scripts/orb-font/` turns the animated "thinking orb" loading indicators from
[orbs.jakubantalik.com](https://orbs.jakubantalik.com/) into a flipbook font:
every animation frame is a glyph, and printing successive Private Use Area
codepoints in place plays the animation in any terminal or browser that can
reach the font. No terminal protocol support is needed — the font does all the
work. A tenth state, a dotted Rubik's cube being solved, is an original scene
written in the same visual style.

The built font is checked in at `scripts/orb-font/ThinkingOrbs.ttf` (~18 MiB).
It is not installed anywhere by default.

## States and codepoints

Each state occupies a `0x100`-codepoint block. Frame `i` of a state lives at
`base + i`; frame counts vary per state (45–150) and `orbs-meta.json` is the
canonical map of `{ base, count }` per state, plus the playback rate (30 fps).

| state      | cell base (20 px tuned) | display base (64 px tuned) |
| ---------- | ----------------------- | -------------------------- |
| working    | U+10E000                | U+10F000                   |
| searching  | U+10E100                | U+10F100                   |
| solving    | U+10E200                | U+10F200                   |
| listening  | U+10E300                | U+10F300                   |
| connecting | U+10E400                | U+10F400                   |
| weaving    | U+10E500                | U+10F500                   |
| composing  | U+10E600                | U+10F600                   |
| breathing  | U+10E700                | U+10F700                   |
| shaping    | U+10E800                | U+10F800                   |
| cube       | U+10E900                | U+10F900                   |

The **cell** set uses the site's hand-tuned 20 px variants with extra
"terminal cell" tuning (fewer, bigger dots; see `CELL_EXTRA` in `capture.mjs`)
and draws in an 880-unit box that deliberately overhangs the 600-unit advance
so a one-cell orb reads larger. The **display** set uses the 64 px variants —
the look of the site itself — for rendering at larger-than-cell sizes.

Why this codepoint range: PUA is squatted territory. Nerd Fonts v3 occupy
plane-15 PUA-A (U+F0001–U+F1AF0), and Apple maps SF Symbols into plane-16
PUA-B from U+100000 upward, so CoreText resolves low plane-16 codepoints to
SF Pro. U+10E000+ is beyond both; with the font installed, macOS font fallback
finds it without configuration. Verify what CoreText resolves with
`CTFontCreateForString` if a glyph renders as something unexpected.

## Using it

1. Install: `cp scripts/orb-font/ThinkingOrbs.ttf ~/Library/Fonts/`
2. Optional but deterministic — pin the range in Ghostty
   (`~/.config/ghostty/config`), then reload with cmd+shift+comma:

   ```
   font-codepoint-map = U+10E000-U+10FFFF=Thinking Orbs <N>
   ```

   `<N>` is the build revision (`scripts/orb-font/.fontrev`); the font family
   is renamed every build (see "Ghostty font caching" below). kitty equivalent:
   `symbol_map U+10E000-U+10FFFF Thinking Orbs <N>`.
3. Terminal playback: `node scripts/orb-font/play.ts [state]` flips one
   character in place at 30 fps (no argument cycles all states).
4. Browser demo: open `scripts/orb-font/test.html` (works over `file://`) —
   big orbs from the display set, inline orbs from the cell set.
5. One static frame anywhere: `printf '\U10E700'` is breathing, frame 0.

## Pipeline

```
thinking-orb-bundle.mjs   site bundle + one appended export of its internals
custom-scenes.mjs         original scenes (cube) in the same scene contract
        │ node capture.mjs 20   → frames-20.json
        │ node capture.mjs 64   → frames-64.json
        ▼
build.py (uv run --with fonttools python scripts/orb-font/build.py [--install])
        → ThinkingOrbs.ttf, orbs-meta.json, orbs-meta.js
review.py                 side-by-side fidelity sheet (reference vs glyphs)
```

- **Capture.** The site's scene functions are pure
  `(size, time, opts) -> {dots, lines}`; a one-line `export` appended to a
  copy of its minified bundle exposes them, so capture runs in plain Node
  with a six-line DOM stub — no browser, no porting, zero drift. Frames store
  raw per-dot `[x, y, r, white, alpha]`. Loop points are auto-picked per
  state by minimizing a coarse-raster diff against frame 0 (the cube's
  analytic 45-frame period is found exactly).
- **Build.** Each frame becomes a COLRv0 color glyph: dots at their exact
  original radii, alpha quantized into four CPAL levels (palette 0
  white-on-dark, palette 1 black-on-light), painted faint-to-bright. The
  base glyph carries a monochrome fallback outline for COLR-unaware
  renderers. The 64 px `connecting` state has real connection lines,
  rendered as rectangle contours. `--install` additionally copies the font
  to `~/Library/Fonts` and rewrites the Ghostty `font-codepoint-map` line.
- **Review.** `review.py` renders the site's exact paint math (z-sorted
  grayscale + alpha circles) next to FreeType rasterizations of the built
  glyphs for every state — the tool that caught every fidelity bug below.

## Hard-won findings

- **Brightness cannot be folded into radius.** The scenes encode depth in
  both dot radius and brightness; folding brightness into radius applies the
  depth cue twice (measured: `working`'s dot-size spread went from the
  site's 2.83× to 7.28×). That is why the glyphs are COLR with real alpha.
  The monochrome fallback still folds (`ink^0.65`, dust below 0.15 ink
  dropped) — tuned as the least-bad 1-bit approximation: `^0.5` is
  energy-preserving but full-white antialiased dots bloom, and near-invisible
  ghost dust must be dropped entirely or it becomes visible specks.
- **Ghostty font caching.** Ghostty/CoreText keep serving a cached font
  across config reloads even when the file changes in place (fresh inode
  included). Renaming the family per build ("Thinking Orbs N", tracked in
  `.fontrev`) plus updating the config line makes cmd+shift+comma a
  guaranteed cache miss; otherwise a full Ghostty restart is required.
- **A complete `name` table matters.** Without `psName`/`fullName`, CoreText
  treats the font as anonymous (`.LastResort` full name) and fallback
  resolution is flaky.
- **The site's 20 px and 64 px variants are different designs**, not scaled
  copies — counts, radii, and even geometry differ (web grows lines only at
  64 px). Matching the site's look at display size requires capturing the
  64 px parameters.

## Tuning

Cell-set legibility: `CELL_EXTRA` in `capture.mjs` (dot count / dot size
multipliers applied through the site's own scaler functions) and `CELL_BOX`
in `build.py` (orb box size; ~1000 units is the clipping ceiling). Cube
behavior: `custom-scenes.mjs` — `period` (loop seconds; keep it a multiple of
1/30 so the flipbook wraps seamlessly), `twistFrac` (twist portion of each
move slot), pose (`yaw`/`pitch`), brightness (`inkFar`/`inkSpan`), and the
move list (`slice` — chosen so every twist is visible at the default pose).
After any change: re-capture both sizes, rebuild, and reload the font.
