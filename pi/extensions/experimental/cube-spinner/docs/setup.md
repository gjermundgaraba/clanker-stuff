# Cube spinner setup

The font must be installed on the machine **displaying the terminal**, even when Pi runs over SSH. Loading this extension does not install fonts, change your terminal configuration, or replace your normal text font.

## Ghostty on macOS

From the repository root:

1. Open `pi/extensions/experimental/cube-spinner/assets/CubeSpinner.ttf` in Font Book and choose **Install**.
2. Try the extension without changing Pi's saved packages:

   ```bash
   pi -e ./pi/extensions/experimental/cube-spinner/index.ts
   ```

3. Run `/cube-spinner preview`. Copy the exact `font-codepoint-map` line it prints into your Ghostty configuration. It maps only this font's private-use range, not normal text or Nerd Font symbols.
4. Reload Ghostty's configuration with **Cmd+Shift+,**, then open a new Ghostty tab or window if the mapping has not applied. Ghostty 1.3.1 documents mapping changes as applying to new terminals; a new pane inside Herdr is not a new Ghostty terminal. If missing glyphs persist, restart Ghostty after saving your work. Run the preview again: each sample should show one complete colored cube, not boxes or unrelated symbols. Then send Pi a prompt to check the animation in the actual Working border.
5. Once the preview looks correct, install the local package for subsequent Pi sessions:

   ```bash
   pi install ./pi/extensions/experimental/cube-spinner
   ```

Font family names include a content revision to avoid stale CoreText/Ghostty font caches. After rebuilding or updating the font, install the new TTF and run `/reload` in Pi (or restart Pi) to load its new metadata. Then **replace** the previous cube mapping with the new line from `/cube-spinner preview` and reload Ghostty's configuration. Do not append overlapping mappings. If Font Book says it is already installed, compare the internal family name, not the shared `CubeSpinner.ttf` filename; use a copy named `CubeSpinner-<revision>.ttf` to install a different revision. Old font versions can be removed manually in Font Book once the new one works.

## Controls

| Command                 | Effect                                                                            |
| ----------------------- | --------------------------------------------------------------------------------- |
| `/cube-spinner`         | Show mode and usage.                                                              |
| `/cube-spinner on`      | Animate during normal Pi work.                                                    |
| `/cube-spinner static`  | Use a stationary solved cube instead.                                             |
| `/cube-spinner off`     | Restore Pi's default working spinner.                                             |
| `/cube-spinner preview` | Show sample glyphs, font family, path, and Ghostty mapping without changing mode. |

These choices are in-memory, not saved preferences. A fresh extension load returns to animation. Remove the package or disable it in `pi config` to turn it off persistently.

Pi owns the animation clock and its lifecycle. There is no independent timer, extra widget, or direct terminal output. Normal completion and Escape remove the indicator immediately; it does not wait to finish solving. Retry and compaction indicators remain unchanged. RPC and print modes do not use it.

## Artwork and compatibility

Each frame is one complete cube glyph followed by a literal space. Pi reserves two columns; Ghostty lets the private-use glyph occupy that space. Keeping the cube in a single glyph avoids independently scaled or misaligned halves. Do not remove the spacer or map ordinary spaces to the cube font.

The font uses transparent color bitmaps in an `sbix` table, a format Ghostty's macOS renderer recognizes. Solid colored stickers and a stable camera make the layer turns readable at terminal size. Sticker identities persist through a predefined scramble and inverse solution; no solver or 3D rendering runs inside Pi. This is an activity loop, **not a progress estimate**.

Ghostty on macOS is the target; other terminals are unverified. Color-font support, blank-cell borrowing, line height, and rasterization vary by terminal. Merely installing the font does not prove that its renderer selected it. Pi cannot reliably detect a missing terminal font. Use the preview and `/cube-spinner off` if you see boxes, clipping, or unreadable artwork. Basic monochrome outlines are included, but they lose the intended colors and shading; they are not the target appearance. The earlier COLR-only font silently took this degraded path in Ghostty 1.3.1.

The colored stickers are intentionally self-colored rather than tinted by Pi's theme. Check both light and dark backgrounds at your usual terminal size.

## Development

The build tools are not needed to use the extension. The checked-in font and metadata are generated together; generation never installs anything or edits terminal configuration. See [font generation](font.md) for rebuilding and visual checks.
