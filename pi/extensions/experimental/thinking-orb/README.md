# thinking-orb

Pane-local Ghostty Thinking Orb overlay that animates while the agent works.

> [!CAUTION] **Experimental:** This is not a stable daily driver. Breaking changes may happen without notice, and the extension may be removed.

## Install

Copy this directory into `~/.pi/agent/extensions/thinking-orb` (or load it with `pi -e`), then run `/orb-setup` once and restart Ghostty.

## Usage

The orb runs automatically while the agent works; use `/orb-start`, `/orb-stop`, and `/orb-status` to control it manually.

## Configuration

Preferences live in `~/.pi/agent/thinking-orb.json` (`enabled`, `autoStart`, `fps`, `backingScale`). See [Ghostty setup](docs/ghostty.md) for requirements and troubleshooting.
