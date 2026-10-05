# Shape spinner setup

One extension, one font, and one command select between the colored Rubik's puzzle and four wireframe shapes for Pi's working spinner. Only one working-indicator controller is active.

## Ghostty on macOS

Install the font on the machine **displaying** the terminal, even when Pi runs over SSH. The extension never installs fonts or changes your terminal configuration.

From the repository root:

1. Open `pi/extensions/experimental/shape-spinner/assets/ShapeSpinner.ttf` in Font Book and choose **Install**.
2. Start `pi -e ./pi/extensions/experimental/shape-spinner/index.ts`.
3. Run `/shape-spinner` and copy the `font-codepoint-map` value (without the `Ghostty:` label) from the dialog's footer into your Ghostty configuration. Never map the ordinary-space character.
4. Reload Ghostty's configuration with **Cmd+Shift+,**, then open a new Ghostty tab or window. Ghostty 1.3.1 applies mapping changes to new terminals; a new multiplexer pane is not a new terminal. If necessary, save work and restart Ghostty.
5. Open the dialog again. Expect animated shapes in the preview rows, not boxes or unrelated symbols. Send a prompt to check actual playback.
6. Once verified, run `pi install ./pi/extensions/experimental/shape-spinner`.

The family name contains a font-content revision. After an update, run `/reload` in Pi and open `/shape-spinner`. If the family changed, install the new TTF and **replace** the old Shape Spinner mapping with the footer line from the dialog. Source-only changes do not require reinstalling the font. Do not append overlapping mappings. If Font Book mistakes the filename for an already installed revision, install a copy named `ShapeSpinner-<revision>.ttf`. Old revisions may be removed manually after the new one works.

## Settings dialog

Run `/shape-spinner` to open the settings dialog. It previews the spinner at the real frame rate, updating as you change settings, and applies each change to the live spinner immediately:

| Row      | Effect                                                                            |
| -------- | --------------------------------------------------------------------------------- |
| `Motion` | `animated` plays the loop; `static` rests on the closing pose (solved for Rubik). |
| `Shape`  | Pick the colored puzzle or a wireframe.                                           |
| `Color`  | Pick the wireframe ink.                                                           |

Rubik keeps its stickers but remembers the color for the next wireframe. The live editor stays visible around the dialog.

Wireframe ink follows the theme's light or dark appearance, so a light/dark theme pair switches ink with your terminal. Pi has no theme-change event, so a switch shows from the next run.

Choices are saved to `shape-spinner.json` in Pi's agent directory when the dialog closes and restored on the next start; a file in an earlier format falls back to the defaults. The default is an animated cyan orb. Disable the extension in `pi config` to opt out.

## Lifecycle and compatibility

Pi owns the playback timer for the real spinner: the extension sets its sequence at startup and at each run's start. The only private timer is the settings dialog's preview animation, which stops when the dialog closes. There are no editor replacements, widgets, subprocesses, or direct terminal output. All sequences use nominal 50 fps (20-ms ticks). Wireframes have 400 frames: eight seconds of rotation, with constant global opacity and scale. Rubik has 220 frames: a 4.4-second solve/hold/scramble loop, with no opacity pulse. An integer interval avoids Node truncating a 60-fps delay to 16 ms and shortening the loop. Achieved timing depends on Pi's timer, render coalescing, system load, and terminal. This is activity, **not progress**.

Normal completion and Escape remove the indicator immediately. Amp's startup phase correction, stop easing, and persistent idle icon cannot be represented by this cyclic working-indicator slot. Static mode is a separately rendered resting pose, not a retained idle widget. Only the working spinner changes, through Pi's extension API; retry, compaction, and branch-summary spinners keep Pi's default animation, and any custom editor can be used. RPC, JSON, and print modes are untouched.

Each frame is one private-use color glyph plus an ordinary space. This reserves two terminal columns and allows Ghostty to display the whole shape without independently fitting two halves. Transparent `sbix` bitmaps preserve depth shading and composite against the real background. Colors are baked, not ANSI-tinted by Pi's theme; only the light or dark ink variant follows it. The puzzle has fixed multicolor stickers. One deterministic orb seed and all nine named Amp web colors, each with dark/light variants, are bundled; arbitrary colors or seeds require rebuilding.

Ghostty on macOS with color-font rendering is the supported target, not a guarantee for all terminal versions. There is no monochrome artwork fallback. Pi cannot detect whether your terminal has selected the font. Disable the extension if the result is clipped, missing, or unreadable.

Wireframes have intentionally faint rear edges, but the completed icon does not fade or shrink. Check both ink choices at your actual font size. The wireframe geometry is reconstructed from Amp, but the terminal's tiny raster, cell fitting, and font cache still need visual approval. See [font generation and fidelity](font.md).
