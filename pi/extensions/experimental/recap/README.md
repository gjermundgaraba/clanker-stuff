# recap

Automatically adds durable conversation recap cards after settled Pi turns using a configured secondary model.

> [!CAUTION] **Experimental:** This is not a stable daily driver. Breaking changes may happen without notice, and the extension may be removed.

## Install

Load `pi/extensions/experimental/recap/index.ts` as a local extension; npm installation is not supported.

## Usage

Recaps appear automatically after three completed turns and then after every two additional completed turns.

## Configuration

Create `~/.pi/agent/recap.json` before loading the extension; see [recap configuration](docs/configuration.md).
