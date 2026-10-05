# subagents

Adds durable hierarchical subagents with independent pi sessions, modeled on the Codex collaboration tools; works with any provider but is tuned for OpenAI Codex models.

> [!CAUTION] **Experimental:** This is not a stable daily driver. Breaking changes may happen without notice, and the extension may be removed.

## Install

Load `pi/extensions/experimental/subagents/index.ts` as a local extension; npm installation is not supported.

## Usage

- Ask for delegation explicitly; the model spawns children with `spawn_agent` and each reports its final answer to its parent.
- Run `/agents` to inspect the tree of the current session.
- Opt into the vendored skill with `pi --skill pi/extensions/experimental/subagents/vendor/orchestrate/SKILL.md`.

## Configuration

See the [design and configuration](docs/protocols.md).
