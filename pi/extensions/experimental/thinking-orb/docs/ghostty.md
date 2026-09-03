# Ghostty setup and troubleshooting

## Requirements

- Ghostty (`TERM_PROGRAM = ghostty`); no tmux, screen, or SSH in between.
- A `custom-shader` pointing at this package's `shaders/thinking-orb-overlay.glsl`.
- `custom-shader-animation = false` in Ghostty, so the extension's heartbeat drives the frame rate instead of Ghostty's continuous animation timer.

## One-time setup

Run `/orb-setup`. It copies the shader to `<ghostty-config-dir>/shaders/`, then asks before appending the two required settings to your Ghostty config. Restart Ghostty afterwards so the shader loads.

## How it works

The extension transmits a sparse, transparent coordinate texture once; the shader decodes pane-local geometry from marker pixels and draws the orb on the GPU. A transparent one-pixel "heartbeat" image alternates each frame to force a repaint, which advances the shader clock. Rendered animation pixels never cross the PTY; every heartbeat frame is under ~200 bytes.

## Configuration

`~/.pi/agent/thinking-orb.json`:

```json
{
  "version": 1,
  "enabled": true,
  "autoStart": true,
  "fps": 60,
  "backingScale": 2
}
```

- `enabled` — master switch; when false, no overlay ever starts.
- `autoStart` — start automatically while the agent runs and stop when it settles.
- `fps` — heartbeat rate, 15–60.
- `backingScale` — overrides backing-scale detection when Ghostty's window padding is non-zero and the font-based estimate is ambiguous.

## Troubleshooting

Run `/orb-status` first; it reports config, environment, and runtime state.

- **"Ghostty has no custom-shader configured"** — run `/orb-setup`, restart Ghostty.
- **"custom-shader-animation must be false"** — add `custom-shader-animation = false`.
- **"cannot determine the display backing scale"** — set `backingScale` (1, 2, or 3) in the config file, or set `window-padding-x`/`window-padding-y` to `0` in Ghostty so the padding offset no longer matters.
- **Pink speckle grid** — the shader is not running, so the coordinate texture's markers are visible. The health gate should prevent this; if you see it, run `/orb-status` and confirm `custom-shader` resolves to this package's shader.
- **Nothing animates over SSH/tmux** — unsupported by design; the shader runs in the outer terminal process.

## Attribution

The orbit design is derived from [thinking-orbs](https://github.com/Jakubantalik/thinking-orbs) by Jakub Antalik (MIT); see `shaders/THIRD_PARTY_NOTICES.md`.
