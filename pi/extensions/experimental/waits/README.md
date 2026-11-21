# waits

Lets the agent wait on a shell condition that survives reload and quit, and wakes it once when the condition holds or the wait expires.

> [!CAUTION] **Experimental:** This is not a stable daily driver. Breaking changes may happen without notice, and the extension may be removed.

## Install

Load `pi/extensions/experimental/waits/index.ts` as a local extension; npm installation is not supported.

## Usage

- Ask Pi to wait for something; it calls `wait_start` with a side-effect-free condition (exit 0 means done) and an instruction for later, then ends its turn.
- When the condition holds or the wait expires, the agent is woken once, in this session or after you quit and relaunch it. Use `/waits` to list live waits.

## Configuration

See [usage and lifecycle](docs/usage.md) for the tools, defaults, what survives what, and delivery guarantees.
