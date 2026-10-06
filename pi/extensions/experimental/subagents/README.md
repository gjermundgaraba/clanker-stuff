# subagents

Adds durable hierarchical subagents, branch-local proactive delegation, and a one-shot /ultra thinking boost.

> [!CAUTION] **Experimental:** This is not a stable daily driver. Breaking changes may happen without notice, and the extension may be removed.

## Install

Load `pi/extensions/experimental/subagents/index.ts` as a local extension; npm installation is not supported.

## Usage

- Ask for delegation explicitly; the model spawns children with `spawn_agent` and each reports its final answer to its parent.
- Run `/agents` to inspect the tree of the current session.
- Toggle `/proactive` for branch-local proactive delegation, or run `/ultra` to enable it and boost native thinking once.

## Configuration

See [design and configuration](docs/protocols.md) and [delegation and thinking](docs/delegation.md).
