# presence

Shows every running Pi session as working, waiting on you, or stopped, counting work parked on a wait or another session as working.

> [!CAUTION] **Experimental:** This is not a stable daily driver. Breaking changes may happen without notice, and the extension may be removed.

## Install

Load `pi/extensions/experimental/presence/index.ts` as a local extension; npm installation is not supported.

## Usage

- Run `/who` in Pi, or `node pi/extensions/experimental/presence/cli.ts` in a shell, to list every session with its state, pid and what it is doing.

## Configuration

See [usage and states](docs/usage.md) for how each state is decided, the record format, and how other extensions report parked work.
