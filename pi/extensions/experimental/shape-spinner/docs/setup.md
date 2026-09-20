# Shape spinner setup

One extension, one font, and one command select between the colored Rubik's puzzle and four wireframe shapes for each of Pi's status spinners. Only one working-indicator controller is active.

## Ghostty on macOS

Install the font on the machine **displaying** the terminal, even when Pi runs over SSH. The extension never installs fonts or changes your terminal configuration.

From the repository root:

1. Open `pi/extensions/experimental/shape-spinner/assets/ShapeSpinner.ttf` in Font Book and choose **Install**.
2. Start `pi -e ./pi/extensions/experimental/shape-spinner/index.ts`.
3. Run `/shape-spinner preview` and copy its exact `font-codepoint-map` line into your Ghostty configuration. Never map the ordinary-space character.
4. Reload Ghostty's configuration with **Cmd+Shift+,**, then open a new Ghostty tab or window. Ghostty 1.3.1 applies mapping changes to new terminals; a new multiplexer pane is not a new terminal. If necessary, save work and restart Ghostty.
5. Run the preview again. Expect a colored puzzle cube, complete wireframes, and nine color swatches, not boxes or unrelated symbols. Send a prompt to check actual playback.
6. Once verified, run `pi install ./pi/extensions/experimental/shape-spinner`.

The family name contains a font-content revision. After an update, run `/reload` in Pi and check `/shape-spinner preview`. If the family changed, install the new TTF and **replace** the old Shape Spinner mapping with the line from the preview. Source-only changes do not require reinstalling the font. Do not append overlapping mappings. If Font Book mistakes the filename for an already installed revision, install a copy named `ShapeSpinner-<revision>.ttf`. Old revisions may be removed manually after the new one works.

## Commands

Each invocation takes one option, optionally preceded by the spinner it targets:

| Option                                                                       | Effect                                                                                      |
| ---------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------- |
| `rubik`                                                                      | Select the colored puzzle cube without changing on/static/off mode.                         |
| `orb`, `cube`, `octahedron`, `tetrahedron`                                   | Select a wireframe without changing on/static/off mode.                                     |
| `blue`, `purple`, `pink`, `red`, `orange`, `yellow`, `green`, `cyan`, `gray` | Select a wireframe color without changing shape, background, or mode.                       |
| `dark`, `light`                                                              | Select wireframe ink for that background; Rubik keeps its sticker colors.                   |
| `on`                                                                         | Animate the selected shape while Pi works.                                                  |
| `static`                                                                     | Display its resting pose (solved for Rubik) while Pi works.                                 |
| `off`                                                                        | Restore Pi's default indicators.                                                            |
| `preview`                                                                    | Show all five spinners, nine colors, family, font path, and mapping without changing state. |
| No option                                                                    | Show current choices and help.                                                              |

Without a target, shape and color options change the working spinner. Prefix an option with `working`, `retry`, `compaction`, or `summary` (Pi's branch-summary indicator) to change that spinner's shape or color instead, or use `on`/`off` after the target to keep Pi's default for that spinner alone: `/shape-spinner retry cube`, `/shape-spinner compaction red`, `/shape-spinner summary off`. Background and `on`/`static`/`off` without a target apply to every spinner, and a global `on` also brings back spinners that were turned off individually.

Use `/shape-spinner rubik` for the puzzle and `/shape-spinner cube` for the wireframe cube. Example: `/shape-spinner tetrahedron`, then `/shape-spinner purple`. Use `/shape-spinner light` for a light terminal background, or `dark` for a dark one; this does not change your terminal theme. Rubik keeps its stickers, but remembers your color for the next wireframe. All choices are runtime-only; a fresh load resets to an animated cyan orb for working, an orange tetrahedron for retries, a purple cube for compaction, and a blue octahedron for branch summaries, all with dark-background ink. Disable the extension in `pi config` for a persistent opt-out.

## Lifecycle and compatibility

Pi owns the playback timer: the extension sets a sequence once, with no private timers, editor replacements, widgets, subprocesses, or direct terminal output. All sequences use nominal 50 fps (20-ms ticks). Wireframes have 400 frames: eight seconds of rotation, with constant global opacity and scale. Rubik has 220 frames: a 4.4-second solve/hold/scramble loop, with no opacity pulse. An integer interval avoids Node truncating a 60-fps delay to 16 ms and shortening the loop. Achieved timing depends on Pi's timer, render coalescing, system load, and terminal. This is activity, **not progress**.

Normal completion and Escape remove the indicator immediately. Amp's startup phase correction, stop easing, and persistent idle icon cannot be represented by this cyclic working-indicator slot. Static mode is a separately rendered resting pose, not a retained idle widget. Pi styles only the working spinner through its extension API; the retry, compaction, and branch-summary spinners are restyled by the shared editor from `@clanker-stuff/editor` as Pi embeds them in the editor border, and their labels stay Pi's own. When another extension owns a custom editor, or Pi's editor internals are unsupported, those three keep Pi's default animation and the working spinner still changes. RPC, JSON, and print modes are untouched.

Each frame is one private-use color glyph plus an ordinary space. This reserves two terminal columns and allows Ghostty to display the whole shape without independently fitting two halves. Transparent `sbix` bitmaps preserve depth shading and composite against the real background. Colors are baked, not ANSI-tinted by Pi's theme. The puzzle has fixed multicolor stickers. One deterministic orb seed and all nine named Amp web colors, each with dark/light variants, are bundled; arbitrary colors or seeds require rebuilding.

Ghostty on macOS with color-font rendering is the supported target, not a guarantee for all terminal versions. There is no monochrome artwork fallback. Pi cannot detect whether your terminal has selected the font. Use `/shape-spinner off` if the result is clipped, missing, or unreadable.

Wireframes have intentionally faint rear edges, but the completed icon does not fade or shrink. Check both ink choices at your actual font size. The wireframe geometry is reconstructed from Amp, but the terminal's tiny raster, cell fitting, and font cache still need visual approval. See [font generation and fidelity](font.md).
