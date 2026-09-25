# turn-recap

Adds a turn card with timing, usage, tool activity, and optional LLM recaps to the chat after each run.

> [!CAUTION] **Experimental:** This is not a stable daily driver. Breaking changes may happen without notice, and the extension may be removed.

## Install

Load `pi/extensions/experimental/turn-recap/index.ts` as a local extension; npm installation is not supported.

## Usage

- A live row above the editor tracks each run; afterwards its card stays in the chat. Expand tool output (`Ctrl+O`) for details.
- **Processed** counts reported tokens across the run's model calls, including cache usage; recap generation is excluded.
- **Context** shows how much the estimated context grew during the run; details also show the whole window.

## Configuration

Cards need no configuration; configure a recap model in `~/.pi/agent/turn-recap.json` or build the rolling-number font using [turn-recap configuration](docs/configuration.md).
