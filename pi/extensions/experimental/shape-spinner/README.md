# shape-spinner

Replaces Pi's working spinner with a selectable Rubik's cube or wireframe shape animation.

> [!CAUTION] **Experimental:** This is not a stable daily driver. Breaking changes may happen without notice, and the extension may be removed.

## Install

Install the bundled font using the [setup instructions](docs/setup.md), then run `pi install ./pi/extensions/experimental/shape-spinner` from this repository.

## Usage

- An orb animates automatically while Pi works; use `/shape-spinner preview` to check the font.
- Switch with `/shape-spinner rubik`, `orb`, `cube`, `octahedron`, or `tetrahedron`; choose an Amp color with `/shape-spinner purple`.
- Use `/shape-spinner static` for reduced motion or `/shape-spinner off` to restore Pi's spinner.

## Requirements

Pi 0.85 or newer, Ghostty on macOS, and the bundled color font installed on the display machine; disable other working-spinner extensions. See [setup and compatibility](docs/setup.md).
