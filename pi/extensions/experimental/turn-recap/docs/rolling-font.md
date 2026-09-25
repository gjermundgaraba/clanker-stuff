# Rolling-number font

Turn-recap rolls numbers inline using a local companion font derived from an existing static monospace TrueType font. The builder and standalone preview below prepare and verify the font. Building writes the manifest, which [turns animation on](configuration.md#rolling-numbers) at Pi's next reload, so install the font and mapping and check the preview first.

## Build locally

Use a font whose license permits your intended modification and use. The generated font contains derived outlines and retains source copyright/license metadata and embedding flags. Neither the original nor the derivative belongs in this repository. The entrypoint chooses the output directory described below; the builder rejects locations inside this repository and never installs fonts or edits terminal configuration.

With repository dependencies and [uv](https://docs.astral.sh/uv/) installed, run from the repository root:

```sh
vp exec jiti pi/extensions/experimental/turn-recap/scripts/build-font.ts \
  --source "$HOME/Library/Fonts/BerkeleyMonoNerdFontMono-Regular.ttf"
```

The TypeScript entrypoint resolves `<agent-dir>/data/turn-recap/rolling-font/` and passes it, with the digit transitions the runtime rolls through, to the Python builder, so the runtime alone defines which transitions exist. The default agent directory is `~/.pi/agent`; `PI_CODING_AGENT_DIR` overrides it. The example uses the local Berkeley font; it is not downloaded or bundled. The script's pinned dependencies are build-time only. It accepts static TrueType fonts with equal digit advances and zero line gap. Variable fonts, font collections, and CFF outlines are not supported by the builder.

Output includes a content-named `RollingDigits-<revision>.ttf` and `manifest.json`. Source files are never modified. Changes to outlines, metrics, hints, notices, or mappings change the font identity. Each transition has 8 subdivisions, matching what the widget's 30 fps frames can show; the manifest records this resolution for consumers.

## Install in Ghostty

The font itself is terminal-independent; Ghostty is the documented and tested setup. Other terminals need equivalent codepoint-to-font mapping and visual verification.

1. Install the generated TTF through Font Book or copy it into `~/Library/Fonts/`.
2. Add the exact `font-codepoint-map` line printed by the builder to your Ghostty configuration. Its range starts at `U+F2000`, outside this repository's Shape Spinner range. Check for conflicts with any additional personal mappings.
3. Reload Ghostty configuration, or open a new Ghostty process if font discovery remains stale. Keep your existing `font-family` unchanged.

Do not map ASCII digits or ordinary spaces to the companion. Only its private-use characters should use it. When rebuilding, install the new revision and replace the previous rolling-font mapping rather than adding overlapping ranges. Do not remove or change Shape Spinner mappings.

Run the preview directly in Ghostty:

```sh
vp exec jiti pi/extensions/experimental/turn-recap/scripts/preview-font.ts
```

Use `--seconds 60` for a longer preview. It exits after 30 seconds by default; `q`, Escape, or Ctrl-C exits early and restores terminal modes. The preview drives the production widget with synthetic metrics and inherits the terminal's foreground color. It does not create a Pi session or persist metrics.

The native/companion rows compare ASCII digits with the companion's stationary digit glyphs. The widget demonstrates decimal carries and increasing/decreasing motion. Its timer starts at `1:58`, demonstrating the `5 → 0` carry at `1:59 → 2:00` after about two seconds. Missing-glyph boxes mean the companion font or mapping is not active. Both paths must occupy exactly one cell per digit.

## Design

The builder translates and intersects vector outlines in font units. Each intermediate glyph contains the visible parts of the outgoing and incoming digit within one cell. It preserves the source digit advance, units per em, baseline, and vertical metrics. Original endpoint glyphs retain their hint programs and dependent glyphs; translated/clipped intermediate outlines are unhinted because the original instructions no longer describe their geometry.

The builder generates exactly the transitions the runtime passes in: ten decimal pairs plus the special `5 → 0` pair. Endpoint codepoints alias original digit glyphs. There are no embedded bitmaps or colors; the terminal rasterizes and colors the glyphs.

The mapping contains 99 codepoints, including both endpoints of each transition; there is no separate stationary mapping. The manifest records the codepoints, and the runtime reads nothing else it needs from the source font.

## Validate

There are no automated builder tests; a broken build fails or looks wrong in the checks below, and the runtime rejects a manifest it cannot read. On macOS, use CoreText to check the actual local font and create a contact sheet:

```sh
font_dir="${PI_CODING_AGENT_DIR:-$HOME/.pi/agent}/data/turn-recap/rolling-font"
swift pi/extensions/experimental/turn-recap/scripts/check-font.swift \
  "$HOME/Library/Fonts/BerkeleyMonoNerdFontMono-Regular.ttf" \
  "$font_dir/manifest.json" \
  "$font_dir/proof.png"
```

The checker verifies matching resting outlines and vertical metrics, fixed advance widths, and actual ink containment at 12 sizes (including 30 px for a 15 pt Retina setup). Pixel equality is reported separately, not assumed: CoreText can rasterize identical outlines differently in the source and companion fonts at smaller sizes. Intermediate frames are unhinted and can also differ from native hinted digits.

These are CoreText checks, not Ghostty screenshots. Before enabling animation, inspect the standalone preview at the actual terminal font size and display scale. Check the native/companion rows, baseline and width stability, cell clipping, direction changes, and the return to ordinary digits. Terminal-specific fallback scaling and adjusted cell height are not automatically calibrated.
