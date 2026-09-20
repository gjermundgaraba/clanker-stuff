# shape-spinner

Replaces Pi's working, retry, compaction, and branch-summary spinners with selectable Rubik's cube or wireframe shape animations.

> [!CAUTION] **Experimental:** This is not a stable daily driver. Breaking changes may happen without notice, and the extension may be removed.

## Install

Install the bundled font using the [setup instructions](docs/setup.md), then run `pi install ./pi/extensions/experimental/shape-spinner` from this repository.

## Usage

- An orb animates while Pi works; retries, compaction, and branch summaries get their own shapes in the editor border.
- Run `/shape-spinner` to open the settings dialog: pick shapes, colors, playback, and background per spinner, with animated previews that apply live and also verify the font.

## Requirements

Pi 0.86 or newer, Ghostty on macOS, and the bundled color font installed on the display machine; disable other working-spinner extensions. Border spinners need the shared editor, so another custom editor limits changes to the working spinner. See [setup and compatibility](docs/setup.md).
