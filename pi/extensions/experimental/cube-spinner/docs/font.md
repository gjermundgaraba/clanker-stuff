# Font generation

The runtime loads only `assets/cube.json`. The terminal renders the bundled `assets/CubeSpinner.ttf`; Python, FreeType, and fontTools are development tools, not Pi dependencies.

From the repository root, with [uv](https://docs.astral.sh/uv/) installed:

```bash
uv run pi/extensions/experimental/cube-spinner/scripts/build.py
uv run pi/extensions/experimental/cube-spinner/scripts/build.py --check
uv run pi/extensions/experimental/cube-spinner/scripts/preview.py --out /tmp/cube-spinner-review
```

Each Python script declares pinned dependencies inline. The builder always generates both the font and metadata, without installing anything. `--check` rebuilds in memory and rejects missing or stale checked-in assets.

On macOS, also run the native painted-pixel check (requires Apple's Swift command-line tools):

```bash
swift pi/extensions/experimental/cube-spinner/scripts/check-coretext.swift
```

## Design

The original flipbook-font reference is `gjermund/nice-animations` at `93c4dab`, especially `scripts/orb-font/custom-scenes.mjs` and `build.py`. The artwork has since been redesigned as solid colored stickers for terminal-sized legibility. The website bundle, other orb states, display-size alphabet, terminal player, and shader extension are not dependencies.

`scripts/build.py` owns the complete build-time pipeline:

- An integer model of 26 cubies and 54 colored stickers follows five authored quarter-turns and their inverse. Playback starts scrambled, solves, briefly holds the solved state, then scrambles quickly back into the loop. The camera stays fixed so layer motion is easy to follow.
- The scramble resets the loop quickly with 0.2-second turns; solving keeps the more readable half-second turns. The full loop takes 4.4 seconds. Both use short acceleration/deceleration ramps around steady-speed motion. Intermediate poses target 60 fps; repeated hold frames reuse their glyphs without shortening playback. Pi's native renderer coalesces updates, so achieved frame rate depends on the terminal and system load.
- Each frame becomes one whole-cube glyph followed by an ordinary space, reserving two columns. The font uses a 1000-unit em, a 600-unit advance, and an 800/-200 ascent/descent. A square 1000-unit canvas better matches Ghostty's two-column display area. One scale fits the complete animation with a small margin; moving frames never resize independently.
- Supersampled transparent PNG strikes in an `sbix` table preserve painter order, color, and alpha shading. Every frame has the same canvas and outline bounds so Ghostty applies a consistent scale and placement. The palette is reviewed against both light and dark backgrounds; there is no assumed terminal palette switching.
- Basic monochrome outlines remain for renderers without bitmap support, but lose the intended shading and are not the approved appearance.
- The font family includes a hash of its generator to avoid stale font caches. Font timestamps are fixed, so identical builds produce identical font and metadata bytes.

The metadata contains `{ family, fps, frames, still }`. Each frame is `[privateUseCodepoint, 32]`; `still` is the index of a solved frame. Runtime strings use `String.fromCodePoint(...frame)` rather than UTF-16 character splitting. The printed font mapping excludes the ordinary-space codepoint.

Ghostty 1.3.1's CoreText backend recognizes `sbix` and SVG color glyphs, but not COLR-only glyphs. Its color-glyph fitting also makes separately encoded cube halves unsuitable. Direct CoreText and FreeType color previews did not expose either constraint: actual terminal playback is the acceptance test.

The [sbix specification](https://learn.microsoft.com/en-us/typography/opentype/spec/sbix) places bitmaps relative to the glyph bounding box when outline contours exist. Our bounds already include the descender, so bitmap offsets must be zero. Adding the descender again pushed the bitmap below its reported bounds and caused Ghostty to clip the lower stickers, even though the embedded PNGs were complete.

## Checks and visual approval

The builder checks the complete sticker-state solution, loop equality, finite geometry, fixed canvas bounds, bitmap strike coverage, advances, cmap coverage, and deterministic serialization. Package unit tests also verify Pi's measured two-column width, space-free font mapping, and command/lifecycle behavior. Discovery smoke tests load the actual local package.

`check-coretext.swift` draws every glyph into an oversized buffer at 12–20 pixels and their doubled display sizes. It checks actual painted pixels against CoreText's reported bounds, ignoring near-transparent antialiasing fringe. This catches misplaced bitmap ink that checking outline bounds or standalone PNGs cannot catch; it does not replace the terminal check.

The preview tool renders the **built font's bitmaps**, not substitute scene drawings. It writes native-size and enlarged contact sheets plus animated GIFs to the selected temporary directory. Inspect the native sizes first; enlargement is for examining edges, not judging legibility. These are font proofs, not simulations of Ghostty's layout and rasterization.

Before accepting artwork changes, check:

1. Both backgrounds at 12, 14, 16, 18, and 20 pixels, including the solved state, partially turned layers, and the loop boundary.
2. No sticker flicker or sudden appearance at edge-on angles; no per-frame scale or position jumps.
3. Actual Ghostty rendering at normal font size and display scale, next to the editor border and “Working” text. FreeType previews cannot prove CoreText rendering, terminal font selection, or cell placement.
4. Completion, Escape, repeated tool turns, resizing, and another extension's custom editor. The cube should not outlive Pi's working indicator or change the editor layout.

Run package validation after rebuilding:

```bash
vp test --project unit pi/extensions/experimental/cube-spinner
vp test --project smoke pi/extensions/experimental/cube-spinner
vp check pi/extensions/experimental/cube-spinner
```

When the generated family changes, reinstall the TTF and run `/reload` in Pi (or restart Pi) before requesting `/cube-spinner preview`; metadata is loaded once per extension instance. Replace the Ghostty mapping with the newly printed family and range, then reload Ghostty's configuration.
