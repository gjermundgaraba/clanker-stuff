# Font generation and fidelity

Runtime loads only `assets/shapes.json`; the display terminal renders `assets/ShapeSpinner.ttf`. Node/Chrome wireframe rasterization and Python/Pillow/fontTools are build-time only. No files from Amp or the Desktop demo are needed to build or use this package.

## Rebuild and inspect

From the repository root, with Node 26+, [uv](https://docs.astral.sh/uv/), Chrome, and the repository toolchain installed (`vp install`):

```bash
uv run pi/extensions/experimental/shape-spinner/tests/build_test.py
uv run pi/extensions/experimental/shape-spinner/scripts/build.py
uv run pi/extensions/experimental/shape-spinner/scripts/build.py --check
uv run pi/extensions/experimental/shape-spinner/scripts/preview.py --out /tmp/shape-spinner-review
swift pi/extensions/experimental/shape-spinner/scripts/check-coretext.swift
vp test --project unit pi/extensions/experimental/shape-spinner
vp test --project smoke pi/extensions/experimental/shape-spinner
vp check pi/extensions/experimental/shape-spinner
```

Set `CHROME` to override the macOS Google Chrome executable path. The renderer launches a headless temporary profile and an `about:blank` page, communicates over localhost CDP, then closes the process and deletes the profile. It does not navigate to Amp or any remote website. Python dependencies are pinned inline. The Swift check requires Apple's command-line tools.

A normal build rasterizes and assembles the font once, validates every glyph, formats metadata with the repository formatter, and writes both assets. `--check` re-rasterizes, assembles twice to check determinism, and compares both checked-in assets. Use the Chrome version recorded in `assets/shapes.json` for reproducibility: changing browser version or platform can change rasterization. Family identity hashes the assembled font before adding its derived names, covering bitmaps, codepoint mapping, bounds, and metrics. Source text and browser provenance are not part of the identity; timestamps are fixed. Rebuilding never installs fonts or edits terminal configuration.

Rubik's 94%-of-em canvas leaves a small geometric inset; Lanczos antialiasing fringe can touch the bitmap edge. Wireframe bitmaps retain fully transparent borders. CoreText's paint check verifies both against their fixed glyph bounds.

The preview script decodes the **built font's PNGs**, producing all-color light/dark contact sheets plus native-size and enlarged shape sheets and GIFs for cyan (choose another with `--color purple`). These are proofs of embedded artwork, not Ghostty screenshots. The Swift script paints every glyph at 12–20 px and their doubled sizes using CoreText, checking actual painted pixels against declared bounds. Neither test proves terminal font selection or two-cell fitting.

## Reconstruction provenance

The wireframe geometry originated in the separate `amp-orb-recreation/native-demo` reconstruction of Amp 1.0 build 308. Numeric fixtures come from an independently extracted cached web engine, with its inner-ring inclination ceiling adjusted to the native model's 85°; they contain numeric outputs, not the extracted program.

Local tests cover those fixtures, animation seams, fixed viewport bounds, path topology, drawing opacity, and source-to-manifest palette consistency. Python unit tests exercise font identity, bitmap preservation, and the real puzzle builder without launching Chrome.

Preserved details:

- Orb: four 20-vertex rings, each split into four six-point paths; 16 strokes, not 80 independent segments. FNV-1a UTF-16 hashing and xorshift32 seed the three tilted rings, tangent axes, and signed 1/2/1 tumble rates.
- Cube, octahedron, tetrahedron: exact normalized vertices, face-adjacent edges, recovered resting orientations, and shape-specific elevation.
- Perspective camera distance 2.6; full-path mean depth sorting and opacity `0.16 + 0.84 × ((z + 1) / 2)^1.5`. Resting silhouette emphasis is separate from working opacity.
- Compact radii (native radius × 1.15), 1.2-unit round-capped/round-joined strokes, and eight-second rotation. Working loops keep global opacity and scale at 1.

Working frames are drawn directly onto one canvas, with no group opacity or scale transform. The native fade/shrink effect is optional, and the cached web working renderer does not apply it; it is not part of these working loops.

The nine colors in `scripts/frames.ts` preserve the cached web bright palette, not every native caller's supplied color. Each color has separate dark- and light-background inks; gray is achromatic. Chromium rasterizes each OKLCH ink to sRGB PNGs, including gamut mapping, rather than recoloring cyan pixels. Normal/non-bright and two-tone palettes are not bundled. Native CoreGraphics antialiasing and color-management pixel parity has not been established.

## Rubik's cube

`scripts/rubik.py` contains the solid puzzle renderer. It is original sticker artwork, not reconstructed from Amp. The font-flipbook layout originally drew on [gjermund/nice-animations](https://github.com/gjermund/nice-animations); no runtime player or shader is included.

The model retains 26 cubies and 54 sticker identities through five quarter-turns and their exact inverse. A fixed camera, opaque bodies, colored stickers, and narrow gutters keep layer turns legible. One scale normalizes the union of every pose, never each individual frame.

Playback begins scrambled, solves, briefly holds, then scrambles again. Sampling at 50 fps preserves the authored 0.2-second scramble turns, 0.5-second solve turns, and 4.4-second loop. This avoids Node's fractional-timer truncation. Static mode uses the solved pose. The puzzle has no pulse, and its sticker colors do not change with either the color or dark/light selector.

Pillow supersamples opaque polygons before reducing to the font strikes. The builder checks cubie/sticker identity, inverse solution, timeline, loop, and fixed-canvas bounds.

## Font layout

Wireframe poses use the same centered 32-unit square viewport around the original 24-unit logical icon box. The extra margin preserves perspective overflow and antialiasing without clipping. It is a fixed terminal adaptation: frames and shapes are never individually normalized, so relative radii are preserved without artificial breathing.

Each glyph has a 1000-unit em, 600-unit advance, 800/-200 ascent/descent, and fixed square outline bounds anchored with zero-area contours. Transparent PNG strikes at 32 and 64 ppem cover ordinary and Retina terminal sizes. Larger display sizes upscale these strikes. One complete frame plus an unmapped U+0020 reserves two columns. All five spinners share a single contiguous bank starting at U+100000.

Ghostty's macOS CoreText backend supports `sbix`; COLR-only support cannot be assumed. Bitmap offsets are zero: with outline contours, sbix offsets are relative to the lower-left glyph bounds, which already include the descender. Every artwork glyph has only two zero-area bounding contours, which establish bitmap placement without painting monochrome artwork. Color-font rendering is required.

Metadata contains family, fps, seed, wireframe inks/viewport, renderer version, and `animations[wireframe][color][background]` plus one independent `rubik` animation. Each animation has its cycle `seconds`, `frames` (400 wireframe or 220 Rubik codepoints), and `still` (a resting codepoint). Runtime appends the ordinary-space spacer; it is not repeated in metadata. Rubik is stored once, independent of color/background choices. PNGs are recompressed losslessly (no quantization or alpha changes). Exact duplicate bitmaps may share codepoints without changing frame duration. The eighteen wireframe color/background banks plus Rubik occupy about 93 MiB in one font; runtime JavaScript loads only the much smaller metadata, not these bitmap bytes.

## Acceptance checklist

Before calling a new build visually approved:

1. Inspect all shapes at 12, 14, 16, 18, and 20 px on both backgrounds, especially edge-on orientations and the rest pose.
2. Watch the eight-second wireframe and 4.4-second puzzle seams; no position/scale jumps or unintended whole-icon fading.
3. Test actual Ghostty playback beside Pi's Working text at the usual display scale. Verify font selection, two-cell placement, clipping, and faint-edge legibility.
4. Check completion, Escape, repeated turns, resize, and any custom editor. The indicator must not outlive Pi's normal work.
5. Switch between Rubik and wireframes in animated, static, and off modes. Verify that static Rubik is solved, color and dark/light preserve sticker colors, and off restores Pi's default.

Automated proofs do not substitute for step 3. This implementation deliberately does not add a private widget to imitate Amp's startup/stop lifecycle.
