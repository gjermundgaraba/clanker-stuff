# subagents

Adds durable hierarchical subagents with independent pi sessions, modeled on the Codex collaboration tools; works with any provider but is tuned for OpenAI Codex models.

> [!CAUTION] **Experimental:** This is not a stable daily driver. Breaking changes may happen without notice, and the extension may be removed.

## Compatibility goal

Together with [`codex-provider`](../codex-provider), this package minimizes model-facing distribution shift from the native Codex CLI harness. Its collaboration tools, schemas, descriptions, results, prompts, messages, and lifecycle behavior should match the pinned Codex implementation whenever Pi can execute that contract truthfully; every known difference remains explicit in the [parity ledger](docs/codex-parity.md).

## Install

Load `pi/extensions/experimental/subagents/index.ts` as a local extension; npm installation is not supported.

## Usage

- Models get either the UUID-based V1 tools or hierarchical V2 tools; run `/agents` to inspect the active durable tree.
- Delegation defaults to explicit requests and each child runs an independent Pi session in the same trusted project boundary.
- Proactive configuration changes the model-facing mode policy; opt into the vendored skill with `pi --skill pi/extensions/experimental/subagents/vendor/orchestrate/SKILL.md`.

## Configuration

See the normative [Pi protocol contract](docs/protocols.md). Pinned Codex references and the parity ledger are maintained in the [repository](https://github.com/gjermundgaraba/clanker-stuff/tree/main/pi/extensions/experimental/subagents/docs).
