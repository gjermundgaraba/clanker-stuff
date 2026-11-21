# peers

Lets running Pi sessions message each other by session name, waking the recipient, with a visible error for a name nobody has.

> [!CAUTION] **Experimental:** This is not a stable daily driver. Breaking changes may happen without notice, and the extension may be removed.

## Install

Load `pi/extensions/experimental/peers/index.ts` as a local extension; npm installation is not supported.

## Usage

- Name each session with `/name <name>`; a named TUI or RPC session is reachable by that name while it runs. `/peers` lists them.
- Ask Pi to message another session; it calls `peer_send`, ends its turn, and is woken when the reply arrives.

## Configuration

See [usage and delivery](docs/usage.md) for the tools, the files behind them, and delivery guarantees.
