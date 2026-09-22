# turn-recap

Shows a persistent live turn card with timing, usage, tool activity, and optional LLM recaps.

> [!CAUTION] **Experimental:** This is not a stable daily driver. Breaking changes may happen without notice, and the extension may be removed.

## Install

Load `pi/extensions/experimental/turn-recap/index.ts` as a local extension; npm installation is not supported.

## Usage

The card stays above the editor while working and after completion; use `/turn-recap` to toggle detailed statistics.

## Configuration

Timing and statistics need no configuration; optionally configure a secondary recap model in `~/.pi/agent/turn-recap.json` using [turn-recap configuration](docs/configuration.md).
